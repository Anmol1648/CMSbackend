import ExcelJS from 'exceljs';
import { db } from '../../core/db';
import { badRequest, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { isoOf, todayIST } from '../attendance/attendance.settings';
import { balanceOf, leaveYearOf } from '../leave/balances.service';
import { daysFor, fullAmounts, heads, Line, monthLabel, monthRange, r2, runView, salariesOn } from './payroll.service';
import { PAYROLL } from './payroll.settings';

/**
 * What a month's payroll produces: the bank transfer sheet, the salary register (Excel), the PF ECR
 * file (EPFO upload) and the ESI contribution sheet; and the full and final settlement of a leaver.
 */

const finalisedOrApproved = async (month: string) => {
    const v = await runView(month);
    if (!v.run) throw badRequest(`No payroll for ${monthLabel(month)}`);
    return v;
};
const book = async (sheet: string, title: string, head: string[], rows: (string | number)[][], widths: number[]) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheet);
    ws.addRow([title]).font = { bold: true, size: 13 };
    ws.addRow([]);
    ws.addRow(head).font = { bold: true };
    for (const r of rows) ws.addRow(r);
    widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
    return Buffer.from(await wb.xlsx.writeBuffer());
};

export const bankSheet = async (month: string) => {
    const v = await finalisedOrApproved(month);
    const rows = v.slips.filter((s) => s.net > 0).map((s, i) => [i + 1, s.employeeCode, s.name, s.bank.bank, s.bank.accountNo, s.bank.ifsc, s.net]);
    const total = v.slips.reduce((a, s) => a + (s.net > 0 ? s.net : 0), 0);
    rows.push(['', '', 'Total', '', '', '', r2(total)]);
    return { buffer: await book('Bank transfer', `Salary for ${v.label}: bank transfer`, ['S. no.', 'Emp. code', 'Name', 'Bank', 'Account no.', 'IFSC', 'Amount (₹)'], rows, [7, 12, 28, 22, 20, 14, 14]), filename: `salary-bank-${month}.xlsx` };
};

export const registerSheet = async (month: string) => {
    const v = await finalisedOrApproved(month);
    const eCodes = [...new Map(v.slips.flatMap((s) => s.earnings.map((e) => [e.name, e.name]))).keys()];
    const dCodes = [...new Map(v.slips.flatMap((s) => s.deductions.map((d) => [d.name.replace(/ \(balance.*\)$/, ''), 1]))).keys()];
    const rows = v.slips.map((s) => [s.employeeCode, s.name, s.designation, s.paidDays, ...eCodes.map((n) => s.earnings.find((e) => e.name === n)?.amount ?? 0), s.gross, ...dCodes.map((n) => s.deductions.filter((d) => d.name.replace(/ \(balance.*\)$/, '') === n).reduce((a, d) => a + d.amount, 0)), s.deducted, s.net, s.employer.pf ?? 0, s.employer.esi ?? 0]);
    return { buffer: await book('Register', `Salary register: ${v.label}`, ['Emp. code', 'Name', 'Designation', 'Paid days', ...eCodes, 'Gross', ...dCodes, 'Deductions', 'Net pay', 'Employer PF', 'Employer ESI'], rows, [12, 26, 18, 9, ...eCodes.map(() => 12), 12, ...dCodes.map(() => 12), 12, 12, 12, 12]), filename: `salary-register-${month}.xlsx` };
};

/** EPFO ECR 2.0 text: UAN#~#name#~#gross#~#EPF wages#~#EPS wages#~#EDLI wages#~#EPF#~#EPS#~#diff#~#NCP days#~#refund. */
export const pfEcr = async (month: string) => {
    const v = await finalisedOrApproved(month);
    const staff = await db.staff.findMany({ where: { id: { in: v.slips.map((s) => s.staffId) } }, select: { id: true, uan: true } });
    const lines: string[] = [];
    const missing: string[] = [];
    for (const s of v.slips) {
        const pf = s.deductions.find((d) => d.code === 'PF')?.amount ?? 0;
        if (!pf) continue;
        const uan = staff.find((x) => x.id === s.staffId)?.uan;
        if (!uan) {
            missing.push(s.name);
            continue;
        }
        const wage = Math.round(s.employer.pfWage ?? (pf * 100) / 12);
        const epsWage = Math.min(wage, 15000);
        const eps = Math.round(epsWage * 0.0833);
        lines.push([uan, s.name.toUpperCase(), Math.round(s.gross), wage, epsWage, epsWage, pf, eps, pf - eps, Math.round(Math.max(0, s.totalDays - s.paidDays)), 0].join('#~#'));
    }
    return { text: lines.join('\n'), missing, filename: `pf-ecr-${month}.txt` };
};

export const esiSheet = async (month: string) => {
    const v = await finalisedOrApproved(month);
    const sal = await salariesOn(monthRange(month).to, v.slips.map((s) => s.staffId));
    const rows = v.slips.filter((s) => s.deductions.some((d) => d.code === 'ESI')).map((s) => [sal.get(s.staffId)?.esiNumber ?? '', s.name, Math.round(s.paidDays), Math.round(s.gross), s.deductions.find((d) => d.code === 'ESI')?.amount ?? 0, s.employer.esi ?? 0]);
    return { buffer: await book('ESI', `ESI contributions: ${v.label}`, ['IP number', 'Name', 'Days paid', 'Wages (₹)', 'Employee ESI', 'Employer ESI'], rows, [16, 28, 10, 12, 13, 13]), filename: `esi-${month}.xlsx` };
};

/** Full and final settlement of a leaver: this month's pay to the last day, earned leave encashed, loans recovered. */
export const settlement = async (staffId: string, lastDay: string) => {
    const st = await db.staff.findFirst({ where: { id: staffId }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true, joiningDate: true, status: true, statusDate: true, designationId: true } });
    if (!st) throw notFound('Staff member not found');
    const month = lastDay.slice(0, 7);
    const [sal, hs, s, loans, run] = await Promise.all([salariesOn(lastDay, [staffId]), heads(), getSettings({ encash: PAYROLL.encash, code: PAYROLL.encashCode }), db.staffLoan.findMany({ where: { staffId, status: 'active' } }), db.payrollRun.findFirst({ where: { month, status: 'finalised' }, include: { slips: { where: { staffId } } } })]);
    const salary = sal.get(staffId);
    if (!salary) throw badRequest('This staff member has no salary set');
    const full = fullAmounts(salary.basic, salary.lines as Line[], hs);
    // Pay for the last month up to the last day (unless that month is already paid).
    let monthPay = 0;
    let paidDays = 0;
    let totalDays = 0;
    if (!run?.slips.length) {
        const d = await daysFor(month, [{ id: st.id, joiningDate: st.joiningDate, status: 'left', statusDate: new Date(`${lastDay}T00:00:00Z`) }]);
        const x = d.out.get(st.id)!;
        paidDays = x.paidDays;
        totalDays = x.totalDays;
        monthPay = r2((full.gross * x.paidDays) / x.totalDays);
    }
    let encashDays = 0;
    let encash = 0;
    if (s.encash && s.code) {
        const type = await db.leaveType.findFirst({ where: { code: { equals: s.code, mode: 'insensitive' } }, select: { id: true } });
        if (type) {
            const b = await balanceOf(staffId, type.id, await leaveYearOf(lastDay)).catch(() => null);
            encashDays = Math.max(0, b?.balance ?? 0);
            encash = r2(((salary.basic + (full.earnings.find((e) => e.code === 'DA')?.amount ?? 0)) / 30) * encashDays);
        }
    }
    const recover = r2(loans.reduce((a, l) => a + l.balance, 0));
    const designation = st.designationId ? ((await db.masterValue.findFirst({ where: { id: st.designationId }, select: { name: true } }))?.name ?? '') : '';
    return {
        staff: { name: [st.firstName, st.middleName, st.lastName].filter(Boolean).join(' '), employeeCode: st.employeeCode, designation, joiningDate: isoOf(st.joiningDate), lastDay },
        monthLabel: monthLabel(month),
        paidDays,
        totalDays,
        monthPay,
        encashDays,
        encash,
        loans: loans.map((l) => ({ kind: l.kind === 'advance' ? 'Salary advance' : 'Loan', balance: l.balance })),
        recover,
        net: r2(monthPay + encash - recover),
        today: todayIST(),
        monthlyGross: full.gross,
    };
};
