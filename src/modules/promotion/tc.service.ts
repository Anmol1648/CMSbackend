import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { formatNumber, takeNumbers } from '../../core/numbering';
import { getUserAccess } from '../rbac/access.service';
import { revokeUserSessions } from '../auth/session.service';
import { currentYear } from '../academic/years.service';
import { fullName } from '../students/students.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { computeDues, dueStudents } from '../fees/dues.service';
import { PROMOTION } from './promotion.settings';
import { alertTc } from './tc.alerts';

/**
 * Transfer certificates: asked for (by the office, or by promotion as "leaving"), cleared (fees by
 * themselves; library, laboratory… ticked by the people looking after them), issued with the next TC
 * number (the student is marked as left and their login stops), printed (later prints say Duplicate).
 */

const ISO = z.iso.date();
type Clearance = { id: string; label: string; done: boolean; by: string | null; at: string | null };

const studentSelect = { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, status: true, userId: true } } as const;
type TcRow = Prisma.TransferCertificateGetPayload<{ include: { student: typeof studentSelect } }>;

/** What the student still owes, over every session they were in. */
export const duesOf = async (studentId: string) => {
    const years = await db.enrolment.findMany({ where: { studentId }, select: { academicYearId: true, academicYear: { select: { name: true } } } });
    let total = 0;
    const by: { year: string; amount: number }[] = [];
    for (const y of years) {
        const d = (await computeDues(y.academicYearId, await dueStudents(y.academicYearId, { id: studentId }))).get(studentId);
        if (d && d.totals.balance > 0) {
            total += d.totals.balance;
            by.push({ year: y.academicYear.name, amount: d.totals.balance });
        }
    }
    return { total, by };
};

/** The checklist of a TC: the school's clearances (Masters → TC clearances), with what is already ticked. */
const checklist = async (saved: Clearance[]) => {
    const items = await db.masterValue.findMany({ where: { master: 'tc_clearance', isActive: true }, select: { id: true, name: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    return items.map((i) => saved.find((c) => c.id === i.id) ?? { id: i.id, label: i.name, done: false, by: null, at: null });
};

const present = async (rows: TcRow[], withDues = false) => {
    const year = await currentYear();
    const enrol = new Map(
        (
            await db.enrolment.findMany({
                where: { studentId: { in: rows.map((r) => r.studentId) } },
                orderBy: { academicYear: { startDate: 'desc' } },
                select: { studentId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } }, academicYear: { select: { name: true } } },
            })
        )
            .reverse()
            .map((e) => [e.studentId, e])
    );
    const reasons = new Map((await db.masterValue.findMany({ where: { id: { in: rows.map((r) => r.reasonId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((m) => [m.id, m.name]));
    const users = new Map((await db.user.findMany({ where: { id: { in: rows.flatMap((r) => [r.requestedBy, r.issuedBy]).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
    return Promise.all(
        rows.map(async (r) => {
            const e = enrol.get(r.studentId);
            const clearances = await checklist(r.clearances as Clearance[]);
            return {
                id: r.id,
                status: r.status,
                tcNo: r.tcNo,
                student: { id: r.student.id, name: fullName(r.student), admissionNo: r.student.admissionNo, status: r.student.status, section: e ? `${sectionLabel(e.section)} (${e.academicYear.name})` : null },
                applicationDate: isoOf(r.applicationDate),
                leavingDate: isoOf(r.leavingDate),
                reasonId: r.reasonId,
                reason: r.reasonId ? (reasons.get(r.reasonId) ?? null) : null,
                lastClass: r.lastClass,
                result: r.result,
                conduct: r.conduct,
                remarks: r.remarks,
                clearances,
                cleared: clearances.every((c) => c.done),
                requestedBy: r.requestedBy ? (users.get(r.requestedBy) ?? null) : null,
                issuedBy: r.issuedBy ? (users.get(r.issuedBy) ?? null) : null,
                issuedAt: r.issuedAt,
                printCount: r.printCount,
                cancelNote: r.cancelNote,
                ...(withDues ? { dues: await duesOf(r.studentId) } : {}),
                currentYear: year?.name ?? null,
            };
        })
    );
};

const loadTc = async (id: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('TC not found');
    const r = await db.transferCertificate.findFirst({ where: { id }, include: { student: studentSelect } });
    if (!r) throw notFound('TC not found');
    return r;
};

// ─── Listing ─────────────────────────────────────────────────────────────────

export const listQuery = z.object({ status: z.enum(['requested', 'issued', 'cancelled', 'all']).default('requested'), search: z.string().trim().max(60).optional() });

export const listTcs = async (q: z.infer<typeof listQuery>) => {
    const words = (q.search ?? '').split(/\s+/).filter(Boolean);
    const rows = await db.transferCertificate.findMany({
        where: {
            ...(q.status === 'all' ? {} : { status: q.status }),
            ...(words.length ? { OR: [{ tcNo: { contains: q.search!, mode: 'insensitive' } }, { student: { AND: words.map((w) => ({ OR: [{ firstName: { contains: w, mode: 'insensitive' as const } }, { lastName: { contains: w, mode: 'insensitive' as const } }, { admissionNo: { contains: w, mode: 'insensitive' as const } }] })) } }] } : {}),
        },
        include: { student: studentSelect },
        orderBy: q.status === 'requested' ? { applicationDate: 'asc' } : { updatedAt: 'desc' },
        take: 300,
    });
    return present(rows);
};

export const getTc = async (id: string) => (await present([await loadTc(id)], true))[0];

// ─── Asking ──────────────────────────────────────────────────────────────────

export const requestSchema = z.strictObject({
    studentId: z.uuid(),
    applicationDate: ISO.optional(),
    leavingDate: ISO,
    reasonId: z.uuid().nullable().optional(),
    remarks: z.string().trim().max(300).nullable().optional(),
});

export const requestTc = async (input: z.infer<typeof requestSchema>, userId: string) => {
    const s = await db.student.findFirst({ where: { id: input.studentId }, select: { id: true, status: true, firstName: true, lastName: true } });
    if (!s) throw notFound('Student not found');
    if (s.status === 'left') throw conflict(`${s.firstName} has already left`);
    if (await db.transferCertificate.findFirst({ where: { studentId: s.id, status: { in: ['requested', 'issued'] } }, select: { id: true } })) throw conflict(`${s.firstName} already has a TC (asked or issued)`);
    if (input.reasonId && !(await db.masterValue.findFirst({ where: { id: input.reasonId, master: 'leaving_reason' } }))) throw badRequest('Choose a leaving reason from the list', [{ field: 'reasonId', message: 'is not a leaving reason' }]);
    const year = await currentYear();
    const e = year ? await db.enrolment.findFirst({ where: { studentId: s.id, academicYearId: year.id }, select: { section: { select: { schoolClass: { select: { name: true } } } } } }) : null;
    const row = await db.transferCertificate.create({
        data: {
            tenantId: getTenantId()!,
            studentId: s.id,
            applicationDate: dayDate(input.applicationDate ?? todayIST()),
            leavingDate: dayDate(input.leavingDate),
            reasonId: input.reasonId ?? null,
            remarks: input.remarks ?? null,
            lastClass: e?.section.schoolClass.name ?? null,
            requestedBy: userId,
        },
    });
    await recordAudit({ action: 'tc_requested', entity: 'student', entityId: s.id, changes: { leavingDate: input.leavingDate } });
    alertTc(row.id, 'requested');
    return getTc(row.id);
};

export const updateSchema = z.strictObject({
    leavingDate: ISO,
    reasonId: z.uuid().nullable().optional(),
    lastClass: z.string().trim().max(60).nullable().optional(),
    result: z.string().trim().max(120).nullable().optional(),
    conduct: z.string().trim().min(1).max(60).default('Good'),
    remarks: z.string().trim().max(300).nullable().optional(),
});

export const updateTc = async (id: string, input: z.infer<typeof updateSchema>) => {
    const r = await loadTc(id);
    if (r.status !== 'requested') throw badRequest('Only a TC not yet issued can be changed');
    if (input.reasonId && !(await db.masterValue.findFirst({ where: { id: input.reasonId, master: 'leaving_reason' } }))) throw badRequest('Choose a leaving reason from the list', [{ field: 'reasonId', message: 'is not a leaving reason' }]);
    await db.transferCertificate.update({ where: { id }, data: { leavingDate: dayDate(input.leavingDate), reasonId: input.reasonId ?? null, lastClass: input.lastClass ?? null, result: input.result ?? null, conduct: input.conduct, remarks: input.remarks ?? null } });
    return getTc(id);
};

/** Ticks (or unticks) one clearance; by whoever looks after it (tc.clear) or the office. */
export const setClearance = async (id: string, input: { clearanceId: string; done: boolean }, userId: string) => {
    const r = await loadTc(id);
    if (r.status !== 'requested') throw badRequest('The TC has already been issued');
    const list = await checklist(r.clearances as Clearance[]);
    const item = list.find((c) => c.id === input.clearanceId);
    if (!item) throw notFound('Clearance not found');
    const me = await db.user.findUnique({ where: { id: userId }, select: { displayName: true } });
    const next = list.map((c) => (c.id === item.id ? { ...c, done: input.done, by: input.done ? (me?.displayName ?? null) : null, at: input.done ? new Date().toISOString() : null } : c));
    await db.transferCertificate.update({ where: { id }, data: { clearances: next } });
    await recordAudit({ action: input.done ? 'tc_cleared' : 'tc_uncleared', entity: 'student', entityId: r.studentId, changes: { clearance: item.label } });
    return getTc(id);
};

// ─── Issuing ─────────────────────────────────────────────────────────────────

/** Gives the TC its number; the student is marked as left (their login stops). */
export const issueTc = async (id: string, userId: string) => {
    const t = await getTc(id);
    if (t.status !== 'requested') throw badRequest('This TC has already been issued or cancelled');
    if (!t.cleared) throw badRequest(`Not cleared yet: ${t.clearances.filter((c) => !c.done).map((c) => c.label).join(', ')}`);
    const s = await getSettings({ pattern: PROMOTION.tcPattern, start: PROMOTION.tcStart, dues: PROMOTION.tcDues });
    if (t.dues && t.dues.total > 0 && s.dues === 'block') throw badRequest(`Fees of ₹${t.dues.total.toLocaleString('en-IN')} are still due (${t.dues.by.map((d) => d.year).join(', ')}). Clear them first, or allow it in System Settings → Promotion & TC.`);
    const year = await currentYear();
    let tcNo = '';
    for (let i = 0; i < 50; i++) {
        tcNo = formatNumber(s.pattern, { seq: await takeNumbers('tc', s.start), date: new Date(), academicYear: year?.name });
        if (!(await db.transferCertificate.findFirst({ where: { tcNo }, select: { id: true } }))) break;
    }
    const r = await loadTc(id);
    await withTransaction(async (tx) => {
        await tx.transferCertificate.update({ where: { id }, data: { status: 'issued', tcNo, issuedBy: userId, issuedAt: new Date() } });
        await tx.student.update({ where: { id: r.studentId }, data: { status: 'left', statusDate: r.leavingDate, leavingReasonId: r.reasonId, tcNumber: tcNo } });
        if (r.student.userId) await tx.user.update({ where: { id: r.student.userId }, data: { status: 'disabled' } });
    });
    if (r.student.userId) await revokeUserSessions(r.student.userId, 'admin');
    await recordAudit({ action: 'tc_issued', entity: 'student', entityId: r.studentId, changes: { tcNo, dues: t.dues?.total ?? 0 } });
    alertTc(id, 'issued');
    return getTc(id);
};

/** Cancels a TC asked for, or one issued by mistake (the student is then active again). */
export const cancelTc = async (id: string, note: string) => {
    const r = await loadTc(id);
    if (r.status === 'cancelled') throw badRequest('It is already cancelled');
    await withTransaction(async (tx) => {
        await tx.transferCertificate.update({ where: { id }, data: { status: 'cancelled', cancelledAt: new Date(), cancelNote: note } });
        if (r.status === 'issued') {
            await tx.student.update({ where: { id: r.studentId }, data: { status: 'active', statusDate: null, leavingReasonId: null, tcNumber: null } });
            if (r.student.userId) await tx.user.update({ where: { id: r.student.userId }, data: { status: 'active' } });
        }
    });
    await recordAudit({ action: 'tc_cancelled', entity: 'student', entityId: r.studentId, changes: { was: r.status, tcNo: r.tcNo, note } });
    return getTc(id);
};

/** The person may print TCs (the office) or certificates. */
export const mayPrint = async (userId: string, what: 'tc' | 'certificate') => {
    const a = await getUserAccess(userId);
    if (what === 'tc' ? !a.permissions['tc.manage'] : !a.permissions['certificate.issue'] && !a.permissions['tc.manage']) throw forbidden();
};
