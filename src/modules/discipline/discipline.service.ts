import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { getUserAccess } from '../rbac/access.service';
import { currentYear } from '../academic/years.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { dayDate, isoOf } from '../attendance/attendance.settings';
import { raiseLater } from '../alerts/deliver';
import { classTeachersOf, holdersOf, parentsOf, studentsOf } from '../alerts/recipients';
import { DISCIPLINE, SEVERITIES } from './discipline.settings';

/**
 * Discipline: incidents (and positive notes) with the students involved, their part and points;
 * actions taken (some wait for the principal's approval); parents told by severity, who see and
 * acknowledge their child's conduct; and a student's conduct history with thresholds that alert
 * the class teacher and principal.
 */

type Severity = (typeof SEVERITIES)[number];
const RANK: Record<string, number> = { minor: 1, moderate: 2, serious: 3 };
const ROLE: Record<string, string> = { did: 'Involved', affected: 'Affected', witness: 'Witness' };
const DAY = 86_400_000;

/** Sections a person reaches with a discipline permission: 'all', the ones they teach / class-teach, or none. */
export const scopeOf = async (userId: string, key: 'discipline.view' | 'discipline.record'): Promise<'all' | string[]> => {
    const a = await getUserAccess(userId);
    const level = a.permissions[key];
    if (!level) return [];
    if (level === 'all') return 'all';
    const [staff, year] = await Promise.all([db.staff.findFirst({ where: { userId }, select: { id: true } }), currentYear()]);
    if (!staff || !year) return [];
    const rows = await db.section.findMany({ where: { academicYearId: year.id, OR: [{ classTeacherId: staff.id }, { teachingAssignments: { some: { staffId: staff.id } } }] }, select: { id: true } });
    return rows.map((r) => r.id);
};
const inScope = (scope: 'all' | string[], sectionId: string | null) => scope === 'all' || (!!sectionId && scope.includes(sectionId));

type TypeInfo = { id: string; name: string; positive: boolean; severity: Severity; points: number };
const typeInfo = async (id: string): Promise<TypeInfo> => {
    const t = await db.masterValue.findFirst({ where: { id, master: 'incident_type' }, select: { id: true, name: true, extra: true } });
    if (!t) throw badRequest('Choose the kind of incident');
    const x = (t.extra ?? {}) as { positive?: boolean; severity?: string; points?: number };
    return { id: t.id, name: t.name, positive: !!x.positive, severity: (SEVERITIES as readonly string[]).includes(x.severity ?? '') ? (x.severity as Severity) : 'minor', points: Number(x.points ?? 0) };
};

/** What the record form needs. */
export const recordOptions = async (userId: string) => {
    const [types, actions, s, a] = await Promise.all([
        db.masterValue.findMany({ where: { master: 'incident_type', isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, extra: true } }),
        db.masterValue.findMany({ where: { master: 'discipline_action', isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, extra: true } }),
        getSettings({ positives: DISCIPLINE.positives, points: DISCIPLINE.points, alertFrom: DISCIPLINE.alertFrom }),
        getUserAccess(userId),
    ]);
    return {
        types: types.map((t) => ({ id: t.id, name: t.name, ...((t.extra ?? {}) as { positive?: boolean; severity?: string; points?: number }) })).filter((t) => s.positives || !t.positive),
        actions: actions.map((x) => ({ id: x.id, name: x.name, approval: !!(x.extra as { approval?: boolean } | null)?.approval, dates: !!(x.extra as { dates?: boolean } | null)?.dates })),
        points: s.points,
        alertFrom: s.alertFrom,
        can: { record: !!a.permissions['discipline.record'], action: !!a.permissions['discipline.action'], approve: !!a.permissions['discipline.approve'] },
    };
};

/** Students to pick (by name / admission no), within the person's reach. */
export const studentSearch = async (q: string, userId: string) => {
    const t = q.trim();
    if (t.length < 2) return [];
    const { any } = await getSettings({ any: DISCIPLINE.teacherOwnSections });
    const scope = any ? 'all' : await scopeOf(userId, 'discipline.record');
    const year = await currentYear();
    if (!year) return [];
    const rows = await db.enrolment.findMany({ where: { academicYearId: year.id, ...(scope === 'all' ? {} : { sectionId: { in: scope } }), student: { status: 'active', OR: [{ firstName: { startsWith: t, mode: 'insensitive' } }, { lastName: { startsWith: t, mode: 'insensitive' } }, { admissionNo: { contains: t, mode: 'insensitive' } }] } }, take: 15, select: { sectionId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } }, student: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } } } });
    return rows.map((r) => ({ id: r.student.id, name: fullName(r.student), admissionNo: r.student.admissionNo, section: sectionLabel(r.section) }));
};

// ─── Recording ───────────────────────────────────────────────────────────────

export const recordSchema = z.strictObject({
    typeId: z.uuid(),
    severity: z.enum(SEVERITIES).optional(),
    occurredAt: z.iso.datetime({ offset: true }),
    placeId: z.uuid().nullable().optional(),
    title: z.string().trim().max(150).nullable().optional(),
    details: z.string().trim().max(3000).nullable().optional(),
    students: z.array(z.strictObject({ studentId: z.uuid(), role: z.enum(['did', 'affected', 'witness']).default('did') })).min(1, 'add at least one student').max(30),
    attachmentIds: z.array(z.uuid()).max(5).default([]),
    /** The teacher already told the parents by phone. */
    phoned: z.boolean().default(false),
    followUpOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

/** Is this incident shown to (and alerted to) parents, by the settings? */
const forParents = async (positive: boolean, severity: string) => {
    const s = await getSettings({ see: DISCIPLINE.parentsSee, from: DISCIPLINE.alertFrom, pos: DISCIPLINE.positiveAlert });
    const see = s.see !== 'none' && (positive || s.see === 'all' || RANK[severity] >= RANK[s.see]);
    const alert = see && (positive ? s.pos : s.from !== 'never' && RANK[severity] >= RANK[s.from]);
    return { see, alert };
};

export const record = async (input: z.infer<typeof recordSchema>, userId: string) => {
    const year = await currentYear();
    if (!year) throw badRequest('No current academic year');
    const t = await typeInfo(input.typeId);
    const severity: Severity = t.positive ? 'minor' : (input.severity ?? t.severity);
    const { any, points } = await getSettings({ any: DISCIPLINE.teacherOwnSections, points: DISCIPLINE.points });
    const scope = any ? 'all' : await scopeOf(userId, 'discipline.record');
    const enrol = await db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: input.students.map((s) => s.studentId) } }, select: { studentId: true, sectionId: true } });
    for (const s of input.students) if (!inScope(scope, enrol.find((e) => e.studentId === s.studentId)?.sectionId ?? null)) throw forbidden('You can only record for students of the sections you teach');
    const occurred = new Date(input.occurredAt);
    if (occurred.getTime() > Date.now() + 5 * 60_000) throw badRequest('The time is in the future', [{ field: 'occurredAt', message: 'is in the future' }]);
    const p = await forParents(t.positive, severity);
    const inc = await db.incident.create({
        data: {
            tenantId: getTenantId()!,
            academicYearId: year.id,
            typeId: t.id,
            positive: t.positive,
            severity,
            occurredAt: occurred,
            placeId: input.placeId ?? null,
            title: input.title || t.name,
            details: input.details || null,
            attachmentIds: input.attachmentIds,
            followUpOn: input.followUpOn ? dayDate(input.followUpOn) : null,
            status: t.positive ? 'resolved' : 'open',
            resolvedAt: t.positive ? new Date() : null,
            recordedBy: userId,
            students: {
                create: input.students.map((s) => {
                    const told = s.role !== 'witness' && p.alert;
                    return { studentId: s.studentId, sectionId: enrol.find((e) => e.studentId === s.studentId)?.sectionId ?? null, role: t.positive ? 'did' : s.role, points: points && (s.role === 'did' || t.positive) ? t.points : 0, informedHow: told ? 'alert' : input.phoned ? 'phone' : 'none', informedAt: told || input.phoned ? new Date() : null };
                }),
            },
        },
    });
    // Alerts: parents (by severity), class teachers, the principal for serious ones.
    const recorder = (await db.user.findFirst({ where: { id: userId }, select: { displayName: true } }))?.displayName ?? '';
    const told = input.students.filter((s) => s.role !== 'witness').map((s) => s.studentId);
    const vars = { title: inc.title, kind: t.name, severity, recordedBy: recorder, date: occurred.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }) };
    if (p.alert && told.length) raiseLater(t.positive ? 'conduct_praise' : 'conduct_incident', { parent: () => parentsOf(told), student: () => studentsOf(told) }, vars, { dedupe: `incident:${inc.id}` });
    raiseLater('conduct_recorded', { class_teacher: async () => (await classTeachersOf(input.students.map((s) => s.studentId))).filter((r) => r.userId !== userId) }, { ...vars, students: String(input.students.length) }, { dedupe: `incident-ct:${inc.id}` });
    if (severity === 'serious') raiseLater('conduct_serious', { principal: () => holdersOf('discipline.approve') }, { ...vars, students: String(input.students.length) }, { dedupe: `incident-serious:${inc.id}` });
    if (!t.positive) await checkThresholds(input.students.filter((s) => s.role === 'did').map((s) => s.studentId), year.id);
    await recordAudit({ action: t.positive ? 'positive_note' : 'incident_recorded', entity: 'incident', entityId: inc.id, changes: { type: t.name, severity, students: input.students.length } });
    return incidentView(inc.id, userId);
};

/** A student over a threshold (incidents in 30 days, or points this session): class teacher and principal told (once a week at most). */
const checkThresholds = async (studentIds: string[], yearId: string) => {
    const s = await getSettings({ count: DISCIPLINE.thresholdCount, pts: DISCIPLINE.thresholdPoints, on: DISCIPLINE.points });
    for (const id of studentIds) {
        const [recent, sum] = await Promise.all([
            s.count ? db.incidentStudent.count({ where: { studentId: id, role: 'did', incident: { positive: false, occurredAt: { gte: new Date(Date.now() - 30 * DAY) } } } }) : 0,
            s.on && s.pts ? db.incidentStudent.aggregate({ where: { studentId: id, incident: { academicYearId: yearId } }, _sum: { points: true } }) : null,
        ]);
        const points = sum?._sum.points ?? 0;
        const why = s.count && recent >= s.count ? `${recent} incidents in 30 days` : s.on && s.pts && points <= -s.pts ? `${points} conduct points` : null;
        if (!why) continue;
        const st = await db.student.findFirst({ where: { id }, select: { firstName: true, lastName: true } });
        const week = Math.floor(Date.now() / (7 * DAY));
        raiseLater('conduct_threshold', { class_teacher: () => classTeachersOf([id]), principal: () => holdersOf('discipline.approve') }, { student: [st?.firstName, st?.lastName].filter(Boolean).join(' '), why }, { dedupe: `conduct-threshold:${id}:${week}` });
    }
};

// ─── Seeing ──────────────────────────────────────────────────────────────────

const names = async (ids: { actions?: (string | null)[]; types?: (string | null)[]; places?: (string | null)[] }) => {
    const all = [...(ids.actions ?? []), ...(ids.types ?? []), ...(ids.places ?? [])].filter((x): x is string => !!x);
    return new Map((await db.masterValue.findMany({ where: { id: { in: all } }, select: { id: true, name: true } })).map((m) => [m.id, m.name]));
};

export const incidentView = async (id: string, userId: string) => {
    const inc = await db.incident.findFirst({ where: { id }, include: { students: true, actions: { orderBy: { createdAt: 'asc' } } } });
    if (!inc) throw notFound('Incident not found');
    const a = await getUserAccess(userId);
    const scope = await scopeOf(userId, 'discipline.view');
    if (inc.recordedBy !== userId && !inc.students.some((s) => inScope(scope, s.sectionId))) throw forbidden();
    const [students, m, users, sections] = await Promise.all([
        db.student.findMany({ where: { id: { in: inc.students.map((s) => s.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } }),
        names({ actions: inc.actions.map((x) => x.actionId), types: [inc.typeId], places: [inc.placeId] }),
        db.user.findMany({ where: { id: { in: [inc.recordedBy, inc.resolvedBy, ...inc.actions.map((x) => x.decidedBy), ...inc.actions.map((x) => x.approvedBy), ...inc.students.map((s) => s.acknowledgedBy)].filter((x): x is string => !!x) } }, select: { id: true, displayName: true } }),
        db.section.findMany({ where: { id: { in: inc.students.map((s) => s.sectionId!).filter(Boolean) } }, select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } } } }),
    ]);
    const u = (x: string | null) => users.find((y) => y.id === x)?.displayName ?? null;
    const p = await forParents(inc.positive, inc.severity);
    return {
        id: inc.id,
        type: m.get(inc.typeId ?? '') ?? '',
        typeId: inc.typeId,
        positive: inc.positive,
        severity: inc.severity,
        occurredAt: inc.occurredAt,
        place: m.get(inc.placeId ?? '') ?? null,
        title: inc.title,
        details: inc.details,
        attachmentIds: inc.attachmentIds,
        status: inc.status,
        followUpOn: inc.followUpOn ? isoOf(inc.followUpOn) : null,
        recordedBy: u(inc.recordedBy),
        resolvedBy: u(inc.resolvedBy),
        resolvedAt: inc.resolvedAt,
        parentsSee: p.see,
        students: inc.students.map((s) => {
            const st = students.find((x) => x.id === s.studentId);
            const sec = sections.find((x) => x.id === s.sectionId);
            return { id: s.id, studentId: s.studentId, name: st ? fullName(st) : '', admissionNo: st?.admissionNo ?? '', section: sec ? sectionLabel(sec) : '', role: s.role, roleLabel: ROLE[s.role] ?? s.role, points: s.points, informedHow: s.informedHow, informedAt: s.informedAt, acknowledgedAt: s.acknowledgedAt, acknowledgedBy: u(s.acknowledgedBy), parentReply: s.parentReply };
        }),
        actions: inc.actions.map((x) => ({ id: x.id, action: m.get(x.actionId ?? '') ?? '', student: x.studentId ? (students.find((s) => s.id === x.studentId) ? fullName(students.find((s) => s.id === x.studentId)!) : '') : 'All involved', note: x.note, fromDate: x.fromDate ? isoOf(x.fromDate) : null, toDate: x.toDate ? isoOf(x.toDate) : null, status: x.status, decidedBy: u(x.decidedBy), approvedBy: u(x.approvedBy), answer: x.answer, at: x.createdAt })),
        can: { action: !!a.permissions['discipline.action'] && !inc.positive, approve: !!a.permissions['discipline.approve'], resolve: !!a.permissions['discipline.action'] && !inc.positive },
    };
};

export const listQuery = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    section: z.uuid().optional(),
    type: z.uuid().optional(),
    severity: z.enum(SEVERITIES).optional(),
    status: z.enum(['open', 'resolved', 'pending']).optional(),
    kind: z.enum(['incidents', 'positive', 'all']).default('incidents'),
    search: z.string().trim().max(60).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(5).max(100).default(25),
});

export const listIncidents = async (q: z.infer<typeof listQuery>, userId: string) => {
    const scope = await scopeOf(userId, 'discipline.view');
    const year = await currentYear();
    // A chosen section must be in reach; with none chosen, a limited person sees their sections and what they recorded.
    const sectionFilter = q.section ? (scope === 'all' || scope.includes(q.section) ? [q.section] : []) : null;
    const limited = scope !== 'all' && !q.section;
    const searchIds = q.search ? (await db.student.findMany({ where: { OR: [{ firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }, { admissionNo: { contains: q.search, mode: 'insensitive' } }] }, select: { id: true }, take: 300 })).map((s) => s.id) : null;
    const where: Prisma.IncidentWhereInput = {
        academicYearId: year?.id,
        ...(q.kind === 'incidents' ? { positive: false } : q.kind === 'positive' ? { positive: true } : {}),
        ...(q.from || q.to ? { occurredAt: { ...(q.from ? { gte: dayDate(q.from) } : {}), ...(q.to ? { lt: new Date(dayDate(q.to).getTime() + DAY) } : {}) } } : {}),
        ...(q.type ? { typeId: q.type } : {}),
        ...(q.severity ? { severity: q.severity } : {}),
        ...(q.status === 'pending' ? { actions: { some: { status: 'pending' } } } : q.status ? { status: q.status } : {}),
        ...(sectionFilter || searchIds ? { students: { some: { ...(sectionFilter ? { sectionId: { in: sectionFilter } } : {}), ...(searchIds ? { studentId: { in: searchIds } } : {}) } } } : {}),
        ...(limited ? { OR: [{ students: { some: { sectionId: { in: scope as string[] } } } }, { recordedBy: userId }] } : {}),
    };
    const [total, rows] = await Promise.all([db.incident.count({ where }), db.incident.findMany({ where, orderBy: { occurredAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { students: { select: { studentId: true, role: true, acknowledgedAt: true } }, actions: { select: { status: true } } } })]);
    const [students, m] = await Promise.all([db.student.findMany({ where: { id: { in: rows.flatMap((r) => r.students.map((s) => s.studentId)) } }, select: { id: true, firstName: true, lastName: true } }), names({ types: rows.map((r) => r.typeId) })]);
    return {
        total,
        page: q.page,
        pageSize: q.pageSize,
        rows: rows.map((r) => ({ id: r.id, title: r.title, type: m.get(r.typeId ?? '') ?? '', positive: r.positive, severity: r.severity, occurredAt: r.occurredAt, status: r.status, students: r.students.filter((s) => s.role !== 'witness').map((s) => { const st = students.find((x) => x.id === s.studentId); return st ? [st.firstName, st.lastName].filter(Boolean).join(' ') : ''; }), actions: r.actions.length, pending: r.actions.filter((x) => x.status === 'pending').length, acknowledged: r.students.some((s) => s.acknowledgedAt) })),
    };
};

/** A student's conduct: every incident and positive note this session, with points and actions. */
export const studentConduct = async (studentId: string, userId: string) => {
    const year = await currentYear();
    const scope = await scopeOf(userId, 'discipline.view');
    const e = year ? await db.enrolment.findFirst({ where: { academicYearId: year.id, studentId }, select: { sectionId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } }, student: { select: { firstName: true, middleName: true, lastName: true, admissionNo: true } } } }) : null;
    if (!e || !inScope(scope, e.sectionId)) throw forbidden();
    const rows = await db.incidentStudent.findMany({ where: { studentId, incident: { academicYearId: year!.id } }, include: { incident: { include: { actions: true } } }, orderBy: { incident: { occurredAt: 'desc' } } });
    const m = await names({ types: rows.map((r) => r.incident.typeId), actions: rows.flatMap((r) => r.incident.actions.map((a) => a.actionId)) });
    return {
        student: { id: studentId, name: fullName(e.student), admissionNo: e.student.admissionNo, section: sectionLabel(e.section) },
        points: rows.reduce((a, r) => a + r.points, 0),
        incidents: rows.filter((r) => !r.incident.positive && r.role === 'did').length,
        positives: rows.filter((r) => r.incident.positive).length,
        history: rows.map((r) => ({ id: r.incident.id, title: r.incident.title, type: m.get(r.incident.typeId ?? '') ?? '', positive: r.incident.positive, severity: r.incident.severity, role: ROLE[r.role] ?? r.role, points: r.points, occurredAt: r.incident.occurredAt, status: r.incident.status, actions: r.incident.actions.filter((a) => !a.studentId || a.studentId === studentId).map((a) => `${m.get(a.actionId ?? '') ?? ''}${a.status === 'pending' ? ' (waiting for approval)' : a.status === 'rejected' ? ' (refused)' : ''}`) })),
    };
};

// ─── Actions ─────────────────────────────────────────────────────────────────

export const actionSchema = z.strictObject({ studentId: z.uuid().nullable().optional(), actionId: z.uuid(), note: z.string().trim().max(1000).nullable().optional(), fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() });

export const addAction = async (incidentId: string, input: z.infer<typeof actionSchema>, userId: string) => {
    const inc = await db.incident.findFirst({ where: { id: incidentId }, include: { students: true } });
    if (!inc) throw notFound('Incident not found');
    if (inc.positive) throw badRequest('A positive note has no actions');
    const a = await getUserAccess(userId);
    if (!a.permissions['discipline.action']) throw forbidden();
    if (input.studentId && !inc.students.some((s) => s.studentId === input.studentId)) throw badRequest('That student isn’t in this incident');
    const act = await db.masterValue.findFirst({ where: { id: input.actionId, master: 'discipline_action' }, select: { name: true, extra: true } });
    if (!act) throw badRequest('Choose an action');
    const x = (act.extra ?? {}) as { approval?: boolean; dates?: boolean };
    if (x.dates && (!input.fromDate || !input.toDate || input.toDate < input.fromDate)) throw badRequest('Give the dates (from – to)', [{ field: 'fromDate', message: 'is required' }]);
    const pending = !!x.approval && !a.permissions['discipline.approve'];
    const row = await db.incidentAction.create({ data: { tenantId: getTenantId()!, incidentId, studentId: input.studentId ?? null, actionId: input.actionId, note: input.note || null, fromDate: input.fromDate ? dayDate(input.fromDate) : null, toDate: input.toDate ? dayDate(input.toDate) : null, status: pending ? 'pending' : 'done', decidedBy: userId, ...(x.approval && !pending ? { approvedBy: userId, approvedAt: new Date() } : {}) } });
    if (pending) raiseLater('conduct_approval', { principal: () => holdersOf('discipline.approve') }, { action: act.name, title: inc.title, by: (await db.user.findFirst({ where: { id: userId }, select: { displayName: true } }))?.displayName ?? '' }, { dedupe: `conduct-approval:${row.id}` });
    await recordAudit({ action: 'discipline_action', entity: 'incident', entityId: incidentId, changes: { action: act.name, status: row.status } });
    return incidentView(incidentId, userId);
};

export const answerAction = async (actionId: string, approve: boolean, answer: string | null, userId: string) => {
    const x = await db.incidentAction.findFirst({ where: { id: actionId } });
    if (!x) throw notFound('Not found');
    if (x.status !== 'pending') throw badRequest('Already answered');
    await db.incidentAction.update({ where: { id: actionId }, data: { status: approve ? 'done' : 'rejected', approvedBy: userId, approvedAt: new Date(), answer: answer || null } });
    await recordAudit({ action: approve ? 'discipline_action_approved' : 'discipline_action_refused', entity: 'incident', entityId: x.incidentId, changes: { answer } });
    return incidentView(x.incidentId, userId);
};

/** Actions waiting for approval (the principal's list). */
export const pendingActions = async () => {
    const rows = await db.incidentAction.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, include: { incident: { select: { id: true, title: true, severity: true } } } });
    const [m, users, students] = await Promise.all([names({ actions: rows.map((r) => r.actionId) }), db.user.findMany({ where: { id: { in: rows.map((r) => r.decidedBy!).filter(Boolean) } }, select: { id: true, displayName: true } }), db.student.findMany({ where: { id: { in: rows.map((r) => r.studentId!).filter(Boolean) } }, select: { id: true, firstName: true, lastName: true } })]);
    return rows.map((r) => ({ id: r.id, incidentId: r.incident.id, title: r.incident.title, severity: r.incident.severity, action: m.get(r.actionId ?? '') ?? '', student: r.studentId ? [students.find((s) => s.id === r.studentId)?.firstName, students.find((s) => s.id === r.studentId)?.lastName].filter(Boolean).join(' ') : 'All involved', fromDate: r.fromDate ? isoOf(r.fromDate) : null, toDate: r.toDate ? isoOf(r.toDate) : null, note: r.note, by: users.find((u) => u.id === r.decidedBy)?.displayName ?? '', at: r.createdAt }));
};

export const resolveIncident = async (id: string, resolved: boolean, userId: string) => {
    const a = await getUserAccess(userId);
    if (!a.permissions['discipline.action']) throw forbidden();
    await db.incident.update({ where: { id }, data: resolved ? { status: 'resolved', resolvedAt: new Date(), resolvedBy: userId } : { status: 'open', resolvedAt: null, resolvedBy: null } });
    return incidentView(id, userId);
};

export const informedSchema = z.strictObject({ incidentStudentId: z.uuid(), how: z.enum(['phone', 'meeting', 'alert']) });
/** The teacher notes that the parents were told (phone, meeting), or sends the alert now. */
export const markInformed = async (incidentId: string, input: z.infer<typeof informedSchema>, userId: string) => {
    const s = await db.incidentStudent.findFirst({ where: { id: input.incidentStudentId, incidentId }, include: { incident: true } });
    if (!s) throw notFound('Not found');
    const view = await incidentView(incidentId, userId);
    if (input.how === 'alert') {
        const t = await db.masterValue.findFirst({ where: { id: s.incident.typeId ?? '' }, select: { name: true } });
        raiseLater(s.incident.positive ? 'conduct_praise' : 'conduct_incident', { parent: () => parentsOf([s.studentId]), student: () => studentsOf([s.studentId]) }, { title: s.incident.title, kind: t?.name ?? '', severity: s.incident.severity, recordedBy: view.recordedBy ?? '', date: s.incident.occurredAt.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }) }, { dedupe: `incident:${incidentId}:${s.studentId}:manual` });
    }
    await db.incidentStudent.update({ where: { id: s.id }, data: { informedHow: input.how, informedAt: new Date() } });
    return incidentView(incidentId, userId);
};

// ─── Parents and students ────────────────────────────────────────────────────

/** A parent's (or student's) view of each child's conduct: what the settings let them see. */
export const myConduct = async (userId: string) => {
    const year = await currentYear();
    const kids = await db.student.findMany({ where: { status: 'active', OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, select: { id: true, firstName: true, middleName: true, lastName: true } });
    const s = await getSettings({ see: DISCIPLINE.parentsSee, points: DISCIPLINE.points });
    if (!year || s.see === 'none') return { visible: s.see !== 'none', points: s.points, children: kids.map((k) => ({ id: k.id, name: fullName(k), points: 0, items: [] })) };
    const out = [];
    for (const k of kids) {
        const rows = await db.incidentStudent.findMany({ where: { studentId: k.id, role: { in: ['did', 'affected'] }, incident: { academicYearId: year.id } }, include: { incident: { include: { actions: true } } }, orderBy: { incident: { occurredAt: 'desc' } } });
        const visible = [];
        for (const r of rows) if ((await forParents(r.incident.positive, r.incident.severity)).see) visible.push(r);
        const m = await names({ types: visible.map((r) => r.incident.typeId), actions: visible.flatMap((r) => r.incident.actions.map((a) => a.actionId)), places: visible.map((r) => r.incident.placeId) });
        out.push({
            id: k.id,
            name: fullName(k),
            points: rows.reduce((a, r) => a + r.points, 0),
            items: visible.map((r) => ({ id: r.id, incidentId: r.incident.id, title: r.incident.title, type: m.get(r.incident.typeId ?? '') ?? '', positive: r.incident.positive, severity: r.incident.severity, role: ROLE[r.role] ?? r.role, details: r.incident.details, place: m.get(r.incident.placeId ?? '') ?? null, occurredAt: r.incident.occurredAt, points: r.points, actions: r.incident.actions.filter((a) => a.status === 'done' && (!a.studentId || a.studentId === k.id)).map((a) => `${m.get(a.actionId ?? '') ?? ''}${a.fromDate ? ` (${isoOf(a.fromDate)}${a.toDate && a.toDate.getTime() !== a.fromDate.getTime() ? ` – ${isoOf(a.toDate)}` : ''})` : ''}`), acknowledgedAt: r.acknowledgedAt, parentReply: r.parentReply })),
        });
    }
    return { visible: true, points: s.points, children: out };
};

export const ackSchema = z.strictObject({ reply: z.string().trim().max(1000).nullable().optional() });
/** A parent acknowledges an incident (and may reply to the school). */
export const acknowledge = async (incidentStudentId: string, reply: string | null | undefined, userId: string) => {
    const r = await db.incidentStudent.findFirst({ where: { id: incidentStudentId }, include: { incident: { select: { id: true, title: true, recordedBy: true } } } });
    if (!r) throw notFound('Not found');
    const mine = await db.student.findFirst({ where: { id: r.studentId, OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, select: { firstName: true, lastName: true } });
    if (!mine) throw forbidden();
    await db.incidentStudent.update({ where: { id: r.id }, data: { acknowledgedAt: new Date(), acknowledgedBy: userId, parentReply: reply || null } });
    if (reply) raiseLater('conduct_reply', { class_teacher: () => classTeachersOf([r.studentId]) }, { student: [mine.firstName, mine.lastName].filter(Boolean).join(' '), title: r.incident.title, reply }, { dedupe: `conduct-reply:${r.id}` });
    return { acknowledged: true };
};

/** A file of an incident, for those who may see it. */
export const incidentFile = async (id: string, fileId: string, userId: string) => {
    const v = await incidentView(id, userId);
    if (!v.attachmentIds.includes(fileId)) throw forbidden();
    return fileId;
};
