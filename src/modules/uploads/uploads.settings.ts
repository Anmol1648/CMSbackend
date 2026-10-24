import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/**
 * System Settings → Shared files (the Downloads library): file types, teachers' uploads, "new"
 * badges, versions. The size limit is Uploads & exports → largest file. Who manages folders, adds
 * files or sees the tracking is in Roles & Permissions (upload.*).
 */

const G = 'Shared files';
const bool = (key: string, label: string, def: boolean, help?: string) => defineSetting<boolean>({ key, group: G, label, help, type: 'boolean', default: def, schema: z.boolean() });
const num = (key: string, label: string, def: number, min: number, max: number, help?: string) =>
    defineSetting<number>({ key, group: G, label, help, type: 'number', default: def, schema: z.number().int().min(min).max(max) });

export const FILE_TYPES = ['pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpeg', 'webp', 'gif', 'mp4'] as const;

export const SHARED = {
    types: defineSetting<string[]>({
        key: 'shared.file_types',
        group: G,
        label: 'Files that can be shared',
        help: 'The size limit is in Uploads & exports.',
        type: 'multiselect',
        default: ['pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpeg', 'webp'],
        schema: z.array(z.enum(FILE_TYPES)).min(1),
        options: [
            { value: 'pdf', label: 'PDF' },
            { value: 'docx', label: 'Word (.docx)' },
            { value: 'xlsx', label: 'Excel (.xlsx)' },
            { value: 'pptx', label: 'PowerPoint (.pptx)' },
            { value: 'png', label: 'PNG image' },
            { value: 'jpeg', label: 'JPG photo' },
            { value: 'webp', label: 'WebP image' },
            { value: 'gif', label: 'GIF image' },
            { value: 'mp4', label: 'MP4 video (mind the size limit)' },
        ],
    }),
    teachersApproval: bool('shared.teachers_approval', 'Files added by teachers wait for approval before others see them', false),
    keepVersions: bool('shared.keep_versions', 'Keep earlier versions when a file is replaced', true),
    newDays: num('shared.new_days', 'Files show as “new” for this many days', 7, 1, 60),
    ackRemindDays: num('shared.ack_remind_days', 'Remind people to acknowledge a file this many days after it was shared (0 = never)', 3, 0, 60),
};

defineMasterGroup({ key: 'shared', label: 'Shared files', order: 23 });

defineMaster({
    key: 'upload_tag',
    label: 'File tag',
    plural: 'File tags',
    group: 'shared',
    order: 10,
    code: 'none',
    ordering: 'manual',
    seed: ['Circular', 'Syllabus', 'Timetable', 'Form', 'Worksheet', 'Holiday homework', 'Policy', 'Notes', 'Video'].map((name) => ({ name })),
});
