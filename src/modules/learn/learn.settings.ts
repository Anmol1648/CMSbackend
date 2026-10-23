import { z } from 'zod';
import { defineSetting } from '../../core/settings';

/** System Settings → AI Tutor: how the tutor answers students, and its limits. */

const G = 'AI Tutor';

export const LEARN = {
    mode: defineSetting<string>({
        key: 'learn.mode',
        group: G,
        label: 'How the tutor helps',
        help: 'Guide: hints and steps, so students work it out (it won’t just do their homework). Full: it gives complete answers.',
        type: 'select',
        default: 'guide',
        schema: z.enum(['guide', 'full']),
        options: [
            { value: 'guide', label: 'Guide step by step (recommended)' },
            { value: 'full', label: 'Give full answers' },
        ],
    }),
    dailyMessages: defineSetting<number>({ key: 'learn.daily_messages', group: G, label: 'Questions a student can ask the tutor in a day', type: 'number', default: 30, schema: z.number().int().min(1).max(500) }),
    quizSize: defineSetting<number>({ key: 'learn.quiz_size', group: G, label: 'Questions in a practice quiz', type: 'number', default: 5, schema: z.number().int().min(3).max(20) }),
    bankFirst: defineSetting<boolean>({ key: 'learn.bank_first', group: G, label: 'Practice quizzes use the school’s question bank first (the AI writes them only when there aren’t enough)', type: 'boolean', default: true, schema: z.boolean() }),
    keepDays: defineSetting<number>({ key: 'learn.keep_days', group: G, label: 'Keep students’ tutor conversations for this many days', type: 'number', default: 180, schema: z.number().int().min(7).max(1825) }),
};
