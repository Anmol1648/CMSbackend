import type { LeaveType } from '@prisma/client';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { getSetting } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { staffName } from '../staff/staff.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { dayOff } from '../attendance/calendar.service';
import { LEAVE } from './leave.settings';
import { eligible, leaveTypeById, leaveTypes } from './leave-types.service';

/**
 * Leave balances. What a person has = the policy's credit for the leave year (worked out, never
 * stored, so a changed quota applies at once) + carried forward + HR adjustments + comp-offs earned,
 * minus approved leave. Pending requests are held back from what can still be asked.
 */

const ISO = z.iso.date();
const DAY = 86_400_000;
const half = (x: number) => Math.round(x * 2) / 2;
const addDays = (iso: string, n: number) => isoOf(new Date(dayDate(iso).getTime() + n * DAY));

// ─── Leave years ─────────────────────────────────────────────────────────────

export interface LeaveYear {
    start: string;
    end: string;
    name: string;
}

/** The leave year a day falls in: the academic session (default) or the calendar year. */
export const leaveYearOf = async (date: string): Promise<LeaveYear> => {
    if ((await getSetting(LEAVE.year)) === 'session') {
        const y = await db.academicYear.findFirst({ where: { startDate: { lte: dayDate(date) }, endDate: { gte: dayDate(date) } }, orderBy: { startDate: 'desc' } });
        if (y) return { start: isoOf(y.startDate), end: isoOf(y.endDate), name: y.name };
    }
    const yr = date.slice(0, 4);
    return { start: `${yr}-01-01`, end: `${yr}-12-31`, name: yr };
};

/** The leave years to choose from (sessions, or the calendar years around this one). */
export const leaveYears = async () => {
    const current = await leaveYearOf(todayIST());
    if ((await getSetting(LEAVE.year)) === 'session') {
        const years = await db.academicYear.findMany({ orderBy: { startDate: 'desc' }, select: { name: true, startDate: true, endDate: true } });
        if (years.length) return { current, years: years.map((y) => ({ start: isoOf(y.startDate), end: isoOf(y.endDate), name: y.name })) };
    }
    const y = Number(todayIST().slice(0, 4));
    return { current, years: [y + 1, y, y - 1, y - 2].map((n) => ({ start: `${n}-01-01`, end: `${n}-12-31`, name: String(n) })) };
};

/** A leave year by its first day. */
export const leaveYearStarting = async (start: string) => {
    const y = await leaveYearOf(start);
    if (y.start !== start) throw badRequest('That is not the first day of a leave year', [{ field: 'year', message: 'is not a leave year' }]);
    return y;
};

// ─── Credit ──────────────────────────────────────────────────────────────────

const monthIndex = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;

/** What the policy gives a person for a leave year, up to a day (monthly credit grows month by month). */
export const credit = (t: LeaveType, year: LeaveYear, joining: string, asOf: string) => {
    if (t.credit === 'none' || t.quota == null || joining > year.end) return 0;
    const from = joining > year.start ? joining : year.start;
    const months = monthIndex(year.end) - monthIndex(year.start) + 1;
    if (t.credit === 'yearly') {
        if (!t.prorate || from === year.start) return t.quota;
        return half((t.quota * (monthIndex(year.end) - monthIndex(from) + 1)) / months);
    }
    const until = asOf < year.end ? asOf : year.end;
    if (until < from) return 0;
    return half((t.quota * (monthIndex(until) - monthIndex(from) + 1)) / months);
};

type StaffForBalance = { id: string; joiningDate: Date; staffTypeId: string | null; employmentTypeId: string | null; genderId: string | null };
const staffSelect = { id: true, joiningDate: true, staffTypeId: true, employmentTypeId: true, genderId: true } as const;

export interface Balance {
    typeId: string;
    code: string;
    name: string;
    /** No limit (leave without pay, on duty): only what was taken matters. */
    unlimited: boolean;
    isCompOff: boolean;
    credited: number;
    carried: number;
    adjusted: number;
    /** Comp-offs earned and not lapsed. */
    earned: number;
    taken: number;
    pending: number;
    /** What they have (before pending requests). */
    balance: number;
    /** What they can still ask for. */
    available: number;
}

/** Balances of many people for a leave year, as on a day (today by default). */
export const balancesOf = async (staff: StaffForBalance[], year: LeaveYear, asOf = todayIST()) => {
    const types = (await leaveTypes()).filter((t) => t.isActive);
    const ids = staff.map((s) => s.id);
    const [entries, leaves] = await Promise.all([
        db.leaveEntry.findMany({ where: { staffId: { in: ids }, yearStart: dayDate(year.start) }, select: { staffId: true, leaveTypeId: true, kind: true, days: true, expiresOn: true } }),
        db.staffLeave.findMany({ where: { staffId: { in: ids }, status: { in: ['approved', 'pending'] }, fromDate: { gte: dayDate(year.start), lte: dayDate(year.end) } }, select: { staffId: true, leaveTypeId: true, status: true, days: true, lwpDays: true } }),
    ]);
    const out = new Map<string, Balance[]>();
    for (const s of staff) {
        const list: Balance[] = [];
        for (const t of types) {
            if (!eligible(t, s)) continue;
            const mine = entries.filter((e) => e.staffId === s.id && e.leaveTypeId === t.id);
            const sum = (kind: string) => mine.filter((e) => e.kind === kind && (kind !== 'compoff' || !e.expiresOn || isoOf(e.expiresOn) >= asOf)).reduce((a, e) => a + e.days, 0);
            const taken = leaves.filter((l) => l.staffId === s.id && l.leaveTypeId === t.id && l.status === 'approved').reduce((a, l) => a + l.days - l.lwpDays, 0);
            const pending = leaves.filter((l) => l.staffId === s.id && l.leaveTypeId === t.id && l.status === 'pending').reduce((a, l) => a + l.days - l.lwpDays, 0);
            const credited = credit(t, year, isoOf(s.joiningDate), asOf);
            const [carried, adjusted, earned] = [sum('carry'), sum('adjust'), t.isCompOff ? sum('compoff') : 0];
            const unlimited = t.quota == null && !t.isCompOff;
            const balance = half(credited + carried + adjusted + earned - taken);
            list.push({ typeId: t.id, code: t.code, name: t.name, unlimited, isCompOff: t.isCompOff, credited, carried, adjusted, earned, taken, pending, balance, available: half(balance - pending) });
        }
        out.set(s.id, list);
    }
    return out;
};

/** One person's balance of one type (null when they may not take it). */
export const balanceOf = async (staffId: string, typeId: string, year: LeaveYear) => {
    const s = await db.staff.findFirst({ where: { id: staffId }, select: staffSelect });
    if (!s) throw notFound('Staff member not found');
    return (await balancesOf([s], year)).get(s.id)?.find((b) => b.typeId === typeId) ?? null;
};

// ─── The balances screen ─────────────────────────────────────────────────────

export const balancesQuery = z.object({ year: ISO.optional(), search: z.string().trim().max(60).optional(), department: z.uuid().optional() });

/** Everyone working and their balance of each type, for a leave year. */
export const balanceSheet = async (q: z.infer<typeof balancesQuery>) => {
    const year = q.year ? await leaveYearStarting(q.year) : await leaveYearOf(todayIST());
    const words = (q.search ?? '').split(/\s+/).filter(Boolean);
    const staff = await db.staff.findMany({
        where: {
            status: 'working',
            ...(q.department ? { departmentId: q.department } : {}),
            AND: words.map((w) => ({ OR: [{ firstName: { contains: w, mode: 'insensitive' as const } }, { lastName: { contains: w, mode: 'insensitive' as const } }, { employeeCode: { contains: w, mode: 'insensitive' as const } }] })),
        },
        select: { ...staffSelect, employeeCode: true, firstName: true, middleName: true, lastName: true, designation: { select: { name: true } }, department: { select: { name: true } } },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
        take: 500,
    });
    const balances = await balancesOf(staff, year);
    const types = (await leaveTypes()).filter((t) => t.isActive);
    return {
        year,
        types: types.map((t) => ({ id: t.id, code: t.code, name: t.name, unlimited: t.quota == null && !t.isCompOff, isCompOff: t.isCompOff })),
        staff: staff.map((s) => ({ id: s.id, name: staffName(s), employeeCode: s.employeeCode, designation: s.designation?.name ?? null, department: s.department?.name ?? null, balances: balances.get(s.id) ?? [] })),
    };
};

/** One person's balances and the changes behind them (credit, carried, adjustments, comp-offs). */
export const staffBalance = async (staffId: string, yearStart?: string) => {
    if (!z.uuid().safeParse(staffId).success) throw notFound('Staff member not found');
    const year = yearStart ? await leaveYearStarting(yearStart) : await leaveYearOf(todayIST());
    const s = await db.staff.findFirst({ where: { id: staffId }, select: { ...staffSelect, employeeCode: true, firstName: true, middleName: true, lastName: true } });
    if (!s) throw notFound('Staff member not found');
    const [balances, entries, types] = await Promise.all([
        balancesOf([s], year),
        db.leaveEntry.findMany({ where: { staffId, yearStart: dayDate(year.start) }, orderBy: { createdAt: 'desc' } }),
        leaveTypes(),
    ]);
    const users = new Map((await db.user.findMany({ where: { id: { in: entries.map((e) => e.createdBy).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
    const typeName = new Map(types.map((t) => [t.id, t.name]));
    return {
        year,
        staff: { id: s.id, name: staffName(s), employeeCode: s.employeeCode, joiningDate: isoOf(s.joiningDate) },
        balances: balances.get(s.id) ?? [],
        entries: entries.map((e) => ({
            id: e.id,
            type: typeName.get(e.leaveTypeId) ?? '',
            kind: e.kind,
            days: e.days,
            workedOn: e.workedOn ? isoOf(e.workedOn) : null,
            expiresOn: e.expiresOn ? isoOf(e.expiresOn) : null,
            note: e.note,
            by: e.createdBy ? (users.get(e.createdBy) ?? null) : null,
            at: e.createdAt,
        })),
    };
};

// ─── HR: adjustments and comp-offs ───────────────────────────────────────────

export const adjustSchema = z.strictObject({
    staffId: z.uuid(),
    typeId: z.uuid(),
    year: ISO.optional(),
    /** Added (positive) or taken away (negative). */
    days: z.number().min(-366).max(366).refine((x) => x !== 0 && Number.isInteger(x * 2), 'must be whole or half days, not 0'),
    note: z.string().trim().min(3, 'say why').max(300),
});

/** Adds or takes away days (opening balance, a correction), with the reason; audited. */
export const adjustBalance = async (input: z.infer<typeof adjustSchema>) => {
    const year = input.year ? await leaveYearStarting(input.year) : await leaveYearOf(todayIST());
    const t = await leaveTypeById(input.typeId);
    if (t.quota == null && !t.isCompOff) throw badRequest(`${t.name} has no limit, so it has no balance to adjust`);
    const s = await db.staff.findFirst({ where: { id: input.staffId }, select: { ...staffSelect, firstName: true, lastName: true } });
    if (!s) throw notFound('Staff member not found');
    const row = await db.leaveEntry.create({ data: { tenantId: getTenantId()!, staffId: s.id, leaveTypeId: t.id, yearStart: dayDate(year.start), kind: 'adjust', days: input.days, note: input.note } });
    await recordAudit({ action: 'leave_balance_adjusted', entity: 'staff', entityId: s.id, changes: { type: t.code, year: year.name, days: input.days, note: input.note } });
    return { id: row.id, ...(await staffBalance(s.id, year.start)) };
};

export const compOffSchema = z.strictObject({
    staffId: z.uuid(),
    workedOn: ISO,
    days: z.union([z.literal(1), z.literal(0.5)]).default(1),
    note: z.string().trim().max(300).optional(),
});

/** Gives a comp-off for working on a holiday or weekly off; it lapses after the type's days. */
export const grantCompOff = async (input: z.infer<typeof compOffSchema>) => {
    const t = (await leaveTypes()).find((x) => x.isCompOff && x.isActive);
    if (!t) throw badRequest('There is no comp-off leave type (Leave Setup → a type marked “comp-off”)');
    if (input.workedOn > todayIST()) throw badRequest('The day worked can’t be in the future', [{ field: 'workedOn', message: 'is in the future' }]);
    const off = await dayOff(input.workedOn, 'staff');
    if (!off) throw badRequest('That was a working day. A comp-off is for working on a holiday or weekly off.', [{ field: 'workedOn', message: 'is a working day' }]);
    const s = await db.staff.findFirst({ where: { id: input.staffId }, select: { id: true, firstName: true, lastName: true } });
    if (!s) throw notFound('Staff member not found');
    if (await db.leaveEntry.findFirst({ where: { staffId: s.id, kind: 'compoff', workedOn: dayDate(input.workedOn) } })) throw conflict(`${s.firstName} already has a comp-off for that day`);
    const year = await leaveYearOf(input.workedOn);
    const expiresOn = t.compOffDays ? dayDate(addDays(input.workedOn, t.compOffDays)) : null;
    await db.leaveEntry.create({ data: { tenantId: getTenantId()!, staffId: s.id, leaveTypeId: t.id, yearStart: dayDate(year.start), kind: 'compoff', days: input.days, workedOn: dayDate(input.workedOn), expiresOn, note: input.note || `Worked on ${off}` } });
    await recordAudit({ action: 'comp_off_given', entity: 'staff', entityId: s.id, changes: { workedOn: input.workedOn, days: input.days } });
    return staffBalance(s.id, year.start);
};

/** Removes an adjustment or comp-off given by mistake (carry forward is undone with the year-end). */
export const removeEntry = async (id: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Entry not found');
    const e = await db.leaveEntry.findFirst({ where: { id } });
    if (!e) throw notFound('Entry not found');
    if (e.kind === 'carry') throw badRequest('Carried-forward days are undone from the year-end screen');
    await db.leaveEntry.delete({ where: { id } });
    await recordAudit({ action: 'leave_entry_removed', entity: 'staff', entityId: e.staffId, changes: { kind: e.kind, days: e.days } });
    return staffBalance(e.staffId, isoOf(e.yearStart));
};

/** Staff who checked in on a day off in the last 60 days and have no comp-off for it yet. */
export const compOffSuggestions = async () => {
    const from = addDays(todayIST(), -60);
    const rows = await db.staffAttendance.findMany({
        where: { date: { gte: dayDate(from) }, checkIn: { not: null } },
        select: { date: true, staffId: true, staff: { select: { firstName: true, middleName: true, lastName: true, employeeCode: true } } },
        orderBy: { date: 'desc' },
    });
    const given = new Set((await db.leaveEntry.findMany({ where: { kind: 'compoff', workedOn: { gte: dayDate(from) } }, select: { staffId: true, workedOn: true } })).map((e) => `${e.staffId}|${isoOf(e.workedOn!)}`));
    const offCache = new Map<string, string | null>();
    const out = [];
    for (const r of rows) {
        const iso = isoOf(r.date);
        if (given.has(`${r.staffId}|${iso}`)) continue;
        if (!offCache.has(iso)) offCache.set(iso, await dayOff(iso, 'staff'));
        const off = offCache.get(iso);
        if (off) out.push({ staffId: r.staffId, name: staffName(r.staff), employeeCode: r.staff.employeeCode, date: iso, dayOff: off });
    }
    return out.slice(0, 100);
};

// ─── Year end ────────────────────────────────────────────────────────────────

const nextYearOf = async (year: LeaveYear) => {
    const next = await leaveYearOf(addDays(year.end, 1));
    if (next.start !== addDays(year.end, 1)) throw badRequest('Add the next academic year first (Academic → Sessions): carried days go into it');
    return next;
};

/** What closing a leave year would carry forward and what would lapse, person by person. */
export const yearEndPreview = async (yearStart: string) => {
    const year = await leaveYearStarting(yearStart);
    const next = await nextYearOf(year);
    const types = (await leaveTypes()).filter((t) => t.isActive && t.carryForward !== 'none' && !t.isCompOff);
    const done = await db.leaveEntry.count({ where: { kind: 'carry', yearStart: dayDate(next.start) } });
    const staff = await db.staff.findMany({ where: { status: 'working' }, select: { ...staffSelect, employeeCode: true, firstName: true, middleName: true, lastName: true }, orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }] });
    const balances = await balancesOf(staff, year, year.end);
    const rows = staff.flatMap((s) =>
        types.flatMap((t) => {
            const b = balances.get(s.id)?.find((x) => x.typeId === t.id);
            if (!b) return [];
            const left = Math.max(0, b.balance);
            const carry = t.carryForward === 'all' ? left : Math.min(left, t.carryMax ?? 0);
            return [{ staffId: s.id, name: staffName(s), employeeCode: s.employeeCode, typeId: t.id, type: t.name, code: t.code, balance: b.balance, carry, lapse: half(left - carry) }];
        })
    );
    return { year, next, done: done > 0, types: types.map((t) => ({ code: t.code, name: t.name, rule: t.carryForward === 'all' ? 'all' : `up to ${t.carryMax}` })), rows, totals: { carry: half(rows.reduce((a, r) => a + r.carry, 0)), lapse: half(rows.reduce((a, r) => a + r.lapse, 0)) } };
};

/** Carries the days into the next leave year (once; it can be undone and run again). */
export const closeYear = async (yearStart: string) => {
    const p = await yearEndPreview(yearStart);
    if (p.done) throw conflict(`${p.year.name} has already been closed. Undo it first to run it again.`);
    const rows = p.rows.filter((r) => r.carry > 0);
    const tenantId = getTenantId()!;
    await db.leaveEntry.createMany({ data: rows.map((r) => ({ tenantId, staffId: r.staffId, leaveTypeId: r.typeId, yearStart: dayDate(p.next.start), kind: 'carry', days: r.carry, note: `Carried from ${p.year.name}` })) });
    await recordAudit({ action: 'leave_year_closed', entity: 'school', changes: { year: p.year.name, people: new Set(rows.map((r) => r.staffId)).size, days: p.totals.carry } });
    return yearEndPreview(yearStart);
};

/** Takes back what a year-end carried forward. */
export const undoCloseYear = async (yearStart: string) => {
    const year = await leaveYearStarting(yearStart);
    const next = await nextYearOf(year);
    await withTransaction(async (tx) => {
        await tx.leaveEntry.deleteMany({ where: { kind: 'carry', yearStart: dayDate(next.start) } });
    });
    await recordAudit({ action: 'leave_year_reopened', entity: 'school', changes: { year: year.name } });
    return yearEndPreview(yearStart);
};
