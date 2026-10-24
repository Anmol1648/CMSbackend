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
import { dayDate, todayIST } from '../attendance/attendance.settings';
import { raiseLater } from '../alerts/deliver';
import { classTeachersOf, holdersOf, parentsOf } from '../alerts/recipients';
import { VISITORS } from './visitors.settings';

/**
 * Who may collect a student: the parents and guardians of the family record, and the people on the
 * student's pickup list (with photos, added by the office or the parents). An early pickup at the
 * gate is checked against them, logged, and the parents and class teacher are told; someone not on
 * the list needs the office's OK.
 */

const clock = (d: Date) => d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });

/** The children a login looks after (parent) or is (student). */
export const myChildren = async (userId: string) => (await db.student.findMany({ where: { status: 'active', OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, select: { id: true, firstName: true, middleName: true, lastName: true } })).map((s) => ({ id: s.id, name: fullName(s) }));

const mayEdit = async (studentId: string, userId: string) => {
    const a = await getUserAccess(userId);
    if (a.permissions['visitor.manage']) return true;
    if (!a.permissions['visitor.pickup_mine']) return false;
    const { add } = await getSettings({ add: VISITORS.parentsAddPickup });
    return add && (await myChildren(userId)).some((c) => c.id === studentId);
};

/** A student's pickup list: the family's parents / guardians, then the added people. */
export const pickupList = async (studentId: string) => {
    const s = await db.student.findFirst({ where: { id: studentId }, select: { id: true, familyId: true } });
    if (!s) throw notFound('Student not found');
    const [guardians, people] = await Promise.all([
        s.familyId ? db.guardian.findMany({ where: { familyId: s.familyId }, orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }], select: { id: true, name: true, mobile: true, relation: { select: { name: true } } } }) : [],
        db.pickupPerson.findMany({ where: { studentId, isActive: true }, orderBy: { createdAt: 'asc' } }),
    ]);
    const relations = new Map((await db.masterValue.findMany({ where: { id: { in: people.map((p) => p.relationId!).filter(Boolean) } }, select: { id: true, name: true } })).map((r) => [r.id, r.name]));
    return {
        guardians: guardians.map((g) => ({ id: g.id, name: g.name, relation: g.relation?.name ?? 'Guardian', mobile: g.mobile })),
        people: people.map((p) => ({ id: p.id, name: p.name, relationId: p.relationId, relation: relations.get(p.relationId ?? '') ?? 'Other', mobile: p.mobile, photoFileId: p.photoFileId, note: p.note })),
    };
};

export const personSchema = z.strictObject({ name: z.string().trim().min(2, 'is required').max(100), relationId: z.uuid().nullable().optional(), mobile: z.string().trim().regex(/^[0-9+\- ]{7,15}$/, 'is not a phone number'), photoFileId: z.uuid().nullable().optional(), note: z.string().trim().max(200).nullable().optional() });

export const addPerson = async (studentId: string, input: z.infer<typeof personSchema>, userId: string) => {
    if (!(await mayEdit(studentId, userId))) throw forbidden();
    if ((await db.pickupPerson.count({ where: { studentId, isActive: true } })) >= 8) throw badRequest('At most 8 people on the list');
    const p = await db.pickupPerson.create({ data: { tenantId: getTenantId()!, studentId, name: input.name, relationId: input.relationId ?? null, mobile: input.mobile.replace(/[^0-9+]/g, ''), photoFileId: input.photoFileId ?? null, note: input.note || null, addedBy: userId } });
    await recordAudit({ action: 'pickup_person_added', entity: 'student', entityId: studentId, changes: { name: p.name } });
    return pickupList(studentId);
};

export const updatePerson = async (id: string, input: z.infer<typeof personSchema>, userId: string) => {
    const p = await db.pickupPerson.findFirst({ where: { id } });
    if (!p) throw notFound('Not found');
    if (!(await mayEdit(p.studentId, userId))) throw forbidden();
    await db.pickupPerson.update({ where: { id }, data: { name: input.name, relationId: input.relationId ?? null, mobile: input.mobile.replace(/[^0-9+]/g, ''), ...(input.photoFileId !== undefined ? { photoFileId: input.photoFileId } : {}), note: input.note || null } });
    return pickupList(p.studentId);
};

export const removePerson = async (id: string, userId: string) => {
    const p = await db.pickupPerson.findFirst({ where: { id } });
    if (!p) throw notFound('Not found');
    if (!(await mayEdit(p.studentId, userId))) throw forbidden();
    await db.pickupPerson.update({ where: { id }, data: { isActive: false } });
    await recordAudit({ action: 'pickup_person_removed', entity: 'student', entityId: p.studentId, changes: { name: p.name } });
    return pickupList(p.studentId);
};

/** A parent's page: each child's list (and whether they may add to it). */
export const myPickup = async (userId: string) => {
    const children = await myChildren(userId);
    const { add } = await getSettings({ add: VISITORS.parentsAddPickup });
    const out = [];
    for (const c of children) {
        const pickups = await db.studentPickup.findMany({ where: { studentId: c.id }, orderBy: { at: 'desc' }, take: 10 });
        out.push({ student: c, ...(await pickupList(c.id)), recent: pickups.map((p) => ({ id: p.id, at: p.at, name: p.name, relation: p.relation, reason: p.reason, status: p.status })) });
    }
    return { canAdd: add, children: out };
};

/** Mine to see: a pickup person's photo (the office, the gate, or the student's parent). */
export const personPhoto = async (id: string, userId: string) => {
    const p = await db.pickupPerson.findFirst({ where: { id }, select: { studentId: true, photoFileId: true } });
    if (!p?.photoFileId) return null;
    const a = await getUserAccess(userId);
    if (a.permissions['visitor.gate'] || a.permissions['visitor.manage'] || a.permissions['visitor.view']) return p.photoFileId;
    return (await myChildren(userId)).some((c) => c.id === p.studentId) ? p.photoFileId : null;
};

// ─── At the gate ─────────────────────────────────────────────────────────────

/** A student at the gate: who they are, who may collect them, and today's pickups. */
export const gateStudent = async (studentId: string) => {
    const year = await currentYear();
    const s = await db.student.findFirst({ where: { id: studentId }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, photoFileId: true, status: true } });
    if (!s) throw notFound('Student not found');
    const e = year ? await db.enrolment.findFirst({ where: { academicYearId: year.id, studentId }, select: { section: { select: { name: true, classTeacherId: true, schoolClass: { select: { name: true, shortName: true } } } } } }) : null;
    const ct = e?.section.classTeacherId ? await db.staff.findFirst({ where: { id: e.section.classTeacherId }, select: { firstName: true, lastName: true, mobile: true } }) : null;
    const today = await db.studentPickup.findMany({ where: { studentId, at: { gte: dayDate(todayIST()) } }, orderBy: { at: 'desc' } });
    return {
        student: { id: s.id, name: fullName(s), admissionNo: s.admissionNo, hasPhoto: !!s.photoFileId, section: e ? sectionLabel(e.section) : '', classTeacher: ct ? { name: [ct.firstName, ct.lastName].filter(Boolean).join(' '), mobile: ct.mobile } : null, active: s.status === 'active' },
        ...(await pickupList(studentId)),
        today: today.map((p) => ({ id: p.id, at: p.at, name: p.name, relation: p.relation, status: p.status })),
    };
};

export const pickupSchema = z.strictObject({
    studentId: z.uuid(),
    byKind: z.enum(['guardian', 'person', 'other']),
    guardianId: z.uuid().nullable().optional(),
    personId: z.uuid().nullable().optional(),
    /** Someone not on the list. */
    name: z.string().trim().max(100).nullable().optional(),
    relation: z.string().trim().max(60).nullable().optional(),
    mobile: z.string().trim().max(15).nullable().optional(),
    photoFileId: z.uuid().nullable().optional(),
    reason: z.string().trim().min(2, 'is required').max(200),
});

const tellPickup = async (p: { id: string; studentId: string; name: string; relation: string | null; at: Date; reason: string | null }) => {
    const { alert } = await getSettings({ alert: VISITORS.pickupAlert });
    const st = await db.student.findFirst({ where: { id: p.studentId }, select: { firstName: true, lastName: true } });
    const vars = { student: [st?.firstName, st?.lastName].filter(Boolean).join(' '), by: `${p.name}${p.relation ? ` (${p.relation})` : ''}`, time: clock(p.at), reason: p.reason ?? '' };
    raiseLater('pickup_done', { ...(alert ? { parent: () => parentsOf([p.studentId]) } : {}), class_teacher: () => classTeachersOf([p.studentId]) }, vars, { dedupe: `pickup:${p.id}` });
};

/** Hands a student over (early pickup). Someone not on the list waits for the office’s OK (if set). */
export const recordPickup = async (input: z.infer<typeof pickupSchema>, userId: string) => {
    const list = await pickupList(input.studentId);
    let name = '';
    let relation: string | null = null;
    let mobile: string | null = null;
    let photo: string | null = input.photoFileId ?? null;
    if (input.byKind === 'guardian') {
        const g = list.guardians.find((x) => x.id === input.guardianId);
        if (!g) throw badRequest('Choose a parent / guardian of this student');
        [name, relation, mobile] = [g.name, g.relation, g.mobile];
    } else if (input.byKind === 'person') {
        const p = list.people.find((x) => x.id === input.personId);
        if (!p) throw badRequest('Choose someone on the pickup list');
        [name, relation, mobile, photo] = [p.name, p.relation, p.mobile, photo ?? p.photoFileId];
    } else {
        if (!input.name || !input.mobile) throw badRequest('Note the name and mobile of the person collecting', [{ field: 'name', message: 'is required' }]);
        [name, relation, mobile] = [input.name, input.relation || null, input.mobile];
    }
    const { approval } = await getSettings({ approval: VISITORS.unknownNeedsApproval });
    const waiting = input.byKind === 'other' && approval;
    const p = await db.studentPickup.create({ data: { tenantId: getTenantId()!, studentId: input.studentId, byKind: input.byKind, guardianId: input.guardianId ?? null, personId: input.personId ?? null, name, relation, mobile, photoFileId: photo, reason: input.reason, status: waiting ? 'waiting' : 'done', createdBy: userId } });
    if (waiting) {
        const st = await db.student.findFirst({ where: { id: input.studentId }, select: { firstName: true, lastName: true } });
        raiseLater('pickup_unknown', { office: () => holdersOf('visitor.manage') }, { student: [st?.firstName, st?.lastName].filter(Boolean).join(' '), by: `${name}${relation ? ` (${relation})` : ''}, ${mobile}`, reason: input.reason, time: clock(p.at) }, { dedupe: `pickup-unknown:${p.id}` });
    } else await tellPickup(p);
    await recordAudit({ action: waiting ? 'pickup_waiting' : 'pickup_done', entity: 'student', entityId: input.studentId, changes: { by: name, relation, reason: input.reason } });
    return { id: p.id, status: p.status };
};

/** The office lets someone not on the list collect the student, or not. */
export const answerPickup = async (id: string, allow: boolean, userId: string) => {
    const p = await db.studentPickup.findFirst({ where: { id } });
    if (!p) throw notFound('Not found');
    if (p.status !== 'waiting') throw badRequest('Already answered');
    const done = await db.studentPickup.update({ where: { id }, data: { status: allow ? 'done' : 'refused', approvedBy: userId, approvedAt: new Date() } });
    if (allow) await tellPickup(done);
    await recordAudit({ action: allow ? 'pickup_allowed' : 'pickup_refused', entity: 'student', entityId: p.studentId, changes: { by: p.name } });
    return { id, status: done.status };
};

/** Early pickups of today (the gate) and the ones waiting for the office. */
export const pickupsToday = async () => {
    const rows = await db.studentPickup.findMany({ where: { OR: [{ at: { gte: dayDate(todayIST()) } }, { status: 'waiting' }] }, orderBy: { at: 'desc' } });
    const students = await db.student.findMany({ where: { id: { in: rows.map((r) => r.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } });
    return rows.map((r) => ({ id: r.id, student: fullName(students.find((s) => s.id === r.studentId) ?? { firstName: '' }), studentId: r.studentId, name: r.name, relation: r.relation, mobile: r.mobile, reason: r.reason, byKind: r.byKind, status: r.status, at: r.at, photoFileId: r.photoFileId }));
};

export const studentPhoto = async (studentId: string) => (await db.student.findFirst({ where: { id: studentId }, select: { photoFileId: true } }))?.photoFileId ?? null;
export const pickupPhoto = async (id: string) => (await db.studentPickup.findFirst({ where: { id }, select: { photoFileId: true } }))?.photoFileId ?? null;
