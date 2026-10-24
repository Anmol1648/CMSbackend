import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { takeNumbers } from '../../core/numbering';
import { getUserAccess } from '../rbac/access.service';
import { currentYear } from '../academic/years.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { raiseLater } from '../alerts/deliver';
import { staffOf } from '../alerts/recipients';
import { VISITORS } from './visitors.settings';

/**
 * The gate: visitors come in (found again by their mobile number), get a pass, meet a staff member,
 * the office or come about a student, and go out. A visitor meeting a staff member can wait for
 * their OK (System Settings → Visitors). Staff can tell the gate who they expect.
 */

const MOBILE = z.string().trim().regex(/^[0-9+\- ]{7,15}$/, 'is not a phone number');
const staffName = (s: { firstName: string; middleName?: string | null; lastName?: string | null }) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');
const clock = (d: Date | null) => (d ? d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }) : '');
const cleanMobile = (m: string | null | undefined) => (m ? m.replace(/[^0-9+]/g, '') : null);

/** A visitor by mobile number (to fill the form again), with their last visits. */
export const lookup = async (mobile: string) => {
    const m = cleanMobile(mobile);
    if (!m || m.length < 7) return null;
    const v = await db.visitor.findFirst({ where: { mobile: m }, orderBy: { lastVisitAt: 'desc' } });
    if (!v) return null;
    const visits = await db.visit.findMany({ where: { visitorId: v.id, status: { in: ['in', 'out'] } }, orderBy: { inAt: 'desc' }, take: 5, select: { day: true, purposeId: true, hostKind: true, staffId: true } });
    const [purposes, staff] = await Promise.all([db.masterValue.findMany({ where: { id: { in: visits.map((x) => x.purposeId!).filter(Boolean) } }, select: { id: true, name: true } }), db.staff.findMany({ where: { id: { in: visits.map((x) => x.staffId!).filter(Boolean) } }, select: { id: true, firstName: true, middleName: true, lastName: true } })]);
    return { id: v.id, name: v.name, mobile: v.mobile, photoFileId: v.photoFileId, idTypeId: v.idTypeId, idNumber: v.idNumber, address: v.address, blacklisted: v.blacklisted, blacklistReason: v.blacklistReason, visits: visits.map((x) => ({ day: isoOf(x.day), purpose: purposes.find((p) => p.id === x.purposeId)?.name ?? null, met: x.staffId ? staffName(staff.find((s) => s.id === x.staffId) ?? { firstName: '' }) : x.hostKind === 'office' ? 'Office' : 'About a student' })) };
};

/** Whom a visitor can meet: working staff, or students (for a parent / relative). */
export const hostSearch = async (kind: 'staff' | 'student', q: string) => {
    const t = q.trim();
    if (t.length < 2) return [];
    if (kind === 'staff') {
        const rows = await db.staff.findMany({ where: { status: 'working', OR: [{ firstName: { startsWith: t, mode: 'insensitive' } }, { lastName: { startsWith: t, mode: 'insensitive' } }, { employeeCode: { equals: t, mode: 'insensitive' } }] }, take: 12, select: { id: true, firstName: true, middleName: true, lastName: true, designationId: true } });
        const des = new Map((await db.masterValue.findMany({ where: { id: { in: rows.map((r) => r.designationId!).filter(Boolean) } }, select: { id: true, name: true } })).map((d) => [d.id, d.name]));
        return rows.map((r) => ({ id: r.id, label: staffName(r), detail: des.get(r.designationId ?? '') ?? 'Staff' }));
    }
    const year = await currentYear();
    const rows = await db.enrolment.findMany({ where: { academicYearId: year?.id, student: { status: 'active', OR: [{ firstName: { startsWith: t, mode: 'insensitive' } }, { lastName: { startsWith: t, mode: 'insensitive' } }, { admissionNo: { contains: t, mode: 'insensitive' } }] } }, take: 12, select: { section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } }, student: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } } } });
    return rows.map((r) => ({ id: r.student.id, label: fullName(r.student), detail: `${sectionLabel(r.section)} · ${r.student.admissionNo}` }));
};

const newPassNo = async () => {
    const { prefix } = await getSettings({ prefix: VISITORS.passPrefix });
    const d = todayIST().replace(/-/g, '').slice(2);
    const n = await takeNumbers(`visit:${d}`, 1);
    return `${prefix}${d}-${String(n).padStart(3, '0')}`;
};

// ─── Entry ───────────────────────────────────────────────────────────────────

export const entrySchema = z.strictObject({
    /** Coming for an expected visit (pre-registered by staff). */
    expectedVisitId: z.uuid().nullable().optional(),
    name: z.string().trim().min(2, 'is required').max(100),
    mobile: MOBILE.nullable().optional(),
    idTypeId: z.uuid().nullable().optional(),
    idNumber: z.string().trim().max(40).nullable().optional(),
    address: z.string().trim().max(200).nullable().optional(),
    photoFileId: z.uuid().nullable().optional(),
    purposeId: z.uuid().nullable().optional(),
    hostKind: z.enum(['staff', 'student', 'office']),
    staffId: z.uuid().nullable().optional(),
    studentId: z.uuid().nullable().optional(),
    people: z.number().int().min(1).max(50).default(1),
    vehicleNo: z.string().trim().toUpperCase().max(20).nullable().optional(),
    note: z.string().trim().max(300).nullable().optional(),
});

/** Saves the visitor (found by mobile, or new) with what was typed at the gate. */
const saveVisitor = async (input: { name: string; mobile?: string | null; idTypeId?: string | null; idNumber?: string | null; address?: string | null; photoFileId?: string | null }) => {
    const mobile = cleanMobile(input.mobile);
    const found = mobile ? await db.visitor.findFirst({ where: { mobile }, orderBy: { lastVisitAt: 'desc' } }) : null;
    const data = { name: input.name, mobile, ...(input.idTypeId !== undefined ? { idTypeId: input.idTypeId } : {}), ...(input.idNumber !== undefined ? { idNumber: input.idNumber || null } : {}), ...(input.address !== undefined ? { address: input.address || null } : {}), ...(input.photoFileId ? { photoFileId: input.photoFileId } : {}) };
    return found ? db.visitor.update({ where: { id: found.id }, data }) : db.visitor.create({ data: { ...data, tenantId: getTenantId()! } });
};

export const enter = async (input: z.infer<typeof entrySchema>, userId: string) => {
    const s = await getSettings({ photo: VISITORS.photoRequired, id: VISITORS.idRequired, approval: VISITORS.approval });
    if (s.photo && !input.photoFileId) throw badRequest('Take the visitor’s photo first', [{ field: 'photoFileId', message: 'is required' }]);
    if (s.id && (!input.idTypeId || !input.idNumber)) throw badRequest('Note the ID proof and its number', [{ field: 'idNumber', message: 'is required' }]);
    // An expected visitor meets whom the staff member said (the form's choice doesn't matter).
    const expected = input.expectedVisitId ? await db.visit.findFirst({ where: { id: input.expectedVisitId, status: 'expected' } }) : null;
    if (input.expectedVisitId && !expected) throw badRequest('This expected visit was already used or removed');
    if (expected) Object.assign(input, { hostKind: expected.hostKind as 'staff' | 'student' | 'office', staffId: expected.staffId, studentId: expected.studentId });
    if (input.hostKind === 'staff' && !input.staffId) throw badRequest('Choose whom they are meeting', [{ field: 'staffId', message: 'is required' }]);
    if (input.hostKind === 'student' && !input.studentId) throw badRequest('Choose the student', [{ field: 'studentId', message: 'is required' }]);
    const mobile = cleanMobile(input.mobile);
    if (mobile) {
        const black = await db.visitor.findFirst({ where: { mobile, blacklisted: true } });
        if (black) throw badRequest(`This visitor is blacklisted${black.blacklistReason ? `: ${black.blacklistReason}` : ''}. Call the office.`);
    }
    const v = await saveVisitor(input);
    const needsOk = s.approval && input.hostKind === 'staff';
    const now = new Date();
    const data = { visitorId: v.id, day: dayDate(todayIST()), purposeId: input.purposeId ?? null, hostKind: input.hostKind, staffId: input.hostKind === 'staff' ? input.staffId! : null, studentId: input.hostKind === 'student' ? input.studentId! : null, people: input.people, vehicleNo: input.vehicleNo || null, note: input.note || null, photoFileId: input.photoFileId ?? null, status: needsOk ? 'waiting' : 'in', inAt: needsOk ? null : now, passNo: await newPassNo(), createdBy: userId };
    // An expected visit was already agreed by the staff member: in at once.
    const visit = expected ? await db.visit.update({ where: { id: expected.id }, data: { ...data, status: 'in', inAt: now } }) : await db.visit.create({ data: { ...data, tenantId: getTenantId()! } });
    await db.visitor.update({ where: { id: v.id }, data: { lastVisitAt: now } });
    if (visit.staffId) {
        const purpose = visit.purposeId ? (await db.masterValue.findFirst({ where: { id: visit.purposeId }, select: { name: true } }))?.name : null;
        raiseLater('visitor_arrived', { host: () => staffOf([visit.staffId!]) }, { visitor: v.name, mobile: v.mobile ?? '', purpose: purpose ?? 'a visit', people: String(visit.people), time: clock(now), action: visit.status === 'waiting' ? 'Please allow or refuse on My Visitors.' : 'They are on their way to you.' }, { dedupe: `visitor:${visit.id}` });
    }
    await recordAudit({ action: 'visitor_in', entity: 'visit', entityId: visit.id, changes: { visitor: v.name, pass: visit.passNo, status: visit.status } });
    return visitView(visit.id);
};

/** A visit with the visitor and whom they met (for the gate, the pass and the host). */
export const visitView = async (id: string) => {
    const v = await db.visit.findFirst({ where: { id }, include: { visitor: true } });
    if (!v) throw notFound('Visit not found');
    const [purpose, staff, student, idType] = await Promise.all([
        v.purposeId ? db.masterValue.findFirst({ where: { id: v.purposeId }, select: { name: true } }) : null,
        v.staffId ? db.staff.findFirst({ where: { id: v.staffId }, select: { firstName: true, middleName: true, lastName: true } }) : null,
        v.studentId ? db.student.findFirst({ where: { id: v.studentId }, select: { firstName: true, middleName: true, lastName: true, admissionNo: true } }) : null,
        v.visitor.idTypeId ? db.masterValue.findFirst({ where: { id: v.visitor.idTypeId }, select: { name: true } }) : null,
    ]);
    return {
        id: v.id,
        passNo: v.passNo,
        day: isoOf(v.day),
        status: v.status,
        visitor: { id: v.visitor.id, name: v.visitor.name, mobile: v.visitor.mobile, idType: idType?.name ?? null, idNumber: v.visitor.idNumber, blacklisted: v.visitor.blacklisted },
        photoFileId: v.photoFileId ?? v.visitor.photoFileId,
        purpose: purpose?.name ?? null,
        hostKind: v.hostKind,
        host: v.hostKind === 'staff' && staff ? staffName(staff) : v.hostKind === 'student' && student ? `About ${fullName(student)} (${student.admissionNo})` : 'Office',
        people: v.people,
        vehicleNo: v.vehicleNo,
        note: v.note,
        inAt: v.inAt,
        outAt: v.outAt,
        answerNote: v.answerNote,
    };
};

/** The gate's screen: inside now, waiting for an OK, expected today, and how many came and went. */
export const gateToday = async () => {
    const today = dayDate(todayIST());
    const [inside, waiting, expected, denied, out] = await Promise.all([
        db.visit.findMany({ where: { status: 'in' }, orderBy: { inAt: 'asc' }, select: { id: true } }),
        db.visit.findMany({ where: { status: 'waiting', day: today }, orderBy: { createdAt: 'asc' }, select: { id: true } }),
        db.visit.findMany({ where: { status: 'expected', day: today }, orderBy: { createdAt: 'asc' }, select: { id: true } }),
        db.visit.findMany({ where: { status: 'denied', day: today, answeredAt: { gte: new Date(Date.now() - 2 * 3_600_000) } }, orderBy: { answeredAt: 'desc' }, select: { id: true } }),
        db.visit.count({ where: { status: 'out', day: today } }),
    ]);
    const views = async (rows: { id: string }[]) => Promise.all(rows.map((r) => visitView(r.id)));
    return { inside: await views(inside), waiting: await views(waiting), expected: await views(expected), denied: await views(denied), outToday: out, inToday: inside.length + out };
};

/** Check-out: by the visit, or its pass number (what the pass's QR code has). */
export const checkOut = async (key: string, userId: string) => {
    const v = /^[0-9a-f-]{36}$/i.test(key) ? await db.visit.findFirst({ where: { id: key } }) : await db.visit.findFirst({ where: { passNo: { equals: key.trim(), mode: 'insensitive' } }, orderBy: { createdAt: 'desc' } });
    if (!v) throw notFound('No visit with this pass');
    if (v.status === 'out') throw badRequest(`Already checked out at ${clock(v.outAt)}`);
    if (!['in', 'waiting'].includes(v.status)) throw badRequest('This visitor isn’t inside');
    await db.visit.update({ where: { id: v.id }, data: { status: 'out', outAt: new Date(), checkedOutBy: userId } });
    return visitView(v.id);
};

// ─── Staff: approvals and expected visitors ──────────────────────────────────

const myStaffId = async (userId: string) => (await db.staff.findFirst({ where: { userId }, select: { id: true } }))?.id ?? null;

export const answerSchema = z.strictObject({ allow: z.boolean(), note: z.string().trim().max(200).nullable().optional() });
/** The staff member (or the office) lets a waiting visitor in, or not. */
export const answer = async (visitId: string, input: z.infer<typeof answerSchema>, userId: string) => {
    const v = await db.visit.findFirst({ where: { id: visitId } });
    if (!v) throw notFound('Visit not found');
    if (v.status !== 'waiting') throw badRequest('Already answered');
    const mine = (await myStaffId(userId)) === v.staffId;
    if (!mine && !(await getUserAccess(userId)).permissions['visitor.manage']) throw forbidden();
    await db.visit.update({ where: { id: visitId }, data: { status: input.allow ? 'in' : 'denied', inAt: input.allow ? new Date() : null, answeredBy: userId, answeredAt: new Date(), answerNote: input.note || null } });
    return visitView(visitId);
};

export const expectSchema = z.strictObject({ name: z.string().trim().min(2, 'is required').max(100), mobile: MOBILE.nullable().optional(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), purposeId: z.uuid().nullable().optional(), people: z.number().int().min(1).max(50).default(1), note: z.string().trim().max(300).nullable().optional() });

/** A staff member tells the gate who is coming to meet them (they go in without waiting). */
export const expect = async (input: z.infer<typeof expectSchema>, userId: string) => {
    if (input.day < todayIST()) throw badRequest('The day is in the past', [{ field: 'day', message: 'is in the past' }]);
    const staffId = await myStaffId(userId);
    const v = await saveVisitor({ name: input.name, mobile: input.mobile });
    const visit = await db.visit.create({ data: { tenantId: getTenantId()!, visitorId: v.id, day: dayDate(input.day), purposeId: input.purposeId ?? null, hostKind: staffId ? 'staff' : 'office', staffId, people: input.people, note: input.note || null, status: 'expected', createdBy: userId } });
    return visitView(visit.id);
};

export const cancelExpected = async (visitId: string, userId: string) => {
    const v = await db.visit.findFirst({ where: { id: visitId, status: 'expected' } });
    if (!v) throw notFound('Not found');
    if (v.createdBy !== userId && !(await getUserAccess(userId)).permissions['visitor.manage']) throw forbidden();
    await db.visit.delete({ where: { id: visitId } });
    return { deleted: true };
};

/** A staff member's page: visitors waiting for their OK, expected ones, and their visits lately. */
export const myVisitors = async (userId: string) => {
    const staffId = await myStaffId(userId);
    const today = dayDate(todayIST());
    const [waiting, expected, recent] = await Promise.all([
        staffId ? db.visit.findMany({ where: { staffId, status: 'waiting' }, orderBy: { createdAt: 'asc' }, select: { id: true } }) : [],
        db.visit.findMany({ where: { status: 'expected', day: { gte: today }, OR: [{ createdBy: userId }, ...(staffId ? [{ staffId }] : [])] }, orderBy: { day: 'asc' }, select: { id: true } }),
        staffId ? db.visit.findMany({ where: { staffId, status: { in: ['in', 'out', 'denied'] } }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true } }) : [],
    ]);
    const views = async (rows: { id: string }[]) => Promise.all(rows.map((r) => visitView(r.id)));
    return { waiting: await views(waiting), expected: await views(expected), recent: await views(recent) };
};

// ─── The log and the blacklist ───────────────────────────────────────────────

export const logQuery = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    purpose: z.uuid().optional(),
    status: z.enum(['in', 'out', 'waiting', 'denied', 'expected', 'no_show']).optional(),
    search: z.string().trim().max(60).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(5).max(200).default(25),
});

export const visitLog = async (q: z.infer<typeof logQuery>) => {
    const where: Prisma.VisitWhereInput = {
        ...(q.from || q.to ? { day: { ...(q.from ? { gte: dayDate(q.from) } : {}), ...(q.to ? { lte: dayDate(q.to) } : {}) } } : {}),
        ...(q.purpose ? { purposeId: q.purpose } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.search ? { OR: [{ visitor: { name: { contains: q.search, mode: 'insensitive' } } }, { visitor: { mobile: { contains: q.search } } }, { passNo: { contains: q.search, mode: 'insensitive' } }, { vehicleNo: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await Promise.all([db.visit.count({ where }), db.visit.findMany({ where, orderBy: [{ day: 'desc' }, { createdAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true } })]);
    return { total, page: q.page, pageSize: q.pageSize, rows: await Promise.all(rows.map((r) => visitView(r.id))) };
};

export const blacklist = async () => (await db.visitor.findMany({ where: { blacklisted: true }, orderBy: { name: 'asc' } })).map((v) => ({ id: v.id, name: v.name, mobile: v.mobile, reason: v.blacklistReason, photoFileId: v.photoFileId }));

export const blacklistSchema = z.strictObject({ visitorId: z.uuid().optional(), name: z.string().trim().max(100).optional(), mobile: MOBILE.optional(), blacklisted: z.boolean(), reason: z.string().trim().max(300).nullable().optional() });
export const setBlacklist = async (input: z.infer<typeof blacklistSchema>, userId: string) => {
    let id = input.visitorId;
    if (!id) {
        if (!input.name || !input.mobile) throw badRequest('Give the name and mobile number', [{ field: 'mobile', message: 'is required' }]);
        id = (await saveVisitor({ name: input.name, mobile: input.mobile })).id;
    }
    if (input.blacklisted && !input.reason) throw badRequest('Say why', [{ field: 'reason', message: 'is required' }]);
    const v = await db.visitor.update({ where: { id }, data: { blacklisted: input.blacklisted, blacklistReason: input.blacklisted ? input.reason : null } });
    await recordAudit({ action: input.blacklisted ? 'visitor_blacklisted' : 'visitor_unblacklisted', entity: 'visitor', entityId: v.id, changes: { name: v.name, reason: input.reason } });
    void userId;
    return { id: v.id, blacklisted: v.blacklisted };
};

/** The photo file of a visit (or its visitor). */
export const visitPhoto = async (visitId: string) => {
    const v = await db.visit.findFirst({ where: { id: visitId }, select: { photoFileId: true, visitor: { select: { photoFileId: true } } } });
    return v?.photoFileId ?? v?.visitor.photoFileId ?? null;
};
export const visitorPhoto = async (visitorId: string) => (await db.visitor.findFirst({ where: { id: visitorId }, select: { photoFileId: true } }))?.photoFileId ?? null;

/** The pass: school, number, visitor, photo, host and time (printed at the gate). */
export const pass = async (visitId: string) => {
    const [v, school, s] = await Promise.all([visitView(visitId), db.schoolProfile.findFirst({ select: { shortName: true, legalName: true, logoFileId: true } }), getSettings({ size: VISITORS.passSize })]);
    return { visit: v, school: { name: school?.shortName ?? school?.legalName ?? '', hasLogo: !!school?.logoFileId }, size: s.size };
};

/** Checks out everyone still inside from earlier days (and today after the set time). */
export const autoCheckOut = async () => {
    const r = await db.visit.updateMany({ where: { status: { in: ['in', 'waiting'] } }, data: { status: 'out', outAt: new Date(), answerNote: 'Checked out by the system at the end of the day' } });
    const ex = await db.visit.updateMany({ where: { status: 'expected', day: { lt: dayDate(todayIST()) } }, data: { status: 'no_show' } });
    return r.count + ex.count;
};

/** The gate setup (what the form needs from settings). */
export const gateSetup = async () => {
    const s = await getSettings({ photo: VISITORS.photoRequired, id: VISITORS.idRequired, approval: VISITORS.approval, size: VISITORS.passSize });
    return { photoRequired: s.photo, idRequired: s.id, approval: s.approval, passSize: s.size, today: todayIST(), yesterday: isoOf(new Date(dayDate(todayIST()).getTime() - 86_400_000)) };
};
