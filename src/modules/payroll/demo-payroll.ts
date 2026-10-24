import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { seedMasters } from '../masters/masters.service';
import { todayIST } from '../attendance/attendance.settings';
import { addAdjustment, approve, finalise, giveIncrements, giveLoan, heads, Line, prepare, saveSalary, saveStructure } from './payroll.service';

/**
 * Demo payroll: four salary structures; a salary for every demo staff member (by designation, from
 * the session's start); the last three months prepared, approved and finalised; this month prepared
 * and waiting for the principal's approval; a loan and an advance being recovered; a backdated
 * increment (arrears this month); a bonus and a deduction this month. Marked is_demo.
 */

let seed = 8_484;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const monthsBack = (n: number) => {
    const [y, m] = todayIST().slice(0, 7).split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 - n, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

// designation (starts with) → structure, basic range
const PAY: [string, string, number, number][] = [
    ['Principal', 'Teaching (PGT)', 62000, 62000],
    ['Vice Principal', 'Teaching (PGT)', 54000, 54000],
    ['Administrative', 'Non-teaching', 38000, 38000],
    ['PGT', 'Teaching (PGT)', 38000, 46000],
    ['TGT', 'Teaching (TGT)', 30000, 36000],
    ['PRT', 'Teaching (PRT)', 22000, 27000],
    ['Librarian', 'Teaching (TGT)', 27000, 27000],
    ['Accountant', 'Non-teaching', 29000, 29000],
    ['Senior Secretariat', 'Non-teaching', 21000, 21000],
    ['Junior Secretariat', 'Non-teaching', 17000, 17000],
    ['Lab Assistant', 'Non-teaching', 14000, 14000],
    ['Driver', 'Non-teaching', 14500, 14500],
    ['Sub Staff', 'Non-teaching', 11000, 11000],
    ['Security', 'Non-teaching', 11500, 11500],
];

export const createDemoPayroll = async () => {
    const tenantId = getTenantId()!;
    if (await db.salaryStructure.count({ where: { isDemo: true } })) return { staff: 0, months: 0 };
    await seedMasters();
    const hs = await heads();
    const id = (code: string) => hs.find((h) => h.code === code)?.id;
    if (!id('BASIC')) return { staff: 0, months: 0 };
    const L = (code: string, mode: Line['mode'], value: number) => (id(code) ? [{ headId: id(code)!, mode, value }] : []);
    const defs: [string, Line[]][] = [
        ['Teaching (PGT)', [...L('DA', 'pct_basic', 12), ...L('HRA', 'pct_basic', 20), ...L('TA', 'fixed', 1600), ...L('MED', 'fixed', 1250), ...L('SPL', 'fixed', 2000)]],
        ['Teaching (TGT)', [...L('DA', 'pct_basic', 12), ...L('HRA', 'pct_basic', 20), ...L('TA', 'fixed', 1600), ...L('MED', 'fixed', 1250), ...L('SPL', 'fixed', 1500)]],
        ['Teaching (PRT)', [...L('DA', 'pct_basic', 10), ...L('HRA', 'pct_basic', 15), ...L('TA', 'fixed', 1200), ...L('MED', 'fixed', 1000)]],
        ['Non-teaching', [...L('HRA', 'pct_basic', 10), ...L('TA', 'fixed', 800)]],
    ];
    for (const [name, lines] of defs) await saveStructure(null, { name, lines, isActive: true });
    await db.salaryStructure.updateMany({ where: { name: { in: defs.map((d) => d[0]) } }, data: { isDemo: true } });
    const structures = await db.salaryStructure.findMany({ select: { id: true, name: true, lines: true } });

    const year = await db.academicYear.findFirst({ where: { isCurrent: true }, select: { startDate: true } });
    const from = year ? year.startDate.toISOString().slice(0, 10) : `${monthsBack(6)}-01`;
    const admin = await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: { in: ['school-admin', 'principal'] } } } } }, select: { id: true } });
    const by = admin?.id ?? (await db.user.findFirst({ select: { id: true } }))!.id;
    const staff = await db.staff.findMany({ where: { isDemo: true, status: 'working' }, select: { id: true, joiningDate: true, designationId: true, uan: true } });
    const designations = await db.masterValue.findMany({ where: { master: 'designation' }, select: { id: true, name: true } });
    let n = 0;
    for (const s of staff) {
        const dname = designations.find((d) => d.id === s.designationId)?.name ?? 'TGT';
        const p = PAY.find(([k]) => dname.startsWith(k)) ?? PAY[4];
        const st = structures.find((x) => x.name === p[1])!;
        const basic = Math.round((p[2] + rand() * (p[3] - p[2])) / 100) * 100;
        const joined = s.joiningDate.toISOString().slice(0, 10);
        if (!s.uan) await db.staff.update({ where: { id: s.id }, data: { uan: String(100000000000 + Math.floor(rand() * 899999999999)) } });
        await saveSalary(s.id, { structureId: st.id, effectiveFrom: joined > from ? joined : from, basic, lines: st.lines as Line[], tdsMonthly: basic >= 45000 ? 3500 : basic >= 36000 ? 1200 : 0, pf: true, esi: true, esiNumber: basic < 17000 ? String(3100000000 + Math.floor(rand() * 99999999)) : null, reason: 'new', note: null }, by, { isDemo: true, noArrears: true });
        n++;
    }
    await db.staffSalary.updateMany({ where: { createdBy: by, isDemo: false }, data: { isDemo: true } });

    // Loans: one started three months ago, an advance two months ago.
    const borrowers = staff.slice(3, 5);
    if (borrowers[0]) await giveLoan({ staffId: borrowers[0].id, kind: 'loan', amount: 50000, emi: 5000, startMonth: monthsBack(3), note: 'Medical emergency' }, by, { isDemo: true });
    if (borrowers[1]) await giveLoan({ staffId: borrowers[1].id, kind: 'advance', amount: 10000, emi: 5000, startMonth: monthsBack(2), note: 'Festival advance' }, by, { isDemo: true });

    // The last three months: prepared, approved, finalised (on the pay day).
    let months = 0;
    for (const k of [3, 2, 1]) {
        const m = monthsBack(k);
        if (m < from.slice(0, 7)) continue;
        await prepare(m, by, { isDemo: true });
        await approve(m, by);
        await finalise(m, by, { isDemo: true, at: new Date(`${monthsBack(k - 1)}-07T10:00:00Z`) });
        months++;
    }
    // A backdated increment (two months ago) gives arrears this month; a bonus and a deduction too.
    const cur = monthsBack(0);
    const lucky = staff[6];
    if (lucky) await giveIncrements({ staffIds: [lucky.id], effectiveFrom: `${monthsBack(2)}-01`, percent: 6, amount: 0, note: 'Annual increment (approved late)' }, by, { isDemo: true });
    if (staff[8]) await addAdjustment({ staffId: staff[8].id, month: cur, kind: 'earning', label: 'Bonus: board results', amount: 5000 }, by);
    if (staff[9]) await addAdjustment({ staffId: staff[9].id, month: cur, kind: 'deduction', label: 'Library book lost', amount: 450 }, by);
    await db.payrollAdjustment.updateMany({ where: { month: cur }, data: { isDemo: true } });
    // This month: prepared, waiting for the principal's approval.
    await prepare(cur, by, { isDemo: true });
    await db.staffLoan.updateMany({ where: { createdBy: by }, data: { isDemo: true } });
    return { staff: n, months: months + 1, tenantId };
};

export const clearDemoPayroll = async () => {
    await db.payrollRun.deleteMany({ where: { isDemo: true } });
    await db.payrollAdjustment.deleteMany({ where: { isDemo: true } });
    await db.staffLoan.deleteMany({ where: { isDemo: true } });
    await db.staffSalary.deleteMany({ where: { isDemo: true } });
    await db.salaryStructure.deleteMany({ where: { isDemo: true } });
};
