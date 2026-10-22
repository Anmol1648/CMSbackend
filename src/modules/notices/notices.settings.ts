import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/** System Settings → Notices & Events, and the lists of notice categories and event types (Masters). */

const G = 'Notices & Events';

export const NOTICES = {
    approval: defineSetting<boolean>({
        key: 'notices.approval',
        group: G,
        label: 'Notices need approval before they go out',
        help: 'On: people who may write notices send them for approval; those allowed to publish (principal) approve them. Off: writers publish directly.',
        type: 'boolean',
        default: false,
        schema: z.boolean(),
    }),
    ackDefault: defineSetting<boolean>({
        key: 'notices.ack_default',
        group: G,
        label: 'New notices ask readers to press “I have read this”',
        help: 'Each notice can still turn it on or off.',
        type: 'boolean',
        default: false,
        schema: z.boolean(),
    }),
    families: defineSetting<boolean>({
        key: 'notices.families',
        group: G,
        label: 'Students and parents see the notices and events meant for them in the app',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
    archiveDays: defineSetting<number>({
        key: 'notices.archive_days',
        group: G,
        label: 'Expired notices stay in the archive for this many days',
        type: 'number',
        default: 365,
        schema: z.number().int().min(7).max(3650),
    }),
};

defineMasterGroup({ key: 'communication', label: 'Notices & Events', order: 15 });
defineMaster({
    key: 'notice_category',
    label: 'Notice category',
    plural: 'Notice categories',
    description: 'Kinds of notices on the notice board (Circular, Exam notice, Fee notice…).',
    group: 'communication',
    order: 10,
    code: 'none',
    ordering: 'manual',
    seed: [{ name: 'Circular' }, { name: 'General notice' }, { name: 'Exam notice' }, { name: 'Fee notice' }, { name: 'Holiday notice' }, { name: 'Event' }, { name: 'Staff notice' }, { name: 'Urgent' }],
});
defineMaster({
    key: 'event_type',
    label: 'Event type',
    plural: 'Event types',
    description: 'Kinds of events on the school calendar (PTM, Sports Day, Exams…).',
    group: 'communication',
    order: 20,
    code: 'none',
    ordering: 'manual',
    seed: [
        { name: 'Exam' },
        { name: 'PTM' },
        { name: 'Sports' },
        { name: 'Cultural programme' },
        { name: 'Competition' },
        { name: 'Celebration' },
        { name: 'Trip / Excursion' },
        { name: 'Meeting' },
        { name: 'Holiday' },
        { name: 'Other' },
    ],
});
