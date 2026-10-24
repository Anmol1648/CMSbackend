import { z } from 'zod';
import { badRequest, forbidden } from '../../core/errors';
import { getUserAccess } from '../rbac/access.service';
import { defineDocument } from '../documents/documents.registry';
import { defineReport, registerReportCategory } from '../reports/reports.registry';
import { defineWidget } from '../dashboard/dashboard.registry';
import { balanceSheet, dayBook, incomeExpenditure, moneyNow, payables, receiptsPayments, trialBalance, voucherView } from './accounts.service';

/** Accounts reports (Report Center), the voucher print, and a dashboard widget. */

registerReportCategory('Accounts', 62);

const range = [
    { key: 'from', label: 'From', type: 'date' as const, required: true, default: 'monthStart' },
    { key: 'to', label: 'To', type: 'date' as const, required: true, default: 'today' },
];
const check = (f: Record<string, string>) => {
    if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
};
const T: Record<string, string> = { receipt: 'Receipt', payment: 'Payment', contra: 'Contra', journal: 'Journal' };

defineReport({
    key: 'acc_daybook',
    category: 'Accounts',
    label: 'Day book',
    description: 'Every posted voucher in a period with its debits and credits.',
    permissions: ['accounts.view'],
    orientation: 'landscape',
    filters: range,
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 0.7 },
        { key: 'number', label: 'Voucher', type: 'text', width: 1 },
        { key: 'type', label: 'Type', type: 'text', width: 0.6 },
        { key: 'ledger', label: 'Ledger', type: 'text', width: 1.6 },
        { key: 'narration', label: 'Narration', type: 'text', width: 1.8 },
        { key: 'dr', label: 'Debit', type: 'money', width: 0.8, total: true },
        { key: 'cr', label: 'Credit', type: 'money', width: 0.8, total: true },
    ],
    async run(f) {
        check(f);
        const rows = await dayBook(f.from, f.to);
        return { subtitle: `${f.from} – ${f.to}`, rows: rows.flatMap((v) => v.lines.map((l, i) => ({ date: i ? '' : v.date, number: i ? '' : v.number, type: i ? '' : T[v.type], ledger: l.ledger, narration: i ? '' : (v.narration ?? ''), dr: l.dr, cr: l.cr }))) };
    },
});

defineReport({
    key: 'acc_trial_balance',
    category: 'Accounts',
    label: 'Trial balance',
    description: 'Every ledger’s debit or credit balance on a day, grouped; the two sides must agree.',
    permissions: ['accounts.view'],
    orientation: 'portrait',
    filters: [{ key: 'asOf', label: 'As on', type: 'date', required: true, default: 'today' }],
    columns: [
        { key: 'name', label: 'Ledger', type: 'text', width: 2 },
        { key: 'dr', label: 'Debit', type: 'money', width: 0.9, total: true },
        { key: 'cr', label: 'Credit', type: 'money', width: 0.9, total: true },
    ],
    async run(f) {
        const t = await trialBalance(f.asOf);
        return { subtitle: `As on ${f.asOf}`, groupedBy: 'Group', rows: t.rows.map((r) => ({ groupKey: r.group, groupLabel: `${r.top} · ${r.group}`, name: r.name, dr: r.dr, cr: r.cr })).sort((a, b) => a.groupLabel.localeCompare(b.groupLabel)) };
    },
});

defineReport({
    key: 'acc_income_expenditure',
    category: 'Accounts',
    label: 'Income and expenditure',
    description: 'Income and expenses of a period by ledger, and the surplus or deficit.',
    permissions: ['accounts.view'],
    orientation: 'portrait',
    filters: range,
    columns: [
        { key: 'name', label: 'Ledger', type: 'text', width: 2 },
        { key: 'income', label: 'Income', type: 'money', width: 0.9, total: true },
        { key: 'expense', label: 'Expenditure', type: 'money', width: 0.9, total: true },
    ],
    async run(f) {
        check(f);
        const r = await incomeExpenditure(f.from, f.to);
        return { subtitle: `${f.from} – ${f.to} · ${r.surplus >= 0 ? 'Surplus' : 'Deficit'} ₹${Math.abs(r.surplus).toLocaleString('en-IN')}`, groupedBy: 'Side', rows: [...r.income.map((x) => ({ groupKey: 'i', groupLabel: 'Income', name: x.name, income: x.amount, expense: 0 })), ...r.expense.map((x) => ({ groupKey: 'e', groupLabel: 'Expenditure', name: x.name, income: 0, expense: x.amount }))] };
    },
});

defineReport({
    key: 'acc_balance_sheet',
    category: 'Accounts',
    label: 'Balance sheet',
    description: 'Assets and liabilities (with the general fund and the year’s surplus) on a day.',
    permissions: ['accounts.view'],
    orientation: 'portrait',
    filters: [{ key: 'asOf', label: 'As on', type: 'date', required: true, default: 'today' }],
    columns: [
        { key: 'name', label: 'Ledger', type: 'text', width: 2 },
        { key: 'group', label: 'Group', type: 'text', width: 1.2 },
        { key: 'amount', label: 'Amount', type: 'money', width: 0.9, total: true },
    ],
    async run(f) {
        const b = await balanceSheet(f.asOf);
        return { subtitle: `As on ${f.asOf}${Math.abs(b.difference) > 0.5 ? ` · difference ₹${b.difference} (check opening balances)` : ''}`, groupedBy: 'Side', rows: [...b.liabilities.map((x) => ({ groupKey: 'l', groupLabel: 'Liabilities and funds', ...x })), ...b.assets.map((x) => ({ groupKey: 'a', groupLabel: 'Assets', ...x }))] };
    },
});

defineReport({
    key: 'acc_receipts_payments',
    category: 'Accounts',
    label: 'Receipts and payments account',
    description: 'Opening cash and bank, money received and paid by what it was for, and the closing balance.',
    permissions: ['accounts.view'],
    orientation: 'portrait',
    filters: range,
    columns: [
        { key: 'name', label: 'Particulars', type: 'text', width: 2 },
        { key: 'receipts', label: 'Receipts', type: 'money', width: 0.9, total: true },
        { key: 'payments', label: 'Payments', type: 'money', width: 0.9, total: true },
    ],
    async run(f) {
        check(f);
        const r = await receiptsPayments(f.from, f.to);
        return { subtitle: `${f.from} – ${f.to} · closing cash and bank ₹${r.closing.toLocaleString('en-IN')}`, groupedBy: 'Part', rows: [...r.opening.map((x) => ({ groupKey: 'o', groupLabel: 'Opening balance', name: x.name, receipts: x.amount, payments: 0 })), ...r.receipts.map((x) => ({ groupKey: 'r', groupLabel: 'Receipts', name: x.name, receipts: x.amount, payments: 0 })), ...r.payments.map((x) => ({ groupKey: 'p', groupLabel: 'Payments', name: x.name, receipts: 0, payments: x.amount }))] };
    },
});

defineReport({
    key: 'acc_payables',
    category: 'Accounts',
    label: 'Amounts owed to vendors',
    description: 'What the school owes each vendor (store purchases not yet paid).',
    permissions: ['accounts.view'],
    orientation: 'portrait',
    filters: [],
    columns: [
        { key: 'name', label: 'Vendor', type: 'text', width: 2 },
        { key: 'owed', label: 'Owed', type: 'money', width: 0.9, total: true },
    ],
    async run() {
        return { rows: await payables() };
    },
});

defineDocument({
    key: 'acc_voucher',
    label: 'Accounts voucher',
    description: 'A receipt, payment, contra or journal voucher with its lines, narration and signatures.',
    fields: [{ key: 'number / typeLabel / date / narration / reference / #each entries → ledger, dr, cr / total / totalValue', label: 'The voucher' }],
    html: `<header class="head">{{#if school.logo}}<img class="logo" src="{{school.logo}}" alt="">{{/if}}<div><h1>{{school.name}}</h1><p>{{school.address}}</p></div></header>
<h2 class="title">{{upper typeLabel}} VOUCHER</h2>
<table class="info"><tr><td>Voucher no.</td><td><b>{{number}}</b></td><td>Date</td><td>{{date date}}</td></tr>{{#if reference}}<tr><td>Reference</td><td colspan="3">{{reference}}</td></tr>{{/if}}</table>
<table class="pay" style="margin-top:10px"><thead><tr><th>Ledger</th><th>Debit</th><th>Credit</th></tr></thead><tbody>
{{#each entries}}<tr><td>{{ledger}}{{#if note}}<br><small>{{note}}</small>{{/if}}</td><td class="n">{{#if dr}}{{rupees dr}}{{/if}}</td><td class="n">{{#if cr}}{{rupees cr}}{{/if}}</td></tr>{{/each}}
<tr class="sum"><td>Total</td><td class="n">{{rupees total}}</td><td class="n">{{rupees total}}</td></tr></tbody></table>
<p>{{#if narration}}<b>Narration:</b> {{narration}}<br>{{/if}}<b>Amount in words:</b> {{inWords totalValue}} only</p>
<div class="sign"><div>Prepared by<br><small>{{createdByName}}</small></div><div>Checked / approved<br><small>{{approvedByName}}</small></div><div>Received by</div></div>`,
    css: `body { font-size: 11.5px; }
.head { display: flex; gap: 12px; align-items: center; border-bottom: 2px solid #1A365D; padding-bottom: 6px; }
.head .logo { width: 50px; height: 50px; object-fit: contain; }
.head h1 { margin: 0; font-size: 17px; color: #1A365D; text-transform: uppercase; }
.head p { margin: 1px 0; font-size: 10.5px; }
h2.title { text-align: center; font-size: 14px; color: #1A365D; letter-spacing: 1px; margin: 10px 0; }
table { width: 100%; border-collapse: collapse; }
table.info td { padding: 3px 6px; border: 1px solid #ccc; }
table.pay th, table.pay td { border: 1px solid #999; padding: 4px 6px; }
table.pay th { background: #1A365D; color: #fff; text-align: left; }
table.pay td.n { text-align: right; width: 22%; }
table.pay tr.sum td { font-weight: 700; background: #EEF2F7; }
.sign { display: flex; justify-content: space-between; margin-top: 44px; font-size: 11px; }
.sign div { text-align: center; min-width: 140px; border-top: 1px solid #333; padding-top: 4px; }`,
    paper: { size: 'A5', orientation: 'landscape', margin: 8, copies: ['Voucher'] },
    sample: async () => ({ data: { number: 'PV/2026-27/0012', typeLabel: 'Payment', date: '2026-10-20', reference: 'UPI 4521', narration: 'Electricity bill for September', entries: [{ ledger: 'Electricity', dr: 18450, cr: 0 }, { ledger: 'School bank account', dr: 0, cr: 18450 }], total: 18450, totalValue: 18450, createdByName: 'Sanjay Singh', approvedByName: 'Sandeep Bhandari' }, filename: 'voucher-sample.pdf' }),
    load: async (params, userId) => {
        const a = await getUserAccess(userId);
        if (!['accounts.view', 'accounts.entry', 'accounts.approve'].some((k) => a.permissions[k])) throw forbidden();
        if (!params.id || !z.uuid().safeParse(params.id).success) throw badRequest('Choose the voucher');
        const v = await voucherView(params.id);
        return { data: { ...v, typeLabel: T[v.type], totalValue: Math.round(v.total) }, filename: `voucher-${v.number.replace(/[^A-Za-z0-9-]+/g, '-')}.pdf` };
    },
});

defineWidget({
    key: 'accounts_money',
    label: 'Cash and bank',
    description: 'Cash in hand and bank balances today, and payments waiting for approval.',
    category: 'Today',
    type: 'stat',
    size: 'sm',
    href: '/accounts',
    permissions: ['accounts.view', 'accounts.approve'],
    cacheSeconds: 300,
    async load({ permissions }) {
        const m = await moneyNow();
        return { value: `₹${Math.round(m.cash + m.bank).toLocaleString('en-IN')}`, caption: 'cash and bank', tone: m.cashWarning || (permissions['accounts.approve'] && m.pending) ? 'warn' : 'neutral', sub: [{ label: 'Cash in hand', value: `₹${Math.round(m.cash).toLocaleString('en-IN')}`, tone: m.cashWarning ? 'warn' : undefined }, { label: 'Bank', value: `₹${Math.round(m.bank).toLocaleString('en-IN')}` }, ...(permissions['accounts.approve'] ? [{ label: 'Payments to approve', value: m.pending, tone: m.pending ? ('warn' as const) : undefined }] : [])] };
    },
});

