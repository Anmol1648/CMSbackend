import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/**
 * System Settings → PTM (how parent–teacher meetings work), and its lists (Masters → PTM). Who plans
 * PTMs, runs the desk, meets parents or books slots is in Roles & Permissions (ptm.*).
 */

const G = 'PTM';
const bool = (key: string, label: string, def: boolean, help?: string) => defineSetting<boolean>({ key, group: G, label, help, type: 'boolean', default: def, schema: z.boolean() });
const num = (key: string, label: string, def: number, min: number, max: number, help?: string) =>
    defineSetting<number>({ key, group: G, label, help, type: 'number', default: def, schema: z.number().int().min(min).max(max) });

export const PTM = {
    slotMinutes: num('ptm.slot_minutes', 'Usual length of a meeting slot (minutes)', 10, 3, 60, 'Each PTM can have its own; this is what a new one starts with.'),
    whoSits: defineSetting<string>({
        key: 'ptm.who_sits',
        group: G,
        label: 'Who parents meet (usual)',
        type: 'select',
        default: 'class_subject',
        schema: z.enum(['class', 'class_subject']),
        options: [
            { value: 'class_subject', label: 'The class teacher and the subject teachers' },
            { value: 'class', label: 'The class teacher only' },
        ],
    }),
    perSlot: num('ptm.per_slot', 'Families one teacher can meet in the same slot', 1, 1, 10),
    cutoffHours: num('ptm.cutoff_hours', 'Parents can book or change until this many hours before the PTM starts', 12, 0, 240),
    parentsChange: bool('ptm.parents_change', 'Parents can change or cancel their booking (before the cut-off)', true),
    parentsSeeRemarks: bool('ptm.parents_see_remarks', 'Parents see the teacher’s remarks after the meeting', true, 'A teacher can still keep a remark private.'),
    walkIns: bool('ptm.walk_ins', 'Parents without a booking can be checked in at the desk (walk-in)', true),
    remindDays: num('ptm.remind_days', 'Remind parents this many days before the PTM', 1, 0, 14),
};

defineMasterGroup({ key: 'ptm', label: 'PTM', order: 19 });

defineMaster({
    key: 'ptm_remark',
    label: 'PTM remark',
    plural: 'PTM remarks',
    description: 'Ready-made points a teacher ticks after meeting a parent (they can also write their own).',
    group: 'ptm',
    order: 10,
    code: 'none',
    ordering: 'manual',
    fields: [{ key: 'tone', label: 'Kind', type: 'select', options: [{ value: 'good', label: 'Praise' }, { value: 'work', label: 'To work on' }, { value: 'info', label: 'Information' }] }],
    seed: [
        { name: 'Attentive and participates in class', extra: { tone: 'good' } },
        { name: 'Completes homework regularly', extra: { tone: 'good' } },
        { name: 'Good progress since the last PTM', extra: { tone: 'good' } },
        { name: 'Well-behaved and helpful', extra: { tone: 'good' } },
        { name: 'Needs to improve in this subject', extra: { tone: 'work' } },
        { name: 'Homework often incomplete', extra: { tone: 'work' } },
        { name: 'Needs to improve handwriting', extra: { tone: 'work' } },
        { name: 'Talks in class / easily distracted', extra: { tone: 'work' } },
        { name: 'Attendance is low', extra: { tone: 'work' } },
        { name: 'Should read more at home', extra: { tone: 'work' } },
        { name: 'Extra practice needed before the exams', extra: { tone: 'work' } },
        { name: 'Parent will check the diary daily', extra: { tone: 'info' } },
    ],
});

defineMaster({
    key: 'ptm_topic',
    label: 'PTM topic',
    plural: 'PTM topics',
    description: 'What a parent can say they want to talk about when booking.',
    group: 'ptm',
    order: 20,
    code: 'none',
    ordering: 'manual',
    seed: ['Marks and progress', 'Homework', 'Behaviour', 'Attendance', 'Health', 'Fees', 'Transport', 'Other'].map((name) => ({ name })),
});
