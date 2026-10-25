import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId, runAsSystem, runAsTenant } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { takeNumbers } from '../../core/numbering';
import { logger } from '../../core/logger';
import { getUserAccess } from '../rbac/access.service';
import { currentYear } from '../academic/years.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { todayIST } from '../attendance/attendance.settings';
import { raiseLater } from '../alerts/deliver';
import { holdersOf, usersOf } from '../alerts/recipients';
import { onQueuePass } from '../alerts/queue';
import { defineDailyJob } from '../alerts/jobs';
import { COMPLAINTS } from './complaints.settings';
import { checkCustom, visibleValues } from '../forms/forms.service';

/**
 * Complaints: raised by parents, students, staff (or taken at the office), routed by category to a
 * handler (the student's class teacher, or someone holding a role), answered in a thread (replies
 * the complainant sees, notes they don't), resolved, then accepted or reopened, and rated.
 * Complaints past their reply / resolve time are escalated to those who manage complaints.
 */

const HOUR = 3_600_000;
const OPEN = ['new', 'assigned', 'in_progress', 'reopened'];

interface Rules {
    handler: string;
    responseHours: number;
    resolveHours: number;
    urgent: boolean;
    anonymous: boolean;
}

/** A category's routing and times (Masters → Complaint categories), with the settings' defaults. */
const rulesOf = async (categoryId: string | null): Promise<Rules & { name: string }> => {
    const s = await getSettings({ resp: COMPLAINTS.defaultResponseHours, res: COMPLAINTS.defaultResolveHours });
    const c = categoryId ? await db.masterValue.findFirst({ where: { id: categoryId, master: 'complaint_category' }, select: { name: true, extra: true } }) : null;
    const x = (c?.extra ?? {}) as { handler?: string; response_hours?: number; resolve_hours?: number; urgent?: boolean; anonymous?: boolean };
    return { name: c?.name ?? 'Other', handler: x.handler || 'office-staff', responseHours: Number(x.response_hours) || s.resp, resolveHours: Number(x.resolve_hours) || s.res, urgent: !!x.urgent, anonymous: !!x.anonymous };
};

/** Whom a complaint goes to: the student's class teacher, or the least busy person with that role. */
export const pickHandler = async (handler: string, studentId: string | null) => {
    if (handler === 'class_teacher') {
        if (studentId) {
            const year = await currentYear();
            const e = year ? await db.enrolment.findFirst({ where: { academicYearId: year.id, studentId }, select: { section: { select: { classTeacherId: true } } } }) : null;
            const ct = e?.section.classTeacherId ? await db.staff.findFirst({ where: { id: e.section.classTeacherId, status: 'working', userId: { not: null } }, select: { userId: true } }) : null;
            if (ct?.userId) return ct.userId;
        }
        handler = 'principal';
    }
    const users = await db.user.findMany({ where: { status: 'active', roles: { some: { role: { slug: handler } } } }, select: { id: true } });
    if (!users.length) return null;
    const load = await db.complaint.groupBy({ by: ['assignedTo'], where: { assignedTo: { in: users.map((u) => u.id) }, status: { in: OPEN } }, _count: { _all: true } });
    return users.map((u) => ({ id: u.id, n: load.find((l) => l.assignedTo === u.id)?._count._all ?? 0 })).sort((a, b) => a.n - b.n)[0].id;
};

const userName = async (id: string | null) => (id ? ((await db.user.findFirst({ where: { id }, select: { displayName: true } }))?.displayName ?? '') : '');
const event = (complaintId: string, text: string, userId: string | null, authorName: string) => db.complaintMessage.create({ data: { tenantId: getTenantId()!, complaintId, userId, authorName, kind: 'event', text } });

/** The children a login looks after (or is). */
const myStudents = async (userId: string) => (await db.student.findMany({ where: { status: 'active', OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, select: { id: true, firstName: true, middleName: true, lastName: true } })).map((s) => ({ id: s.id, name: fullName(s) }));

/** What the raise form needs: categories (anonymous allowed?), the person's children. */
export const raiseOptions = async (userId: string) => {
    const [cats, students, access] = await Promise.all([db.masterValue.findMany({ where: { master: 'complaint_category', isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, extra: true } }), myStudents(userId), getUserAccess(userId)]);
    const { files } = await getSettings({ files: COMPLAINTS.maxFiles });
    return {
        categories: cats.map((c) => ({ id: c.id, name: c.name, anonymous: !!(c.extra as { anonymous?: boolean } | null)?.anonymous, urgent: !!(c.extra as { urgent?: boolean } | null)?.urgent })),
        students,
        maxFiles: files,
        office: !!access.permissions['complaint.manage'],
    };
};

// ─── Raising ─────────────────────────────────────────────────────────────────

export const raiseSchema = z.strictObject({
    categoryId: z.uuid(),
    subject: z.string().trim().min(5, 'is too short').max(150),
    details: z.string().trim().min(10, 'please say a little more').max(4000),
    priority: z.enum(['normal', 'high']).default('normal'),
    anonymous: z.boolean().default(false),
    studentId: z.uuid().nullable().optional(),
    staffId: z.uuid().nullable().optional(),
    routeId: z.uuid().nullable().optional(),
    attachmentIds: z.array(z.uuid()).max(10).default([]),
    /** At the office, for someone without a login. */
    contactName: z.string().trim().max(100).nullable().optional(),
    contactMobile: z.string().trim().max(15).nullable().optional(),
    /** Extra fields of the school (Setup → Form Builder). */
    custom: z.record(z.string(), z.unknown()).optional(),
});

export const raise = async (input: z.infer<typeof raiseSchema>, userId: string) => {
    const [access, rules, s] = await Promise.all([getUserAccess(userId), rulesOf(input.categoryId), getSettings({ files: COMPLAINTS.maxFiles, prefix: COMPLAINTS.ticketPrefix })]);
    const office = !!access.permissions['complaint.manage'] && !!input.contactName;
    if (input.attachmentIds.length > s.files) throw badRequest(`At most ${s.files} files`);
    if (input.anonymous && !rules.anonymous) throw badRequest('This kind of complaint can’t be anonymous', [{ field: 'anonymous', message: 'not allowed for this category' }]);
    if (input.studentId && !office && !access.permissions['complaint.manage']) {
        if (!(await myStudents(userId)).some((x) => x.id === input.studentId)) throw forbidden('Choose one of your children');
    }
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    const self = await db.student.findFirst({ where: { userId }, select: { id: true } });
    const raisedAs = office ? 'office' : staff ? 'staff' : self ? 'student' : 'parent';
    const studentId = input.studentId ?? (raisedAs === 'student' ? self!.id : null);
    const now = new Date();
    const year = todayIST().slice(0, 4);
    const ticketNo = `${s.prefix}${year}-${String(await takeNumbers(`complaint:${year}`, 1)).padStart(4, '0')}`;
    const assignedTo = await pickHandler(rules.handler, studentId);
    const customFields = (await checkCustom('complaint', input.custom, null, true, userId)) ?? {};
    const c = await db.complaint.create({
        data: {
            tenantId: getTenantId()!,
            ticketNo,
            categoryId: input.categoryId,
            subject: input.subject,
            details: input.details,
            priority: rules.urgent ? 'urgent' : input.priority,
            anonymous: input.anonymous,
            raisedBy: userId,
            raisedAs,
            contactName: office ? input.contactName : null,
            contactMobile: office ? (input.contactMobile ?? null) : null,
            studentId,
            staffId: input.staffId ?? null,
            routeId: input.routeId ?? null,
            assignedTo,
            assignedAt: assignedTo ? now : null,
            status: assignedTo ? 'assigned' : 'new',
            respondBy: new Date(now.getTime() + rules.responseHours * HOUR),
            resolveBy: new Date(now.getTime() + rules.resolveHours * HOUR),
            attachmentIds: input.attachmentIds,
            customFields: customFields as Prisma.InputJsonValue,
        },
    });
    await event(c.id, `Raised${office ? ` at the office for ${input.contactName}` : ''}${assignedTo ? `; assigned to ${await userName(assignedTo)}` : ''}`, userId, office ? 'Office' : input.anonymous ? 'Anonymous' : await userName(userId));
    const vars = { ticket: c.ticketNo, subject: c.subject, category: rules.name, priority: c.priority, by: input.anonymous ? 'Anonymous' : office ? `${input.contactName} (at the office)` : await userName(userId) };
    if (assignedTo) raiseLater('complaint_new', { handler: () => usersOf([assignedTo]) }, vars, { dedupe: `cmp-new:${c.id}` });
    if (c.priority === 'urgent' || !assignedTo) raiseLater('complaint_urgent', { managers: () => holdersOf('complaint.manage') }, { ...vars, reason: assignedTo ? 'Urgent complaint' : 'No one to assign it to: please assign' }, { dedupe: `cmp-urgent:${c.id}` });
    await recordAudit({ action: 'complaint_raised', entity: 'complaint', entityId: c.id, changes: { ticket: c.ticketNo, category: rules.name, anonymous: input.anonymous } });
    return complaintView(c.id, userId);
};

// ─── Seeing ──────────────────────────────────────────────────────────────────

type Row = Awaited<ReturnType<typeof db.complaint.findFirst>> & {};

/** What a person may do with a complaint. */
const powers = async (c: NonNullable<Row>, userId: string) => {
    const a = await getUserAccess(userId);
    const manage = !!a.permissions['complaint.manage'];
    const handler = c.assignedTo === userId && !!a.permissions['complaint.handle'];
    const raiser = c.raisedBy === userId && c.raisedAs !== 'office';
    return { manage, handler, raiser, staffSide: manage || handler, seesWho: !c.anonymous || raiser || !!a.permissions['complaint.view_anonymous'] };
};

export const complaintView = async (id: string, userId: string) => {
    const c = await db.complaint.findFirst({ where: { id } });
    if (!c) throw notFound('Complaint not found');
    const p = await powers(c, userId);
    if (!p.staffSide && !p.raiser) throw forbidden();
    const [cat, messages, student, staff, route, s] = await Promise.all([
        c.categoryId ? db.masterValue.findFirst({ where: { id: c.categoryId }, select: { name: true } }) : null,
        db.complaintMessage.findMany({ where: { complaintId: id, ...(p.staffSide ? {} : { kind: { not: 'note' } }) }, orderBy: { createdAt: 'asc' } }),
        c.studentId ? db.student.findFirst({ where: { id: c.studentId }, select: { firstName: true, middleName: true, lastName: true, admissionNo: true } }) : null,
        c.staffId ? db.staff.findFirst({ where: { id: c.staffId }, select: { firstName: true, middleName: true, lastName: true } }) : null,
        c.routeId ? db.transportRoute.findFirst({ where: { id: c.routeId }, select: { name: true } }) : null,
        getSettings({ reopen: COMPLAINTS.reopenDays, ratings: COMPLAINTS.ratings }),
    ]);
    const year = await currentYear();
    const sec = c.studentId && year ? await db.enrolment.findFirst({ where: { academicYearId: year.id, studentId: c.studentId }, select: { section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } }) : null;
    const now = Date.now();
    const open = OPEN.includes(c.status);
    const canReopen = p.raiser && c.status === 'resolved' && !!c.resolvedAt && now - c.resolvedAt.getTime() <= s.reopen * 24 * HOUR;
    // The raiser's name is hidden in anonymous messages too.
    const hideName = (m: { userId: string | null; fromRaiser: boolean; authorName: string }) => (c.anonymous && m.fromRaiser && !p.seesWho ? 'Anonymous' : m.authorName);
    return {
        id: c.id,
        custom: await visibleValues('complaint', c.customFields, userId),
        ticketNo: c.ticketNo,
        category: cat?.name ?? '',
        categoryId: c.categoryId,
        subject: c.subject,
        details: c.details,
        priority: c.priority,
        status: c.status,
        anonymous: c.anonymous,
        raisedBy: p.seesWho ? (c.raisedAs === 'office' ? `${c.contactName ?? ''}${c.contactMobile ? ` (${c.contactMobile})` : ''} · at the office` : `${await userName(c.raisedBy)} (${c.raisedAs})`) : 'Anonymous',
        raisedAs: c.raisedAs,
        student: student ? `${fullName(student)}${sec ? ` (${sectionLabel(sec.section)})` : ''}` : null,
        staff: staff ? fullName(staff) : null,
        route: route?.name ?? null,
        assignedTo: c.assignedTo,
        handler: await userName(c.assignedTo),
        createdAt: c.createdAt,
        respondBy: c.respondBy,
        resolveBy: c.resolveBy,
        firstResponseAt: c.firstResponseAt,
        resolvedAt: c.resolvedAt,
        closedAt: c.closedAt,
        resolution: c.resolution,
        escalation: c.escalation,
        reopened: c.reopened,
        rating: c.rating,
        ratingNote: c.ratingNote,
        attachmentIds: c.attachmentIds,
        overdue: open && ((!c.firstResponseAt && !!c.respondBy && c.respondBy.getTime() < now) || (!!c.resolveBy && c.resolveBy.getTime() < now)),
        messages: messages.map((m) => ({ id: m.id, kind: m.kind, text: m.text, author: hideName(m), fromRaiser: m.fromRaiser, attachmentIds: m.attachmentIds, at: m.createdAt })),
        can: {
            reply: (p.staffSide || p.raiser) && c.status !== 'closed',
            note: p.staffSide && c.status !== 'closed',
            assign: p.manage && c.status !== 'closed',
            work: p.staffSide && open,
            close: p.manage && c.status !== 'closed',
            accept: p.raiser && c.status === 'resolved',
            reopen: canReopen,
            rate: p.raiser && s.ratings && ['resolved', 'closed'].includes(c.status) && !c.rating,
        },
    };
};

const listSelect = { id: true, ticketNo: true, subject: true, categoryId: true, priority: true, status: true, anonymous: true, raisedBy: true, raisedAs: true, contactName: true, assignedTo: true, createdAt: true, updatedAt: true, respondBy: true, resolveBy: true, firstResponseAt: true, escalation: true, rating: true, studentId: true } as const;

const toRows = async (rows: Prisma.ComplaintGetPayload<{ select: typeof listSelect }>[], userId: string) => {
    const a = await getUserAccess(userId);
    const [cats, users, students] = await Promise.all([
        db.masterValue.findMany({ where: { id: { in: rows.map((r) => r.categoryId!).filter(Boolean) } }, select: { id: true, name: true } }),
        db.user.findMany({ where: { id: { in: [...rows.map((r) => r.assignedTo!), ...rows.map((r) => r.raisedBy!)].filter(Boolean) } }, select: { id: true, displayName: true } }),
        db.student.findMany({ where: { id: { in: rows.map((r) => r.studentId!).filter(Boolean) } }, select: { id: true, firstName: true, lastName: true } }),
    ]);
    const now = Date.now();
    const name = (id: string | null) => users.find((u) => u.id === id)?.displayName ?? '';
    return rows.map((r) => {
        const st = students.find((s) => s.id === r.studentId);
        const open = OPEN.includes(r.status);
        return {
            id: r.id,
            ticketNo: r.ticketNo,
            subject: r.subject,
            category: cats.find((c) => c.id === r.categoryId)?.name ?? '',
            priority: r.priority,
            status: r.status,
            raisedBy: r.anonymous && r.raisedBy !== userId && !a.permissions['complaint.view_anonymous'] ? 'Anonymous' : r.raisedAs === 'office' ? `${r.contactName ?? ''} (office)` : name(r.raisedBy),
            student: st ? [st.firstName, st.lastName].filter(Boolean).join(' ') : null,
            handler: name(r.assignedTo),
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            escalation: r.escalation,
            rating: r.rating,
            overdue: open && ((!r.firstResponseAt && !!r.respondBy && r.respondBy.getTime() < now) || (!!r.resolveBy && r.resolveBy.getTime() < now)),
        };
    });
};

/** A person's own complaints (raised by them). */
export const myComplaints = async (userId: string) => toRows(await db.complaint.findMany({ where: { raisedBy: userId, raisedAs: { not: 'office' } }, orderBy: { updatedAt: 'desc' }, take: 100, select: listSelect }), userId);

export const deskQuery = z.object({
    show: z.enum(['open', 'resolved', 'closed', 'all']).default('open'),
    mine: z.enum(['1']).optional(),
    overdue: z.enum(['1']).optional(),
    category: z.uuid().optional(),
    priority: z.enum(['normal', 'high', 'urgent']).optional(),
    search: z.string().trim().max(60).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(5).max(100).default(25),
});

/** The desk: everything (those who manage) or what is assigned to me (handlers). */
export const desk = async (q: z.infer<typeof deskQuery>, userId: string) => {
    const a = await getUserAccess(userId);
    const manage = !!a.permissions['complaint.manage'];
    const now = new Date();
    const where: Prisma.ComplaintWhereInput = {
        ...(manage && !q.mine ? {} : { assignedTo: userId }),
        ...(q.show === 'open' ? { status: { in: OPEN } } : q.show === 'resolved' ? { status: 'resolved' } : q.show === 'closed' ? { status: 'closed' } : {}),
        ...(q.category ? { categoryId: q.category } : {}),
        ...(q.priority ? { priority: q.priority } : {}),
        ...(q.overdue ? { status: { in: OPEN }, OR: [{ firstResponseAt: null, respondBy: { lt: now } }, { resolveBy: { lt: now } }] } : {}),
        ...(q.search ? { AND: [{ OR: [{ ticketNo: { contains: q.search, mode: 'insensitive' } }, { subject: { contains: q.search, mode: 'insensitive' } }, { details: { contains: q.search, mode: 'insensitive' } }] }] } : {}),
    };
    const [total, rows, counts] = await Promise.all([
        db.complaint.count({ where }),
        db.complaint.findMany({ where, orderBy: [{ updatedAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: listSelect }),
        db.complaint.groupBy({ by: ['status'], where: manage && !q.mine ? {} : { assignedTo: userId }, _count: { _all: true } }),
    ]);
    const overdue = await db.complaint.count({ where: { ...(manage && !q.mine ? {} : { assignedTo: userId }), status: { in: OPEN }, OR: [{ firstResponseAt: null, respondBy: { lt: now } }, { resolveBy: { lt: now } }] } });
    const n = (st: string[]) => counts.filter((c) => st.includes(c.status)).reduce((x, c) => x + c._count._all, 0);
    return { total, page: q.page, pageSize: q.pageSize, manage, counts: { open: n(OPEN), resolved: n(['resolved']), closed: n(['closed']), overdue }, rows: await toRows(rows, userId) };
};

/** People a complaint can be assigned to (holding complaint.handle or .manage). */
export const handlers = async () => {
    // One query: staff whose roles can handle or manage complaints (Super Admin can do everything).
    const users = await db.user.findMany({
        where: { status: 'active', kind: 'staff', roles: { some: { role: { deletedAt: null, OR: [{ isSystem: true }, { permissions: { some: { permissionKey: { in: ['complaint.handle', 'complaint.manage'] } } } }] } } } },
        select: { id: true, displayName: true },
    });
    return users.map((u) => ({ id: u.id, name: u.displayName })).sort((a, b) => a.name.localeCompare(b.name));
};

// ─── Working on it ───────────────────────────────────────────────────────────

const load = async (id: string, userId: string) => {
    const c = await db.complaint.findFirst({ where: { id } });
    if (!c) throw notFound('Complaint not found');
    return { c, p: await powers(c, userId) };
};
const tellRaiser = (c: { id: string; raisedBy: string | null; raisedAs: string; ticketNo: string; subject: string }, key: string, vars: Record<string, string>) => {
    if (c.raisedBy && c.raisedAs !== 'office') raiseLater(key, { raiser: () => usersOf([c.raisedBy!]) }, { ticket: c.ticketNo, subject: c.subject, ...vars }, { dedupe: `${key}:${c.id}:${Date.now()}` });
};

export const messageSchema = z.strictObject({ text: z.string().trim().min(1, 'is required').max(4000), attachmentIds: z.array(z.uuid()).max(10).default([]) });

export const reply = async (id: string, input: z.infer<typeof messageSchema>, userId: string) => {
    const { c, p } = await load(id, userId);
    if (c.status === 'closed') throw badRequest('This complaint is closed');
    if (!p.staffSide && !p.raiser) throw forbidden();
    const fromRaiser = p.raiser && !p.staffSide;
    await db.complaintMessage.create({ data: { tenantId: getTenantId()!, complaintId: id, userId, authorName: fromRaiser && c.anonymous ? 'Anonymous' : await userName(userId), kind: 'reply', fromRaiser, text: input.text, attachmentIds: input.attachmentIds } });
    const data: Prisma.ComplaintUpdateInput = {};
    if (!fromRaiser && !c.firstResponseAt) data.firstResponseAt = new Date();
    if (!fromRaiser && ['new', 'assigned', 'reopened'].includes(c.status)) data.status = 'in_progress';
    await db.complaint.update({ where: { id }, data: { ...data, updatedAt: new Date() } });
    if (fromRaiser) {
        if (c.assignedTo) raiseLater('complaint_reply', { other: () => usersOf([c.assignedTo!]) }, { ticket: c.ticketNo, subject: c.subject, by: c.anonymous ? 'The complainant' : await userName(userId), text: input.text.slice(0, 300) }, { dedupe: `cmp-reply:${id}:${Date.now()}` });
    } else tellRaiser(c, 'complaint_reply', { by: 'The school', text: input.text.slice(0, 300) });
    return complaintView(id, userId);
};

export const note = async (id: string, input: z.infer<typeof messageSchema>, userId: string) => {
    const { c, p } = await load(id, userId);
    if (!p.staffSide) throw forbidden();
    if (c.status === 'closed') throw badRequest('This complaint is closed');
    await db.complaintMessage.create({ data: { tenantId: getTenantId()!, complaintId: id, userId, authorName: await userName(userId), kind: 'note', text: input.text, attachmentIds: input.attachmentIds } });
    return complaintView(id, userId);
};

export const assign = async (id: string, to: string, userId: string) => {
    const { c, p } = await load(id, userId);
    if (!p.manage) throw forbidden();
    if (c.status === 'closed') throw badRequest('This complaint is closed');
    if (!(await handlers()).some((h) => h.id === to)) throw badRequest('This person can’t handle complaints (Roles & Permissions → complaint.handle)');
    await db.complaint.update({ where: { id }, data: { assignedTo: to, assignedAt: new Date(), status: ['new', 'assigned'].includes(c.status) ? 'assigned' : c.status } });
    await event(id, `Assigned to ${await userName(to)}`, userId, await userName(userId));
    const cat = await rulesOf(c.categoryId);
    raiseLater('complaint_new', { handler: () => usersOf([to]) }, { ticket: c.ticketNo, subject: c.subject, category: cat.name, priority: c.priority, by: c.anonymous ? 'Anonymous' : await userName(c.raisedBy) }, { dedupe: `cmp-assign:${id}:${to}` });
    await recordAudit({ action: 'complaint_assigned', entity: 'complaint', entityId: id, changes: { to } });
    return complaintView(id, userId);
};

export const resolveSchema = z.strictObject({ resolution: z.string().trim().min(5, 'say what was done').max(2000) });
export const resolve = async (id: string, resolution: string, userId: string) => {
    const { c, p } = await load(id, userId);
    if (!p.staffSide) throw forbidden();
    if (!OPEN.includes(c.status)) throw badRequest('Only an open complaint can be resolved');
    await db.complaint.update({ where: { id }, data: { status: 'resolved', resolvedAt: new Date(), resolution, firstResponseAt: c.firstResponseAt ?? new Date() } });
    await db.complaintMessage.create({ data: { tenantId: getTenantId()!, complaintId: id, userId, authorName: await userName(userId), kind: 'event', text: `Resolved: ${resolution}` } });
    const { days } = await getSettings({ days: COMPLAINTS.reopenDays });
    tellRaiser(c, 'complaint_resolved', { resolution, days: String(days) });
    await recordAudit({ action: 'complaint_resolved', entity: 'complaint', entityId: id, changes: {} });
    return complaintView(id, userId);
};

export const acceptSchema = z.strictObject({ rating: z.number().int().min(1).max(5).nullable().optional(), note: z.string().trim().max(500).nullable().optional() });
/** The complainant is satisfied: it closes (with their rating, if given). */
export const accept = async (id: string, input: z.infer<typeof acceptSchema>, userId: string) => {
    const { c, p } = await load(id, userId);
    if (!p.raiser) throw forbidden();
    if (c.status !== 'resolved') throw badRequest('Only a resolved complaint can be accepted');
    await db.complaint.update({ where: { id }, data: { status: 'closed', closedAt: new Date(), ...(input.rating ? { rating: input.rating, ratingNote: input.note || null } : {}) } });
    await event(id, `Accepted and closed by the complainant${input.rating ? ` · rated ${input.rating}/5` : ''}`, userId, c.anonymous ? 'Anonymous' : await userName(userId));
    return complaintView(id, userId);
};

export const rate = async (id: string, input: z.infer<typeof acceptSchema>, userId: string) => {
    const { c, p } = await load(id, userId);
    if (!p.raiser || !input.rating) throw forbidden();
    if (c.rating) throw badRequest('Already rated');
    await db.complaint.update({ where: { id }, data: { rating: input.rating, ratingNote: input.note || null } });
    return complaintView(id, userId);
};

export const reopenSchema = z.strictObject({ reason: z.string().trim().min(5, 'say what is still wrong').max(1000) });
export const reopen = async (id: string, reason: string, userId: string) => {
    const { c, p } = await load(id, userId);
    const s = await getSettings({ days: COMPLAINTS.reopenDays });
    if (!p.raiser) throw forbidden();
    if (c.status !== 'resolved' || !c.resolvedAt || Date.now() - c.resolvedAt.getTime() > s.days * 24 * HOUR) throw badRequest('This complaint can’t be reopened now; raise a new one');
    const rules = await rulesOf(c.categoryId);
    await db.complaint.update({ where: { id }, data: { status: 'reopened', reopened: c.reopened + 1, resolvedAt: null, resolveBy: new Date(Date.now() + rules.resolveHours * HOUR), escalation: 0, escalatedAt: null } });
    await db.complaintMessage.create({ data: { tenantId: getTenantId()!, complaintId: id, userId, authorName: c.anonymous ? 'Anonymous' : await userName(userId), kind: 'reply', fromRaiser: true, text: `Reopened: ${reason}` } });
    if (c.assignedTo) raiseLater('complaint_reply', { other: () => usersOf([c.assignedTo!]) }, { ticket: c.ticketNo, subject: c.subject, by: 'The complainant reopened it', text: reason }, { dedupe: `cmp-reopen:${id}:${c.reopened + 1}` });
    return complaintView(id, userId);
};

export const closeSchema = z.strictObject({ note: z.string().trim().max(1000).nullable().optional() });
export const close = async (id: string, noteText: string | null | undefined, userId: string) => {
    const { c, p } = await load(id, userId);
    if (!p.manage) throw forbidden();
    if (c.status === 'closed') throw badRequest('Already closed');
    await db.complaint.update({ where: { id }, data: { status: 'closed', closedAt: new Date(), resolution: c.resolution ?? noteText ?? null } });
    await event(id, `Closed${noteText ? `: ${noteText}` : ''}`, userId, await userName(userId));
    return complaintView(id, userId);
};

/** A file attached to a complaint (or its messages), for those who may see the complaint. */
export const attachment = async (id: string, fileId: string, userId: string) => {
    const v = await complaintView(id, userId);
    const ok = v.attachmentIds.includes(fileId) || v.messages.some((m) => m.attachmentIds.includes(fileId));
    if (!ok) throw forbidden();
    return fileId;
};

// ─── Escalation and closing ──────────────────────────────────────────────────

/** Open complaints past their times: escalated to those who manage complaints (again after N hours). */
const escalateSchool = async () => {
    const { again } = await getSettings({ again: COMPLAINTS.escalateAfterHours });
    const now = new Date();
    const due = await db.complaint.findMany({
        where: {
            status: { in: OPEN },
            OR: [
                { escalation: 0, firstResponseAt: null, respondBy: { lt: now } },
                { escalation: 0, resolveBy: { lt: now } },
                { escalation: { gt: 0 }, escalatedAt: { lt: new Date(now.getTime() - again * HOUR) } },
            ],
        },
        take: 50,
    });
    for (const c of due) {
        const level = c.escalation + 1;
        await db.complaint.update({ where: { id: c.id }, data: { escalation: level, escalatedAt: now } });
        const why = !c.firstResponseAt ? 'not answered in time' : 'not resolved in time';
        await event(c.id, `Escalated (level ${level}): ${why}`, null, 'System');
        raiseLater('complaint_escalated', { managers: () => holdersOf('complaint.manage'), handler: () => (c.assignedTo ? usersOf([c.assignedTo]) : Promise.resolve([])) }, { ticket: c.ticketNo, subject: c.subject, why, level: String(level), handler: (await userName(c.assignedTo)) || 'no one' }, { dedupe: `cmp-esc:${c.id}:${level}` });
    }
};

let lastPass = 0;
onQueuePass(async () => {
    if (Date.now() - lastPass < 10 * 60_000) return;
    lastPass = Date.now();
    const tenants = await runAsSystem(() => db.complaint.findMany({ where: { status: { in: OPEN } }, select: { tenantId: true }, distinct: ['tenantId'] }));
    for (const t of tenants) await runAsTenant(t.tenantId, () => escalateSchool().catch((err) => logger.warn('Complaint escalation', { error: (err as Error).message })));
});

defineDailyJob({
    key: 'complaints_auto_close',
    at: async () => '01:30',
    run: async () => {
        const { days } = await getSettings({ days: COMPLAINTS.autoCloseDays });
        if (!days) return 'off';
        const old = await db.complaint.findMany({ where: { status: 'resolved', resolvedAt: { lt: new Date(Date.now() - days * 24 * HOUR) } }, select: { id: true } });
        for (const c of old) {
            await db.complaint.update({ where: { id: c.id }, data: { status: 'closed', closedAt: new Date() } });
            await event(c.id, `Closed by the system (resolved more than ${days} days ago)`, null, 'System');
        }
        return `${old.length} closed`;
    },
});
