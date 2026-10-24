import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { takeNumbers } from '../../core/numbering';
import { getUserAccess } from '../rbac/access.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { raiseLater } from '../alerts/deliver';
import { holdersOf } from '../alerts/recipients';
import { ACCOUNTS } from './accounts.settings';

/**
 * Accounts (double entry). A chart of groups and ledgers (made with sensible defaults on first use),
 * financial years with opening balances, and vouchers whose debits equal their credits. Books and
 * statements are worked out from the posted entries. Payments above a limit wait for approval;
 * a closed year is locked and its balances carried forward.
 */

export const r2 = (n: number) => Math.round(n * 100) / 100;
export type Nature = 'asset' | 'liability' | 'income' | 'expense';
const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ─── The chart of accounts ───────────────────────────────────────────────────

const GROUPS: [string, string, Nature, string | null][] = [
    ['fixed_assets', 'Fixed assets', 'asset', null],
    ['current_assets', 'Current assets', 'asset', null],
    ['bank', 'Bank accounts', 'asset', 'current_assets'],
    ['cash', 'Cash in hand', 'asset', 'current_assets'],
    ['receivables', 'Advances and receivables', 'asset', 'current_assets'],
    ['capital', 'General fund', 'liability', null],
    ['current_liabilities', 'Current liabilities', 'liability', null],
    ['duties', 'Statutory dues payable', 'liability', 'current_liabilities'],
    ['creditors', 'Vendors (sundry creditors)', 'liability', 'current_liabilities'],
    ['advances_received', 'Fees and deposits received in advance', 'liability', 'current_liabilities'],
    ['fee_income', 'Fee income', 'income', null],
    ['other_income', 'Other income', 'income', null],
    ['staff_cost', 'Salaries and staff costs', 'expense', null],
    ['admin_exp', 'Administrative expenses', 'expense', null],
    ['academic_exp', 'Academic expenses', 'expense', null],
    ['maintenance', 'Repairs and maintenance', 'expense', null],
    ['transport_exp', 'Transport expenses', 'expense', null],
    ['purchases', 'Store purchases', 'expense', null],
];
const LEDGERS: [string | null, string, string, 'cash' | 'bank' | 'other'][] = [
    ['cash', 'Cash in hand', 'cash', 'cash'],
    ['bank_main', 'School bank account', 'bank', 'bank'],
    ['general_fund', 'General fund', 'capital', 'other'],
    ['salary_payable', 'Salaries payable', 'current_liabilities', 'other'],
    ['pf_payable', 'Provident fund payable', 'duties', 'other'],
    ['esi_payable', 'ESI payable', 'duties', 'other'],
    ['tds_payable', 'TDS payable', 'duties', 'other'],
    ['pt_payable', 'Professional tax payable', 'duties', 'other'],
    ['staff_loans', 'Loans and advances to staff', 'receivables', 'other'],
    ['salary_expense', 'Salaries', 'staff_cost', 'other'],
    ['employer_pf', 'Employer’s PF contribution', 'staff_cost', 'other'],
    ['employer_esi', 'Employer’s ESI contribution', 'staff_cost', 'other'],
    ['late_fee', 'Late fee (fines)', 'fee_income', 'other'],
    ['library_fines', 'Library fines', 'other_income', 'other'],
    ['store_sales', 'Sales to students (uniform, books)', 'other_income', 'other'],
    ['donations', 'Donations', 'other_income', 'other'],
    ['interest', 'Bank interest', 'other_income', 'other'],
    ['recoveries', 'Recoveries from staff', 'other_income', 'other'],
    ['rounding', 'Rounding off', 'admin_exp', 'other'],
    ['store_purchases', 'Store purchases', 'purchases', 'other'],
    ['cash_purchases', 'Cash purchases (no vendor)', 'creditors', 'other'],
    [null, 'Electricity', 'admin_exp', 'other'],
    [null, 'Water', 'admin_exp', 'other'],
    [null, 'Telephone and internet', 'admin_exp', 'other'],
    [null, 'Printing and stationery', 'admin_exp', 'other'],
    [null, 'Bank charges', 'admin_exp', 'other'],
    [null, 'Audit fees', 'admin_exp', 'other'],
    [null, 'Miscellaneous expenses', 'admin_exp', 'other'],
    [null, 'Exam expenses', 'academic_exp', 'other'],
    [null, 'Sports and games', 'academic_exp', 'other'],
    [null, 'Events and functions', 'academic_exp', 'other'],
    [null, 'Building repairs', 'maintenance', 'other'],
    [null, 'Equipment repairs', 'maintenance', 'other'],
    [null, 'Fuel', 'transport_exp', 'other'],
    [null, 'Vehicle maintenance', 'transport_exp', 'other'],
    [null, 'Furniture and fixtures', 'fixed_assets', 'other'],
    [null, 'Computers and equipment', 'fixed_assets', 'other'],
];

/** Makes the default chart the first time (and adds any missing system group / ledger). */
export const ensureChart = async () => {
    const tenantId = getTenantId()!;
    const groups = await db.accGroup.findMany({ select: { id: true, systemKey: true } });
    if (groups.length && groups.length >= GROUPS.length) return;
    const ids = new Map(groups.filter((g) => g.systemKey).map((g) => [g.systemKey!, g.id]));
    let order = 0;
    for (const [key, name, nature, parent] of GROUPS) {
        order += 10;
        if (ids.has(key)) continue;
        const g = await db.accGroup.create({ data: { tenantId, name, nature, parentId: parent ? (ids.get(parent) ?? null) : null, sortOrder: order, systemKey: key } });
        ids.set(key, g.id);
    }
    const have = new Set((await db.accLedger.findMany({ select: { systemKey: true, name: true } })).map((l) => l.systemKey ?? `name:${l.name}`));
    for (const [key, name, group, kind] of LEDGERS) {
        if (have.has(key ?? `name:${name}`)) continue;
        await db.accLedger.create({ data: { tenantId, name, groupId: ids.get(group)!, kind, systemKey: key, isDefault: key === 'bank_main' } });
    }
};

/** A system ledger by its key (made under its group when missing: fee heads, vendors). */
export const systemLedger = async (key: string, make?: { name: string; group: string }) => {
    const l = await db.accLedger.findFirst({ where: { systemKey: key }, select: { id: true } });
    if (l) return l.id;
    await ensureChart();
    const again = await db.accLedger.findFirst({ where: { systemKey: key }, select: { id: true } });
    if (again) return again.id;
    if (!make) throw badRequest(`Ledger ${key} is missing from the chart of accounts`);
    const g = await db.accGroup.findFirst({ where: { systemKey: make.group }, select: { id: true } });
    return (await db.accLedger.create({ data: { tenantId: getTenantId()!, name: make.name, groupId: g!.id, systemKey: key } })).id;
};
export const defaultBank = async () => (await db.accLedger.findFirst({ where: { kind: 'bank', isActive: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }], select: { id: true } }))?.id ?? (await systemLedger('bank_main'));

export const chart = async () => {
    await ensureChart();
    const [groups, ledgers] = await Promise.all([db.accGroup.findMany({ orderBy: { sortOrder: 'asc' } }), db.accLedger.findMany({ orderBy: { name: 'asc' } })]);
    return { groups, ledgers: ledgers.map((l) => ({ ...l, nature: groups.find((g) => g.id === l.groupId)?.nature ?? 'asset' })) };
};

export const groupSchema = z.strictObject({ name: z.string().trim().min(2).max(80), nature: z.enum(['asset', 'liability', 'income', 'expense']), parentId: z.uuid().nullable().optional() });
export const saveGroup = async (id: string | null, input: z.infer<typeof groupSchema>) => {
    if (id) await db.accGroup.update({ where: { id }, data: { name: input.name, parentId: input.parentId ?? null } });
    else await db.accGroup.create({ data: { tenantId: getTenantId()!, name: input.name, nature: input.nature, parentId: input.parentId ?? null, sortOrder: 999 } });
    return chart();
};

export const ledgerSchema = z.strictObject({
    name: z.string().trim().min(2).max(100),
    groupId: z.uuid(),
    code: z.string().trim().max(20).nullable().optional(),
    kind: z.enum(['cash', 'bank', 'other']).default('other'),
    details: z.strictObject({ bank: z.string().max(80).optional(), accountNo: z.string().max(30).optional(), ifsc: z.string().max(15).optional(), branch: z.string().max(80).optional() }).default({}),
    isDefault: z.boolean().default(false),
    isActive: z.boolean().default(true),
});
export const saveLedger = async (id: string | null, input: z.infer<typeof ledgerSchema>) => {
    if (input.isDefault) await db.accLedger.updateMany({ where: { kind: 'bank' }, data: { isDefault: false } });
    const data = { ...input, code: input.code || null };
    if (id) await db.accLedger.update({ where: { id }, data });
    else await db.accLedger.create({ data: { ...data, tenantId: getTenantId()! } });
    return chart();
};

// ─── Financial years ─────────────────────────────────────────────────────────

/** The financial year a day falls in. */
export const fyOf = async (iso: string) => {
    const { m } = await getSettings({ m: ACCOUNTS.yearStartMonth });
    const y = Number(iso.slice(0, 4));
    const startYear = Number(iso.slice(5, 7)) >= m ? y : y - 1;
    const start = `${startYear}-${String(m).padStart(2, '0')}-01`;
    const endD = new Date(Date.UTC(startYear + 1, m - 1, 0));
    return { start, end: isoOf(endD), label: m === 1 ? String(startYear) : `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}` };
};
export const yearOf = async (iso: string) => {
    const fy = await fyOf(iso);
    const y = await db.accYear.findFirst({ where: { start: dayDate(fy.start) } });
    return y ?? (await db.accYear.create({ data: { tenantId: getTenantId()!, start: dayDate(fy.start), end: dayDate(fy.end) } }));
};
export const years = async () => {
    await yearOf(todayIST());
    return (await db.accYear.findMany({ orderBy: { start: 'desc' } })).map((y) => ({ id: y.id, start: isoOf(y.start), end: isoOf(y.end), status: y.status, closedAt: y.closedAt, openings: y.openings as Record<string, number>, budgets: y.budgets as Record<string, number> }));
};

export const openingSchema = z.strictObject({ yearStart: D, openings: z.record(z.uuid(), z.number().min(-1e11).max(1e11)) });
export const saveOpenings = async (input: z.infer<typeof openingSchema>) => {
    const y = await yearOf(input.yearStart);
    if (y.status === 'closed') throw badRequest('That year is closed');
    const clean = Object.fromEntries(Object.entries(input.openings).filter(([, v]) => v !== 0).map(([k, v]) => [k, r2(v)]));
    await db.accYear.update({ where: { id: y.id }, data: { openings: clean } });
    const diff = r2(Object.values(clean).reduce((a, v) => a + v, 0));
    return { saved: true, difference: diff };
};
export const budgetSchema = z.strictObject({ yearStart: D, budgets: z.record(z.uuid(), z.number().min(0).max(1e11)) });
export const saveBudgets = async (input: z.infer<typeof budgetSchema>) => {
    const y = await yearOf(input.yearStart);
    await db.accYear.update({ where: { id: y.id }, data: { budgets: Object.fromEntries(Object.entries(input.budgets).filter(([, v]) => v > 0)) } });
    return { saved: true };
};

// ─── Vouchers ────────────────────────────────────────────────────────────────

export type VType = 'receipt' | 'payment' | 'contra' | 'journal';
export const voucherSchema = z.strictObject({
    type: z.enum(['receipt', 'payment', 'contra', 'journal']),
    date: D,
    narration: z.string().trim().max(500).nullable().optional(),
    reference: z.string().trim().max(80).nullable().optional(),
    attachmentId: z.uuid().nullable().optional(),
    lines: z.array(z.strictObject({ ledgerId: z.uuid(), dr: z.number().min(0).max(1e11), cr: z.number().min(0).max(1e11), note: z.string().trim().max(200).nullable().optional() })).min(2).max(200),
});
type VoucherInput = z.infer<typeof voucherSchema> & { source?: string; sourceKey?: string | null; isDemo?: boolean };

const prefixes = async () => getSettings({ receipt: ACCOUNTS.receiptPrefix, payment: ACCOUNTS.paymentPrefix, contra: ACCOUNTS.contraPrefix, journal: ACCOUNTS.journalPrefix });

/** Checks a voucher (balanced, cash / bank where its type needs it, year open) and saves it. */
export const createVoucher = async (input: VoucherInput, userId: string | null, opts: { approve?: boolean } = {}) => {
    const lines = input.lines.map((l) => ({ ...l, dr: r2(l.dr), cr: r2(l.cr) })).filter((l) => l.dr > 0 || l.cr > 0);
    if (lines.some((l) => l.dr > 0 && l.cr > 0)) throw badRequest('A line is either a debit or a credit');
    const dr = r2(lines.reduce((a, l) => a + l.dr, 0));
    const cr = r2(lines.reduce((a, l) => a + l.cr, 0));
    if (lines.length < 2 || dr <= 0) throw badRequest('A voucher needs at least one debit and one credit');
    if (Math.abs(dr - cr) > 0.005) throw badRequest(`Debits (₹${dr}) and credits (₹${cr}) must be equal`);
    const y = await yearOf(input.date);
    if (y.status === 'closed') throw badRequest('That financial year is closed');
    const ledgers = await db.accLedger.findMany({ where: { id: { in: lines.map((l) => l.ledgerId) } }, select: { id: true, kind: true, isActive: true } });
    if (ledgers.length !== new Set(lines.map((l) => l.ledgerId)).size) throw badRequest('A ledger is not in the chart of accounts');
    const money = (id: string) => ['cash', 'bank'].includes(ledgers.find((l) => l.id === id)?.kind ?? '');
    if (input.source === 'manual' || !input.source) {
        if (input.type === 'receipt' && !lines.some((l) => l.dr > 0 && money(l.ledgerId))) throw badRequest('A receipt brings money into cash or a bank: debit cash / bank');
        if (input.type === 'payment' && !lines.some((l) => l.cr > 0 && money(l.ledgerId))) throw badRequest('A payment takes money out of cash or a bank: credit cash / bank');
        if (input.type === 'contra' && !lines.every((l) => money(l.ledgerId))) throw badRequest('A contra moves money between cash and banks only');
    }
    let status = 'posted';
    if (input.type === 'payment' && (input.source ?? 'manual') === 'manual' && !opts.approve) {
        const { limit } = await getSettings({ limit: ACCOUNTS.approvalAbove });
        const can = userId ? !!(await getUserAccess(userId)).permissions['accounts.approve'] : false;
        if (!can && (limit === 0 || dr > limit)) status = 'pending';
    }
    const p = await prefixes();
    const fy = await fyOf(input.date);
    const n = await takeNumbers(`acc_${input.type}_${fy.start}`, 1);
    const tenantId = getTenantId()!;
    const v = await db.accVoucher.create({
        data: { tenantId, type: input.type, number: `${p[input.type]}/${fy.label}/${String(n).padStart(4, '0')}`, date: dayDate(input.date), narration: input.narration || null, reference: input.reference || null, attachmentId: input.attachmentId ?? null, total: dr, status, source: input.source ?? 'manual', sourceKey: input.sourceKey ?? null, createdBy: userId, approvedBy: status === 'posted' && (input.source ?? 'manual') === 'manual' ? userId : null, approvedAt: status === 'posted' ? new Date() : null, isDemo: !!input.isDemo, entries: { create: lines.map((l) => ({ ledgerId: l.ledgerId, dr: l.dr, cr: l.cr, note: l.note || null })) } },
    });
    if (status === 'pending') {
        const by = userId ? ((await db.user.findFirst({ where: { id: userId }, select: { displayName: true } }))?.displayName ?? '') : '';
        raiseLater('acc_payment_approval', { approvers: () => holdersOf('accounts.approve') }, { number: v.number, amount: String(Math.round(dr)), narration: v.narration ?? '', by }, { dedupe: `acc-pay:${v.id}` });
    }
    return { id: v.id, number: v.number, status };
};

export const approveVoucher = async (id: string, approve: boolean, reason: string | null, userId: string) => {
    const v = await db.accVoucher.findFirst({ where: { id } });
    if (!v || v.status !== 'pending') throw badRequest('Nothing to approve');
    await db.accVoucher.update({ where: { id }, data: approve ? { status: 'posted', approvedBy: userId, approvedAt: new Date() } : { status: 'cancelled', cancelReason: reason || 'Not approved', approvedBy: userId, approvedAt: new Date() } });
    await recordAudit({ action: approve ? 'voucher_approved' : 'voucher_refused', entity: 'acc_voucher', entityId: id, changes: { number: v.number, total: v.total } });
    return voucherView(id);
};

export const cancelVoucher = async (id: string, reason: string, userId: string) => {
    const v = await db.accVoucher.findFirst({ where: { id }, include: { entries: { select: { reconciledOn: true } } } });
    if (!v || v.status === 'cancelled') throw badRequest('Already cancelled');
    if ((await yearOf(isoOf(v.date))).status === 'closed') throw badRequest('That financial year is closed');
    if (v.entries.some((e) => e.reconciledOn)) throw badRequest('It is reconciled with the bank statement: untick it there first');
    await db.accVoucher.update({ where: { id }, data: { status: 'cancelled', cancelReason: reason, sourceKey: null } });
    await recordAudit({ action: 'voucher_cancelled', entity: 'acc_voucher', entityId: id, changes: { number: v.number, reason, by: userId } });
    return voucherView(id);
};

export const voucherView = async (id: string) => {
    const v = await db.accVoucher.findFirst({ where: { id }, include: { entries: true } });
    if (!v) throw notFound('Voucher not found');
    const [ledgers, users] = await Promise.all([db.accLedger.findMany({ where: { id: { in: v.entries.map((e) => e.ledgerId) } }, select: { id: true, name: true } }), db.user.findMany({ where: { id: { in: [v.createdBy, v.approvedBy].filter((x): x is string => !!x) } }, select: { id: true, displayName: true } })]);
    return { ...v, date: isoOf(v.date), createdByName: users.find((u) => u.id === v.createdBy)?.displayName ?? (v.source === 'manual' ? '' : 'Posted by the software'), approvedByName: users.find((u) => u.id === v.approvedBy)?.displayName ?? '', entries: v.entries.map((e) => ({ ...e, ledger: ledgers.find((l) => l.id === e.ledgerId)?.name ?? '', reconciledOn: e.reconciledOn ? isoOf(e.reconciledOn) : null })) };
};

export const vouchersQuery = z.object({ from: D, to: D, type: z.enum(['receipt', 'payment', 'contra', 'journal', '']).default(''), status: z.enum(['posted', 'pending', 'cancelled', '']).default(''), source: z.string().max(20).optional(), search: z.string().trim().max(60).optional() });
export const listVouchers = async (q: z.infer<typeof vouchersQuery>) => {
    const rows = await db.accVoucher.findMany({ where: { date: { gte: dayDate(q.from), lte: dayDate(q.to) }, ...(q.type ? { type: q.type } : {}), ...(q.status ? { status: q.status } : {}), ...(q.source ? { source: q.source } : {}), ...(q.search ? { OR: [{ number: { contains: q.search, mode: 'insensitive' } }, { narration: { contains: q.search, mode: 'insensitive' } }, { reference: { contains: q.search, mode: 'insensitive' } }] } : {}) }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 500, include: { entries: { select: { ledgerId: true, dr: true, cr: true } } } });
    const ledgers = await db.accLedger.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => r.entries.map((e) => e.ledgerId)))] } }, select: { id: true, name: true } });
    const ln = (id: string) => ledgers.find((l) => l.id === id)?.name ?? '';
    return rows.map((v) => ({ id: v.id, type: v.type, number: v.number, date: isoOf(v.date), narration: v.narration, reference: v.reference, total: v.total, status: v.status, source: v.source, debits: v.entries.filter((e) => e.dr > 0).map((e) => ln(e.ledgerId)).slice(0, 3), credits: v.entries.filter((e) => e.cr > 0).map((e) => ln(e.ledgerId)).slice(0, 3) }));
};

// ─── Balances and books ──────────────────────────────────────────────────────

const posted = { voucher: { status: 'posted' } } as const;

/** Every ledger's balance at the end of a day (+ debit, − credit): its year's opening and the year's entries. */
export const balancesAt = async (iso: string) => {
    const y = await yearOf(iso);
    const sums = await db.accEntry.groupBy({ by: ['ledgerId'], where: { ...posted, voucher: { status: 'posted', date: { gte: y.start, lte: dayDate(iso) } } }, _sum: { dr: true, cr: true } });
    const out = new Map<string, number>();
    for (const [k, v] of Object.entries(y.openings as Record<string, number>)) out.set(k, v);
    for (const s of sums) out.set(s.ledgerId, r2((out.get(s.ledgerId) ?? 0) + (s._sum.dr ?? 0) - (s._sum.cr ?? 0)));
    return { year: y, balances: out };
};

/** Movement of each ledger in a period (+ debit, − credit). */
const movement = async (from: string, to: string) => {
    const sums = await db.accEntry.groupBy({ by: ['ledgerId'], where: { voucher: { status: 'posted', date: { gte: dayDate(from), lte: dayDate(to) } } }, _sum: { dr: true, cr: true } });
    return new Map(sums.map((s) => [s.ledgerId, r2((s._sum.dr ?? 0) - (s._sum.cr ?? 0))]));
};

export const ledgerStatement = async (ledgerId: string, from: string, to: string) => {
    const l = await db.accLedger.findFirst({ where: { id: ledgerId } });
    if (!l) throw notFound('Ledger not found');
    const g = await db.accGroup.findFirst({ where: { id: l.groupId }, select: { name: true, nature: true } });
    const y = await yearOf(from);
    const before = await db.accEntry.aggregate({ where: { ledgerId, voucher: { status: 'posted', date: { gte: y.start, lt: dayDate(from) } } }, _sum: { dr: true, cr: true } });
    const opening = r2(((y.openings as Record<string, number>)[ledgerId] ?? 0) + (before._sum.dr ?? 0) - (before._sum.cr ?? 0));
    const entries = await db.accEntry.findMany({ where: { ledgerId, voucher: { status: 'posted', date: { gte: dayDate(from), lte: dayDate(to) } } }, include: { voucher: { select: { id: true, number: true, date: true, type: true, narration: true, entries: { select: { ledgerId: true, dr: true, cr: true } } } } }, orderBy: [{ voucher: { date: 'asc' } }, { voucher: { createdAt: 'asc' } }] });
    const others = await db.accLedger.findMany({ where: { id: { in: [...new Set(entries.flatMap((e) => e.voucher.entries.map((x) => x.ledgerId)))] } }, select: { id: true, name: true } });
    let bal = opening;
    const rows = entries.map((e) => {
        bal = r2(bal + e.dr - e.cr);
        const against = e.voucher.entries.filter((x) => x.ledgerId !== ledgerId && (e.dr > 0 ? x.cr > 0 : x.dr > 0)).map((x) => others.find((o) => o.id === x.ledgerId)?.name ?? '');
        return { voucherId: e.voucher.id, date: isoOf(e.voucher.date), number: e.voucher.number, type: e.voucher.type, against: against.slice(0, 2).join(', ') + (against.length > 2 ? '…' : ''), narration: e.voucher.narration, dr: e.dr, cr: e.cr, balance: bal };
    });
    return { ledger: { id: l.id, name: l.name, kind: l.kind, group: g?.name ?? '', nature: g?.nature ?? 'asset' }, from, to, opening, rows, closing: bal, totalDr: r2(rows.reduce((a, r) => a + r.dr, 0)), totalCr: r2(rows.reduce((a, r) => a + r.cr, 0)) };
};

export const dayBook = async (from: string, to: string) => {
    const rows = await db.accVoucher.findMany({ where: { status: 'posted', date: { gte: dayDate(from), lte: dayDate(to) } }, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }], include: { entries: true } });
    const ledgers = await db.accLedger.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => r.entries.map((e) => e.ledgerId)))] } }, select: { id: true, name: true } });
    return rows.map((v) => ({ id: v.id, date: isoOf(v.date), number: v.number, type: v.type, narration: v.narration, total: v.total, lines: v.entries.map((e) => ({ ledger: ledgers.find((l) => l.id === e.ledgerId)?.name ?? '', dr: e.dr, cr: e.cr })) }));
};

/** Ledgers with their group, nature and balance at a day (for the statements). */
const tree = async (iso: string) => {
    await ensureChart();
    const [{ balances }, groups, ledgers] = await Promise.all([balancesAt(iso), db.accGroup.findMany({ orderBy: { sortOrder: 'asc' } }), db.accLedger.findMany({ orderBy: { name: 'asc' } })]);
    const top = (id: string): { id: string; name: string; nature: string } => {
        const g = groups.find((x) => x.id === id)!;
        return g.parentId ? top(g.parentId) : g;
    };
    return { groups, rows: ledgers.map((l) => ({ id: l.id, name: l.name, groupId: l.groupId, group: groups.find((g) => g.id === l.groupId)?.name ?? '', top: top(l.groupId).name, nature: top(l.groupId).nature as Nature, balance: balances.get(l.id) ?? 0 })) };
};

export const trialBalance = async (asOf: string) => {
    const t = await tree(asOf);
    const rows = t.rows.filter((r) => Math.abs(r.balance) > 0.004).map((r) => ({ ...r, dr: r.balance > 0 ? r.balance : 0, cr: r.balance < 0 ? -r.balance : 0 }));
    return { asOf, rows, totalDr: r2(rows.reduce((a, r) => a + r.dr, 0)), totalCr: r2(rows.reduce((a, r) => a + r.cr, 0)) };
};

export const incomeExpenditure = async (from: string, to: string) => {
    await ensureChart();
    const [mv, t] = await Promise.all([movement(from, to), tree(to)]);
    const income = t.rows.filter((r) => r.nature === 'income').map((r) => ({ name: r.name, group: r.group, amount: r2(-(mv.get(r.id) ?? 0)) })).filter((r) => Math.abs(r.amount) > 0.004);
    const expense = t.rows.filter((r) => r.nature === 'expense').map((r) => ({ name: r.name, group: r.group, amount: r2(mv.get(r.id) ?? 0) })).filter((r) => Math.abs(r.amount) > 0.004);
    const ti = r2(income.reduce((a, r) => a + r.amount, 0));
    const te = r2(expense.reduce((a, r) => a + r.amount, 0));
    return { from, to, income, expense, totalIncome: ti, totalExpense: te, surplus: r2(ti - te) };
};

export const balanceSheet = async (asOf: string) => {
    const t = await tree(asOf);
    const y = await yearOf(asOf);
    const ie = await incomeExpenditure(isoOf(y.start), asOf);
    const assets = t.rows.filter((r) => r.nature === 'asset' && Math.abs(r.balance) > 0.004).map((r) => ({ name: r.name, group: r.group, amount: r.balance }));
    const liabilities = t.rows.filter((r) => r.nature === 'liability' && Math.abs(r.balance) > 0.004).map((r) => ({ name: r.name, group: r.group, amount: r2(-r.balance) }));
    liabilities.push({ name: 'Surplus / (deficit) of the year so far', group: 'General fund', amount: ie.surplus });
    const ta = r2(assets.reduce((a, r) => a + r.amount, 0));
    const tl = r2(liabilities.reduce((a, r) => a + r.amount, 0));
    return { asOf, assets, liabilities, totalAssets: ta, totalLiabilities: tl, difference: r2(ta - tl) };
};

/** Receipts and payments: money into and out of cash and banks, by what it was for. */
export const receiptsPayments = async (from: string, to: string) => {
    await ensureChart();
    const money = await db.accLedger.findMany({ where: { kind: { in: ['cash', 'bank'] } }, select: { id: true, name: true } });
    const ids = new Set(money.map((m) => m.id));
    const y = await yearOf(from);
    const opening = await Promise.all(money.map(async (m) => {
        const b = await db.accEntry.aggregate({ where: { ledgerId: m.id, voucher: { status: 'posted', date: { gte: y.start, lt: dayDate(from) } } }, _sum: { dr: true, cr: true } });
        return { name: m.name, amount: r2(((y.openings as Record<string, number>)[m.id] ?? 0) + (b._sum.dr ?? 0) - (b._sum.cr ?? 0)) };
    }));
    const vouchers = await db.accVoucher.findMany({ where: { status: 'posted', type: { not: 'contra' }, date: { gte: dayDate(from), lte: dayDate(to) } }, include: { entries: true } });
    const rec = new Map<string, number>();
    const pay = new Map<string, number>();
    for (const v of vouchers) {
        const inn = v.entries.filter((e) => ids.has(e.ledgerId)).reduce((a, e) => a + e.dr - e.cr, 0);
        if (Math.abs(inn) < 0.005) continue;
        const others = v.entries.filter((e) => !ids.has(e.ledgerId));
        const tot = others.reduce((a, e) => a + (inn > 0 ? e.cr : e.dr), 0) || 1;
        for (const e of others) {
            const share = ((inn > 0 ? e.cr : e.dr) / tot) * Math.abs(inn);
            if (share <= 0) continue;
            const m = inn > 0 ? rec : pay;
            m.set(e.ledgerId, (m.get(e.ledgerId) ?? 0) + share);
        }
    }
    const names = await db.accLedger.findMany({ where: { id: { in: [...rec.keys(), ...pay.keys()] } }, select: { id: true, name: true } });
    const list = (m: Map<string, number>) => [...m.entries()].map(([id, a]) => ({ name: names.find((n) => n.id === id)?.name ?? '', amount: r2(a) })).sort((a, b) => b.amount - a.amount);
    const receipts = list(rec);
    const payments = list(pay);
    const o = r2(opening.reduce((a, x) => a + x.amount, 0));
    const tr = r2(receipts.reduce((a, x) => a + x.amount, 0));
    const tp = r2(payments.reduce((a, x) => a + x.amount, 0));
    return { from, to, opening, openingTotal: o, receipts, payments, totalReceipts: tr, totalPayments: tp, closing: r2(o + tr - tp) };
};

export const budgetVsActual = async (yearStart: string) => {
    const y = await yearOf(yearStart);
    const [mv, ledgers] = await Promise.all([movement(isoOf(y.start), isoOf(y.end)), db.accLedger.findMany({ select: { id: true, name: true, groupId: true } })]);
    const budgets = y.budgets as Record<string, number>;
    const groups = await db.accGroup.findMany({ select: { id: true, nature: true, name: true } });
    return ledgers
        .filter((l) => groups.find((g) => g.id === l.groupId)?.nature === 'expense')
        .map((l) => ({ ledgerId: l.id, name: l.name, group: groups.find((g) => g.id === l.groupId)?.name ?? '', budget: budgets[l.id] ?? 0, actual: r2(mv.get(l.id) ?? 0) }))
        .filter((r) => r.budget || r.actual)
        .map((r) => ({ ...r, left: r2(r.budget - r.actual), used: r.budget ? Math.round((r.actual / r.budget) * 100) : null }));
};

/** What the school owes each vendor. */
export const payables = async () => {
    const g = await db.accGroup.findFirst({ where: { systemKey: 'creditors' }, select: { id: true } });
    if (!g) return [];
    const { balances } = await balancesAt(todayIST());
    const ledgers = await db.accLedger.findMany({ where: { groupId: g.id }, select: { id: true, name: true } });
    return ledgers.map((l) => ({ ledgerId: l.id, name: l.name, owed: r2(-(balances.get(l.id) ?? 0)) })).filter((x) => Math.abs(x.owed) > 0.004).sort((a, b) => b.owed - a.owed);
};

/** Cash and bank balances today (and the cash-in-hand warning). */
export const moneyNow = async () => {
    await ensureChart();
    const [{ balances }, ledgers, s, pending] = await Promise.all([balancesAt(todayIST()), db.accLedger.findMany({ where: { kind: { in: ['cash', 'bank'] }, isActive: true }, select: { id: true, name: true, kind: true } }), getSettings({ limit: ACCOUNTS.cashLimit }), db.accVoucher.count({ where: { status: 'pending' } })]);
    const rows = ledgers.map((l) => ({ id: l.id, name: l.name, kind: l.kind, balance: balances.get(l.id) ?? 0 }));
    const cash = rows.filter((r) => r.kind === 'cash').reduce((a, r) => a + r.balance, 0);
    return { rows, cash: r2(cash), bank: r2(rows.filter((r) => r.kind === 'bank').reduce((a, r) => a + r.balance, 0)), cashWarning: s.limit > 0 && cash > s.limit ? s.limit : null, pending };
};

// ─── Closing a year ──────────────────────────────────────────────────────────

/** Locks a year and carries balances forward: assets and liabilities as they are, the surplus into the general fund. */
export const closeYear = async (yearStart: string, userId: string) => {
    const y = await yearOf(yearStart);
    if (y.status === 'closed') throw badRequest('Already closed');
    if (isoOf(y.end) >= todayIST()) throw badRequest('A year can be closed only after it ends');
    if (await db.accVoucher.count({ where: { status: 'pending', date: { gte: y.start, lte: y.end } } })) throw badRequest('Some payments of that year wait for approval');
    const t = await tree(isoOf(y.end));
    const ie = await incomeExpenditure(isoOf(y.start), isoOf(y.end));
    const fund = await systemLedger('general_fund');
    const openings: Record<string, number> = {};
    for (const r of t.rows) if ((r.nature === 'asset' || r.nature === 'liability') && Math.abs(r.balance) > 0.004) openings[r.id] = r.balance;
    openings[fund] = r2((openings[fund] ?? 0) - ie.surplus);
    const nextStart = isoOf(new Date(y.end.getTime() + 86_400_000));
    const next = await yearOf(nextStart);
    await db.accYear.update({ where: { id: next.id }, data: { openings } });
    await db.accYear.update({ where: { id: y.id }, data: { status: 'closed', closedAt: new Date(), closedBy: userId } });
    await recordAudit({ action: 'accounts_year_closed', entity: 'acc_year', entityId: y.id, changes: { start: yearStart, surplus: ie.surplus } });
    return years();
};
