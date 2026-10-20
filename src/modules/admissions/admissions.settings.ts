import { z } from 'zod';
import { defineSetting } from '../../core/settings';

/** System Settings → Admissions (enquiries before a student is admitted). */

const G = 'Admissions';
const numberPattern = (example: string) =>
    z
        .string()
        .trim()
        .min(1)
        .max(40)
        .refine((p) => /\{SEQ(:\d)?\}/.test(p), 'must contain {SEQ} (the running number)')
        .refine((p) => !/\{(?!SEQ(:\d)?\}|YYYY\}|YY\})[^}]*\}/.test(p), `uses an unknown {…} part (e.g. ${example})`);

export const ADMISSIONS = {
    enquiryPattern: defineSetting<string>({
        key: 'admissions.enquiry_number_pattern',
        group: G,
        label: 'Enquiry number looks like',
        help: 'Any text, plus {SEQ} the running number ({SEQ:4} = 0001) and {YYYY} / {YY} the year.',
        type: 'text',
        default: 'ENQ/{YYYY}/{SEQ:4}',
        schema: numberPattern('ENQ/{YYYY}/{SEQ:4}'),
    }),
    registrationEnabled: defineSetting<boolean>({
        key: 'admissions.registration_enabled',
        group: G,
        label: 'Families register (with a registration number) before admission',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
    registrationPattern: defineSetting<string>({
        key: 'admissions.registration_number_pattern',
        group: G,
        label: 'Registration number looks like',
        type: 'text',
        default: 'REG/{YYYY}/{SEQ:4}',
        schema: numberPattern('REG/{YYYY}/{SEQ:4}'),
    }),
    registrationFee: defineSetting<number>({
        key: 'admissions.registration_fee',
        group: G,
        label: 'Registration fee (₹, 0 = no fee)',
        help: 'Recorded when an enquiry is registered; can be paid online on the website form (System Settings → Online payments).',
        type: 'number',
        default: 0,
        schema: z.number().int().min(0).max(100_000),
    }),
    testEnabled: defineSetting<boolean>({
        key: 'admissions.test_enabled',
        group: G,
        label: 'Use an entrance test / interaction step',
        help: 'Per enquiry it can still be "not needed".',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
    followUpDays: defineSetting<number>({
        key: 'admissions.follow_up_days',
        group: G,
        label: 'Next follow-up is suggested after (days)',
        type: 'number',
        default: 3,
        schema: z.number().int().min(0).max(60),
    }),
    publicForm: defineSetting<boolean>({
        key: 'admissions.public_form',
        group: G,
        label: 'Parents can send an enquiry from the website (public form)',
        help: 'The form is at /enquire on the school’s address.',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
    duplicateCheck: defineSetting<'warn' | 'block' | 'off'>({
        key: 'admissions.duplicate_check',
        group: G,
        label: 'When a mobile number already has an open enquiry for the same class',
        type: 'select',
        default: 'warn',
        schema: z.enum(['warn', 'block', 'off']),
        options: [
            { value: 'warn', label: 'Allow, with a warning' },
            { value: 'block', label: "Don't allow a second one" },
            { value: 'off', label: "Don't check" },
        ],
    }),
};
