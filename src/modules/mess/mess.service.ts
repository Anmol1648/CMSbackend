import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { currentYear } from '../academic/years.service';
import { fullName } from '../students/students.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { registerFeeSource } from '../fees/dues.service';
import { registerPayrollDeduction } from '../payroll/payroll.service';
import { raiseLater } from '../alerts/deliver';
import { holdersOf } from '../alerts/recipients';
import { defineDailyJob } from '../alerts/jobs';
import { MESS } from './mess.settings';

/**
 * Mess: meals (Masters), plans (meals + charge; one can take every boarder automatically), members
 * (students and staff), a menu that repeats every 1–4 weeks with special days, meals skipped before
 * the cut-off, the daily headcount (less skipped meals and boarders away on hostel leave), the
 * counter (scan the ID card or tick the list), guests, ratings, and the kitchen cost from the
 * store's issues to the kitchen. Students' charges go into the fee instalments (with a rebate for
 * long hostel leave); staff charges are deducted on the payslip.
 */

const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DAY = 86_400_000;
const staffName = (s: { firstName: string; middleName?: string | null; lastName?: string | null }) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');
const addDays = (date: string, n: number) => isoOf(new Date(dayDate(date).getTime() + n * DAY));

export type Meal = { id: string; name: string; time: string; rate: number };
export const meals = async (): Promise<Meal[]> =>
    (await db.masterValue.findMany({ where: { master: 'mess_meal', isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, extra: true } })).map((m) => {
        const x = (m.extra ?? {}) as { time?: string; guest_rate?: number };
        return { id: m.id, name: m.name, time: /^\d{1,2}:\d{2}$/.test(x.time ?? '') ? x.time!.padStart(5, '0') : '12:00', rate: Number(x.guest_rate ?? 0) };
    });
const startOf = (date: string, meal: Meal) => new Date(`${date}T${meal.time}:00+05:30`);

// ─── Plans ───────────────────────────────────────────────────────────────────

export const planSchema = z.strictObject({ name: z.string().trim().min(2).max(80), mealIds: z.array(z.uuid()).min(1).max(10), fee: z.number().int().min(0).max(1_000_000), monthly: z.number().int().min(0).max(1_000_000), forBoarders: z.boolean().default(false), forWho: z.enum(['students', 'staff', 'both']).default('both'), isActive: z.boolean().default(true) });
export const savePlan = async (id: string | null, input: z.infer<typeof planSchema>, opts: { isDemo?: boolean } = {}) => {
    if (input.forBoarders) await db.messPlan.updateMany({ where: { forBoarders: true, ...(id ? { id: { not: id } } : {}) }, data: { forBoarders: false } });
    return id ? db.messPlan.update({ where: { id }, data: input }) : db.messPlan.create({ data: { ...input, tenantId: getTenantId()!, isDemo: !!opts.isDemo } });
};
export const listPlans = async () => {
    const [plans, counts] = await Promise.all([db.messPlan.findMany({ orderBy: { name: 'asc' } }), db.messSubscription.groupBy({ by: ['planId'], where: { status: 'active' }, _count: { _all: true } })]);
    return plans.map((p) => ({ ...p, members: counts.find((c) => c.planId === p.id)?._count._all ?? 0 }));
};

// ─── Menu ────────────────────────────────────────────────────────────────────

/** Which week of the cycle a date is in (weeks counted from Monday 1 January 2024) and its weekday (1 = Monday). */
export const cycleOf = (date: string, weeks: number) => {
    const days = Math.floor((dayDate(date).getTime() - Date.UTC(2024, 0, 1)) / DAY);
    return { week: (Math.floor(days / 7) % weeks) + 1, weekday: (days % 7) + 1 };
};

export const getMenu = async () => {
    const [{ weeks }, rows, specials, ms] = await Promise.all([getSettings({ weeks: MESS.menuWeeks }), db.messMenu.findMany({ orderBy: [{ week: 'asc' }, { weekday: 'asc' }] }), db.messSpecial.findMany({ where: { date: { gte: dayDate(addDays(todayIST(), -7)) } }, orderBy: { date: 'asc' } }), meals()]);
    return { weeks, thisWeek: cycleOf(todayIST(), weeks).week, meals: ms, rows: rows.map((r) => ({ week: r.week, weekday: r.weekday, mealId: r.mealId, items: r.items })), specials: specials.map((s) => ({ id: s.id, date: isoOf(s.date), mealId: s.mealId, items: s.items, note: s.note })) };
};

export const menuSchema = z.strictObject({ rows: z.array(z.strictObject({ week: z.number().int().min(1).max(4), weekday: z.number().int().min(1).max(7), mealId: z.uuid(), items: z.string().trim().max(300) })).max(4 * 7 * 10) });
export const saveMenu = async (input: z.infer<typeof menuSchema>, opts: { isDemo?: boolean } = {}) => {
    const rows = input.rows.filter((r) => r.items);
    await db.$transaction([db.messMenu.deleteMany({}), db.messMenu.createMany({ data: rows.map((r) => ({ ...r, tenantId: getTenantId()!, isDemo: !!opts.isDemo })) })]);
    return getMenu();
};

export const specialSchema = z.strictObject({ date: D, mealId: z.uuid(), items: z.string().trim().min(2).max(300), note: z.string().trim().max(100).nullable().optional() });
export const saveSpecial = async (input: z.infer<typeof specialSchema>, opts: { isDemo?: boolean } = {}) => {
    await db.messSpecial.upsert({ where: { tenantId_date_mealId: { tenantId: getTenantId()!, date: dayDate(input.date), mealId: input.mealId } }, create: { tenantId: getTenantId()!, date: dayDate(input.date), mealId: input.mealId, items: input.items, note: input.note || null, isDemo: !!opts.isDemo }, update: { items: input.items, note: input.note || null } });
    return getMenu();
};
export const deleteSpecial = async (id: string) => {
    await db.messSpecial.delete({ where: { id } });
    return getMenu();
};

/** What is served on each of these dates, meal by meal (a special day replaces the weekly menu). */
export const menuFor = async (dates: string[]) => {
    const [{ weeks }, rows, specials] = await Promise.all([getSettings({ weeks: MESS.menuWeeks }), db.messMenu.findMany(), db.messSpecial.findMany({ where: { date: { in: dates.map(dayDate) } } })]);
    return (date: string, mealId: string) => {
        const sp = specials.find((s) => isoOf(s.date) === date && s.mealId === mealId);
        if (sp) return { items: sp.items, special: sp.note || 'Special' };
        const c = cycleOf(date, weeks);
        return { items: rows.find((r) => r.week === c.week && r.weekday === c.weekday && r.mealId === mealId)?.items ?? '', special: null as string | null };
    };
};

// ─── Members ─────────────────────────────────────────────────────────────────

type Sub = { id: string; planId: string; studentId: string | null; staffId: string | null; fromDate: Date; toDate: Date | null; status: string; source: string };
const covers = (s: Sub, date: string) => isoOf(s.fromDate) <= date && (!s.toDate || isoOf(s.toDate) >= date);

/** Names, classes and codes of the people of these subscriptions. */
const people = async (subs: Sub[]) => {
    const year = await currentYear();
    const sIds = subs.map((s) => s.studentId).filter((x): x is string => !!x);
    const fIds = subs.map((s) => s.staffId).filter((x): x is string => !!x);
    const [st, en, sf, plans] = await Promise.all([
        db.student.findMany({ where: { id: { in: sIds } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, photoFileId: true } }),
        year ? db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: sIds } }, select: { studentId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } }) : [],
        db.staff.findMany({ where: { id: { in: fIds } }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true, photoFileId: true, designation: { select: { name: true } } } }),
        db.messPlan.findMany({ select: { id: true, name: true, mealIds: true } }),
    ]);
    return (s: Sub) => {
        const plan = plans.find((p) => p.id === s.planId);
        if (s.studentId) {
            const x = st.find((y) => y.id === s.studentId);
            const e = en.find((y) => y.studentId === s.studentId);
            return { kind: 'student' as const, personId: s.studentId, name: x ? fullName(x) : '', code: x?.admissionNo ?? '', sub: e ? sectionLabel(e.section) : '', photo: x?.photoFileId ? `students/${s.studentId}/photo?v=${x.photoFileId}` : null, plan: plan?.name ?? '', mealIds: plan?.mealIds ?? [] };
        }
        const x = sf.find((y) => y.id === s.staffId);
        return { kind: 'staff' as const, personId: s.staffId!, name: x ? staffName(x) : '', code: x?.employeeCode ?? '', sub: x?.designation?.name ?? 'Staff', photo: x?.photoFileId ? `staff/${s.staffId}/photo?v=${x.photoFileId}` : null, plan: plan?.name ?? '', mealIds: plan?.mealIds ?? [] };
    };
};

export const membersQuery = z.object({ show: z.enum(['active', 'all']).default('active'), planId: z.uuid().optional(), kind: z.enum(['student', 'staff', '']).default('') });
export const listMembers = async (q: z.infer<typeof membersQuery>) => {
    await syncBoarders();
    const subs = await db.messSubscription.findMany({ where: { ...(q.show === 'active' ? { status: 'active' } : {}), ...(q.planId ? { planId: q.planId } : {}), ...(q.kind === 'student' ? { studentId: { not: null } } : q.kind === 'staff' ? { staffId: { not: null } } : {}) }, orderBy: { createdAt: 'desc' }, take: 2000 });
    const who = await people(subs);
    return subs.map((s) => ({ id: s.id, ...who(s), from: isoOf(s.fromDate), to: s.toDate ? isoOf(s.toDate) : null, status: s.status, source: s.source })).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
};

export const findPeople = async (q: string) => {
    const t = q.trim();
    if (t.length < 2) return [];
    const [st, sf] = await Promise.all([
        db.student.findMany({ where: { status: 'active', OR: [{ firstName: { contains: t, mode: 'insensitive' } }, { lastName: { contains: t, mode: 'insensitive' } }, { admissionNo: { contains: t, mode: 'insensitive' } }] }, take: 10, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } }),
        db.staff.findMany({ where: { status: 'working', OR: [{ firstName: { contains: t, mode: 'insensitive' } }, { lastName: { contains: t, mode: 'insensitive' } }, { employeeCode: { contains: t, mode: 'insensitive' } }] }, take: 10, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true } }),
    ]);
    return [...st.map((s) => ({ kind: 'student' as const, id: s.id, name: fullName(s), code: s.admissionNo })), ...sf.map((s) => ({ kind: 'staff' as const, id: s.id, name: staffName(s), code: s.employeeCode }))];
};

export const subscribeSchema = z.strictObject({ planId: z.uuid(), studentIds: z.array(z.uuid()).max(500).default([]), staffIds: z.array(z.uuid()).max(500).default([]), fromDate: D });
/** Puts people on a plan from a date (their current plan, if any, ends the day before). */
export const subscribe = async (input: z.infer<typeof subscribeSchema>, userId: string | null, opts: { isDemo?: boolean; source?: string } = {}) => {
    const plan = await db.messPlan.findFirst({ where: { id: input.planId, isActive: true } });
    if (!plan) throw notFound('Plan not found');
    if (plan.forWho === 'students' && input.staffIds.length) throw badRequest(`${plan.name} is for students only`);
    if (plan.forWho === 'staff' && input.studentIds.length) throw badRequest(`${plan.name} is for staff only`);
    const year = await currentYear();
    if (!year) throw badRequest('No current session');
    const people = [...input.studentIds.map((id) => ({ studentId: id, staffId: null })), ...input.staffIds.map((id) => ({ studentId: null, staffId: id }))];
    if (!people.length) throw badRequest('Choose who to add');
    const current = await db.messSubscription.findMany({ where: { status: 'active', OR: [{ studentId: { in: input.studentIds } }, { staffId: { in: input.staffIds } }] } });
    const end = addDays(input.fromDate, -1);
    for (const c of current) {
        if (c.planId === plan.id) continue;
        await db.messSubscription.update({ where: { id: c.id }, data: { status: 'ended', toDate: dayDate(end < isoOf(c.fromDate) ? isoOf(c.fromDate) : end) } });
    }
    const keep = current.filter((c) => c.planId === plan.id);
    const add = people.filter((p) => !keep.some((k) => (p.studentId && k.studentId === p.studentId) || (p.staffId && k.staffId === p.staffId)));
    await db.messSubscription.createMany({ data: add.map((p) => ({ tenantId: getTenantId()!, planId: plan.id, ...p, academicYearId: year.id, fromDate: dayDate(input.fromDate), source: opts.source ?? 'manual', createdBy: userId, isDemo: !!opts.isDemo })) });
    if (userId) await recordAudit({ action: 'mess_subscribed', entity: 'mess_plan', entityId: plan.id, changes: { added: add.length, from: input.fromDate } });
    return { added: add.length, already: keep.length };
};

export const endSubscription = async (id: string, date: string) => {
    const s = await db.messSubscription.findFirst({ where: { id, status: 'active' } });
    if (!s) throw badRequest('Not an active member');
    await db.messSubscription.update({ where: { id }, data: { status: 'ended', toDate: dayDate(date < isoOf(s.fromDate) ? isoOf(s.fromDate) : date) } });
    return { ok: true };
};

/** Boarders on the boarders' plan: every student with a bed is a member; those who left the hostel stop. */
export const syncBoarders = async (opts: { isDemo?: boolean } = {}) => {
    const plan = await db.messPlan.findFirst({ where: { forBoarders: true, isActive: true } });
    if (!plan) return { added: 0, ended: 0 };
    const year = await currentYear();
    if (!year) return { added: 0, ended: 0 };
    const [allots, subs] = await Promise.all([db.hostelAllotment.findMany({ where: { academicYearId: year.id }, orderBy: { fromDate: 'asc' } }), db.messSubscription.findMany({ where: { status: 'active', studentId: { not: null } } })]);
    const active = allots.filter((a) => a.status === 'active');
    const add = active.filter((a) => !subs.some((s) => s.studentId === a.studentId));
    if (add.length) await db.messSubscription.createMany({ data: add.map((a) => ({ tenantId: getTenantId()!, planId: plan.id, studentId: a.studentId, academicYearId: year.id, fromDate: a.fromDate, source: 'hostel', isDemo: opts.isDemo || a.isDemo })) });
    let ended = 0;
    for (const s of subs.filter((x) => x.source === 'hostel' && !active.some((a) => a.studentId === x.studentId))) {
        const last = allots.filter((a) => a.studentId === s.studentId && a.toDate).pop();
        const to = last?.toDate ? isoOf(last.toDate) : todayIST();
        await db.messSubscription.update({ where: { id: s.id }, data: { status: 'ended', toDate: dayDate(to < isoOf(s.fromDate) ? isoOf(s.fromDate) : to) } });
        ended++;
    }
    return { added: add.length, ended };
};

// ─── Who eats: the headcount ─────────────────────────────────────────────────

/** Boarders away on hostel leave at a time. */
const awayAt = async (studentIds: string[], at: Date) => {
    if (!studentIds.length) return new Set<string>();
    const rows = await db.hostelLeave.findMany({ where: { studentId: { in: studentIds }, status: { in: ['approved', 'out', 'returned'] }, fromAt: { lte: at } }, select: { studentId: true, toAt: true, inAt: true, outAt: true, status: true } });
    // Approved: away for the pass; out: until they come back; returned: between going out and coming back.
    const isAway = (r: (typeof rows)[number]) => (r.status === 'approved' ? r.toAt >= at : r.status === 'out' ? true : !!r.outAt && !!r.inAt && r.outAt <= at && r.inAt >= at);
    return new Set(rows.filter(isAway).map((r) => r.studentId));
};

/** Everyone expected at a meal on a date: members whose plan has the meal, less skipped and away. */
export const expected = async (date: string, meal: Meal) => {
    const subs = (await db.messSubscription.findMany({ where: { fromDate: { lte: dayDate(date) }, OR: [{ toDate: null }, { toDate: { gte: dayDate(date) } }] } })).filter((s) => covers(s, date));
    const plans = await db.messPlan.findMany({ select: { id: true, mealIds: true } });
    const on = subs.filter((s) => plans.find((p) => p.id === s.planId)?.mealIds.includes(meal.id));
    const [skips, away, served] = await Promise.all([
        db.messSkip.findMany({ where: { date: dayDate(date), mealId: meal.id, subscriptionId: { in: on.map((s) => s.id) } }, select: { subscriptionId: true } }),
        awayAt(on.map((s) => s.studentId).filter((x): x is string => !!x), startOf(date, meal)),
        db.messServe.findMany({ where: { date: dayDate(date), mealId: meal.id } }),
    ]);
    return { subs: on, skipped: new Set(skips.map((s) => s.subscriptionId)), away, served };
};

export const today = async (date: string) => {
    await syncBoarders();
    const ms = await meals();
    const menu = await menuFor([date]);
    const out = [];
    for (const m of ms) {
        const e = await expected(date, m);
        const skipped = e.subs.filter((s) => e.skipped.has(s.id)).length;
        const away = e.subs.filter((s) => !e.skipped.has(s.id) && s.studentId && e.away.has(s.studentId)).length;
        const guests = e.served.filter((s) => !s.subscriptionId).reduce((a, s) => a + s.guests, 0);
        const ratings = await db.messRating.aggregate({ where: { date: dayDate(date), mealId: m.id }, _avg: { stars: true }, _count: { _all: true } });
        out.push({ ...m, ...menu(date, m.id), members: e.subs.length, skipped, away, cook: e.subs.length - skipped - away, served: e.served.filter((s) => s.subscriptionId).length, guests, rating: ratings._avg.stars ? Math.round(ratings._avg.stars * 10) / 10 : null, ratings: ratings._count._all, started: startOf(date, m) <= new Date() });
    }
    return { date, meals: out };
};

// ─── The counter ─────────────────────────────────────────────────────────────

export const counterList = async (date: string, mealId: string) => {
    const meal = (await meals()).find((m) => m.id === mealId);
    if (!meal) throw notFound('Meal not found');
    const e = await expected(date, meal);
    const who = await people(e.subs);
    const guestRows = e.served.filter((s) => !s.subscriptionId);
    return {
        meal,
        members: e.subs.map((s) => ({ subscriptionId: s.id, ...who(s), skipped: e.skipped.has(s.id), away: !!s.studentId && e.away.has(s.studentId), servedId: e.served.find((x) => x.subscriptionId === s.id)?.id ?? null, servedAt: e.served.find((x) => x.subscriptionId === s.id)?.at ?? null })).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
        guests: guestRows.map((g) => ({ id: g.id, name: g.guestName, guests: g.guests, amount: g.amount, payBy: g.payBy, at: g.at })),
    };
};

/** A scanned ID card (card no, admission no or employee code; a QR link's last part). */
const personOf = async (code: string) => {
    const t = code.trim().split(/[/=?#]/).filter(Boolean).pop() ?? '';
    const card = await db.idCard.findFirst({ where: { cardNo: { equals: t, mode: 'insensitive' } }, select: { studentId: true, staffId: true, status: true } });
    if (card) {
        if (card.status === 'cancelled') throw badRequest('This ID card is cancelled');
        return { studentId: card.studentId, staffId: card.staffId };
    }
    const st = await db.student.findFirst({ where: { admissionNo: { equals: t, mode: 'insensitive' } }, select: { id: true } });
    if (st) return { studentId: st.id, staffId: null };
    const sf = await db.staff.findFirst({ where: { employeeCode: { equals: t, mode: 'insensitive' } }, select: { id: true } });
    if (sf) return { studentId: null, staffId: sf.id };
    throw notFound(`No card or person with the code ${t}`);
};

export const serveSchema = z.strictObject({ date: D, mealId: z.uuid(), subscriptionId: z.uuid().optional(), code: z.string().trim().min(2).max(200).optional() });
export const serve = async (input: z.infer<typeof serveSchema>, userId: string, opts: { isDemo?: boolean; at?: Date } = {}) => {
    const meal = (await meals()).find((m) => m.id === input.mealId);
    if (!meal) throw notFound('Meal not found');
    let sub: Sub | null = null;
    if (input.subscriptionId) sub = await db.messSubscription.findFirst({ where: { id: input.subscriptionId } });
    else if (input.code) {
        const p = await personOf(input.code);
        const subs = await db.messSubscription.findMany({ where: p.studentId ? { studentId: p.studentId } : { staffId: p.staffId } });
        sub = subs.find((s) => covers(s, input.date)) ?? null;
        if (!sub) throw badRequest('Not a mess member on this day');
    } else throw badRequest('Scan a card or choose the member');
    if (!sub || !covers(sub, input.date)) throw badRequest('Not a mess member on this day');
    const plan = await db.messPlan.findFirst({ where: { id: sub.planId } });
    const who = (await people([sub]))(sub);
    if (!plan?.mealIds.includes(meal.id)) throw badRequest(`${who.name}’s plan (${plan?.name ?? ''}) does not have ${meal.name}`);
    const had = await db.messServe.findFirst({ where: { date: dayDate(input.date), mealId: meal.id, subscriptionId: sub.id } });
    if (had) throw badRequest(`${who.name} already had ${meal.name} at ${had.at.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', timeStyle: 'short' })}`);
    const skipped = await db.messSkip.findFirst({ where: { subscriptionId: sub.id, date: dayDate(input.date), mealId: meal.id } });
    await db.messServe.create({ data: { tenantId: getTenantId()!, date: dayDate(input.date), mealId: meal.id, subscriptionId: sub.id, by: userId, isDemo: !!opts.isDemo, ...(opts.at ? { at: opts.at } : {}) } });
    return { name: who.name, code: who.code, sub: who.sub, photo: who.photo, plan: who.plan, warning: skipped ? 'Had skipped this meal' : null };
};
export const unserve = async (id: string) => {
    await db.messServe.delete({ where: { id } });
    return { ok: true };
};

export const guestSchema = z.strictObject({ date: D, mealId: z.uuid(), guestName: z.string().trim().min(2).max(80), guests: z.number().int().min(1).max(100), payBy: z.enum(['cash', 'student', 'staff', 'free']), studentId: z.uuid().nullable().optional(), staffId: z.uuid().nullable().optional() });
export const addGuest = async (input: z.infer<typeof guestSchema>, userId: string, opts: { isDemo?: boolean; at?: Date } = {}) => {
    const meal = (await meals()).find((m) => m.id === input.mealId);
    if (!meal) throw notFound('Meal not found');
    if (input.payBy === 'student' && !input.studentId) throw badRequest('Choose the student it is charged to');
    if (input.payBy === 'staff' && !input.staffId) throw badRequest('Choose the staff member it is charged to');
    await db.messServe.create({ data: { tenantId: getTenantId()!, date: dayDate(input.date), mealId: meal.id, guestName: input.guestName, guests: input.guests, amount: input.payBy === 'free' ? 0 : meal.rate * input.guests, payBy: input.payBy, studentId: input.payBy === 'student' ? input.studentId! : null, staffId: input.payBy === 'staff' ? input.staffId! : null, by: userId, isDemo: !!opts.isDemo, ...(opts.at ? { at: opts.at } : {}) } });
    return { amount: input.payBy === 'free' ? 0 : meal.rate * input.guests };
};

// ─── Skipping meals and ratings (members, parents) ───────────────────────────

const myStudentIds = async (userId: string) => (await db.student.findMany({ where: { OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, select: { id: true } })).map((s) => s.id);
const myStaffId = async (userId: string) => (await db.staff.findFirst({ where: { userId }, select: { id: true } }))?.id ?? null;
const ownsSub = async (userId: string, s: Sub) => (s.studentId ? (await myStudentIds(userId)).includes(s.studentId) : s.staffId === (await myStaffId(userId)));

export const skipSchema = z.strictObject({ subscriptionId: z.uuid(), date: D, mealIds: z.array(z.uuid()).min(1).max(10), skip: z.boolean() });
export const setSkip = async (input: z.infer<typeof skipSchema>, userId: string, asManager: boolean) => {
    const s = await db.messSubscription.findFirst({ where: { id: input.subscriptionId } });
    if (!s || !covers(s, input.date)) throw badRequest('Not a member on that day');
    if (!asManager && !(await ownsSub(userId, s))) throw forbidden();
    const ms = await meals();
    const { cutoff } = await getSettings({ cutoff: MESS.cutoffHours });
    for (const mealId of input.mealIds) {
        const m = ms.find((x) => x.id === mealId);
        if (!m) throw notFound('Meal not found');
        if (!asManager && startOf(input.date, m).getTime() - cutoff * 3_600_000 < Date.now()) throw badRequest(`Too late to change ${m.name} on ${input.date} (up to ${cutoff} hours before)`);
        if (input.skip) await db.messSkip.upsert({ where: { subscriptionId_date_mealId: { subscriptionId: s.id, date: dayDate(input.date), mealId } }, create: { tenantId: getTenantId()!, subscriptionId: s.id, date: dayDate(input.date), mealId, createdBy: userId }, update: {} });
        else await db.messSkip.deleteMany({ where: { subscriptionId: s.id, date: dayDate(input.date), mealId } });
    }
    return { ok: true };
};

export const rateSchema = z.strictObject({ date: D, mealId: z.uuid(), stars: z.number().int().min(1).max(5), comment: z.string().trim().max(300).nullable().optional() });
export const rate = async (input: z.infer<typeof rateSchema>, userId: string, opts: { isDemo?: boolean } = {}) => {
    const { on } = await getSettings({ on: MESS.ratings });
    if (!on) throw forbidden('Ratings are off');
    const meal = (await meals()).find((m) => m.id === input.mealId);
    if (!meal) throw notFound('Meal not found');
    if (startOf(input.date, meal) > new Date()) throw badRequest('Rate a meal after it is served');
    if (input.date < addDays(todayIST(), -3)) throw badRequest('Rate meals of the last three days only');
    await db.messRating.upsert({ where: { tenantId_date_mealId_userId: { tenantId: getTenantId()!, date: dayDate(input.date), mealId: meal.id, userId } }, create: { tenantId: getTenantId()!, date: dayDate(input.date), mealId: meal.id, userId, stars: input.stars, comment: input.comment || null, isDemo: !!opts.isDemo }, update: { stars: input.stars, comment: input.comment || null, at: new Date() } });
    const agg = await db.messRating.aggregate({ where: { date: dayDate(input.date), mealId: meal.id }, _avg: { stars: true }, _count: { _all: true } });
    if (!opts.isDemo && agg._count._all >= 5 && (agg._avg.stars ?? 5) <= 2.5)
        raiseLater('mess_low_rating', { managers: () => holdersOf('mess.manage') }, { meal: meal.name, date: input.date, rating: (agg._avg.stars ?? 0).toFixed(1), count: String(agg._count._all) }, { dedupe: `mess-low:${input.date}:${meal.id}` });
    return { ok: true };
};

export const myMess = async (userId: string) => {
    const [sIds, staffId, ms, { cutoff }, { on: ratings }] = await Promise.all([myStudentIds(userId), myStaffId(userId), meals(), getSettings({ cutoff: MESS.cutoffHours }), getSettings({ on: MESS.ratings })]);
    await syncBoarders();
    const subs = await db.messSubscription.findMany({ where: { status: 'active', OR: [{ studentId: { in: sIds } }, ...(staffId ? [{ staffId }] : [])] } });
    const who = await people(subs);
    const t = todayIST();
    const days = Array.from({ length: 7 }, (_, i) => addDays(t, i));
    const menu = await menuFor(days);
    const now = Date.now();
    const out = [];
    for (const s of subs) {
        const w = who(s);
        const [skips, served, rated] = await Promise.all([
            db.messSkip.findMany({ where: { subscriptionId: s.id, date: { gte: dayDate(t) } }, select: { date: true, mealId: true } }),
            db.messServe.findMany({ where: { subscriptionId: s.id, date: { gte: dayDate(addDays(t, -13)) } }, orderBy: { date: 'desc' }, select: { date: true, mealId: true, at: true } }),
            db.messRating.findMany({ where: { userId, date: { gte: dayDate(addDays(t, -3)) } }, select: { date: true, mealId: true, stars: true } }),
        ]);
        const planMeals = ms.filter((m) => w.mealIds.includes(m.id));
        out.push({
            subscriptionId: s.id,
            ...w,
            since: isoOf(s.fromDate),
            meals: planMeals,
            week: days.map((d) => ({ date: d, meals: planMeals.map((m) => ({ mealId: m.id, ...menu(d, m.id), skipped: skips.some((k) => isoOf(k.date) === d && k.mealId === m.id), canChange: startOf(d, m).getTime() - cutoff * 3_600_000 > now })) })),
            served: served.map((x) => ({ date: isoOf(x.date), meal: ms.find((m) => m.id === x.mealId)?.name ?? '', at: x.at })),
            // Meals of the last three days they can rate (served to them, or for staff/students themselves).
            toRate: ratings && (s.staffId || s.studentId === (await db.student.findFirst({ where: { userId }, select: { id: true } }))?.id) ? served.filter((x) => isoOf(x.date) >= addDays(t, -3)).map((x) => ({ date: isoOf(x.date), mealId: x.mealId, meal: ms.find((m) => m.id === x.mealId)?.name ?? '', stars: rated.find((r) => isoOf(r.date) === isoOf(x.date) && r.mealId === x.mealId)?.stars ?? null })) : [],
        });
    }
    return { cutoff, members: out };
};

// ─── Kitchen cost ────────────────────────────────────────────────────────────

/** The store's issues to the kitchen department (less returns) per day. */
export const kitchenCost = async (from: string, to: string) => {
    const { dept } = await getSettings({ dept: MESS.kitchenDepartment });
    const d = await db.masterValue.findFirst({ where: { master: 'department', name: { equals: dept, mode: 'insensitive' } }, select: { id: true } });
    if (!d) return { department: null, days: new Map<string, number>() };
    const moves = await db.invMove.findMany({ where: { departmentId: d.id, kind: { in: ['issue', 'return'] }, at: { gte: dayDate(from), lt: new Date(dayDate(to).getTime() + DAY) } }, select: { at: true, qty: true, rate: true } });
    const days = new Map<string, number>();
    for (const m of moves) {
        const k = isoOf(new Date(m.at.getTime() + 5.5 * 3_600_000));
        days.set(k, (days.get(k) ?? 0) - m.qty * m.rate);
    }
    return { department: dept, days };
};

// ─── Charges: fees and payroll ───────────────────────────────────────────────

registerFeeSource(async (yearId, students, instalments) => {
    const out = new Map<string, { feeHeadId: string; instalmentId: string; amount: number }[]>();
    if (!students.length || !instalments.length) return out;
    const ids = students.map((s) => s.id);
    const [subs, guests] = await Promise.all([db.messSubscription.findMany({ where: { academicYearId: yearId, studentId: { in: ids } } }), db.messServe.findMany({ where: { payBy: 'student', studentId: { in: ids }, amount: { gt: 0 } }, select: { studentId: true, amount: true, date: true } })]);
    if (!subs.length && !guests.length) return out;
    const { c, perDay, minDays } = await getSettings({ c: MESS.feeHeadCode, perDay: MESS.rebatePerDay, minDays: MESS.rebateMinDays });
    const head = await db.masterValue.findFirst({ where: { master: 'fee_head', code: { equals: c, mode: 'insensitive' } }, select: { id: true } });
    if (!head) return out;
    const plans = await db.messPlan.findMany({ select: { id: true, fee: true } });
    const sorted = [...instalments].sort((x, y) => x.dueDate.getTime() - y.dueDate.getTime());
    const add = (studentId: string, instalmentId: string, amount: number) => {
        const lines = out.get(studentId) ?? [];
        const same = lines.find((l) => l.instalmentId === instalmentId);
        if (same) same.amount += amount;
        else lines.push({ feeHeadId: head.id, instalmentId, amount });
        out.set(studentId, lines);
    };
    for (const inst of sorted)
        for (const s of subs) {
            const due = isoOf(inst.dueDate);
            const from = isoOf(new Date(s.fromDate.getTime() - 15 * DAY));
            if (due >= from && (!s.toDate || due <= isoOf(s.toDate))) add(s.studentId!, inst.id, plans.find((p) => p.id === s.planId)?.fee ?? 0);
        }
    for (const g of guests) {
        const inst = sorted.find((i) => i.dueDate >= g.date) ?? sorted[sorted.length - 1];
        add(g.studentId!, inst.id, g.amount);
    }
    // Rebate for long hostel leave, off the first instalment after they came back that has a mess charge.
    if (perDay > 0) {
        const leaves = await db.hostelLeave.findMany({ where: { status: 'returned', studentId: { in: subs.map((s) => s.studentId!) } }, select: { studentId: true, outAt: true, inAt: true } });
        for (const l of leaves) {
            if (!l.outAt || !l.inAt) continue;
            const days = Math.floor((l.inAt.getTime() - l.outAt.getTime()) / DAY);
            if (days < minDays) continue;
            let left = days * perDay;
            for (const line of (out.get(l.studentId) ?? []).filter((x) => (sorted.find((i) => i.id === x.instalmentId)?.dueDate ?? new Date(0)) >= l.inAt!)) {
                const cut = Math.min(line.amount, left);
                line.amount -= cut;
                left -= cut;
                if (!left) break;
            }
        }
        for (const [k, lines] of out) out.set(k, lines.filter((l) => l.amount > 0));
    }
    return out;
});

registerPayrollDeduction(async (month, staffIds) => {
    const out = new Map<string, { code: string; name: string; amount: number }[]>();
    const { on } = await getSettings({ on: MESS.staffPayroll });
    if (!on || !staffIds.length) return out;
    const [y, m] = month.split('-').map(Number);
    const from = `${month}-01`;
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const to = `${month}-${String(days).padStart(2, '0')}`;
    const [subs, guests, plans] = await Promise.all([
        db.messSubscription.findMany({ where: { staffId: { in: staffIds }, fromDate: { lte: dayDate(to) }, OR: [{ toDate: null }, { toDate: { gte: dayDate(from) } }] } }),
        db.messServe.findMany({ where: { payBy: 'staff', staffId: { in: staffIds }, amount: { gt: 0 }, date: { gte: dayDate(from), lte: dayDate(to) } }, select: { staffId: true, amount: true } }),
        db.messPlan.findMany({ select: { id: true, name: true, monthly: true } }),
    ]);
    const push = (staffId: string, name: string, amount: number) => {
        if (amount <= 0) return;
        const lines = out.get(staffId) ?? [];
        lines.push({ code: 'MESS', name, amount });
        out.set(staffId, lines);
    };
    for (const s of subs) {
        const p = plans.find((x) => x.id === s.planId);
        if (!p?.monthly) continue;
        const a = isoOf(s.fromDate) > from ? isoOf(s.fromDate) : from;
        const b = s.toDate && isoOf(s.toDate) < to ? isoOf(s.toDate) : to;
        const n = Math.round((dayDate(b).getTime() - dayDate(a).getTime()) / DAY) + 1;
        push(s.staffId!, `Mess: ${p.name}${n < days ? ` (${n} days)` : ''}`, Math.round((p.monthly * n) / days));
    }
    const g = new Map<string, number>();
    for (const x of guests) g.set(x.staffId!, (g.get(x.staffId!) ?? 0) + x.amount);
    for (const [id, amt] of g) push(id, 'Mess: guest meals', amt);
    return out;
});

// ─── Daily: boarders onto the plan, the morning headcount ────────────────────

defineDailyJob({
    key: 'mess_morning',
    at: async () => '06:00',
    run: async () => {
        const sync = await syncBoarders();
        const t = await today(todayIST());
        if (t.meals.length) raiseLater('mess_headcount', { managers: () => holdersOf('mess.manage') }, { date: t.date, list: t.meals.map((m) => `- ${m.name}: ${m.cook} (members ${m.members}, skipped ${m.skipped}, away ${m.away})`).join('\n') }, { dedupe: `mess-head:${t.date}` });
        return `${sync.added} boarders added, ${sync.ended} ended; headcount sent`;
    },
});
