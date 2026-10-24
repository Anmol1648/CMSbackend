import { z } from 'zod';
import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuItems } from '../../core/registry/menu';
import { defineSetting } from '../../core/settings';

/**
 * The AI assistant: who may use it (Roles & Permissions) and its limits (System Settings → AI). Its
 * requests count towards the school's AI limits like every other AI feature.
 */

registerPermissions({ key: 'assistant', label: 'AI Assistant', order: 41 }, [{ resource: 'ai', action: 'chat', label: 'Ask the AI assistant questions about the school', description: 'It answers only from data the person may see, and cannot change anything.' }]);

registerMenuItems([{ key: 'assistant', label: 'AI Assistant', icon: 'smart_toy', href: '/assistant', group: 'main', order: 3, permission: 'ai.chat' }]);

const G = 'AI';
export const ASSISTANT = {
    steps: defineSetting<number>({ key: 'ai.chat_steps', group: G, label: 'AI assistant: look-ups it may make for one answer', help: 'Each look-up is one AI request. More = better answers to harder questions, and more requests.', type: 'number', default: 4, schema: z.number().int().min(1).max(8) }),
    keepDays: defineSetting<number>({ key: 'ai.chat_keep_days', group: G, label: 'AI assistant: keep conversations this many days', type: 'number', default: 90, schema: z.number().int().min(1).max(3650) }),
};
