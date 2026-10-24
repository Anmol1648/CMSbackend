import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/**
 * System Settings → Mess (skip cut-off, menu cycle, charges and rebates, the kitchen department) and
 * the meals (Masters → Mess: each with its time and guest rate). Plans and the menu have their own
 * screens; who runs the mess or the counter is in Roles & Permissions (mess.*).
 */

const G = 'Mess';
const num = (key: string, label: string, def: number, min: number, max: number, help?: string) =>
    defineSetting<number>({ key, group: G, label, help, type: 'number', default: def, schema: z.number().int().min(min).max(max) });

export const MESS = {
    cutoffHours: num('mess.skip_cutoff_hours', 'A meal can be skipped up to this many hours before it starts', 4, 0, 72, 'Skipped meals are not cooked; the in-charge can still change them later.'),
    menuWeeks: num('mess.menu_weeks', 'The menu repeats every this many weeks (1–4)', 2, 1, 4),
    feeHeadCode: defineSetting<string>({ key: 'mess.fee_head_code', group: G, label: 'Fee head the mess charge is added under (its code in Masters → Fee heads)', type: 'text', default: 'MESS', schema: z.string().trim().min(1).max(20) }),
    rebatePerDay: num('mess.rebate_per_day', 'Rebate per day for a boarder away on hostel leave (₹, 0 = no rebate)', 60, 0, 5000, 'Taken off the next fee instalment after they come back.'),
    rebateMinDays: num('mess.rebate_min_days', 'Rebate only for leave of at least this many days', 3, 1, 60),
    staffPayroll: defineSetting<boolean>({ key: 'mess.staff_payroll', group: G, label: 'Staff mess charges and guest meals are deducted from salary', type: 'boolean', default: true, schema: z.boolean() }),
    kitchenDepartment: defineSetting<string>({ key: 'mess.kitchen_department', group: G, label: 'Department the store issues kitchen supplies to (name in Masters → Departments)', help: 'Its issues are the kitchen cost in the mess reports.', type: 'text', default: 'Kitchen', schema: z.string().trim().min(1).max(60) }),
    ratings: defineSetting<boolean>({ key: 'mess.ratings', group: G, label: 'Members can rate meals', type: 'boolean', default: true, schema: z.boolean() }),
};

defineMasterGroup({ key: 'mess', label: 'Mess', order: 28 });
defineMaster({
    key: 'mess_meal',
    label: 'Meal',
    plural: 'Meals',
    description: 'The meals the mess serves, their time and the rate for a guest.',
    group: 'mess',
    order: 10,
    code: 'none',
    ordering: 'manual',
    fields: [
        { key: 'time', label: 'Starts at (24-hour, e.g. 13:00)', type: 'text', required: true, example: '13:00' },
        { key: 'guest_rate', label: 'Guest rate (₹)', type: 'number', required: true, example: '90' },
    ],
    seed: [
        { name: 'Breakfast', extra: { time: '07:30', guest_rate: 60 } },
        { name: 'Lunch', extra: { time: '13:00', guest_rate: 90 } },
        { name: 'Evening snacks', extra: { time: '17:00', guest_rate: 40 } },
        { name: 'Dinner', extra: { time: '20:00', guest_rate: 90 } },
    ],
});
