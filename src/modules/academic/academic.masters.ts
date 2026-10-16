import { getSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';
import { ACADEMIC } from './academic.settings';

/** Academic lists kept in the master engine (Configuration → Masters → Academic). */

defineMasterGroup({ key: 'academic', label: 'Academic', order: 5 });

export const CLASS_GROUP = defineMaster({
    key: 'class_group',
    label: 'Class group',
    plural: 'Class groups',
    description: 'Groups of classes (Primary, Middle…), so fees or exams can be set once for many classes.',
    group: 'academic',
    order: 10,
    code: 'optional',
    ordering: 'manual',
    seed: [
        { name: 'Pre-primary', code: 'PP' },
        { name: 'Primary', code: 'PRI' },
        { name: 'Middle', code: 'MID' },
        { name: 'Secondary', code: 'SEC' },
        { name: 'Senior Secondary', code: 'SRSEC' },
    ],
});

export const STREAM = defineMaster({
    key: 'stream',
    label: 'Stream',
    plural: 'Streams',
    description: 'Streams of classes XI and XII.',
    group: 'academic',
    order: 20,
    code: 'optional',
    ordering: 'manual',
    seed: [
        { name: 'Science', code: 'SCI' },
        { name: 'Commerce', code: 'COM' },
        { name: 'Humanities', code: 'HUM' },
    ],
});

export const SUBJECT_TYPE = defineMaster({
    key: 'subject_type',
    label: 'Subject type',
    plural: 'Subject types',
    group: 'academic',
    order: 30,
    code: 'none',
    ordering: 'manual',
    seed: [{ name: 'Theory' }, { name: 'Theory + practical' }, { name: 'Language' }, { name: 'Activity' }],
});

export const HOUSE = defineMaster({
    key: 'house',
    label: 'House',
    plural: 'Houses',
    group: 'academic',
    order: 40,
    code: 'none',
    ordering: 'manual',
    fields: [{ key: 'colour', label: 'Colour', type: 'text', pattern: /^#[0-9A-Fa-f]{6}$/, patternMessage: 'must be a colour like #D62828', upperCase: true, example: '#D62828' }],
    seed: [
        { name: 'Red', extra: { colour: '#D62828' } },
        { name: 'Blue', extra: { colour: '#1D4ED8' } },
        { name: 'Green', extra: { colour: '#15803D' } },
        { name: 'Yellow', extra: { colour: '#EAB308' } },
    ],
    hidden: async () => !(await getSetting(ACADEMIC.housesEnabled)),
});
