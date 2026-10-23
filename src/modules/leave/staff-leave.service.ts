import type { LeaveType, Prisma } from '@prisma/client';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { logger } from '../../core/logger';
import { getUserAccess } from '../rbac/access.service';
import { staffName } from '../staff/staff.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { daysOff, schoolDays } from '../attendance/calendar.service';
import { statuses } from '../attendance/student-attendance.service';
import { publishedOf } from '../timetable/timetable.service';
import { LEAVE } from './leave.settings';
import { eligible, leaveTypeById, leaveTypes } from './leave-types.service';
import { balanceOf, balancesOf, leaveYearOf } from './balances.service';
import { alertLeaveDecided, alertLeaveToDecide } from './leave.alerts';

/**
 * Staff leave: a person asks (or the office records it for them), the person they report to and/or
 * the principal approves. Approved leave fills their attendance and, for teachers, puts their periods
 * on the Substitution screen.
 */

const ISO = z.iso.date();
const DAY = 86_400_000;
const show = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const addDays = (iso: string, n: number) => isoOf(new Date(dayDate(iso).getTime() + n * DAY));
const words = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

const staffSelect = {
    id: true,
    userId: true,
    employeeCode: true,
    firstName: true,
    middleName: true,
    lastName: true,
    status: true,
    joiningDate: true,
    staffTypeId: true,
    employmentTypeId: true,
    genderId: true,
    designation: { select: { name: true } },
    department: { select: { name: true } },
    reportsTo: { select: { id: true, userId: true, firstName: true, middleName: true, lastName: true, status: true } },
} as const;
type StaffRow = Prisma.StaffGetPayload<{ select: typeof staffSelect }>;

const myStaff = async (userId: string) => {
    const s = await db.staff.findFirst({ where: { userId }, select: staffSelect });
    if (!s) throw badRequest('Your login is not linked to a staff record. Ask the office.');
    return s;
};

// ─── Who approves ────────────────────────────────────────────────────────────

const modeOf = async (t: LeaveType) => (t.approval === 'default' ? (await getSettings({ a: LEAVE.approval })).a : t.approval);
/** The login of the person they report to (if they still work here). */
const managerOf = (s: StaffRow) => (s.reportsTo && s.reportsTo.status === 'working' && s.reportsTo.userId && s.reportsTo.userId !== s.userId ? s.reportsTo.userId : null);

/** Stage 1 = the person they report to; 2 = the principal / office. */
const firstStage = async (t: LeaveType, s: StaffRow) => ((await modeOf(t)) === 'office' || !managerOf(s) ? 2 : 1);

const mayDecide = async (userId: string, leave: { stage: number; staff: StaffRow }) => {
    if (leave.staff.userId === userId) return false;
    const a = await getUserAccess(userId);
    if (a.permissions['leave.approve_all']) return true;
    return leave.stage === 1 && !!a.permissions['leave.approve'] && managerOf(leave.staff) === userId;
};

// ─── Days ────────────────────────────────────────────────────────────────────

/** The days a leave takes (and the working days it covers), with the type's half-day and sandwich rules. */
export const leaveDays = async (t: LeaveType, from: string, to: string, half: 'first' | 'second' | null) => {
    const working = await schoolDays(from, to, 'staff');
    if (!working.length) return { days: 0, working };
    if (half) return { days: 0.5, working };
    if (!t.sandwich) return { days: working.length, working };
    // Holidays and weekly offs between the first and last working day count too.
    const first = working[0];
    const last = working[working.length - 1];
    return { days: Math.round((dayDate(last).getTime() - dayDate(first).getTime()) / DAY) + 1, working };
};

// ─── Asking ──────────────────────────────────────────────────────────────────

export const applySchema = z
    .strictObject({
        /** The office records leave for someone else; staff leave it out. */
        staffId: z.uuid().optional(),
        typeId: z.uuid(),
        from: ISO,
        to: ISO,
        half: z.enum(['first', 'second']).nullable().optional(),
        reason: z.string().trim().min(3, 'is too short').max(500),
        attachmentId: z.uuid().nullable().optional(),
    })
    .refine((x) => x.to >= x.from, { message: '“To” is before “from”', path: ['to'] })
    .refine((x) => !x.half || x.from === x.to, { message: 'a half day is one day only', path: ['half'] });
type ApplyInput = z.infer<typeof applySchema>;

/** Checks a request against the type's rules and the balance; says how many days and how many unpaid. */
const check = async (input: ApplyInput, s: StaffRow, office: boolean, ignoreId?: string) => {
    const t = await leaveTypeById(input.typeId);
    if (!t.isActive) throw badRequest(`${t.name} is switched off`);
    if (!eligible(t, s)) throw badRequest(`${t.name} is not for ${s.firstName}`, [{ field: 'typeId', message: 'is not for this person' }]);
    if (s.status !== 'working') throw badRequest(`${s.firstName} no longer works here`);
    if (dayDate(input.to).getTime() - dayDate(input.from).getTime() > 366 * DAY) throw badRequest('At most a year at a time', [{ field: 'to', message: 'is too far from “from”' }]);
    if (input.half && !t.halfDay) throw badRequest(`${t.name} can’t be taken for half a day`, [{ field: 'half', message: 'is not allowed for this leave' }]);
    const { days, working } = await leaveDays(t, input.from, input.to, input.half ?? null);
    if (!days) throw badRequest('There are no working days in those dates', [{ field: 'from', message: 'has no working days' }]);
    const today = todayIST();
    if (!office) {
        if (input.from >= today && t.noticeDays && input.from < addDays(today, t.noticeDays)) throw badRequest(`${t.name} must be asked for at least ${words(t.noticeDays)} before`, [{ field: 'from', message: 'is too soon' }]);
        if (input.from < today && input.from < addDays(today, -t.backDays))
            throw badRequest(t.backDays ? `${t.name} can be asked for up to ${words(t.backDays)} after. Ask the office for older days.` : `${t.name} must be asked for before it starts. Ask the office.`, [{ field: 'from', message: 'is too far back' }]);
        if (t.minDays != null && days < t.minDays) throw badRequest(`${t.name} is at least ${words(t.minDays)} at a time`, [{ field: 'to', message: 'is too short' }]);
        if (t.maxDays != null && days > t.maxDays) throw badRequest(`${t.name} is at most ${words(t.maxDays)} at a time`, [{ field: 'to', message: 'is too long' }]);
        if (t.certificateAfter != null && days > t.certificateAfter && !input.attachmentId) throw badRequest(`Attach a certificate: it is needed for ${t.name} of more than ${words(t.certificateAfter)}`, [{ field: 'attachmentId', message: 'is needed' }]);
    }
    const overlap = await db.staffLeave.findFirst({
        where: { staffId: s.id, status: { in: ['pending', 'approved'] }, fromDate: { lte: dayDate(input.to) }, toDate: { gte: dayDate(input.from) }, ...(ignoreId ? { id: { not: ignoreId } } : {}) },
        select: { fromDate: true, toDate: true, status: true, half: true },
    });
    // Two half days of the same day (first and second half) are fine.
    if (overlap && !(input.half && overlap.half && overlap.half !== input.half)) throw conflict(`There is already ${overlap.status === 'approved' ? 'approved leave' : 'a request'} from ${show(isoOf(overlap.fromDate))} to ${show(isoOf(overlap.toDate))}`);
    let lwpDays = 0;
    let available: number | null = null;
    if (t.quota != null || t.isCompOff) {
        const b = await balanceOf(s.id, t.id, await leaveYearOf(input.from));
        available = b?.available ?? 0;
        if (days > available) {
            const left = Math.max(0, available);
            if (t.overdraw === 'block' && !office) throw badRequest(`Only ${words(left)} of ${t.name} left`, [{ field: 'to', message: 'is more than the balance' }]);
            if (t.overdraw === 'lwp') lwpDays = days - left;
        }
    }
    return { t, days, working, lwpDays, available };
};

/** What a request would take, before asking (for the form): days, unpaid days, balance, or why not. */
export const previewLeave = async (input: ApplyInput, userId: string) => {
    const { s, office } = await whoFor(input, userId);
    try {
        const r = await check(input, s, office);
        return { ok: true, days: r.days, lwpDays: r.lwpDays, available: r.available, message: null as string | null };
    } catch (err) {
        if (err instanceof AppError) return { ok: false, days: null, lwpDays: 0, available: null, message: err.message };
        throw err;
    }
};

/** Whose leave it is (their own, or someone else's for the office) and whether the office is recording it. */
const whoFor = async (input: { staffId?: string }, userId: string) => {
    const a = await getUserAccess(userId);
    const me = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    if (input.staffId && input.staffId !== me?.id) {
        if (!a.permissions['leave.manage']) throw forbidden('Only the office can record leave for someone else');
        const s = await db.staff.findFirst({ where: { id: input.staffId }, select: staffSelect });
        if (!s) throw notFound('Staff member not found');
        return { s, office: true };
    }
    if (!a.permissions['leave.apply']) throw forbidden();
    return { s: await myStaff(userId), office: false };
};

export const applyLeave = async (input: ApplyInput, userId: string) => {
    const { s, office } = await whoFor(input, userId);
    const r = await check(input, s, office);
    if (input.attachmentId) {
        const f = await db.file.findFirst({ where: { id: input.attachmentId, uploadedBy: userId, purpose: 'document' }, select: { id: true } });
        if (!f) throw badRequest('Upload the certificate again', [{ field: 'attachmentId', message: 'is not your upload' }]);
    }
    const row = await db.staffLeave.create({
        data: {
            tenantId: getTenantId()!,
            staffId: s.id,
            leaveTypeId: r.t.id,
            fromDate: dayDate(input.from),
            toDate: dayDate(input.to),
            half: input.half ?? null,
            days: r.days,
            lwpDays: r.lwpDays,
            reason: input.reason,
            attachmentId: input.attachmentId ?? null,
            stage: await firstStage(r.t, s),
            appliedBy: userId,
        },
    });
    await recordAudit({ action: 'staff_leave_asked', entity: 'staff_leave', entityId: row.id, changes: { staff: staffName(s), type: r.t.code, from: input.from, to: input.to, days: r.days } });
    // Recorded by the office: no second step.
    if (office) return finalApprove(row.id, userId, 'Recorded by the office');
    alertLeaveToDecide(row.id);
    return (await present([await loadOne(row.id)], userId))[0];
};

// ─── Showing ─────────────────────────────────────────────────────────────────

const include = { staff: { select: staffSelect }, leaveType: true } as const;
type LeaveRow = Prisma.StaffLeaveGetPayload<{ include: typeof include }>;
const loadOne = async (id: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Leave not found');
    const r = await db.staffLeave.findFirst({ where: { id }, include });
    if (!r) throw notFound('Leave not found');
    return r;
};

const present = async (rows: LeaveRow[], userId: string) => {
    const users = new Map(
        (await db.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.appliedBy, r.firstBy, r.decidedBy, r.cancelledBy]).filter((x): x is string => !!x))] } }, select: { id: true, displayName: true } })).map((u) => [
            u.id,
            u.displayName,
        ])
    );
    const name = (id: string | null) => (id ? (users.get(id) ?? null) : null);
    const a = await getUserAccess(userId);
    const today = todayIST();
    const modes = new Map<string, string>();
    for (const r of rows) if (!modes.has(r.leaveTypeId)) modes.set(r.leaveTypeId, await modeOf(r.leaveType));
    return Promise.all(
        rows.map(async (r) => {
            const mine = r.staff.userId === userId;
            const from = isoOf(r.fromDate);
            const manager = r.staff.reportsTo ? staffName(r.staff.reportsTo) : null;
            return {
                id: r.id,
                staff: { id: r.staff.id, name: staffName(r.staff), employeeCode: r.staff.employeeCode, designation: r.staff.designation?.name ?? null, department: r.staff.department?.name ?? null },
                type: { id: r.leaveType.id, code: r.leaveType.code, name: r.leaveType.name, paid: r.leaveType.paid },
                from,
                to: isoOf(r.toDate),
                half: r.half,
                days: r.days,
                lwpDays: r.lwpDays,
                reason: r.reason,
                hasAttachment: !!r.attachmentId,
                status: r.status,
                stage: r.stage,
                waitingFor: r.status !== 'pending' ? null : r.stage === 1 && manager ? manager : 'the principal / office',
                twoSteps: modes.get(r.leaveTypeId) === 'two_level',
                appliedBy: name(r.appliedBy),
                appliedAt: r.createdAt,
                first: r.firstBy ? { by: name(r.firstBy), at: r.firstAt, note: r.firstNote } : null,
                decided: r.decidedBy ? { by: name(r.decidedBy), at: r.decidedAt, note: r.decisionNote } : null,
                cancelled: r.cancelledBy ? { by: name(r.cancelledBy), at: r.cancelledAt } : null,
                canCancel: (r.status === 'pending' && (mine || !!a.permissions['leave.manage'])) || (r.status === 'approved' && ((mine && from > today) || !!a.permissions['leave.manage'])),
                canDecide: r.status === 'pending' && (await mayDecide(userId, r)),
            };
        })
    );
};

/** The person's own leave: balances, requests, and the types they can ask for. */
export const myLeave = async (userId: string, yearStart?: string) => {
    const s = await myStaff(userId);
    const year = yearStart ? await leaveYearOf(yearStart) : await leaveYearOf(todayIST());
    const [balances, rows, types] = await Promise.all([
        balancesOf([s], year),
        db.staffLeave.findMany({ where: { staffId: s.id, OR: [{ fromDate: { gte: dayDate(year.start), lte: dayDate(year.end) } }, { status: 'pending' }] }, include, orderBy: { fromDate: 'desc' }, take: 200 }),
        leaveTypes(),
    ]);
    return {
        staff: { id: s.id, name: staffName(s), employeeCode: s.employeeCode, reportsTo: s.reportsTo ? staffName(s.reportsTo) : null },
        year,
        today: todayIST(),
        balances: balances.get(s.id) ?? [],
        types: types.filter((t) => t.isActive && eligible(t, s)).map(typeRules),
        leaves: await present(rows, userId),
    };
};

/** A type's rules in words, for the form. */
const typeRules = (t: LeaveType) => ({
    id: t.id,
    code: t.code,
    name: t.name,
    halfDay: t.halfDay,
    limited: t.quota != null || t.isCompOff,
    certificateAfter: t.certificateAfter,
    rules: [
        t.noticeDays ? `ask ${words(t.noticeDays)} before` : null,
        t.backDays ? `can be asked up to ${words(t.backDays)} after` : 'ask before it starts',
        t.minDays != null ? `at least ${words(t.minDays)}` : null,
        t.maxDays != null ? `at most ${words(t.maxDays)} at a time` : null,
        t.certificateAfter != null ? `certificate for more than ${words(t.certificateAfter)}` : null,
        t.sandwich ? 'holidays in between count' : null,
        !t.paid ? 'unpaid' : null,
        t.overdraw === 'lwp' ? 'beyond the balance: without pay' : null,
    ].filter((x): x is string => !!x),
});

// ─── Approving ───────────────────────────────────────────────────────────────

export const approvalsQuery = z.object({ status: z.enum(['pending', 'decided']).default('pending') });

/** Requests the person can decide (their team's; everyone's for the principal / office), with clashes. */
export const approvals = async (q: z.infer<typeof approvalsQuery>, userId: string) => {
    const a = await getUserAccess(userId);
    const all = !!a.permissions['leave.approve_all'];
    const team: Prisma.StaffLeaveWhereInput = { staff: { reportsTo: { userId } } };
    const where: Prisma.StaffLeaveWhereInput =
        q.status === 'pending'
            ? { status: 'pending', staff: { userId: { not: userId } }, ...(all ? {} : { stage: 1, ...team }) }
            : { status: { in: ['approved', 'rejected'] }, OR: [{ decidedBy: userId }, { firstBy: userId }], updatedAt: { gte: new Date(Date.now() - 90 * DAY) } };
    if (!all && !a.permissions['leave.approve']) throw forbidden();
    const rows = await db.staffLeave.findMany({ where, include, orderBy: q.status === 'pending' ? { fromDate: 'asc' } : { updatedAt: 'desc' }, take: 200 });
    const list = await present(rows, userId);
    const { show: clashes } = await getSettings({ show: LEAVE.showClashes });
    // Balances, who else is away, and periods to cover (for teachers).
    const years = new Map<string, Awaited<ReturnType<typeof leaveYearOf>>>();
    const published = await publishedOf().catch(() => null);
    return Promise.all(
        list.map(async (l, i) => {
            const r = rows[i];
            const from = l.from;
            if (!years.has(from)) years.set(from, await leaveYearOf(from));
            const balance = (await balancesOf([r.staff], years.get(from)!)).get(r.staff.id)?.find((b) => b.typeId === r.leaveTypeId) ?? null;
            const away = clashes
                ? await db.staffLeave.findMany({
                      where: { id: { not: r.id }, status: { in: ['approved', 'pending'] }, fromDate: { lte: r.toDate }, toDate: { gte: r.fromDate } },
                      select: { status: true, fromDate: true, toDate: true, staff: { select: { firstName: true, middleName: true, lastName: true, department: { select: { name: true } } } } },
                      take: 20,
                  })
                : [];
            let periods = 0;
            if (published && q.status === 'pending') {
                const { working } = await leaveDays(r.leaveType, from, l.to, r.half as 'first' | 'second' | null);
                const weekdays = working.map((d) => dayDate(d).getUTCDay() || 7);
                const perDay = await db.ttEntry.groupBy({ by: ['weekday'], where: { timetableId: published.id, staffId: r.staffId }, _count: { _all: true } });
                periods = weekdays.reduce((acc, w) => acc + (perDay.find((p) => p.weekday === w)?._count._all ?? 0), 0);
            }
            return {
                ...l,
                balance,
                away: away.map((x) => ({ name: staffName(x.staff), department: x.staff.department?.name ?? null, from: isoOf(x.fromDate), to: isoOf(x.toDate), status: x.status })),
                periods,
            };
        })
    );
};

export const decideSchema = z.strictObject({ approve: z.boolean(), note: z.string().trim().max(300).optional() });

export const decideLeave = async (id: string, input: z.infer<typeof decideSchema>, userId: string) => {
    const r = await loadOne(id);
    if (r.status !== 'pending') throw badRequest('This request has already been decided');
    if (!(await mayDecide(userId, r))) throw forbidden(r.staff.userId === userId ? 'You can’t approve your own leave' : 'This request is not yours to decide');
    if (!input.approve) {
        await db.staffLeave.update({ where: { id }, data: { status: 'rejected', decidedBy: userId, decidedAt: new Date(), decisionNote: input.note || null } });
        await recordAudit({ action: 'staff_leave_rejected', entity: 'staff_leave', entityId: id, changes: { staff: staffName(r.staff), from: isoOf(r.fromDate), to: isoOf(r.toDate) } });
        alertLeaveDecided(id);
        return (await present([await loadOne(id)], userId))[0];
    }
    const a = await getUserAccess(userId);
    // Two steps: the person they report to passes it on; the principal / office approves it.
    if (r.stage === 1 && (await modeOf(r.leaveType)) === 'two_level' && !a.permissions['leave.approve_all']) {
        await db.staffLeave.update({ where: { id }, data: { stage: 2, firstBy: userId, firstAt: new Date(), firstNote: input.note || null } });
        await recordAudit({ action: 'staff_leave_recommended', entity: 'staff_leave', entityId: id, changes: { staff: staffName(r.staff) } });
        alertLeaveToDecide(id);
        return (await present([await loadOne(id)], userId))[0];
    }
    return finalApprove(id, userId, input.note);
};

/** Approves for good: attendance of those days, and the teacher's periods to Substitution. */
const finalApprove = async (id: string, userId: string, note?: string) => {
    const r = await loadOne(id);
    const { working } = await leaveDays(r.leaveType, isoOf(r.fromDate), isoOf(r.toDate), r.half as 'first' | 'second' | null);
    const list = (await statuses()).filter((x) => x.isActive);
    const status = list.find((x) => x.code.toUpperCase() === r.leaveType.attendanceCode.toUpperCase()) ?? list.find((x) => x.code === 'LV') ?? list.find((x) => x.excused);
    const label = `${r.leaveType.name}${r.half ? ` (${r.half} half)` : ''}`;
    await withTransaction(async (tx) => {
        await tx.staffLeave.update({ where: { id }, data: { status: 'approved', decidedBy: userId, decidedAt: new Date(), decisionNote: note || null } });
        // Days they didn't come in get the leave status; days they did check in keep it.
        const existing = await tx.staffAttendance.findMany({ where: { staffId: r.staffId, date: { in: working.map(dayDate) } }, select: { id: true, date: true, checkIn: true } });
        const have = new Map(existing.map((e) => [isoOf(e.date), e]));
        const toUpdate = existing.filter((e) => !e.checkIn).map((e) => e.id);
        if (toUpdate.length) await tx.staffAttendance.updateMany({ where: { id: { in: toUpdate } }, data: { statusId: status?.id ?? null, source: 'leave', note: label } });
        const fresh = working.filter((d) => !have.has(d));
        if (fresh.length) await tx.staffAttendance.createMany({ data: fresh.map((d) => ({ tenantId: getTenantId()!, staffId: r.staffId, date: dayDate(d), statusId: status?.id ?? null, source: 'leave', note: label, isDemo: r.isDemo })), skipDuplicates: true });
    });
    if (!r.half) await toSubstitution(r.staffId, working);
    await recordAudit({ action: 'staff_leave_approved', entity: 'staff_leave', entityId: id, changes: { staff: staffName(r.staff), type: r.leaveType.code, from: isoOf(r.fromDate), to: isoOf(r.toDate), days: r.days } });
    alertLeaveDecided(id);
    return (await present([await loadOne(id)], userId))[0];
};

/** A teacher's periods on their leave days (today onwards) need someone else (Timetable → Substitution). */
const toSubstitution = async (staffId: string, days: string[]) => {
    const { on } = await getSettings({ on: LEAVE.substitution });
    const coming = days.filter((d) => d >= todayIST());
    if (!on || !coming.length) return;
    try {
        const t = await publishedOf();
        if (!t) return;
        const lessons = await db.ttEntry.findMany({ where: { timetableId: t.id, staffId }, select: { weekday: true, sectionId: true, periodNo: true, subjectId: true } });
        const tenantId = getTenantId()!;
        const data = coming.flatMap((d) => {
            const w = dayDate(d).getUTCDay() || 7;
            return lessons.filter((l) => l.weekday === w).map((l) => ({ tenantId, date: dayDate(d), sectionId: l.sectionId, periodNo: l.periodNo, subjectId: l.subjectId, absentStaffId: staffId }));
        });
        if (data.length) await db.ttSubstitution.createMany({ data, skipDuplicates: true });
    } catch (err) {
        logger.warn('Leave approved, but the periods could not be sent to Substitution', { staffId, error: (err as Error).message });
    }
};

// ─── Cancelling ──────────────────────────────────────────────────────────────

/** The person cancels a request (or approved leave not started); the office can cancel any. */
export const cancelLeave = async (id: string, userId: string) => {
    const r = await loadOne(id);
    const a = await getUserAccess(userId);
    const office = !!a.permissions['leave.manage'];
    const mine = r.staff.userId === userId || r.appliedBy === userId;
    const from = isoOf(r.fromDate);
    if (!(r.status === 'pending' || r.status === 'approved')) throw badRequest('Only a request waiting or approved leave can be cancelled');
    if (!office && !(mine && (r.status === 'pending' || from > todayIST()))) throw forbidden(r.status === 'approved' ? 'Approved leave that has started can be cancelled only by the office' : 'Only the person can cancel their request');
    await withTransaction(async (tx) => {
        await tx.staffLeave.update({ where: { id }, data: { status: 'cancelled', cancelledBy: userId, cancelledAt: new Date() } });
        if (r.status === 'approved') {
            await tx.staffAttendance.deleteMany({ where: { staffId: r.staffId, source: 'leave', checkIn: null, date: { gte: r.fromDate, lte: r.toDate } } });
            await tx.ttSubstitution.deleteMany({ where: { absentStaffId: r.staffId, date: { gte: dayDate(from > todayIST() ? from : todayIST()), lte: r.toDate } } });
        }
    });
    await recordAudit({ action: 'staff_leave_cancelled', entity: 'staff_leave', entityId: id, changes: { staff: staffName(r.staff), was: r.status } });
    return (await present([await loadOne(id)], userId))[0];
};

// ─── The register (everyone's leave) ─────────────────────────────────────────

export const registerQuery = z.object({
    from: ISO.optional(),
    to: ISO.optional(),
    status: z.enum(['all', 'pending', 'approved', 'rejected', 'cancelled']).default('all'),
    type: z.uuid().optional(),
    staff: z.uuid().optional(),
    search: z.string().trim().max(60).optional(),
});

export const leaveRegister = async (q: z.infer<typeof registerQuery>, userId: string) => {
    const year = await leaveYearOf(todayIST());
    const from = q.from ?? year.start;
    const to = q.to ?? year.end;
    if (from > to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
    const terms = (q.search ?? '').split(/\s+/).filter(Boolean);
    const rows = await db.staffLeave.findMany({
        where: {
            fromDate: { lte: dayDate(to) },
            toDate: { gte: dayDate(from) },
            ...(q.status === 'all' ? {} : { status: q.status }),
            ...(q.type ? { leaveTypeId: q.type } : {}),
            ...(q.staff ? { staffId: q.staff } : {}),
            ...(terms.length ? { staff: { AND: terms.map((w) => ({ OR: [{ firstName: { contains: w, mode: 'insensitive' as const } }, { lastName: { contains: w, mode: 'insensitive' as const } }, { employeeCode: { contains: w, mode: 'insensitive' as const } }] })) } } : {}),
        },
        include,
        orderBy: { fromDate: 'desc' },
        take: 500,
    });
    return { from, to, leaves: await present(rows, userId) };
};

/** Who is away on a day (approved leave), and who has asked. */
export const awayOn = async (date = todayIST()) => {
    const rows = await db.staffLeave.findMany({
        where: { status: { in: ['approved', 'pending'] }, fromDate: { lte: dayDate(date) }, toDate: { gte: dayDate(date) } },
        select: { status: true, half: true, fromDate: true, toDate: true, leaveType: { select: { name: true, code: true } }, staff: { select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true, designation: { select: { name: true } } } } },
        orderBy: { staff: { firstName: 'asc' } },
    });
    const off = (await daysOff(date, date, 'staff')).get(date) ?? null;
    return {
        date,
        dayOff: off,
        away: rows.map((r) => ({ staffId: r.staff.id, name: staffName(r.staff), employeeCode: r.staff.employeeCode, designation: r.staff.designation?.name ?? null, type: r.leaveType.name, code: r.leaveType.code, half: r.half, status: r.status, from: isoOf(r.fromDate), to: isoOf(r.toDate) })),
    };
};

/** Approved full-day leave of a person on a day (check-in is not expected then). */
export const approvedLeaveOn = async (staffId: string, date: string) =>
    db.staffLeave.findFirst({ where: { staffId, status: 'approved', half: null, fromDate: { lte: dayDate(date) }, toDate: { gte: dayDate(date) } }, select: { leaveType: { select: { name: true, countsPresent: true } } } });

/** The certificate of a request: the person, the approvers, and those who see everyone's leave. */
export const attachmentOf = async (id: string, userId: string) => {
    const r = await loadOne(id);
    if (!r.attachmentId) throw notFound('No certificate was attached');
    const a = await getUserAccess(userId);
    const allowed = r.staff.userId === userId || r.appliedBy === userId || !!a.permissions['leave.view'] || !!a.permissions['leave.approve_all'] || (!!a.permissions['leave.approve'] && managerOf(r.staff) === userId);
    if (!allowed) throw forbidden();
    return r.attachmentId;
};
