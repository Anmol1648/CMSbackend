import { z } from 'zod';
import { defineSetting } from '../../core/settings';

/** System Settings → Fees and → Online payments. Amounts are whole rupees. */

const G = 'Fees';
const O = 'Online payments';

export const FEES = {
    receiptPattern: defineSetting<string>({
        key: 'fees.receipt_number_pattern',
        group: G,
        label: 'Receipt number looks like',
        help: 'Any text, plus {SEQ} the running number ({SEQ:5} = 00001) and {YYYY} / {YY} the year (the number starts again each year when the year is in it).',
        type: 'text',
        default: 'RCP/{YYYY}/{SEQ:5}',
        schema: z
            .string()
            .trim()
            .min(1)
            .max(40)
            .refine((p) => /\{SEQ(:\d)?\}/.test(p), 'must contain {SEQ} (the running number)')
            .refine((p) => !/\{(?!SEQ(:\d)?\}|YYYY\}|YY\})[^}]*\}/.test(p), 'uses an unknown {…} part'),
    }),
    partialPayment: defineSetting<boolean>({
        key: 'fees.partial_payment',
        group: G,
        label: 'Part payment of an instalment is allowed',
        help: 'Payments always clear the oldest instalment first.',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
    newStudentFrom: defineSetting<'all' | 'current' | 'next'>({
        key: 'fees.new_student_from',
        group: G,
        label: 'A student admitted during the year pays',
        help: '"New admissions only" heads (e.g. admission fee) are always charged, in the first instalment they pay.',
        type: 'select',
        default: 'current',
        schema: z.enum(['all', 'current', 'next']),
        options: [
            { value: 'current', label: 'From the instalment they join in (the one last due)' },
            { value: 'next', label: 'From the next instalment due after joining' },
            { value: 'all', label: 'The whole year' },
        ],
    }),
    fineMode: defineSetting<'none' | 'fixed' | 'per_day' | 'per_month'>({
        key: 'fees.late_fine_mode',
        group: G,
        label: 'Late fine after the due date',
        type: 'select',
        default: 'fixed',
        schema: z.enum(['none', 'fixed', 'per_day', 'per_month']),
        options: [
            { value: 'none', label: 'No late fine' },
            { value: 'fixed', label: 'A fixed amount per instalment' },
            { value: 'per_day', label: 'An amount per day late' },
            { value: 'per_month', label: 'An amount per month late (started months count)' },
        ],
    }),
    fineAmount: defineSetting<number>({
        key: 'fees.late_fine_amount',
        group: G,
        label: 'Late fine amount (₹)',
        type: 'number',
        default: 50,
        schema: z.number().int().min(0).max(100_000),
    }),
    fineGraceDays: defineSetting<number>({
        key: 'fees.late_fine_grace_days',
        group: G,
        label: 'Days after the due date before the fine starts',
        type: 'number',
        default: 10,
        schema: z.number().int().min(0).max(365),
    }),
    fineCap: defineSetting<number>({
        key: 'fees.late_fine_cap',
        group: G,
        label: 'Most fine per instalment (₹, 0 = no limit)',
        type: 'number',
        default: 0,
        schema: z.number().int().min(0).max(1_000_000),
    }),
    receiptFormat: defineSetting<'a4_half' | 'thermal'>({
        key: 'fees.receipt_format',
        group: G,
        label: 'Printed receipt',
        type: 'select',
        default: 'a4_half',
        schema: z.enum(['a4_half', 'thermal']),
        options: [
            { value: 'a4_half', label: 'Half A4 page (with the school logo)' },
            { value: 'thermal', label: 'Thermal printer roll (80 mm)' },
        ],
    }),
    receiptNote: defineSetting<string>({
        key: 'fees.receipt_note',
        group: G,
        label: 'Note printed at the bottom of receipts',
        type: 'text',
        default: 'Fees once paid are not refundable. Keep this receipt safely.',
        schema: z.string().trim().max(300),
    }),

    onlineFees: defineSetting<boolean>({
        key: 'payments.online_fees',
        group: O,
        label: 'Parents and students can pay fees online (My Fees)',
        help: 'Set up the payment gateway first: Fees → Online Payments.',
        type: 'boolean',
        default: false,
        schema: z.boolean(),
    }),
    onlineRegistration: defineSetting<boolean>({
        key: 'payments.online_registration',
        group: O,
        label: 'The website enquiry form takes the registration fee online',
        help: 'Uses the registration fee in System Settings → Admissions.',
        type: 'boolean',
        default: false,
        schema: z.boolean(),
    }),
    convenienceMode: defineSetting<'none' | 'percent' | 'fixed'>({
        key: 'payments.convenience_fee_mode',
        group: O,
        label: 'Convenience fee added for online payments',
        help: 'Covers the gateway charges, if the school does not absorb them.',
        type: 'select',
        default: 'none',
        schema: z.enum(['none', 'percent', 'fixed']),
        options: [
            { value: 'none', label: 'None (the school pays the gateway charges)' },
            { value: 'percent', label: 'A percent of the amount' },
            { value: 'fixed', label: 'A fixed amount per payment' },
        ],
    }),
    convenienceValue: defineSetting<number>({
        key: 'payments.convenience_fee_value',
        group: O,
        label: 'Convenience fee (% of the amount, or ₹ when fixed)',
        help: 'E.g. 2 = 2% (percent) or ₹2 (fixed). Rounded up to whole rupees.',
        type: 'number',
        default: 0,
        schema: z.number().min(0).max(100_000),
    }),
    minimumOnline: defineSetting<number>({
        key: 'payments.minimum_amount',
        group: O,
        label: 'Smallest online payment (₹)',
        type: 'number',
        default: 1,
        schema: z.number().int().min(1).max(1_000_000),
    }),
};
