import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster } from '../masters/masters.registry';

/** System Settings → Promotion & TC, and the TC clearance checklist (Masters → Students). */

const G = 'Promotion & TC';

export const PROMOTION = {
    sectionRule: defineSetting<string>({
        key: 'promotion.section_rule',
        group: G,
        label: 'On promotion, students go to the section with the same letter',
        help: 'VII-A → VIII-A. Off: everyone goes to the first section and you move them on the screen.',
        type: 'select',
        default: 'same_letter',
        schema: z.enum(['same_letter', 'first']),
        options: [
            { value: 'same_letter', label: 'Same letter (VII-A → VIII-A)' },
            { value: 'first', label: 'The first section of the class' },
        ],
    }),
    rollRule: defineSetting<string>({
        key: 'promotion.roll_rule',
        group: G,
        label: 'Roll numbers in the new session',
        type: 'select',
        default: 'renumber',
        schema: z.enum(['renumber', 'keep', 'blank']),
        options: [
            { value: 'renumber', label: 'Given again by the school’s roll-number order (System Settings → Students)' },
            { value: 'keep', label: 'Keep last session’s roll numbers' },
            { value: 'blank', label: 'Leave empty (typed by hand)' },
        ],
    }),
    carryDues: defineSetting<boolean>({
        key: 'promotion.carry_dues',
        group: G,
        label: 'Carry fees still due into the new session (as “Previous session dues”)',
        help: 'The old session then shows nothing due, and the new one has a line for it. Late fines stay in the old session.',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
    tcPattern: defineSetting<string>({
        key: 'tc.number_pattern',
        group: G,
        label: 'TC number looks like',
        help: 'Any text, plus {SEQ} the running number ({SEQ:4} = 0001), {YYYY} / {YY} the year, {AY} the academic year.',
        type: 'text',
        default: 'TC/{YYYY}/{SEQ:4}',
        schema: z.string().trim().min(1).max(40).refine((x) => x.includes('{SEQ'), 'must contain {SEQ}'),
    }),
    tcStart: defineSetting<number>({
        key: 'tc.number_start',
        group: G,
        label: 'TC numbers start from',
        type: 'number',
        default: 1,
        schema: z.number().int().min(1).max(10_000_000),
    }),
    tcDues: defineSetting<string>({
        key: 'tc.dues',
        group: G,
        label: 'Issuing a TC while fees are due',
        type: 'select',
        default: 'block',
        schema: z.enum(['block', 'warn']),
        options: [
            { value: 'block', label: 'Not allowed: clear the fees first' },
            { value: 'warn', label: 'Allowed, with a warning' },
        ],
    }),
};

defineMaster({
    key: 'tc_clearance',
    label: 'TC clearance',
    plural: 'TC clearances',
    description: 'What must be cleared before a transfer certificate is issued (fees are checked by themselves).',
    group: 'students',
    order: 80,
    code: 'none',
    ordering: 'manual',
    seed: [{ name: 'Library books returned' }, { name: 'Laboratory items returned' }, { name: 'Sports items returned' }, { name: 'ID card returned' }],
});
