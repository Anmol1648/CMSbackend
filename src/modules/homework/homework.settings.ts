import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/**
 * System Settings → Homework (how homework works), and its lists (Masters → Homework). Who may
 * give, check and see homework is in Roles & Permissions (homework.*).
 */

const G = 'Homework';
const bool = (key: string, label: string, def: boolean, help?: string) => defineSetting<boolean>({ key, group: G, label, help, type: 'boolean', default: def, schema: z.boolean() });
const num = (key: string, label: string, def: number, min: number, max: number, help?: string) =>
    defineSetting<number>({ key, group: G, label, help, type: 'number', default: def, schema: z.number().int().min(min).max(max) });

export const FILE_KINDS = ['pdf', 'png', 'jpeg'] as const;

export const HOMEWORK = {
    online: bool('homework.online', 'Students can hand in homework online (photo, PDF or typed answer)', true, 'Off: teachers only tick done / not done in class.'),
    lateAllowed: bool('homework.late_allowed', 'Homework can be handed in after the due date (marked late)', true),
    lateDays: num('homework.late_days', 'Late homework is taken for this many days after the due date', 3, 0, 60),
    parentsSubmit: bool('homework.parents_submit', 'Parents can hand in homework for their child (young classes)', false),
    onHolidays: bool('homework.on_holidays', 'Homework can be due on a holiday or weekly off', false),
    maxPerDay: num('homework.max_per_day', 'At most this many homework due on one day for a section (0 = no limit)', 0, 0, 20, 'More than this is refused, so children aren’t overloaded.'),
    maxFiles: num('homework.max_files', 'Files a student can attach to one homework', 5, 1, 20),
    fileTypes: defineSetting<string[]>({
        key: 'homework.file_types',
        group: G,
        label: 'Files that can be attached',
        help: 'The size limit is in Uploads & exports.',
        type: 'multiselect',
        default: ['pdf', 'png', 'jpeg'],
        schema: z.array(z.enum(FILE_KINDS)).min(1).max(3),
        options: [
            { value: 'pdf', label: 'PDF' },
            { value: 'png', label: 'PNG image' },
            { value: 'jpeg', label: 'JPG photo' },
        ],
    }),
    showDays: num('homework.show_days', 'My Homework shows homework of the last this many days', 30, 7, 365),
};

defineMasterGroup({ key: 'homework', label: 'Homework', order: 15 });
defineMaster({
    key: 'homework_type',
    label: 'Homework type',
    plural: 'Homework types',
    description: 'Kinds of work teachers give.',
    group: 'homework',
    order: 10,
    code: 'none',
    ordering: 'manual',
    seed: [{ name: 'Homework' }, { name: 'Classwork' }, { name: 'Project' }, { name: 'Holiday homework' }, { name: 'Revision' }, { name: 'Assignment' }],
});
defineMaster({
    key: 'homework_grade',
    label: 'Homework grade',
    plural: 'Homework grades',
    description: 'What teachers give when they check homework. A grade marked “redo” sends it back to the student.',
    group: 'homework',
    order: 20,
    code: 'optional',
    ordering: 'manual',
    fields: [{ key: 'redo', label: 'Sends it back to do again', type: 'boolean' }],
    seed: [
        { name: 'Excellent', code: 'A+', extra: { redo: false } },
        { name: 'Good', code: 'A', extra: { redo: false } },
        { name: 'Satisfactory', code: 'B', extra: { redo: false } },
        { name: 'Needs improvement', code: 'C', extra: { redo: false } },
        { name: 'Redo', code: 'R', extra: { redo: true } },
    ],
});
