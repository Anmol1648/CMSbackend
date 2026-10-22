import { z } from 'zod';
import { defineSetting } from '../../core/settings';

/** System Settings → Leave (the rules of each leave type are in Leave → Leave Setup). */

const G = 'Leave';

export const LEAVE = {
    year: defineSetting<string>({
        key: 'leave.year',
        group: G,
        label: 'Leave year (balances are given and carried forward by it)',
        type: 'select',
        default: 'session',
        schema: z.enum(['session', 'calendar']),
        options: [
            { value: 'session', label: 'The academic session (e.g. April to March)' },
            { value: 'calendar', label: 'The calendar year (January to December)' },
        ],
    }),
    approval: defineSetting<string>({
        key: 'leave.approval',
        group: G,
        label: 'Who approves staff leave',
        help: 'A leave type can choose differently (Leave Setup). “Reports to” is set on each staff member; without one (or without a login) the request goes to the people who approve everyone’s leave.',
        type: 'select',
        default: 'reports_to',
        schema: z.enum(['reports_to', 'two_level', 'office']),
        options: [
            { value: 'reports_to', label: 'The person they report to (else the principal / office)' },
            { value: 'two_level', label: 'Two steps: the person they report to, then the principal / office' },
            { value: 'office', label: 'The principal / office only' },
        ],
    }),
    substitution: defineSetting<boolean>({
        key: 'leave.substitution',
        group: G,
        label: 'When a teacher’s leave is approved, their periods go to Substitution to be covered',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
    showClashes: defineSetting<boolean>({
        key: 'leave.show_clashes',
        group: G,
        label: 'Approvers see who else is away on the same days',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
};

/** The leave types a school starts with (Leave Setup); codes are what reports and imports use. */
export const LEAVE_TYPE_SEED = [
    { code: 'CL', name: 'Casual Leave', quota: 12, credit: 'yearly', carryForward: 'none', noticeDays: 1, backDays: 2, maxDays: 3, attendanceCode: 'LV' },
    { code: 'SL', name: 'Sick Leave', quota: 10, credit: 'yearly', carryForward: 'upto', carryMax: 20, noticeDays: 0, backDays: 7, certificateAfter: 2, attendanceCode: 'ML' },
    { code: 'EL', name: 'Earned Leave', quota: 15, credit: 'monthly', carryForward: 'upto', carryMax: 30, noticeDays: 7, backDays: 0, halfDay: false, attendanceCode: 'LV' },
    { code: 'ML', name: 'Maternity Leave', quota: 180, credit: 'yearly', prorate: false, carryForward: 'none', noticeDays: 0, backDays: 7, halfDay: false, attendanceCode: 'LV', sandwich: true, female: true },
    { code: 'PL', name: 'Paternity Leave', quota: 15, credit: 'yearly', prorate: false, carryForward: 'none', noticeDays: 0, backDays: 7, halfDay: false, attendanceCode: 'LV', male: true },
    { code: 'CO', name: 'Compensatory Off', quota: null, credit: 'none', carryForward: 'none', noticeDays: 0, backDays: 7, attendanceCode: 'LV', isCompOff: true, compOffDays: 30 },
    { code: 'OD', name: 'On Duty', quota: null, credit: 'none', carryForward: 'none', noticeDays: 0, backDays: 7, attendanceCode: 'P', countsPresent: true },
    { code: 'LWP', name: 'Leave Without Pay', quota: null, credit: 'none', carryForward: 'none', noticeDays: 0, backDays: 7, attendanceCode: 'LV', paid: false },
] as const;
