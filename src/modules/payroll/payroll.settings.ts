import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/**
 * System Settings → Payroll (days, late marks, PF, ESI, professional tax, rounding, leave
 * encashment, payslips) and the pay heads (Masters → Payroll). Salary structures have their own
 * screen; who sets salaries, runs, approves or sees payroll is in Roles & Permissions (payroll.*).
 */

const G = 'Payroll';
const bool = (key: string, label: string, def: boolean, help?: string) => defineSetting<boolean>({ key, group: G, label, help, type: 'boolean', default: def, schema: z.boolean() });
const num = (key: string, label: string, def: number, min: number, max: number, help?: string) =>
    defineSetting<number>({ key, group: G, label, help, type: 'number', default: def, schema: z.number().min(min).max(max) });
const select = (key: string, label: string, def: string, options: { value: string; label: string }[], help?: string) =>
    defineSetting<string>({ key, group: G, label, help, type: 'select', default: def, schema: z.enum(options.map((o) => o.value) as [string, ...string[]]), options });

/** Professional tax: monthly slabs by state ({ upto: gross, tax }), the last without a limit. */
export const PT_SLABS: Record<string, { label: string; slabs: { upto: number | null; tax: number }[] }> = {
    none: { label: 'None (e.g. Uttarakhand, Delhi, UP)', slabs: [{ upto: null, tax: 0 }] },
    maharashtra: { label: 'Maharashtra', slabs: [{ upto: 7500, tax: 0 }, { upto: 10000, tax: 175 }, { upto: null, tax: 200 }] },
    karnataka: { label: 'Karnataka', slabs: [{ upto: 24999, tax: 0 }, { upto: null, tax: 200 }] },
    west_bengal: { label: 'West Bengal', slabs: [{ upto: 10000, tax: 0 }, { upto: 15000, tax: 110 }, { upto: 25000, tax: 130 }, { upto: 40000, tax: 150 }, { upto: null, tax: 200 }] },
    tamil_nadu: { label: 'Tamil Nadu', slabs: [{ upto: 3500, tax: 0 }, { upto: 5000, tax: 22 }, { upto: 7500, tax: 52 }, { upto: 10000, tax: 115 }, { upto: 12500, tax: 171 }, { upto: null, tax: 208 }] },
    gujarat: { label: 'Gujarat', slabs: [{ upto: 11999, tax: 0 }, { upto: null, tax: 200 }] },
    andhra_telangana: { label: 'Andhra Pradesh / Telangana', slabs: [{ upto: 15000, tax: 0 }, { upto: 20000, tax: 150 }, { upto: null, tax: 200 }] },
    madhya_pradesh: { label: 'Madhya Pradesh', slabs: [{ upto: 18750, tax: 0 }, { upto: 25000, tax: 125 }, { upto: 33333, tax: 167 }, { upto: null, tax: 208 }] },
};

export const PAYROLL = {
    payDay: num('payroll.pay_day', 'Salary is paid on this day of the next month', 7, 1, 31),
    daysMethod: select('payroll.days_method', 'A month’s pay is divided by', 'calendar', [
        { value: 'calendar', label: 'The days of the month (28–31): holidays and Sundays are paid' },
        { value: 'working', label: 'The working days of the month (school calendar)' },
        { value: 'fixed30', label: 'Always 30' },
    ]),
    noRecord: select('payroll.no_record', 'A working day with no attendance marked counts as', 'present', [
        { value: 'present', label: 'Present (pay unless marked absent)' },
        { value: 'absent', label: 'Absent (no pay)' },
    ]),
    lateRule: num('payroll.late_rule', 'Every this many late marks in a month cut half a day’s pay (0 = never)', 3, 0, 31),
    pf: bool('payroll.pf', 'Deduct provident fund (PF)', true),
    pfRate: num('payroll.pf_rate', 'PF rate (% of basic + DA), employee and employer each', 12, 0, 20),
    pfCap: num('payroll.pf_cap', 'PF on wages up to (₹ a month; 0 = on full basic + DA)', 15000, 0, 1_000_000),
    esi: bool('payroll.esi', 'Deduct ESI', true),
    esiEmployee: num('payroll.esi_employee', 'ESI employee rate (% of gross)', 0.75, 0, 10),
    esiEmployer: num('payroll.esi_employer', 'ESI employer rate (% of gross)', 3.25, 0, 10),
    esiLimit: num('payroll.esi_limit', 'ESI applies when monthly gross is up to (₹)', 21000, 0, 1_000_000),
    ptState: select('payroll.pt_state', 'Professional tax slabs of the state', 'none', Object.entries(PT_SLABS).map(([value, s]) => ({ value, label: s.label }))),
    rounding: select('payroll.rounding', 'Round net pay to', 'rupee', [
        { value: 'none', label: 'Paise (no rounding)' },
        { value: 'rupee', label: 'Nearest rupee' },
        { value: 'ten', label: 'Nearest ₹10' },
    ]),
    encash: bool('payroll.encash', 'Pay unused earned leave in the full and final settlement', true),
    encashCode: defineSetting<string>({ key: 'payroll.encash_leave', group: G, label: 'Leave type paid on leaving (its code, e.g. EL)', type: 'text', default: 'EL', schema: z.string().trim().max(10) }),
    showEmployer: bool('payroll.show_employer', 'Payslips show the employer’s PF and ESI', true),
    approval: bool('payroll.approval', 'A month’s payroll must be approved before it is finalised', true),
};

defineMasterGroup({ key: 'payroll', label: 'Payroll', order: 26 });

/**
 * Pay heads. The code is used by the software for PF, ESI, PT, TDS and loans (keep those codes);
 * other heads are free. "Counts for PF" adds the head to the PF wage (basic + DA by default).
 */
defineMaster({
    key: 'pay_head',
    label: 'Pay head',
    plural: 'Pay heads',
    description: 'Earnings and deductions on payslips. Keep the codes BASIC, DA, PF, ESI, PT, TDS, LOAN, ADV (the software works them out); add any others.',
    group: 'payroll',
    order: 10,
    code: 'required',
    ordering: 'manual',
    fields: [
        { key: 'kind', label: 'Kind', type: 'select', required: true, options: [{ value: 'earning', label: 'Earning' }, { value: 'deduction', label: 'Deduction' }] },
        { key: 'pf', label: 'Counts for PF wage', type: 'boolean' },
    ],
    seed: [
        { name: 'Basic', code: 'BASIC', extra: { kind: 'earning', pf: true } },
        { name: 'Dearness allowance', code: 'DA', extra: { kind: 'earning', pf: true } },
        { name: 'House rent allowance', code: 'HRA', extra: { kind: 'earning', pf: false } },
        { name: 'Transport allowance', code: 'TA', extra: { kind: 'earning', pf: false } },
        { name: 'Medical allowance', code: 'MED', extra: { kind: 'earning', pf: false } },
        { name: 'Special allowance', code: 'SPL', extra: { kind: 'earning', pf: false } },
        { name: 'Arrears', code: 'ARR', extra: { kind: 'earning', pf: false } },
        { name: 'Bonus', code: 'BONUS', extra: { kind: 'earning', pf: false } },
        { name: 'Provident fund', code: 'PF', extra: { kind: 'deduction' } },
        { name: 'ESI', code: 'ESI', extra: { kind: 'deduction' } },
        { name: 'Professional tax', code: 'PT', extra: { kind: 'deduction' } },
        { name: 'Income tax (TDS)', code: 'TDS', extra: { kind: 'deduction' } },
        { name: 'Loan instalment', code: 'LOAN', extra: { kind: 'deduction' } },
        { name: 'Salary advance', code: 'ADV', extra: { kind: 'deduction' } },
        { name: 'Other deduction', code: 'OTHER', extra: { kind: 'deduction' } },
    ],
});
