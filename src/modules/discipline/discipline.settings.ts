import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/**
 * System Settings → Discipline (what parents see, alerts, points, thresholds), and its lists
 * (Masters → Discipline): incident types, actions, places. Who records, sees, decides or approves
 * is in Roles & Permissions (discipline.*).
 */

const G = 'Discipline';
const bool = (key: string, label: string, def: boolean, help?: string) => defineSetting<boolean>({ key, group: G, label, help, type: 'boolean', default: def, schema: z.boolean() });
const num = (key: string, label: string, def: number, min: number, max: number, help?: string) =>
    defineSetting<number>({ key, group: G, label, help, type: 'number', default: def, schema: z.number().int().min(min).max(max) });

export const SEVERITIES = ['minor', 'moderate', 'serious'] as const;

export const DISCIPLINE = {
    parentsSee: defineSetting<string>({
        key: 'discipline.parents_see',
        group: G,
        label: 'Parents (and students) see',
        type: 'select',
        default: 'all',
        schema: z.enum(['none', 'serious', 'moderate', 'all']),
        options: [
            { value: 'all', label: 'Every incident and positive note' },
            { value: 'moderate', label: 'Moderate and serious incidents (and positive notes)' },
            { value: 'serious', label: 'Serious incidents only (and positive notes)' },
            { value: 'none', label: 'Nothing (the school tells them itself)' },
        ],
    }),
    alertFrom: defineSetting<string>({
        key: 'discipline.alert_from',
        group: G,
        label: 'Tell parents at once (alert) from',
        type: 'select',
        default: 'moderate',
        schema: z.enum(['minor', 'moderate', 'serious', 'never']),
        options: [
            { value: 'minor', label: 'Every incident' },
            { value: 'moderate', label: 'Moderate and serious incidents' },
            { value: 'serious', label: 'Serious incidents only' },
            { value: 'never', label: 'Never (the teacher marks “informed by phone”)' },
        ],
    }),
    positiveAlert: bool('discipline.positive_alert', 'Tell parents about positive notes (praise)', true),
    positives: bool('discipline.positives', 'Teachers can record positive notes too (good behaviour, helping)', true),
    points: bool('discipline.points', 'Use conduct points (merit + / demerit −, set on each incident type)', true),
    thresholdCount: num('discipline.threshold_count', 'Alert the class teacher and principal when a student has this many incidents in 30 days (0 = off)', 3, 0, 50),
    thresholdPoints: num('discipline.threshold_points', 'Or when their points this session fall to minus this many (0 = off)', 10, 0, 500),
    teacherOwnSections: bool('discipline.teachers_any_student', 'Teachers can record incidents for any student (not only the sections they teach)', true, 'A teacher on duty in the corridor or the bus can record for anyone.'),
};

defineMasterGroup({ key: 'discipline', label: 'Discipline', order: 22 });

defineMaster({
    key: 'incident_type',
    label: 'Incident type',
    plural: 'Incident types',
    description: 'Kinds of incidents (and positive notes), with how serious they usually are and their points.',
    group: 'discipline',
    order: 10,
    code: 'none',
    ordering: 'manual',
    fields: [
        { key: 'positive', label: 'A positive note (praise)', type: 'boolean' },
        { key: 'severity', label: 'Usually', type: 'select', options: [{ value: 'minor', label: 'Minor' }, { value: 'moderate', label: 'Moderate' }, { value: 'serious', label: 'Serious' }] },
        { key: 'points', label: 'Points (− for incidents, + for praise)', type: 'number' },
    ],
    seed: [
        { name: 'Late coming', extra: { positive: false, severity: 'minor', points: -1 } },
        { name: 'Not in uniform', extra: { positive: false, severity: 'minor', points: -1 } },
        { name: 'Homework not done (repeatedly)', extra: { positive: false, severity: 'minor', points: -1 } },
        { name: 'Mobile phone in class', extra: { positive: false, severity: 'moderate', points: -2 } },
        { name: 'Misbehaviour in class', extra: { positive: false, severity: 'moderate', points: -2 } },
        { name: 'Absent without leave', extra: { positive: false, severity: 'moderate', points: -2 } },
        { name: 'Damage to school property', extra: { positive: false, severity: 'moderate', points: -3 } },
        { name: 'Cheating in a test / exam', extra: { positive: false, severity: 'serious', points: -5 } },
        { name: 'Bullying', extra: { positive: false, severity: 'serious', points: -5 } },
        { name: 'Fighting', extra: { positive: false, severity: 'serious', points: -5 } },
        { name: 'Other', extra: { positive: false, severity: 'minor', points: -1 } },
        { name: 'Helping others', extra: { positive: true, severity: 'minor', points: 2 } },
        { name: 'Good conduct / leadership', extra: { positive: true, severity: 'minor', points: 3 } },
        { name: 'Honesty (returned lost item…)', extra: { positive: true, severity: 'minor', points: 3 } },
    ],
});

defineMaster({
    key: 'discipline_action',
    label: 'Discipline action',
    plural: 'Discipline actions',
    group: 'discipline',
    order: 20,
    code: 'none',
    ordering: 'manual',
    fields: [
        { key: 'approval', label: 'Needs the principal’s approval', type: 'boolean' },
        { key: 'dates', label: 'Has dates (from – to)', type: 'boolean' },
    ],
    seed: [
        { name: 'Verbal warning', extra: { approval: false, dates: false } },
        { name: 'Written warning', extra: { approval: false, dates: false } },
        { name: 'Parent called', extra: { approval: false, dates: false } },
        { name: 'Parent meeting', extra: { approval: false, dates: false } },
        { name: 'Apology letter', extra: { approval: false, dates: false } },
        { name: 'Detention (after school)', extra: { approval: false, dates: true } },
        { name: 'Referred to the counsellor', extra: { approval: false, dates: false } },
        { name: 'Suspension', extra: { approval: true, dates: true } },
        { name: 'Other', extra: { approval: false, dates: false } },
    ],
});

defineMaster({
    key: 'incident_place',
    label: 'Incident place',
    plural: 'Incident places',
    group: 'discipline',
    order: 30,
    code: 'none',
    ordering: 'manual',
    seed: ['Classroom', 'Corridor', 'Playground', 'Bus', 'Laboratory', 'Library', 'Toilets', 'School gate', 'Online (app / social media)', 'Other'].map((name) => ({ name })),
});
