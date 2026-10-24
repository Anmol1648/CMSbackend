import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { daysOff } from '../attendance/calendar.service';
import { raiseLater } from '../alerts/deliver';
import { holdersOf, staffOf } from '../alerts/recipients';
import { PAYROLL, PT_SLABS } from './payroll.settings';

/**
 * Payroll. A staff member's salary (basic + heads as amounts or % of basic) is worked out for a month
 * from the days they are paid for: the school calendar, approved leave (paid / without pay),
 * attendance (absent, half days, late marks) and joining / leaving dates. PF, ESI, professional tax,
 * TDS and loan instalments are deducted; one-time additions and deductions are added. A month is
 * prepared, approved and finalised (locked; loans are recovered then).
 */

export type Mode = 'fixed' | 'pct_basic' | 'pct_basic_da';
export type Line = { headId: string; mode: Mode; value: number };
type Head = { id: string; name: string; code: string; kind: 'earning' | 'deduction'; pf: boolean; order: number };
type Amount = { code: string; name: string; full?: number; amount: number };

export const r2 = (n: number) => Math.round(n * 100) / 100;
const staffName = (s: { firstName: string; middleName?: string | null; lastName?: string | null }) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');
export const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'choose a month');
export const monthRange = (m: string) => {
    const [y, mo] = m.split('-').map(Number);
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, '0')}`, days: last };
};
export const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const nextMonth = (m: string) => {
    const [y, mo] = m.split('-').map(Number);
    return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
};

export const heads = async (): Promise<Head[]> =>
    (await db.masterValue.findMany({ where: { master: 'pay_head', isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, code: true, extra: true, sortOrder: true } })).map((h) => {
        const x = (h.extra ?? {}) as { kind?: string; pf?: boolean };
        return { id: h.id, name: h.name, code: (h.code ?? '').toUpperCase(), kind: x.kind === 'deduction' ? 'deduction' : 'earning', pf: !!x.pf, order: h.sortOrder };
    });

/** The full monthly amounts of a salary: earnings (basic first) and fixed deductions. */
export const fullAmounts = (basic: number, lines: Line[], hs: Head[]) => {
    const byId = new Map(hs.map((h) => [h.id, h]));
    const basicHead = hs.find((h) => h.code === 'BASIC');
    const daLine = lines.find((l) => byId.get(l.headId)?.code === 'DA');
    const da = !daLine ? 0 : daLine.mode === 'fixed' ? daLine.value : (basic * daLine.value) / 100;
    const earnings: (Amount & { headId: string; pf: boolean })[] = basicHead ? [{ headId: basicHead.id, code: 'BASIC', name: basicHead.name, amount: r2(basic), pf: true }] : [];
    const deductions: Amount[] = [];
    for (const l of lines) {
        const h = byId.get(l.headId);
        if (!h || h.code === 'BASIC') continue;
        const amt = r2(l.mode === 'fixed' ? l.value : l.mode === 'pct_basic' ? (basic * l.value) / 100 : ((basic + da) * l.value) / 100);
        if (h.kind === 'earning') earnings.push({ headId: h.id, code: h.code, name: h.name, amount: h.code === 'DA' ? r2(da) : amt, pf: h.pf });
        else if (!['PF', 'ESI', 'PT', 'TDS', 'LOAN', 'ADV'].includes(h.code)) deductions.push({ code: h.code, name: h.name, amount: amt });
    }
    return { earnings, deductions, gross: r2(earnings.reduce((a, e) => a + e.amount, 0)) };
};

/** Each staff member's salary in force on a day (the latest from on or before it). */
export const salariesOn = async (iso: string, staffIds?: string[]) => {
    const rows = await db.staffSalary.findMany({ where: { effectiveFrom: { lte: dayDate(iso) }, ...(staffIds ? { staffId: { in: staffIds } } : {}) }, orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }] });
    const out = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!out.has(r.staffId)) out.set(r.staffId, r);
    return out;
};

// ─── Structures ──────────────────────────────────────────────────────────────

export const lineSchema = z.strictObject({ headId: z.uuid(), mode: z.enum(['fixed', 'pct_basic', 'pct_basic_da']), value: z.number().min(0).max(10_000_000) });
export const structureSchema = z.strictObject({ name: z.string().trim().min(2).max(80), lines: z.array(lineSchema).max(40), isActive: z.boolean().default(true) });
export const listStructures = async () => (await db.salaryStructure.findMany({ orderBy: { name: 'asc' } })).map((s) => ({ ...s, lines: s.lines as Line[] }));
export const saveStructure = async (id: string | null, input: z.infer<typeof structureSchema>) => {
    if (id) await db.salaryStructure.update({ where: { id }, data: input });
    else await db.salaryStructure.create({ data: { ...input, tenantId: getTenantId()! } });
    return listStructures();
};
export const deleteStructure = async (id: string) => {
    if (await db.staffSalary.count({ where: { structureId: id } })) await db.salaryStructure.update({ where: { id }, data: { isActive: false } });
    else await db.salaryStructure.delete({ where: { id } });
    return listStructures();
};

// ─── Staff salaries ──────────────────────────────────────────────────────────

export const salaryList = async () => {
    const [staff, current, hs, structures, l] = await Promise.all([
        db.staff.findMany({ where: { status: 'working' }, orderBy: { firstName: 'asc' }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true, designationId: true, departmentId: true, bankAccountNo: true, ifsc: true } }),
        salariesOn(todayIST()),
        heads(),
        db.salaryStructure.findMany({ select: { id: true, name: true } }),
        db.masterValue.findMany({ where: { master: { in: ['designation', 'department'] } }, select: { id: true, name: true } }),
    ]);
    const name = (id: string | null) => (id ? (l.find((x) => x.id === id)?.name ?? '') : '');
    return staff.map((s) => {
        const sal = current.get(s.id);
        const f = sal ? fullAmounts(sal.basic, sal.lines as Line[], hs) : null;
        return { staffId: s.id, name: staffName(s), employeeCode: s.employeeCode, designation: name(s.designationId), department: name(s.departmentId), bank: !!s.bankAccountNo && !!s.ifsc, salary: sal ? { id: sal.id, basic: sal.basic, gross: f!.gross, structure: structures.find((x) => x.id === sal.structureId)?.name ?? 'Custom', effectiveFrom: isoOf(sal.effectiveFrom), pf: sal.pf, esi: sal.esi, tds: sal.tdsMonthly } : null };
    });
};

export const staffSalary = async (staffId: string) => {
    const [s, history, hs] = await Promise.all([db.staff.findFirst({ where: { id: staffId }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true, bankAccountNo: true, ifsc: true, pan: true, uan: true, pfNumber: true } }), db.staffSalary.findMany({ where: { staffId }, orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }] }), heads()]);
    if (!s) throw notFound('Staff member not found');
    return {
        staff: { id: s.id, name: staffName(s), employeeCode: s.employeeCode, bank: s.bankAccountNo ? `…${s.bankAccountNo.slice(-4)} · ${s.ifsc ?? ''}` : null, pan: s.pan, uan: s.uan, pfNumber: s.pfNumber },
        history: history.map((h) => ({ ...h, effectiveFrom: isoOf(h.effectiveFrom), lines: h.lines as Line[], ...fullAmounts(h.basic, h.lines as Line[], hs) })),
    };
};

export const salarySchema = z.strictObject({
    structureId: z.uuid().nullable().optional(),
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    basic: z.number().min(0).max(10_000_000),
    lines: z.array(lineSchema).max(40),
    tdsMonthly: z.number().min(0).max(10_000_000).default(0),
    pf: z.boolean(),
    esi: z.boolean(),
    esiNumber: z.string().trim().max(30).nullable().optional(),
    reason: z.enum(['new', 'revision', 'increment']).default('revision'),
    note: z.string().trim().max(300).nullable().optional(),
});

/** Arrears for months already finalised since a backdated change: the extra pay, by the days paid then. */
const arrearsFor = async (staffId: string, from: string, newGross: (iso: string) => Promise<number>) => {
    const fromMonth = from.slice(0, 7);
    const slips = await db.payslip.findMany({ where: { staffId, run: { status: 'finalised', month: { gte: fromMonth } } }, include: { run: { select: { month: true } } } });
    let total = 0;
    for (const s of slips) {
        const full = await newGross(`${s.run.month}-01`);
        const earned = (s.earnings as Amount[]).filter((e) => e.code !== 'ARR' && e.code !== 'BONUS').reduce((a, e) => a + (e.full ?? e.amount), 0);
        if (full > earned) total += ((full - earned) * s.paidDays) / s.totalDays;
    }
    return r2(total);
};

/** The first month not yet finalised (where arrears and adjustments go). */
const openMonth = async () => {
    const last = await db.payrollRun.findFirst({ where: { status: 'finalised' }, orderBy: { month: 'desc' }, select: { month: true } });
    return last ? nextMonth(last.month) : todayIST().slice(0, 7);
};

export const saveSalary = async (staffId: string, input: z.infer<typeof salarySchema>, userId: string, opts: { isDemo?: boolean; noArrears?: boolean } = {}) => {
    if (!(await db.staff.findFirst({ where: { id: staffId }, select: { id: true } }))) throw notFound('Staff member not found');
    const hs = await heads();
    const before = (await salariesOn(input.effectiveFrom, [staffId])).get(staffId);
    const row = await db.staffSalary.create({ data: { tenantId: getTenantId()!, staffId, structureId: input.structureId ?? null, effectiveFrom: dayDate(input.effectiveFrom), basic: input.basic, lines: input.lines, tdsMonthly: input.tdsMonthly, pf: input.pf, esi: input.esi, esiNumber: input.esiNumber || null, reason: input.reason, note: input.note || null, createdBy: userId, isDemo: !!opts.isDemo } });
    await recordAudit({ action: 'salary_changed', entity: 'staff', entityId: staffId, changes: { from: input.effectiveFrom, basic: [before?.basic ?? null, input.basic], reason: input.reason } });
    // Backdated into finalised months: the difference becomes arrears in the next open month.
    let arrears = 0;
    if (!opts.noArrears && before) {
        arrears = await arrearsFor(staffId, input.effectiveFrom, async () => fullAmounts(input.basic, input.lines, hs).gross);
        if (arrears > 0) await db.payrollAdjustment.create({ data: { tenantId: getTenantId()!, staffId, month: await openMonth(), kind: 'earning', label: `Arrears from ${monthLabel(input.effectiveFrom.slice(0, 7))}`, amount: arrears, source: 'arrears', createdBy: userId, isDemo: !!opts.isDemo } });
    }
    return { id: row.id, arrears };
};

export const incrementSchema = z.strictObject({ staffIds: z.array(z.uuid()).min(1).max(1000), effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), percent: z.number().min(0).max(100).default(0), amount: z.number().min(0).max(1_000_000).default(0), note: z.string().trim().max(300).nullable().optional() });
/** An increment to many: basic up by a % and / or an amount (allowances in % follow; fixed ones stay). */
export const giveIncrements = async (input: z.infer<typeof incrementSchema>, userId: string, opts: { isDemo?: boolean } = {}) => {
    if (!input.percent && !input.amount) throw badRequest('Give the % or the amount');
    const current = await salariesOn(input.effectiveFrom, input.staffIds);
    let done = 0;
    let arrears = 0;
    for (const id of input.staffIds) {
        const c = current.get(id);
        if (!c) continue;
        const basic = Math.round(c.basic * (1 + input.percent / 100) + input.amount);
        const r = await saveSalary(id, { structureId: c.structureId, effectiveFrom: input.effectiveFrom, basic, lines: c.lines as Line[], tdsMonthly: c.tdsMonthly, pf: c.pf, esi: c.esi, esiNumber: c.esiNumber, reason: 'increment', note: input.note || `Increment${input.percent ? ` ${input.percent}%` : ''}${input.amount ? ` + ₹${input.amount}` : ''}` }, userId, opts);
        arrears += r.arrears;
        done++;
    }
    return { done, skipped: input.staffIds.length - done, arrears: r2(arrears) };
};

// ─── Days ────────────────────────────────────────────────────────────────────

/** How many days of a month each staff member is paid for, and why. */
export const daysFor = async (month: string, staff: { id: string; joiningDate: Date; status: string; statusDate: Date | null }[]) => {
    const { from, to, days } = monthRange(month);
    const s = await getSettings({ method: PAYROLL.daysMethod, noRecord: PAYROLL.noRecord, lateRule: PAYROLL.lateRule });
    const [off, att, leaves, statuses] = await Promise.all([
        daysOff(from, to, 'staff'),
        db.staffAttendance.findMany({ where: { date: { gte: dayDate(from), lte: dayDate(to) }, staffId: { in: staff.map((x) => x.id) } }, select: { staffId: true, date: true, statusId: true, late: true } }),
        db.staffLeave.findMany({ where: { status: 'approved', staffId: { in: staff.map((x) => x.id) }, fromDate: { lte: dayDate(to) }, toDate: { gte: dayDate(from) } }, include: { leaveType: { select: { paid: true } } } }),
        db.masterValue.findMany({ where: { master: 'attendance_status' }, select: { id: true, extra: true } }),
    ]);
    const present = new Map(statuses.map((x) => [x.id, ((x.extra ?? {}) as { present?: number; excused?: boolean })]));
    const today = todayIST();
    const all: string[] = [];
    for (let t = dayDate(from).getTime(); t <= dayDate(to).getTime(); t += 86_400_000) all.push(isoOf(new Date(t)));
    const working = all.filter((d) => !off.has(d));
    const totalDays = s.method === 'calendar' ? days : s.method === 'fixed30' ? 30 : working.length;
    const out = new Map<string, { totalDays: number; paidDays: number; days: { present: number; paidLeave: number; lwp: number; absent: number; lates: number; latePenalty: number; notJoined: number } }>();
    for (const st of staff) {
        const join = isoOf(st.joiningDate);
        const left = st.status !== 'working' && st.statusDate ? isoOf(st.statusDate) : null;
        const d = { present: 0, paidLeave: 0, lwp: 0, absent: 0, lates: 0, latePenalty: 0, notJoined: 0 };
        // Days outside employment: every calendar day (or working day for the "working days" method).
        for (const day of s.method === 'working' ? working : all) if (day < join || (left && day > left)) d.notJoined++;
        for (const day of working) {
            if (day < join || (left && day > left)) continue;
            const lv = leaves.find((x) => x.staffId === st.id && isoOf(x.fromDate) <= day && isoOf(x.toDate) >= day);
            const a = att.find((x) => x.staffId === st.id && isoOf(x.date) === day);
            if (a?.late) d.lates++;
            if (lv) {
                const f = lv.half ? 0.5 : 1;
                const unpaidShare = !lv.leaveType.paid ? 1 : lv.days > 0 ? Math.min(1, lv.lwpDays / lv.days) : 0;
                d.paidLeave += f * (1 - unpaidShare);
                d.lwp += f * unpaidShare;
                d.present += 1 - f;
                continue;
            }
            if (day > today) {
                d.present += 1;
                continue;
            }
            if (a?.statusId) {
                const p = present.get(a.statusId) ?? { present: 1 };
                const v = Number(p.present ?? 1);
                if (p.excused) d.paidLeave += 1;
                else {
                    d.present += v;
                    d.absent += 1 - v;
                }
                continue;
            }
            if (s.noRecord === 'absent') d.absent += 1;
            else d.present += 1;
        }
        d.latePenalty = s.lateRule > 0 ? Math.floor(d.lates / s.lateRule) * 0.5 : 0;
        const unpaid = d.lwp + d.absent + d.latePenalty + d.notJoined;
        out.set(st.id, { totalDays, paidDays: Math.max(0, r2(totalDays - unpaid)), days: { ...d, present: r2(d.present), paidLeave: r2(d.paidLeave), lwp: r2(d.lwp), absent: r2(d.absent) } });
    }
    return { totalDays, working: working.length, out };
};

// ─── The month's payroll ─────────────────────────────────────────────────────

const ptFor = (state: string, gross: number) => {
    const slabs = (PT_SLABS[state] ?? PT_SLABS.none).slabs;
    return slabs.find((x) => x.upto === null || gross <= x.upto)?.tax ?? 0;
};
const roundNet = (n: number, how: string) => (how === 'rupee' ? Math.round(n) : how === 'ten' ? Math.round(n / 10) * 10 : r2(n));

type OutsideDeduction = { code: string; name: string; amount: number };
const deductionSources: ((month: string, staffIds: string[]) => Promise<Map<string, OutsideDeduction[]>>)[] = [];
/** Other modules add their charges to the payslip as deductions (e.g. the mess bill). */
export const registerPayrollDeduction = (source: (month: string, staffIds: string[]) => Promise<Map<string, OutsideDeduction[]>>) => deductionSources.push(source);

/** Works out (or again) every payslip of a month; a finalised month cannot be prepared again. */
export const prepare = async (month: string, userId: string, opts: { isDemo?: boolean; at?: Date } = {}) => {
    const run = await db.payrollRun.findFirst({ where: { month } });
    if (run?.status === 'finalised') throw badRequest(`${monthLabel(month)} is finalised. Reopen it first.`);
    const { from, to } = monthRange(month);
    const [staff, salaries, hs, s, loans, adjustments, banks] = await Promise.all([
        db.staff.findMany({ where: { joiningDate: { lte: dayDate(to) }, OR: [{ status: 'working' }, { statusDate: { gte: dayDate(from) } }] }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true, joiningDate: true, status: true, statusDate: true, bankId: true, bankAccountNo: true, ifsc: true } }),
        salariesOn(to),
        heads(),
        getSettings({ pf: PAYROLL.pf, pfRate: PAYROLL.pfRate, pfCap: PAYROLL.pfCap, esi: PAYROLL.esi, esiE: PAYROLL.esiEmployee, esiR: PAYROLL.esiEmployer, esiLimit: PAYROLL.esiLimit, pt: PAYROLL.ptState, rounding: PAYROLL.rounding }),
        db.staffLoan.findMany({ where: { status: 'active', startMonth: { lte: month } } }),
        db.payrollAdjustment.findMany({ where: { month } }),
        db.masterValue.findMany({ where: { master: 'bank' }, select: { id: true, name: true } }),
    ]);
    const paid = staff.filter((x) => salaries.has(x.id));
    const missing = staff.filter((x) => !salaries.has(x.id)).map((x) => staffName(x));
    const { totalDays, out } = await daysFor(month, paid);
    const outside = await Promise.all(deductionSources.map((f) => f(month, paid.map((x) => x.id))));
    const head = (code: string) => hs.find((h) => h.code === code);
    const r = run ?? (await db.payrollRun.create({ data: { tenantId: getTenantId()!, month, totalDays, preparedBy: userId, isDemo: !!opts.isDemo, ...(opts.at ? { preparedAt: opts.at } : {}) } }));
    if (run) await db.payrollRun.update({ where: { id: run.id }, data: { status: 'prepared', totalDays, preparedBy: userId, preparedAt: opts.at ?? new Date(), approvedBy: null, approvedAt: null } });
    await db.payslip.deleteMany({ where: { runId: r.id } });
    const rows = [];
    for (const st of paid) {
        const sal = salaries.get(st.id)!;
        const dd = out.get(st.id)!;
        const ratio = dd.totalDays ? dd.paidDays / dd.totalDays : 0;
        const f = fullAmounts(sal.basic, sal.lines as Line[], hs);
        const earnings: Amount[] = f.earnings.map((e) => ({ code: e.code, name: e.name, full: e.amount, amount: r2(e.amount * ratio) }));
        for (const a of adjustments.filter((x) => x.staffId === st.id && x.kind === 'earning')) earnings.push({ code: a.source === 'arrears' ? 'ARR' : 'ADJ', name: a.label, amount: r2(a.amount) });
        const gross = r2(earnings.reduce((a, e) => a + e.amount, 0));
        const deductions: Amount[] = [];
        const employer: Record<string, number> = {};
        if (s.pf && sal.pf) {
            const wage = f.earnings.filter((e) => e.pf).reduce((a, e) => a + e.amount * ratio, 0);
            const base = s.pfCap > 0 ? Math.min(wage, s.pfCap) : wage;
            const pf = Math.round((base * s.pfRate) / 100);
            if (pf > 0) {
                deductions.push({ code: 'PF', name: head('PF')?.name ?? 'Provident fund', amount: pf });
                employer.pf = pf;
                employer.pfWage = Math.round(base);
            }
        }
        if (s.esi && sal.esi && f.gross <= s.esiLimit && gross > 0) {
            const e = Math.ceil((gross * s.esiE) / 100);
            deductions.push({ code: 'ESI', name: head('ESI')?.name ?? 'ESI', amount: e });
            employer.esi = Math.ceil((gross * s.esiR) / 100);
        }
        const pt = ptFor(s.pt, gross);
        if (pt > 0) deductions.push({ code: 'PT', name: head('PT')?.name ?? 'Professional tax', amount: pt });
        if (sal.tdsMonthly > 0 && dd.paidDays > 0) deductions.push({ code: 'TDS', name: head('TDS')?.name ?? 'Income tax (TDS)', amount: r2(sal.tdsMonthly) });
        for (const d of f.deductions) deductions.push(d);
        for (const l of loans.filter((x) => x.staffId === st.id)) {
            const amt = r2(Math.min(l.emi, l.balance));
            if (amt > 0) deductions.push({ code: l.kind === 'advance' ? 'ADV' : 'LOAN', name: `${l.kind === 'advance' ? (head('ADV')?.name ?? 'Salary advance') : (head('LOAN')?.name ?? 'Loan instalment')} (balance ₹${r2(l.balance - amt)})`, amount: amt, full: l.balance });
        }
        for (const a of adjustments.filter((x) => x.staffId === st.id && x.kind === 'deduction')) deductions.push({ code: 'ADJ', name: a.label, amount: r2(a.amount) });
        for (const m of outside) for (const d of m.get(st.id) ?? []) if (d.amount > 0) deductions.push({ ...d, amount: r2(d.amount) });
        const deducted = r2(deductions.reduce((a, x) => a + x.amount, 0));
        const net = roundNet(gross - deducted, s.rounding);
        const warnings = [...(!st.bankAccountNo || !st.ifsc ? ['No bank account'] : []), ...(net <= 0 ? ['Net pay is zero or less'] : []), ...(dd.paidDays < dd.totalDays / 2 ? ['Paid for less than half the month'] : [])];
        rows.push({ tenantId: getTenantId()!, runId: r.id, staffId: st.id, totalDays: dd.totalDays, paidDays: dd.paidDays, days: dd.days, earnings, deductions, employer, gross, deducted, net, bank: { bank: banks.find((b) => b.id === st.bankId)?.name ?? '', accountNo: st.bankAccountNo ?? '', ifsc: st.ifsc ?? '' }, warnings, isDemo: !!opts.isDemo });
    }
    if (rows.length) await db.payslip.createMany({ data: rows });
    const { approval } = await getSettings({ approval: PAYROLL.approval });
    if (approval && !opts.isDemo) raiseLater('payroll_prepared', { approvers: () => holdersOf('payroll.approve') }, { month: monthLabel(month), staff: String(rows.length), net: String(Math.round(rows.reduce((a, x) => a + x.net, 0))) }, { dedupe: `payroll:${month}:${Date.now()}` });
    return { ...(await runView(month)), missing };
};

export const runView = async (month: string) => {
    const run = await db.payrollRun.findFirst({ where: { month }, include: { slips: true } });
    if (!run) return { month, label: monthLabel(month), run: null, slips: [], totals: null, missing: [] as string[] };
    const [staff, users, l] = await Promise.all([
        db.staff.findMany({ where: { id: { in: run.slips.map((s) => s.staffId) } }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true, departmentId: true, designationId: true } }),
        db.user.findMany({ where: { id: { in: [run.preparedBy, run.approvedBy].filter((x): x is string => !!x) } }, select: { id: true, displayName: true } }),
        db.masterValue.findMany({ where: { master: { in: ['department', 'designation'] } }, select: { id: true, name: true } }),
    ]);
    const name = (id: string | null) => (id ? (l.find((x) => x.id === id)?.name ?? '') : '');
    const slips = run.slips
        .map((p) => {
            const st = staff.find((x) => x.id === p.staffId);
            return { id: p.id, staffId: p.staffId, name: st ? staffName(st) : '', employeeCode: st?.employeeCode ?? '', department: name(st?.departmentId ?? null), designation: name(st?.designationId ?? null), totalDays: p.totalDays, paidDays: p.paidDays, days: p.days as Record<string, number>, earnings: p.earnings as Amount[], deductions: p.deductions as Amount[], employer: p.employer as Record<string, number>, gross: p.gross, deducted: p.deducted, net: p.net, bank: p.bank as { bank: string; accountNo: string; ifsc: string }, warnings: p.warnings };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    const sum = (f: (s: (typeof slips)[number]) => number) => r2(slips.reduce((a, s) => a + f(s), 0));
    return {
        month,
        label: monthLabel(month),
        run: { id: run.id, status: run.status, totalDays: run.totalDays, preparedBy: users.find((u) => u.id === run.preparedBy)?.displayName ?? '', preparedAt: run.preparedAt, approvedBy: users.find((u) => u.id === run.approvedBy)?.displayName ?? '', approvedAt: run.approvedAt, finalisedAt: run.finalisedAt, reopenReason: run.reopenReason },
        slips,
        totals: { staff: slips.length, gross: sum((s) => s.gross), deducted: sum((s) => s.deducted), net: sum((s) => s.net), pfEmployee: sum((s) => s.deductions.find((d) => d.code === 'PF')?.amount ?? 0), pfEmployer: sum((s) => s.employer.pf ?? 0), esiEmployee: sum((s) => s.deductions.find((d) => d.code === 'ESI')?.amount ?? 0), esiEmployer: sum((s) => s.employer.esi ?? 0), tds: sum((s) => s.deductions.find((d) => d.code === 'TDS')?.amount ?? 0), warnings: slips.filter((s) => s.warnings.length).length },
        missing: [] as string[],
    };
};

export const runsList = async () => (await db.payrollRun.findMany({ orderBy: { month: 'desc' }, take: 24, include: { slips: { select: { net: true, gross: true } } } })).map((r) => ({ month: r.month, label: monthLabel(r.month), status: r.status, staff: r.slips.length, gross: r2(r.slips.reduce((a, s) => a + s.gross, 0)), net: r2(r.slips.reduce((a, s) => a + s.net, 0)), finalisedAt: r.finalisedAt }));

export const approve = async (month: string, userId: string) => {
    const run = await db.payrollRun.findFirst({ where: { month } });
    if (!run || run.status !== 'prepared') throw badRequest('Prepare the month first');
    await db.payrollRun.update({ where: { id: run.id }, data: { status: 'approved', approvedBy: userId, approvedAt: new Date() } });
    await recordAudit({ action: 'payroll_approved', entity: 'payroll_run', entityId: run.id, changes: { month } });
    return runView(month);
};

/** Locks the month: loan instalments are recovered and staff can see their payslips. */
export const finalise = async (month: string, userId: string, opts: { isDemo?: boolean; at?: Date } = {}) => {
    const run = await db.payrollRun.findFirst({ where: { month }, include: { slips: true } });
    if (!run) throw badRequest('Prepare the month first');
    const { approval } = await getSettings({ approval: PAYROLL.approval });
    if (run.status === 'finalised') throw badRequest('Already finalised');
    if (approval && run.status !== 'approved') throw badRequest('The month must be approved first (System Settings → Payroll)');
    const loans = await db.staffLoan.findMany({ where: { status: 'active', startMonth: { lte: month } } });
    for (const l of loans) {
        const slip = run.slips.find((s) => s.staffId === l.staffId);
        if (!slip) continue;
        const paid = Math.min(l.emi, l.balance);
        const balance = r2(l.balance - paid);
        await db.staffLoan.update({ where: { id: l.id }, data: { balance, status: balance <= 0 ? 'closed' : 'active' } });
    }
    await db.payrollRun.update({ where: { id: run.id }, data: { status: 'finalised', finalisedAt: opts.at ?? new Date(), ...(approval ? {} : { approvedBy: userId, approvedAt: new Date() }) } });
    await recordAudit({ action: 'payroll_finalised', entity: 'payroll_run', entityId: run.id, changes: { month, staff: run.slips.length } });
    if (!opts.isDemo) raiseLater('payslip_ready', { staff: () => staffOf(run.slips.map((s) => s.staffId)) }, { month: monthLabel(month) }, { dedupe: `payslip:${month}:${Date.now()}` });
    return runView(month);
};

/** Opens a finalised month again (recorded reason); recovered instalments are put back on the loans. */
export const reopen = async (month: string, reason: string, userId: string) => {
    const run = await db.payrollRun.findFirst({ where: { month }, include: { slips: true } });
    if (!run || run.status !== 'finalised') throw badRequest('Only a finalised month can be reopened');
    const later = await db.payrollRun.findFirst({ where: { status: 'finalised', month: { gt: month } }, select: { month: true } });
    if (later) throw badRequest(`${monthLabel(later.month)} is finalised after it: reopen that first`);
    for (const s of run.slips)
        for (const d of (s.deductions as Amount[]).filter((x) => x.code === 'LOAN' || x.code === 'ADV')) {
            const l = await db.staffLoan.findFirst({ where: { staffId: s.staffId, kind: d.code === 'ADV' ? 'advance' : 'loan', startMonth: { lte: month } }, orderBy: { createdAt: 'desc' } });
            if (l) await db.staffLoan.update({ where: { id: l.id }, data: { balance: r2(l.balance + d.amount), status: 'active' } });
        }
    await db.payrollRun.update({ where: { id: run.id }, data: { status: 'prepared', finalisedAt: null, approvedBy: null, approvedAt: null, reopenReason: reason } });
    await recordAudit({ action: 'payroll_reopened', entity: 'payroll_run', entityId: run.id, changes: { month, reason, by: userId } });
    return runView(month);
};

// ─── Adjustments and loans ───────────────────────────────────────────────────

export const adjustmentSchema = z.strictObject({ staffId: z.uuid(), month: MONTH, kind: z.enum(['earning', 'deduction']), label: z.string().trim().min(2).max(100), amount: z.number().positive().max(10_000_000) });
export const listAdjustments = async (month: string) => {
    const rows = await db.payrollAdjustment.findMany({ where: { month }, orderBy: { createdAt: 'asc' } });
    const staff = await db.staff.findMany({ where: { id: { in: rows.map((r) => r.staffId) } }, select: { id: true, firstName: true, middleName: true, lastName: true } });
    return rows.map((r) => ({ ...r, name: staffName(staff.find((s) => s.id === r.staffId) ?? { firstName: '' }) }));
};
const notFinalised = async (month: string) => {
    if ((await db.payrollRun.findFirst({ where: { month }, select: { status: true } }))?.status === 'finalised') throw badRequest(`${monthLabel(month)} is finalised`);
};
export const addAdjustment = async (input: z.infer<typeof adjustmentSchema>, userId: string) => {
    await notFinalised(input.month);
    await db.payrollAdjustment.create({ data: { ...input, tenantId: getTenantId()!, createdBy: userId } });
    return listAdjustments(input.month);
};
export const deleteAdjustment = async (id: string) => {
    const a = await db.payrollAdjustment.findFirst({ where: { id } });
    if (!a) throw notFound('Not found');
    await notFinalised(a.month);
    await db.payrollAdjustment.delete({ where: { id } });
    return listAdjustments(a.month);
};

export const loanSchema = z.strictObject({ staffId: z.uuid(), kind: z.enum(['loan', 'advance']), amount: z.number().positive().max(10_000_000), emi: z.number().positive().max(10_000_000), startMonth: MONTH, note: z.string().trim().max(300).nullable().optional() });
export const listLoans = async (staffId?: string) => {
    const rows = await db.staffLoan.findMany({ where: staffId ? { staffId } : {}, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }] });
    const staff = await db.staff.findMany({ where: { id: { in: rows.map((r) => r.staffId) } }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true } });
    return rows.map((r) => {
        const s = staff.find((x) => x.id === r.staffId);
        return { ...r, name: s ? staffName(s) : '', employeeCode: s?.employeeCode ?? '', paid: r2(r.amount - r.balance), left: r.balance > 0 ? Math.ceil(r.balance / r.emi) : 0 };
    });
};
export const giveLoan = async (input: z.infer<typeof loanSchema>, userId: string, opts: { isDemo?: boolean; balance?: number } = {}) => {
    if (input.emi > input.amount) throw badRequest('The instalment is more than the amount');
    await db.staffLoan.create({ data: { ...input, note: input.note || null, balance: opts.balance ?? input.amount, tenantId: getTenantId()!, createdBy: userId, isDemo: !!opts.isDemo } });
    await recordAudit({ action: 'staff_loan_given', entity: 'staff', entityId: input.staffId, changes: { kind: input.kind, amount: input.amount, emi: input.emi } });
    return listLoans();
};
export const closeLoan = async (id: string, userId: string) => {
    const l = await db.staffLoan.findFirst({ where: { id } });
    if (!l) throw notFound('Not found');
    await db.staffLoan.update({ where: { id }, data: { status: 'closed', balance: 0, note: [l.note, `Closed (₹${l.balance} settled) by hand`].filter(Boolean).join(' · ') } });
    await recordAudit({ action: 'staff_loan_closed', entity: 'staff', entityId: l.staffId, changes: { balance: l.balance, by: userId } });
    return listLoans();
};

// ─── Staff: own payslips ─────────────────────────────────────────────────────

export const myPayslips = async (userId: string) => {
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    if (!staff) return { slips: [], loans: [] };
    const slips = await db.payslip.findMany({ where: { staffId: staff.id, run: { status: 'finalised' } }, include: { run: { select: { month: true } } }, orderBy: { run: { month: 'desc' } }, take: 36 });
    return { slips: slips.map((s) => ({ id: s.id, month: s.run.month, label: monthLabel(s.run.month), gross: s.gross, deducted: s.deducted, net: s.net, paidDays: s.paidDays, totalDays: s.totalDays })), loans: (await listLoans(staff.id)).map((l) => ({ id: l.id, kind: l.kind, amount: l.amount, emi: l.emi, balance: l.balance, status: l.status, startMonth: l.startMonth })) };
};

/** May this person see this payslip? Payroll staff, or its own staff member (finalised months only). */
export const assertSlip = async (slipId: string, userId: string, canView: boolean) => {
    const p = await db.payslip.findFirst({ where: { id: slipId }, include: { run: { select: { status: true } } } });
    if (!p) throw notFound('Payslip not found');
    if (canView) return p;
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    if (!staff || staff.id !== p.staffId || p.run.status !== 'finalised') throw forbidden();
    return p;
};
