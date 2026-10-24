import ExcelJS from 'exceljs';
import { z } from 'zod';
import { db } from '../../core/db';
import { badRequest, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { defineDailyJob } from '../alerts/jobs';
import { ACCOUNTS } from './accounts.settings';
import { createVoucher, defaultBank, ensureChart, r2, systemLedger } from './accounts.service';

/**
 * Entries the software posts by itself: each day's fee collection (and counter fines and store sales)
 * as one receipt voucher; a finalised month's payroll as a journal (and its payment when marked
 * paid); goods received as purchases payable to the vendor; loans given to staff. Each is posted
 * once (its source key); a changed day of fees is posted again, a reopened payroll cancelled.
 * Bank reconciliation ticks bank entries off against the bank statement.
 */

const DAY = 86_400_000;
type L = { ledgerId: string; dr: number; cr: number; note?: string | null };
const sig = (lines: L[]) => lines.map((l) => `${l.ledgerId}:${r2(l.dr)}:${r2(l.cr)}`).sort().join('|');

/** Replaces a posted voucher of a source when its lines changed (unless reconciled), or makes it. */
const upsertPosted = async (key: string, make: { type: 'receipt' | 'payment' | 'journal'; date: string; narration: string; source: string; lines: L[] }, opts: { isDemo?: boolean } = {}) => {
    const lines = make.lines.filter((l) => r2(l.dr) > 0 || r2(l.cr) > 0);
    const old = await db.accVoucher.findFirst({ where: { sourceKey: key }, include: { entries: true } });
    if (old) {
        if (sig(old.entries) === sig(lines)) return 'same';
        if (old.entries.some((e) => e.reconciledOn)) return 'reconciled';
        await db.accVoucher.update({ where: { id: old.id }, data: { status: 'cancelled', cancelReason: 'Posted again with changes', sourceKey: null } });
    }
    if (!lines.length) return 'empty';
    await createVoucher({ type: make.type, date: make.date, narration: make.narration, reference: null, attachmentId: null, lines, source: make.source, sourceKey: key, isDemo: opts.isDemo }, null);
    return old ? 'updated' : 'made';
};

/** Each day's fee receipts (by fee head and mode), counter library fines and counter store sales. */
export const postFees = async (from: string, to: string, opts: { isDemo?: boolean } = {}) => {
    await ensureChart();
    const [receipts, fines, sales, heads, bank, cash] = await Promise.all([
        db.feeReceipt.findMany({ where: { status: 'active', date: { gte: dayDate(from), lte: dayDate(to) } }, select: { date: true, mode: true, amount: true, lines: { select: { feeHeadId: true, isFine: true, amount: true } } } }),
        db.libraryFine.findMany({ where: { payAt: 'counter', status: 'paid', paidOn: { gte: dayDate(from), lte: dayDate(to) } }, select: { paidOn: true, amount: true, waived: true } }),
        db.invSale.findMany({ where: { payAt: 'counter', status: 'active', at: { gte: dayDate(from), lt: new Date(dayDate(to).getTime() + DAY) } }, select: { at: true, total: true, mode: true } }),
        db.masterValue.findMany({ where: { master: 'fee_head' }, select: { id: true, name: true } }),
        defaultBank(),
        systemLedger('cash'),
    ]);
    const days = new Map<string, { cash: number; bank: number; cr: Map<string, number>; count: number }>();
    const day = (d: string) => days.get(d) ?? (days.set(d, { cash: 0, bank: 0, cr: new Map(), count: 0 }), days.get(d)!);
    const headLedger = new Map<string, string>();
    const ledgerOfHead = async (id: string | null, fine: boolean) => {
        if (fine) return systemLedger('late_fee');
        if (!id) return systemLedger('late_fee');
        if (!headLedger.has(id)) headLedger.set(id, await systemLedger(`fee_head:${id}`, { name: heads.find((h) => h.id === id)?.name ?? 'Fees', group: 'fee_income' }));
        return headLedger.get(id)!;
    };
    for (const r of receipts) {
        const d = day(isoOf(r.date));
        d.count++;
        if (r.mode === 'cash') d.cash += r.amount;
        else d.bank += r.amount;
        for (const l of r.lines) {
            const lid = await ledgerOfHead(l.feeHeadId, l.isFine);
            d.cr.set(lid, (d.cr.get(lid) ?? 0) + l.amount);
        }
        // A receipt's lines can be less than its amount (rounding / extra): the rest to the first head.
        const diff = r.amount - r.lines.reduce((a, l) => a + l.amount, 0);
        if (diff) {
            const lid = await ledgerOfHead(r.lines[0]?.feeHeadId ?? null, false);
            d.cr.set(lid, (d.cr.get(lid) ?? 0) + diff);
        }
    }
    const fineLedger = await systemLedger('library_fines');
    for (const f of fines) {
        const d = day(isoOf(f.paidOn!));
        d.cash += f.amount - f.waived;
        d.cr.set(fineLedger, (d.cr.get(fineLedger) ?? 0) + f.amount - f.waived);
    }
    const salesLedger = await systemLedger('store_sales');
    for (const s of sales) {
        const d = day(isoOf(new Date(s.at.getTime() + 5.5 * 3_600_000)));
        if (!s.mode || /cash/i.test(s.mode)) d.cash += s.total;
        else d.bank += s.total;
        d.cr.set(salesLedger, (d.cr.get(salesLedger) ?? 0) + s.total);
    }
    let made = 0;
    let updated = 0;
    // Every day of the period: a day whose receipts were all cancelled loses its voucher.
    for (let t = dayDate(from).getTime(); t <= dayDate(to).getTime(); t += DAY) {
        const iso = isoOf(new Date(t));
        const d = days.get(iso);
        const lines: L[] = d ? [{ ledgerId: cash, dr: d.cash, cr: 0 }, { ledgerId: bank, dr: d.bank, cr: 0 }, ...[...d.cr.entries()].map(([ledgerId, cr]) => ({ ledgerId, dr: 0, cr }))] : [];
        const r = await upsertPosted(`fees:${iso}`, { type: 'receipt', date: iso, narration: `Fees collected on ${iso}${d ? ` (${d.count} receipt${d.count === 1 ? '' : 's'})` : ''}`, source: 'fees', lines }, opts);
        if (r === 'made') made++;
        if (r === 'updated') updated++;
    }
    return { made, updated };
};

/** A finalised month's payroll as a journal; a reopened month's journal is cancelled. */
export const postPayroll = async (opts: { isDemo?: boolean } = {}) => {
    await ensureChart();
    const runs = await db.payrollRun.findMany({ include: { slips: { select: { gross: true, net: true, deductions: true, employer: true } } } });
    let made = 0;
    for (const run of runs) {
        const key = `payroll:${run.month}`;
        if (run.status !== 'finalised') {
            const v = await db.accVoucher.findFirst({ where: { sourceKey: key } });
            if (v) await db.accVoucher.update({ where: { id: v.id }, data: { status: 'cancelled', cancelReason: 'Payroll reopened', sourceKey: null } });
            continue;
        }
        let gross = 0, net = 0, erPf = 0, erEsi = 0, pf = 0, esi = 0, tds = 0, pt = 0, loans = 0, other = 0;
        for (const s of run.slips) {
            gross += s.gross;
            net += s.net;
            const er = s.employer as Record<string, number>;
            erPf += er.pf ?? 0;
            erEsi += er.esi ?? 0;
            for (const d of s.deductions as { code: string; amount: number }[]) {
                if (d.code === 'PF') pf += d.amount;
                else if (d.code === 'ESI') esi += d.amount;
                else if (d.code === 'TDS') tds += d.amount;
                else if (d.code === 'PT') pt += d.amount;
                else if (d.code === 'LOAN' || d.code === 'ADV') loans += d.amount;
                else other += d.amount;
            }
        }
        const lines: L[] = [
            { ledgerId: await systemLedger('salary_expense'), dr: gross, cr: 0 },
            { ledgerId: await systemLedger('employer_pf'), dr: erPf, cr: 0 },
            { ledgerId: await systemLedger('employer_esi'), dr: erEsi, cr: 0 },
            { ledgerId: await systemLedger('salary_payable'), dr: 0, cr: net },
            { ledgerId: await systemLedger('pf_payable'), dr: 0, cr: pf + erPf },
            { ledgerId: await systemLedger('esi_payable'), dr: 0, cr: esi + erEsi },
            { ledgerId: await systemLedger('tds_payable'), dr: 0, cr: tds },
            { ledgerId: await systemLedger('pt_payable'), dr: 0, cr: pt },
            { ledgerId: await systemLedger('staff_loans'), dr: 0, cr: loans },
            { ledgerId: await systemLedger('recoveries'), dr: 0, cr: other },
        ].map((l) => ({ ...l, dr: r2(l.dr), cr: r2(l.cr) }));
        const diff = r2(lines.reduce((a, l) => a + l.dr - l.cr, 0));
        if (Math.abs(diff) > 0.004) lines.push({ ledgerId: await systemLedger('rounding'), dr: diff < 0 ? -diff : 0, cr: diff > 0 ? diff : 0 });
        const date = isoOf(new Date(dayDate(`${run.month}-01`).getTime() + 32 * DAY)).slice(0, 7) + '-01';
        const monthEnd = isoOf(new Date(dayDate(date).getTime() - DAY));
        if ((await upsertPosted(key, { type: 'journal', date: monthEnd, narration: `Salaries for ${new Date(`${run.month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })} (${run.slips.length} staff)`, source: 'payroll', lines }, opts)) === 'made') made++;
    }
    return { made };
};

export const salaryPaidSchema = z.strictObject({ month: z.string().regex(/^\d{4}-\d{2}$/), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), bankLedgerId: z.uuid().nullable().optional(), reference: z.string().trim().max(80).nullable().optional() });
/** The month's net salaries paid from the bank: salaries payable cleared. */
export const markSalaryPaid = async (input: z.infer<typeof salaryPaidSchema>, userId: string, opts: { isDemo?: boolean } = {}) => {
    const run = await db.payrollRun.findFirst({ where: { month: input.month, status: 'finalised' }, include: { slips: { select: { net: true } } } });
    if (!run) throw badRequest('That month’s payroll is not finalised');
    if (await db.accVoucher.findFirst({ where: { sourceKey: `salary_paid:${input.month}` } })) throw badRequest('Already marked paid');
    const net = r2(run.slips.reduce((a, s) => a + s.net, 0));
    const bank = input.bankLedgerId ?? (await defaultBank());
    return createVoucher({ type: 'payment', date: input.date, narration: `Salaries for ${input.month} paid to staff bank accounts`, reference: input.reference || null, attachmentId: null, lines: [{ ledgerId: await systemLedger('salary_payable'), dr: net, cr: 0 }, { ledgerId: bank, dr: 0, cr: net }], source: 'salary_paid', sourceKey: `salary_paid:${input.month}`, isDemo: opts.isDemo }, userId, { approve: true });
};

/** Goods received in the store: purchases payable to the vendor (cash purchases when no vendor). */
export const postStore = async (opts: { isDemo?: boolean } = {}) => {
    await ensureChart();
    const posted = new Set((await db.accVoucher.findMany({ where: { source: 'store', sourceKey: { not: null } }, select: { sourceKey: true } })).map((v) => v.sourceKey));
    const grns = await db.invReceipt.findMany({ where: { source: { in: ['po', 'direct'] }, total: { gt: 0 } }, orderBy: { at: 'asc' } });
    const vendors = await db.masterValue.findMany({ where: { master: 'asset_vendor' }, select: { id: true, name: true } });
    const purchases = await systemLedger('store_purchases');
    let made = 0;
    for (const g of grns) {
        if (posted.has(`grn:${g.id}`)) continue;
        const cr = g.vendorId ? await systemLedger(`vendor:${g.vendorId}`, { name: vendors.find((v) => v.id === g.vendorId)?.name ?? 'Vendor', group: 'creditors' }) : await systemLedger('cash_purchases');
        await createVoucher({ type: 'journal', date: isoOf(new Date(g.at.getTime() + 5.5 * 3_600_000)), narration: `Store purchase ${g.number}${g.billNo ? `, bill ${g.billNo}` : ''}`, reference: g.billNo, attachmentId: g.billFileId, lines: [{ ledgerId: purchases, dr: g.total, cr: 0 }, { ledgerId: cr, dr: 0, cr: g.total }], source: 'store', sourceKey: `grn:${g.id}`, isDemo: opts.isDemo }, null);
        made++;
    }
    return { made };
};

/** Loans and advances given to staff: paid from the bank. */
export const postLoans = async (opts: { isDemo?: boolean } = {}) => {
    await ensureChart();
    const posted = new Set((await db.accVoucher.findMany({ where: { source: 'loan', sourceKey: { not: null } }, select: { sourceKey: true } })).map((v) => v.sourceKey));
    const loans = await db.staffLoan.findMany({ orderBy: { createdAt: 'asc' } });
    const staff = await db.staff.findMany({ where: { id: { in: loans.map((l) => l.staffId) } }, select: { id: true, firstName: true, lastName: true } });
    let made = 0;
    for (const l of loans) {
        if (posted.has(`loan:${l.id}`)) continue;
        const s = staff.find((x) => x.id === l.staffId);
        await createVoucher({ type: 'payment', date: isoOf(new Date(l.createdAt.getTime() + 5.5 * 3_600_000)), narration: `${l.kind === 'advance' ? 'Salary advance' : 'Loan'} to ${[s?.firstName, s?.lastName].filter(Boolean).join(' ')}`, reference: null, attachmentId: null, lines: [{ ledgerId: await systemLedger('staff_loans'), dr: l.amount, cr: 0 }, { ledgerId: await defaultBank(), dr: 0, cr: l.amount }], source: 'loan', sourceKey: `loan:${l.id}`, isDemo: opts.isDemo }, null, { approve: true });
        made++;
    }
    return { made };
};

/** Posts everything the settings switch on (fees of the last 45 days by default). */
export const syncAll = async (opts: { from?: string; isDemo?: boolean } = {}) => {
    const s = await getSettings({ fees: ACCOUNTS.postFees, payroll: ACCOUNTS.postPayroll, store: ACCOUNTS.postStore, loans: ACCOUNTS.postLoans });
    const today = todayIST();
    const from = opts.from ?? isoOf(new Date(dayDate(today).getTime() - 45 * DAY));
    return {
        fees: s.fees ? await postFees(from, today, opts) : null,
        payroll: s.payroll ? await postPayroll(opts) : null,
        store: s.store ? await postStore(opts) : null,
        loans: s.loans ? await postLoans(opts) : null,
    };
};

defineDailyJob({
    key: 'accounts_post',
    run: async () => {
        const r = await syncAll();
        return JSON.stringify(r);
    },
});

// ─── Bank reconciliation ─────────────────────────────────────────────────────

export const bankEntries = async (ledgerId: string, upTo: string, show: 'open' | 'all') => {
    const l = await db.accLedger.findFirst({ where: { id: ledgerId, kind: 'bank' } });
    if (!l) throw notFound('Choose a bank account');
    const rows = await db.accEntry.findMany({ where: { ledgerId, voucher: { status: 'posted', date: { lte: dayDate(upTo) } }, ...(show === 'open' ? { reconciledOn: null } : {}) }, include: { voucher: { select: { number: true, date: true, narration: true, reference: true } } }, orderBy: { voucher: { date: 'asc' } }, take: 2000 });
    const all = await db.accEntry.aggregate({ where: { ledgerId, voucher: { status: 'posted', date: { lte: dayDate(upTo) } } }, _sum: { dr: true, cr: true } });
    const open = await db.accEntry.aggregate({ where: { ledgerId, reconciledOn: null, voucher: { status: 'posted', date: { lte: dayDate(upTo) } } }, _sum: { dr: true, cr: true } });
    const years = await db.accYear.findMany({ where: { start: { lte: dayDate(upTo) } }, orderBy: { start: 'asc' }, take: 1 });
    const opening = (years[0]?.openings as Record<string, number> | undefined)?.[ledgerId] ?? 0;
    const books = r2(opening + (all._sum.dr ?? 0) - (all._sum.cr ?? 0));
    const notInBank = r2((open._sum.dr ?? 0) - (open._sum.cr ?? 0));
    return { ledger: { id: l.id, name: l.name }, upTo, books, notInBank, bank: r2(books - notInBank), rows: rows.map((e) => ({ id: e.id, date: isoOf(e.voucher.date), number: e.voucher.number, narration: e.voucher.narration, reference: e.voucher.reference, deposit: e.dr, withdrawal: e.cr, reconciledOn: e.reconciledOn ? isoOf(e.reconciledOn) : null })) };
};

export const reconcileSchema = z.strictObject({ entryIds: z.array(z.uuid()).min(1).max(2000), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() });
export const reconcile = async (input: z.infer<typeof reconcileSchema>) => {
    await db.accEntry.updateMany({ where: { id: { in: input.entryIds } }, data: { reconciledOn: input.date ? dayDate(input.date) : null } });
    return { done: input.entryIds.length };
};

/** Reads a bank statement (Excel: date, description, withdrawal / deposit or amount) and suggests matching book entries. */
export const matchStatement = async (ledgerId: string, data: Buffer) => {
    const wb = new ExcelJS.Workbook();
    try {
        await wb.xlsx.load(data as unknown as ExcelJS.Buffer);
    } catch {
        throw badRequest('That is not an Excel (.xlsx) file');
    }
    const ws = wb.worksheets[0];
    let head = 0;
    let cols: Record<string, number> = {};
    ws.eachRow((row, n) => {
        if (head) return;
        const vals = (row.values as unknown[]).map((v) => String(v ?? '').toLowerCase());
        const find = (re: RegExp) => vals.findIndex((v) => re.test(v));
        const date = find(/date/);
        if (date > 0 && (find(/withdraw|debit|amount/) > 0 || find(/deposit|credit/) > 0)) {
            head = n;
            cols = { date, desc: find(/desc|narration|particular|remark/), out: find(/withdraw|debit/), inn: find(/deposit|credit/), amount: find(/^amount/) };
        }
    });
    if (!head) throw badRequest('Could not find the columns: the sheet needs a Date column and Withdrawal / Deposit (or Debit / Credit, or Amount)');
    const lines: { date: string; description: string; deposit: number; withdrawal: number }[] = [];
    const num = (v: unknown) => Number(String(v ?? '').replace(/[,₹\s]/g, '')) || 0;
    for (let n = head + 1; n <= ws.rowCount; n++) {
        const r = ws.getRow(n);
        const raw = r.getCell(cols.date).value;
        const d = raw instanceof Date ? isoOf(raw) : /^\d{4}-\d{2}-\d{2}/.test(String(raw ?? '')) ? String(raw).slice(0, 10) : /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.test(String(raw ?? '')) ? (() => { const m = String(raw).match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/)!; const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; })() : null;
        if (!d) continue;
        let deposit = cols.inn > 0 ? num(r.getCell(cols.inn).value) : 0;
        let withdrawal = cols.out > 0 ? num(r.getCell(cols.out).value) : 0;
        if (!deposit && !withdrawal && cols.amount > 0) {
            const a = num(r.getCell(cols.amount).value);
            if (a >= 0) deposit = a;
            else withdrawal = -a;
        }
        if (deposit || withdrawal) lines.push({ date: d, description: cols.desc > 0 ? String(r.getCell(cols.desc).value ?? '').slice(0, 120) : '', deposit, withdrawal });
    }
    const open = await db.accEntry.findMany({ where: { ledgerId, reconciledOn: null, voucher: { status: 'posted' } }, include: { voucher: { select: { number: true, date: true, narration: true } } } });
    const used = new Set<string>();
    const matches = lines.map((s) => {
        const near = open.filter((e) => !used.has(e.id) && Math.abs(e.dr - s.deposit) < 0.01 && Math.abs(e.cr - s.withdrawal) < 0.01 && Math.abs(e.voucher.date.getTime() - dayDate(s.date).getTime()) <= 5 * DAY).sort((a, b) => Math.abs(a.voucher.date.getTime() - dayDate(s.date).getTime()) - Math.abs(b.voucher.date.getTime() - dayDate(s.date).getTime()))[0];
        if (near) used.add(near.id);
        return { ...s, entryId: near?.id ?? null, voucher: near ? `${near.voucher.number} · ${near.voucher.narration ?? ''}` : null };
    });
    return { lines: matches, matched: matches.filter((m) => m.entryId).length };
};
