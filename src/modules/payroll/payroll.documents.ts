import { z } from 'zod';
import { db } from '../../core/db';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { getUserAccess } from '../rbac/access.service';
import { defineDocument } from '../documents/documents.registry';
import { isoOf, todayIST } from '../attendance/attendance.settings';
import { assertSlip, fullAmounts, heads, Line, monthLabel, runView } from './payroll.service';
import { settlement } from './exports.service';
import { PAYROLL } from './payroll.settings';

/** Payroll documents (Document Templates, editable): payslip, bank letter, increment letter, salary certificate, full and final settlement. */

const uuid = (v: string | undefined, what: string) => {
    if (!v || !z.uuid().safeParse(v).success) throw badRequest(`Choose the ${what}`);
    return v;
};
const need = async (userId: string, keys: string[]) => {
    const a = await getUserAccess(userId);
    if (!keys.some((k) => a.permissions[k])) throw forbidden();
    return a;
};
const HEAD = `<header class="head">{{#if school.logo}}<img class="logo" src="{{school.logo}}" alt="">{{/if}}<div><h1>{{school.name}}</h1><p>{{school.address}}</p></div></header>`;
const CSS = `body { font-size: 11.5px; color: #111; }
.head { display: flex; gap: 12px; align-items: center; border-bottom: 2px solid #1A365D; padding-bottom: 6px; }
.head .logo { width: 52px; height: 52px; object-fit: contain; }
.head h1 { margin: 0; font-size: 17px; color: #1A365D; text-transform: uppercase; }
.head p { margin: 1px 0; font-size: 10.5px; }
h2.title { text-align: center; font-size: 14px; color: #1A365D; letter-spacing: 1px; margin: 10px 0; }
table { width: 100%; border-collapse: collapse; }
table.info td { padding: 3px 6px; border: 1px solid #ccc; }
table.info td:nth-child(odd) { color: #555; width: 18%; }
table.pay th, table.pay td { border: 1px solid #999; padding: 4px 6px; }
table.pay th { background: #1A365D; color: #fff; text-align: left; }
table.pay td.n { text-align: right; }
table.pay tr.sum td { font-weight: 700; background: #EEF2F7; }
.net { margin-top: 10px; font-size: 13px; }
.letter p { line-height: 1.6; }
.sign { display: flex; justify-content: space-between; margin-top: 46px; font-size: 11px; }
.sign div { text-align: center; min-width: 140px; border-top: 1px solid #333; padding-top: 4px; }
.small { font-size: 9.5px; color: #666; margin-top: 8px; }`;
const rupee = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** One payslip shaped for the template. */
const slipData = async (slipId: string) => {
    const p = await db.payslip.findFirst({ where: { id: slipId }, include: { run: { select: { month: true } } } });
    if (!p) throw notFound('Payslip not found');
    const [st, s] = await Promise.all([db.staff.findFirst({ where: { id: p.staffId }, select: { firstName: true, middleName: true, lastName: true, employeeCode: true, pan: true, uan: true, joiningDate: true, designationId: true, departmentId: true } }), getSettings({ showEmployer: PAYROLL.showEmployer })]);
    const m = await db.masterValue.findMany({ where: { id: { in: [st?.designationId, st?.departmentId].filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    const earnings = p.earnings as { name: string; full?: number; amount: number }[];
    const deductions = p.deductions as { name: string; amount: number }[];
    const n = Math.max(earnings.length, deductions.length);
    const days = p.days as Record<string, number>;
    const employer = p.employer as Record<string, number>;
    const bank = p.bank as { bank: string; accountNo: string; ifsc: string };
    return {
        month: monthLabel(p.run.month),
        staff: { name: st ? [st.firstName, st.middleName, st.lastName].filter(Boolean).join(' ') : '', employeeCode: st?.employeeCode ?? '', designation: m.find((x) => x.id === st?.designationId)?.name ?? '', department: m.find((x) => x.id === st?.departmentId)?.name ?? '', pan: st?.pan ?? '', uan: st?.uan ?? '', joiningDate: st ? isoOf(st.joiningDate) : null },
        bank: { name: bank.bank, account: bank.accountNo ? `XXXX${bank.accountNo.slice(-4)}` : '—', ifsc: bank.ifsc },
        days: { total: p.totalDays, paid: p.paidDays, lwp: (days.lwp ?? 0) + (days.absent ?? 0) + (days.latePenalty ?? 0), leave: days.paidLeave ?? 0 },
        rows: Array.from({ length: n }, (_, i) => ({ earning: earnings[i]?.name ?? '', full: earnings[i]?.full != null ? rupee(earnings[i].full!) : '', amount: earnings[i] ? rupee(earnings[i].amount) : '', deduction: deductions[i]?.name ?? '', deducted: deductions[i] ? rupee(deductions[i].amount) : '' })),
        gross: rupee(p.gross),
        deducted: rupee(p.deducted),
        net: rupee(p.net),
        netValue: Math.round(p.net),
        employer: s.showEmployer && (employer.pf || employer.esi) ? [employer.pf ? `PF ${rupee(employer.pf)}` : '', employer.esi ? `ESI ${rupee(employer.esi)}` : ''].filter(Boolean).join(' · ') : null,
    };
};

defineDocument({
    key: 'payslip',
    label: 'Payslip',
    description: 'A staff member’s monthly payslip: days paid, earnings, deductions, net pay (in words), bank. A whole month prints as one PDF.',
    fields: [
        { key: 'month / staff.* / bank.* / days.*', label: 'The month, staff member, bank and days' },
        { key: '#each rows → earning, full, amount, deduction, deducted', label: 'Earnings beside deductions' },
        { key: 'gross / deducted / net / netValue / employer', label: 'Totals (inWords netValue for words)' },
    ],
    html: `${HEAD}
<h2 class="title">PAYSLIP · {{upper month}}</h2>
<table class="info"><tr><td>Name</td><td><b>{{staff.name}}</b></td><td>Emp. code</td><td>{{staff.employeeCode}}</td></tr>
<tr><td>Designation</td><td>{{staff.designation}}</td><td>Department</td><td>{{staff.department}}</td></tr>
<tr><td>PAN</td><td>{{staff.pan}}</td><td>UAN</td><td>{{staff.uan}}</td></tr>
<tr><td>Bank</td><td>{{bank.name}} · {{bank.account}}</td><td>Days paid</td><td><b>{{days.paid}}</b> of {{days.total}}{{#if days.lwp}} (unpaid {{days.lwp}}){{/if}}</td></tr></table>
<table class="pay" style="margin-top:10px"><thead><tr><th>Earnings</th><th>Monthly</th><th>Paid</th><th>Deductions</th><th>Amount</th></tr></thead>
<tbody>{{#each rows}}<tr><td>{{earning}}</td><td class="n">{{full}}</td><td class="n">{{amount}}</td><td>{{deduction}}</td><td class="n">{{deducted}}</td></tr>{{/each}}
<tr class="sum"><td>Gross pay</td><td></td><td class="n">{{gross}}</td><td>Total deductions</td><td class="n">{{deducted}}</td></tr></tbody></table>
<p class="net"><b>Net pay: {{net}}</b> ({{inWords netValue}} only)</p>
{{#if employer}}<p class="small">Paid by the school besides: {{employer}}</p>{{/if}}
<p class="small">This is a computer-generated payslip and needs no signature.</p>`,
    css: CSS,
    paper: { size: 'A4', orientation: 'portrait', margin: 12, copies: ['Payslip'] },
    sample: async () => {
        const p = await db.payslip.findFirst({ orderBy: { id: 'asc' }, select: { id: true } });
        if (!p) throw badRequest('Prepare a month’s payroll first to preview');
        return { data: await slipData(p.id), filename: 'payslip-sample.pdf' };
    },
    load: async (params, userId) => {
        if (params.month) {
            await need(userId, ['payroll.view', 'payroll.run', 'payroll.approve']);
            const v = await runView(params.month);
            if (!v.slips.length) throw badRequest('No payslips for that month');
            const many = [];
            for (const s of v.slips) many.push(await slipData(s.id));
            return { data: many[0], many, filename: `payslips-${params.month}.pdf` };
        }
        const a = await getUserAccess(userId);
        const slip = await assertSlip(uuid(params.slip, 'payslip'), userId, !!(a.permissions['payroll.view'] || a.permissions['payroll.run'] || a.permissions['payroll.approve']));
        const data = await slipData(slip.id);
        return { data, filename: `payslip-${data.staff.employeeCode}-${params.slip?.slice(0, 4)}.pdf` };
    },
});

defineDocument({
    key: 'salary_bank_letter',
    label: 'Salary bank letter',
    description: 'The covering letter to the bank to credit the month’s salaries (with the list).',
    fields: [{ key: 'month / count / total / totalValue / #each rows → name, account, ifsc, amount', label: 'The month and the transfers' }],
    html: `${HEAD}
<div class="letter"><p style="text-align:right">Date: {{date today}}</p>
<p>To,<br>The Branch Manager,<br>{{bankName}}</p>
<p><b>Subject: Credit of staff salaries for {{month}}</b></p>
<p>Dear Sir / Madam,</p>
<p>Please debit our account and credit the salaries of {{count}} staff members for {{month}}, totalling <b>{{total}}</b> ({{inWords totalValue}} only), to the accounts below.</p></div>
<table class="pay"><thead><tr><th>#</th><th>Name</th><th>Account no.</th><th>IFSC</th><th>Amount</th></tr></thead>
<tbody>{{#each rows}}<tr><td>{{no}}</td><td>{{name}}</td><td>{{account}}</td><td>{{ifsc}}</td><td class="n">{{amount}}</td></tr>{{/each}}
<tr class="sum"><td colspan="4">Total</td><td class="n">{{total}}</td></tr></tbody></table>
<div class="sign"><div>Accountant</div><div>Principal / Manager</div></div>`,
    css: CSS,
    paper: { size: 'A4', orientation: 'portrait', margin: 14, copies: ['Bank copy', 'Office copy'] },
    sample: async () => ({ data: { today: todayIST(), bankName: 'State Bank of India', month: 'October 2026', count: 1, total: '₹42,000.00', totalValue: 42000, rows: [{ no: 1, name: 'Anita Sharma', account: '30012345678', ifsc: 'SBIN0001234', amount: '₹42,000.00' }] }, filename: 'bank-letter-sample.pdf' }),
    load: async (params, userId) => {
        await need(userId, ['payroll.view', 'payroll.approve']);
        const v = await runView(params.month ?? '');
        if (!v.slips.length) throw badRequest('No payroll for that month');
        const rows = v.slips.filter((s) => s.net > 0).map((s, i) => ({ no: i + 1, name: s.name, account: s.bank.accountNo || '—', ifsc: s.bank.ifsc || '—', amount: rupee(s.net) }));
        const total = v.slips.reduce((a, s) => a + (s.net > 0 ? s.net : 0), 0);
        const banks = [...new Set(v.slips.map((s) => s.bank.bank).filter(Boolean))];
        return { data: { today: todayIST(), bankName: banks.length === 1 ? banks[0] : 'our bank', month: v.label, count: rows.length, total: rupee(total), totalValue: Math.round(total), rows }, filename: `salary-bank-letter-${params.month}.pdf` };
    },
});

const staffLine = async (staffId: string) => {
    const st = await db.staff.findFirst({ where: { id: staffId }, select: { firstName: true, middleName: true, lastName: true, employeeCode: true, joiningDate: true, designationId: true, departmentId: true, status: true, statusDate: true } });
    if (!st) throw notFound('Staff member not found');
    const m = await db.masterValue.findMany({ where: { id: { in: [st.designationId, st.departmentId].filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    return { name: [st.firstName, st.middleName, st.lastName].filter(Boolean).join(' '), employeeCode: st.employeeCode, designation: m.find((x) => x.id === st.designationId)?.name ?? '', department: m.find((x) => x.id === st.departmentId)?.name ?? '', joiningDate: isoOf(st.joiningDate), working: st.status === 'working', leftOn: st.statusDate ? isoOf(st.statusDate) : null };
};

defineDocument({
    key: 'increment_letter',
    label: 'Increment letter',
    description: 'A letter to a staff member about a salary increase: from when, old and new basic and gross.',
    fields: [{ key: 'staff.* / effectiveFrom / oldBasic / newBasic / oldGross / newGross', label: 'The increment' }],
    html: `${HEAD}
<div class="letter"><p style="text-align:right">Date: {{date today}}</p>
<p>To,<br><b>{{staff.name}}</b> ({{staff.employeeCode}})<br>{{staff.designation}}</p>
<p><b>Subject: Increment in salary</b></p>
<p>Dear {{staff.name}},</p>
<p>We are pleased to inform you that, in appreciation of your work, your salary has been revised with effect from <b>{{date effectiveFrom}}</b>.</p></div>
<table class="pay"><thead><tr><th></th><th>Before</th><th>From {{date effectiveFrom}}</th></tr></thead><tbody>
<tr><td>Basic pay (monthly)</td><td class="n">{{oldBasic}}</td><td class="n"><b>{{newBasic}}</b></td></tr>
<tr><td>Gross salary (monthly)</td><td class="n">{{oldGross}}</td><td class="n"><b>{{newGross}}</b></td></tr></tbody></table>
<div class="letter"><p>The other terms of your service remain the same. We wish you continued success.</p></div>
<div class="sign"><div>Staff member</div><div>Principal</div></div>`,
    css: CSS,
    paper: { size: 'A4', orientation: 'portrait', margin: 16, copies: ['Staff copy', 'Office copy'] },
    sample: async () => ({ data: { today: todayIST(), staff: { name: 'Anita Sharma', employeeCode: 'EMP-0042', designation: 'TGT' }, effectiveFrom: '2026-04-01', oldBasic: '₹35,000.00', newBasic: '₹36,750.00', oldGross: '₹52,000.00', newGross: '₹54,600.00' }, filename: 'increment-letter-sample.pdf' }),
    load: async (params, userId) => {
        await need(userId, ['payroll.salary']);
        const row = await db.staffSalary.findFirst({ where: { id: uuid(params.salary, 'salary change') } });
        if (!row) throw notFound('Not found');
        const prev = await db.staffSalary.findFirst({ where: { staffId: row.staffId, effectiveFrom: { lt: row.effectiveFrom } }, orderBy: { effectiveFrom: 'desc' } });
        const hs = await heads();
        const now = fullAmounts(row.basic, row.lines as Line[], hs);
        const before = prev ? fullAmounts(prev.basic, prev.lines as Line[], hs) : null;
        return { data: { today: todayIST(), staff: await staffLine(row.staffId), effectiveFrom: isoOf(row.effectiveFrom), oldBasic: prev ? rupee(prev.basic) : '—', newBasic: rupee(row.basic), oldGross: before ? rupee(before.gross) : '—', newGross: rupee(now.gross) }, filename: 'increment-letter.pdf' };
    },
});

defineDocument({
    key: 'salary_certificate',
    label: 'Salary certificate',
    description: 'Certifies a staff member’s employment and current monthly salary (for a bank loan, visa…).',
    fields: [{ key: 'staff.* / gross / grossValue / basic / purpose', label: 'The staff member and salary' }],
    html: `${HEAD}
<h2 class="title">SALARY CERTIFICATE</h2>
<div class="letter"><p style="text-align:right">Date: {{date today}}</p>
<p>This is to certify that <b>{{staff.name}}</b> ({{staff.employeeCode}}) is working with us as <b>{{staff.designation}}</b>{{#if staff.department}} in the {{staff.department}} department{{/if}} since {{date staff.joiningDate}}.</p>
<p>Their present monthly gross salary is <b>{{gross}}</b> ({{inWords grossValue}} only), with a basic pay of {{basic}}.</p>
{{#if purpose}}<p>This certificate is issued on their request for {{purpose}}.</p>{{else}}<p>This certificate is issued on their request.</p>{{/if}}</div>
<div class="sign"><div style="visibility:hidden">.</div><div>Principal</div></div>`,
    css: CSS,
    paper: { size: 'A4', orientation: 'portrait', margin: 18, copies: ['Certificate'] },
    sample: async () => ({ data: { today: todayIST(), staff: { name: 'Anita Sharma', employeeCode: 'EMP-0042', designation: 'TGT', department: 'Science', joiningDate: '2019-07-01' }, gross: '₹54,600.00', grossValue: 54600, basic: '₹36,750.00', purpose: 'a home loan' }, filename: 'salary-certificate-sample.pdf' }),
    load: async (params, userId) => {
        await need(userId, ['payroll.salary']);
        const staffId = uuid(params.staff, 'staff member');
        const row = await db.staffSalary.findFirst({ where: { staffId, effectiveFrom: { lte: new Date() } }, orderBy: { effectiveFrom: 'desc' } });
        if (!row) throw badRequest('No salary set for this staff member');
        const f = fullAmounts(row.basic, row.lines as Line[], await heads());
        return { data: { today: todayIST(), staff: await staffLine(staffId), gross: rupee(f.gross), grossValue: Math.round(f.gross), basic: rupee(row.basic), purpose: (params.purpose ?? '').slice(0, 80) }, filename: 'salary-certificate.pdf' };
    },
});

defineDocument({
    key: 'settlement',
    label: 'Full and final settlement',
    description: 'For a staff member leaving: pay to the last day, earned leave paid, loans recovered, the amount payable.',
    fields: [{ key: 'staff.* / monthLabel / paidDays / totalDays / monthPay / encashDays / encash / #each loans / recover / net', label: 'The settlement' }],
    html: `${HEAD}
<h2 class="title">FULL AND FINAL SETTLEMENT</h2>
<table class="info"><tr><td>Name</td><td><b>{{staff.name}}</b></td><td>Emp. code</td><td>{{staff.employeeCode}}</td></tr>
<tr><td>Designation</td><td>{{staff.designation}}</td><td>Joined</td><td>{{date staff.joiningDate}}</td></tr>
<tr><td>Last working day</td><td><b>{{date staff.lastDay}}</b></td><td>Monthly gross</td><td>{{rupees monthlyGross}}</td></tr></table>
<table class="pay" style="margin-top:10px"><thead><tr><th>Item</th><th>Amount</th></tr></thead><tbody>
<tr><td>Salary for {{monthLabel}}{{#if totalDays}} ({{paidDays}} of {{totalDays}} days){{else}} (already paid){{/if}}</td><td class="n">{{rupees monthPay}}</td></tr>
<tr><td>Earned leave paid ({{encashDays}} days)</td><td class="n">{{rupees encash}}</td></tr>
{{#each loans}}<tr><td>Less: {{kind}} outstanding</td><td class="n">− {{rupees balance}}</td></tr>{{/each}}
<tr class="sum"><td>Payable</td><td class="n">{{rupees net}}</td></tr></tbody></table>
<div class="sign"><div>Received by (staff member)</div><div>Accountant</div><div>Principal</div></div>`,
    css: CSS,
    paper: { size: 'A4', orientation: 'portrait', margin: 14, copies: ['Office copy', 'Staff copy'] },
    sample: async () => ({ data: { staff: { name: 'Anita Sharma', employeeCode: 'EMP-0042', designation: 'TGT', joiningDate: '2019-07-01', lastDay: '2026-10-15' }, monthlyGross: 54600, monthLabel: 'October 2026', paidDays: 15, totalDays: 31, monthPay: 26419, encashDays: 12, encash: 14700, loans: [{ kind: 'Loan', balance: 8000 }], recover: 8000, net: 33119 }, filename: 'settlement-sample.pdf' }),
    load: async (params, userId) => {
        await need(userId, ['payroll.salary']);
        const lastDay = params.lastDay && /^\d{4}-\d{2}-\d{2}$/.test(params.lastDay) ? params.lastDay : todayIST();
        return { data: await settlement(uuid(params.staff, 'staff member'), lastDay), filename: 'full-and-final-settlement.pdf' };
    },
});
