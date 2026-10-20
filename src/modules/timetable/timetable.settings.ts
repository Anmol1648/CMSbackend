import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/** System Settings → Timetable, and the rooms list (Configuration → Masters → Rooms & labs). */

const G = 'Timetable';

export const TIMETABLE = {
    maxPerDay: defineSetting<number>({
        key: 'timetable.teacher_max_per_day',
        group: G,
        label: 'Most periods a teacher takes in a day',
        help: 'Each teacher can have their own limit (Timetable Setup → Teachers).',
        type: 'number',
        default: 7,
        schema: z.number().int().min(1).max(20),
    }),
    maxPerWeek: defineSetting<number>({
        key: 'timetable.teacher_max_per_week',
        group: G,
        label: 'Most periods a teacher takes in a week',
        type: 'number',
        default: 40,
        schema: z.number().int().min(1).max(100),
    }),
    maxSamePerDay: defineSetting<number>({
        key: 'timetable.max_same_subject_per_day',
        group: G,
        label: 'Most periods of the same subject in a day (a double period counts as two)',
        type: 'number',
        default: 2,
        schema: z.number().int().min(1).max(8),
    }),
    classTeacherFirst: defineSetting<boolean>({
        key: 'timetable.class_teacher_first_period',
        group: G,
        label: 'The class teacher takes the first period where possible',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
    attempts: defineSetting<number>({
        key: 'timetable.generator_attempts',
        group: G,
        label: 'How many tries the generator makes (more = better, slower)',
        type: 'number',
        default: 25,
        schema: z.number().int().min(1).max(200),
        hidden: true,
    }),
    substituteMaxPerDay: defineSetting<number>({
        key: 'timetable.substitute_max_per_day',
        group: G,
        label: 'Most substitution periods a teacher gets in a day',
        type: 'number',
        default: 2,
        schema: z.number().int().min(0).max(10),
    }),
};

defineMasterGroup({ key: 'facilities', label: 'Rooms & labs', order: 12 });
defineMaster({
    key: 'room',
    label: 'Room',
    plural: 'Rooms & labs',
    description: 'Labs and special rooms a subject needs (the timetable never books one twice at the same time). Classes in their own room need nothing here.',
    group: 'facilities',
    order: 10,
    code: 'optional',
    ordering: 'manual',
    fields: [{ key: 'capacity', label: 'Seats', type: 'number' }],
    seed: [
        { name: 'Physics Lab', code: 'PHY-LAB', extra: { capacity: 40 } },
        { name: 'Chemistry Lab', code: 'CHE-LAB', extra: { capacity: 40 } },
        { name: 'Biology Lab', code: 'BIO-LAB', extra: { capacity: 40 } },
        { name: 'Computer Lab', code: 'COMP-LAB', extra: { capacity: 40 } },
        { name: 'Science Lab (VI–X)', code: 'SCI-LAB', extra: { capacity: 40 } },
        { name: 'Library', code: 'LIB', extra: { capacity: 60 } },
        { name: 'Art Room', code: 'ART', extra: { capacity: 40 } },
        { name: 'Playground', code: 'GROUND', extra: { capacity: 200 } },
    ],
});
