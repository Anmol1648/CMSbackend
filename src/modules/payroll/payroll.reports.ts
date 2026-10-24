import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { todayIST } from '../attendance/attendance.settings';
import { defineReport, registerReportCategory } from '../reports/reports.registry';
import { defineWidget } from '../dashboard/dashboard.registry';
import { listLoans, monthLabel, r2, runView } from './payroll.service';

/** Payroll reports (Report Center) and a dashboard widget. */

registerReportCategory('Payroll', 61);

const monthFilter = { key: 'month', label: 'Month (YYYY-MM)', type: 'text' as const, required: true, default: '', help: 'e.g. 2026-09' };
const check = (m: string) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m ?? '')) throw badRequest('Give the month as YYYY-MM', [{ field: 'month', message: 'like 2026-09' }]);
    return m;
};
type Amount = { code: string; name: string; amount: number };
const amt = (l: Amount[], code: string) => l.filter((x) => x.code === code).reduce((a, x) => a + x.amount, 0);

defineReport({
    key: 'payroll_register',
    category: 'Payroll',
    label: 'Salary register',
    description: 'Every staff member’s pay for a month by department: days, gross, PF, ESI, PT, TDS, other deductions and net.',
    permissions: ['payroll.view'],
    orientation: 'landscape',
    filters: [monthFilter],
    columns: [
        { key: 'code', label: 'Emp. code', type: 'text', width: 0.7 },
        { key: 'name', label: 'Name', type: 'text', width: 1.5 },
        { key: 'days', label: 'Paid days', type: 'number', width: 0.5 },
        { key: 'gross', label: 'Gross', type: 'money', width: 0.8, total: true },
        { key: 'pf', label: 'PF', type: 'money', width: 0.6, total: true },
        { key: 'esi', label: 'ESI', type: 'money', width: 0.5, total: true },
        { key: 'pt', label: 'PT', type: 'money', width: 0.5, total: true },
        { key: 'tds', label: 'TDS', type: 'money', width: 0.6, total: true },
        { key: 'other', label: 'Other', type: 'money', width: 0.6, total: true },
        { key: 'net', label: 'Net', type: 'money', width: 0.8, total: true },
    ],
    async run(f) {
        const v = await runView(check(f.month));
        return { subtitle: v.label + (v.run ? ` · ${v.run.status}` : ''), groupedBy: 'Department', rows: v.slips.map((s) => ({ groupKey: s.department || '-', groupLabel: s.department || 'No department', code: s.employeeCode, name: s.name, days: s.paidDays, gross: s.gross, pf: amt(s.deductions, 'PF'), esi: amt(s.deductions, 'ESI'), pt: amt(s.deductions, 'PT'), tds: amt(s.deductions, 'TDS'), other: r2(s.deducted - amt(s.deductions, 'PF') - amt(s.deductions, 'ESI') - amt(s.deductions, 'PT') - amt(s.deductions, 'TDS')), net: s.net })).sort((a, b) => a.groupLabel.localeCompare(b.groupLabel) || a.name.localeCompare(b.name)) };
    },
});

defineReport({
    key: 'payroll_statutory',
    category: 'Payroll',
    label: 'PF and ESI contributions',
    description: 'For a month: each staff member’s PF wage, employee and employer PF, ESI employee and employer.',
    permissions: ['payroll.view'],
    orientation: 'landscape',
    filters: [monthFilter],
    columns: [
        { key: 'name', label: 'Name', type: 'text', width: 1.6 },
        { key: 'wage', label: 'PF wage', type: 'money', width: 0.8, total: true },
        { key: 'pf', label: 'PF (staff)', type: 'money', width: 0.7, total: true },
        { key: 'pfEr', label: 'PF (school)', type: 'money', width: 0.7, total: true },
        { key: 'gross', label: 'Gross', type: 'money', width: 0.8, total: true },
        { key: 'esi', label: 'ESI (staff)', type: 'money', width: 0.7, total: true },
        { key: 'esiEr', label: 'ESI (school)', type: 'money', width: 0.7, total: true },
    ],
    async run(f) {
        const v = await runView(check(f.month));
        return { subtitle: v.label, rows: v.slips.filter((s) => amt(s.deductions, 'PF') || amt(s.deductions, 'ESI')).map((s) => ({ name: s.name, wage: s.employer.pfWage ?? 0, pf: amt(s.deductions, 'PF'), pfEr: s.employer.pf ?? 0, gross: s.gross, esi: amt(s.deductions, 'ESI'), esiEr: s.employer.esi ?? 0 })) };
    },
});

defineReport({
    key: 'payroll_annual',
    category: 'Payroll',
    label: 'Yearly salary and tax (Form 16 data)',
    description: 'For a financial year (April–March): each staff member’s gross, PF, professional tax and TDS, from finalised months.',
    permissions: ['payroll.view'],
    orientation: 'landscape',
    filters: [{ key: 'fy', label: 'Financial year starting (YYYY)', type: 'text', required: true, default: '', help: 'e.g. 2026 for April 2026 – March 2027' }],
    columns: [
        { key: 'code', label: 'Emp. code', type: 'text', width: 0.7 },
        { key: 'name', label: 'Name', type: 'text', width: 1.5 },
        { key: 'pan', label: 'PAN', type: 'text', width: 0.9 },
        { key: 'months', label: 'Months', type: 'number', width: 0.5 },
        { key: 'gross', label: 'Gross', type: 'money', width: 0.9, total: true },
        { key: 'pf', label: 'PF', type: 'money', width: 0.7, total: true },
        { key: 'pt', label: 'PT', type: 'money', width: 0.6, total: true },
        { key: 'tds', label: 'TDS', type: 'money', width: 0.7, total: true },
    ],
    async run(f) {
        const y = Number(f.fy || todayIST().slice(0, 4));
        if (!Number.isInteger(y) || y < 2000 || y > 2100) throw badRequest('Give the year like 2026', [{ field: 'fy', message: 'like 2026' }]);
        const slips = await db.payslip.findMany({ where: { run: { status: 'finalised', month: { gte: `${y}-04`, lte: `${y + 1}-03` } } }, select: { staffId: true, gross: true, deductions: true } });
        const staff = await db.staff.findMany({ where: { id: { in: [...new Set(slips.map((s) => s.staffId))] } }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true, pan: true } });
        return {
            subtitle: `April ${y} – March ${y + 1}`,
            rows: staff
                .map((st) => {
                    const mine = slips.filter((s) => s.staffId === st.id);
                    const d = (code: string) => r2(mine.reduce((a, s) => a + amt(s.deductions as Amount[], code), 0));
                    return { code: st.employeeCode, name: [st.firstName, st.middleName, st.lastName].filter(Boolean).join(' '), pan: st.pan ?? '', months: mine.length, gross: r2(mine.reduce((a, s) => a + s.gross, 0)), pf: d('PF'), pt: d('PT'), tds: d('TDS') };
                })
                .sort((a, b) => a.name.localeCompare(b.name)),
        };
    },
});

defineReport({
    key: 'payroll_loans',
    category: 'Payroll',
    label: 'Loans and advances outstanding',
    description: 'Every active loan and salary advance: amount, instalment, recovered, balance, months left.',
    permissions: ['payroll.view', 'payroll.loans'],
    orientation: 'portrait',
    filters: [],
    columns: [
        { key: 'name', label: 'Name', type: 'text', width: 1.5 },
        { key: 'kind', label: 'Kind', type: 'text', width: 0.6 },
        { key: 'amount', label: 'Amount', type: 'money', width: 0.8, total: true },
        { key: 'emi', label: 'Instalment', type: 'money', width: 0.7 },
        { key: 'paid', label: 'Recovered', type: 'money', width: 0.8, total: true },
        { key: 'balance', label: 'Balance', type: 'money', width: 0.8, total: true },
        { key: 'left', label: 'Months left', type: 'number', width: 0.5 },
    ],
    async run() {
        return { rows: (await listLoans()).filter((l) => l.status === 'active').map((l) => ({ name: l.name, kind: l.kind === 'advance' ? 'Advance' : 'Loan', amount: l.amount, emi: l.emi, paid: l.paid, balance: l.balance, left: l.left })) };
    },
});

defineReport({
    key: 'payroll_cost',
    category: 'Payroll',
    label: 'Salary cost by month',
    description: 'Each month’s total gross, employer PF and ESI (the school’s cost), deductions and net pay.',
    permissions: ['payroll.view'],
    orientation: 'portrait',
    filters: [],
    columns: [
        { key: 'month', label: 'Month', type: 'text', width: 1 },
        { key: 'status', label: 'Status', type: 'text', width: 0.7 },
        { key: 'staff', label: 'Staff', type: 'number', width: 0.5 },
        { key: 'gross', label: 'Gross', type: 'money', width: 0.9, total: true },
        { key: 'employer', label: 'Employer PF + ESI', type: 'money', width: 0.9, total: true },
        { key: 'cost', label: 'Total cost', type: 'money', width: 0.9, total: true },
        { key: 'net', label: 'Net paid', type: 'money', width: 0.9, total: true },
    ],
    async run() {
        const runs = await db.payrollRun.findMany({ orderBy: { month: 'desc' }, take: 24, include: { slips: { select: { gross: true, net: true, employer: true } } } });
        return { rows: runs.map((r) => { const gross = r2(r.slips.reduce((a, s) => a + s.gross, 0)); const er = r2(r.slips.reduce((a, s) => a + ((s.employer as Record<string, number>).pf ?? 0) + ((s.employer as Record<string, number>).esi ?? 0), 0)); return { month: monthLabel(r.month), status: r.status, staff: r.slips.length, gross, employer: er, cost: r2(gross + er), net: r2(r.slips.reduce((a, s) => a + s.net, 0)) }; }) };
    },
});

defineWidget({
    key: 'payroll_status',
    label: 'Payroll',
    description: 'This month’s payroll: not started, waiting for approval, or finalised, with the net pay.',
    category: 'Today',
    type: 'stat',
    size: 'sm',
    href: '/payroll',
    permissions: ['payroll.run', 'payroll.approve'],
    cacheSeconds: 600,
    async load() {
        const runs = await db.payrollRun.findMany({ orderBy: { month: 'desc' }, take: 1, include: { slips: { select: { net: true } } } });
        const r = runs[0];
        if (!r) return { value: '—', caption: 'no payroll yet', tone: 'neutral' };
        const net = Math.round(r.slips.reduce((a, s) => a + s.net, 0));
        return { value: `₹${net.toLocaleString('en-IN')}`, caption: `${monthLabel(r.month)} · ${r.status === 'finalised' ? 'finalised' : r.status === 'approved' ? 'approved' : 'waiting for approval'}`, tone: r.status === 'finalised' ? 'neutral' : 'warn', sub: [{ label: 'Staff', value: r.slips.length }] };
    },
});

