import { z } from 'zod';
import { defineSetting } from '../../core/settings';

/**
 * System Settings → AI: the provider, the model and the limits. The key is kept encrypted (a hidden
 * setting, entered on Learning → AI Setup). Who may use which AI feature is in Roles & Permissions.
 */

const G = 'AI';
const num = (key: string, label: string, def: number, min: number, max: number, help?: string) =>
    defineSetting<number>({ key, group: G, label, help, type: 'number', default: def, schema: z.number().int().min(min).max(max) });

export const AI = {
    on: defineSetting<boolean>({ key: 'ai.on', group: G, label: 'AI features', help: 'Needs the provider’s key on Learning → AI Setup. Off: question bank, tests and marking still work, without AI.', type: 'boolean', default: true, schema: z.boolean() }),
    provider: defineSetting<string>({
        key: 'ai.provider',
        group: G,
        label: 'AI provider',
        type: 'select',
        default: 'gemini',
        schema: z.enum(['gemini']),
        options: [{ value: 'gemini', label: 'Google Gemini' }],
    }),
    model: defineSetting<string>({ key: 'ai.model', group: G, label: 'Model', help: 'The provider’s model name, e.g. gemini-2.5-flash.', type: 'text', default: 'gemini-2.5-flash', schema: z.string().trim().min(3).max(80).regex(/^[A-Za-z0-9._-]+$/, 'letters, numbers, dots and dashes') }),
    dailyPerUser: num('ai.daily_per_user', 'AI requests one person can make in a day', 40, 1, 2000),
    monthly: num('ai.monthly_limit', 'AI requests the whole school can make in a month (0 = no limit)', 5000, 0, 1_000_000, 'Keeps the bill in check.'),
    maxQuestions: num('ai.max_questions', 'Questions the AI writes in one go', 15, 1, 50),
    key: defineSetting<string>({ key: 'ai.key', group: G, label: 'ai.key', type: 'text', default: '', schema: z.string().max(2000), hidden: true }),
};
