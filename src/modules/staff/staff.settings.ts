import { z } from 'zod';
import { defineSetting } from '../../core/settings';

/** System Settings → Staff. */

const G = 'Staff';

export const STAFF_FIELDS = [
    { value: 'middleName', label: 'Middle name' },
    { value: 'lastName', label: 'Last name' },
    { value: 'dateOfBirth', label: 'Date of birth' },
    { value: 'genderId', label: 'Gender' },
    { value: 'bloodGroupId', label: 'Blood group' },
    { value: 'religionId', label: 'Religion' },
    { value: 'casteCategoryId', label: 'Caste category' },
    { value: 'maritalStatusId', label: 'Marital status' },
    { value: 'mobile', label: 'Mobile' },
    { value: 'email', label: 'Email' },
    { value: 'aadhaar', label: 'Aadhaar' },
    { value: 'pan', label: 'PAN' },
    { value: 'address', label: 'Address' },
    { value: 'departmentId', label: 'Department' },
    { value: 'designationId', label: 'Designation' },
    { value: 'employmentTypeId', label: 'Employment type' },
    { value: 'bank', label: 'Bank account' },
    { value: 'pf', label: 'PF / UAN' },
    { value: 'emergency', label: 'Emergency contact' },
] as const;
export type StaffField = (typeof STAFF_FIELDS)[number]['value'];
const fieldEnum = z.enum(STAFF_FIELDS.map((f) => f.value) as [StaffField, ...StaffField[]]);

/** What staff may change on their own record (My account → Staff details). */
export const SELF_EDIT = [
    { value: 'mobile', label: 'Mobile' },
    { value: 'email', label: 'Email' },
    { value: 'address', label: 'Address' },
    { value: 'emergency', label: 'Emergency contact' },
    { value: 'qualifications', label: 'Qualifications and experience' },
    { value: 'bank', label: 'Bank account' },
] as const;
export type SelfEditField = (typeof SELF_EDIT)[number]['value'];

export const STAFF = {
    codePattern: defineSetting<string>({
        key: 'staff.code_pattern',
        group: G,
        label: 'Employee code looks like',
        help: 'Any text, plus {SEQ} the running number ({SEQ:3} = 001), {YYYY} / {YY} year of joining. E.g. KVJ/EMP/{SEQ:3}.',
        type: 'text',
        default: 'EMP/{SEQ:3}',
        schema: z
            .string()
            .trim()
            .min(1)
            .max(40)
            .refine((p) => /\{SEQ(:\d)?\}/.test(p), 'must contain {SEQ} (the running number)')
            .refine((p) => !/\{(?!SEQ(:\d)?\}|YYYY\}|YY\})[^}]*\}/.test(p), 'uses an unknown {…} part'),
    }),
    codeStart: defineSetting<number>({
        key: 'staff.code_start',
        group: G,
        label: 'The running number starts at',
        type: 'number',
        default: 1,
        schema: z.number().int().min(0).max(9_999_999),
    }),
    codeEditable: defineSetting<boolean>({
        key: 'staff.code_editable',
        group: G,
        label: 'Employee codes can be typed by hand (e.g. the KV employee code)',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
    loginDefault: defineSetting<'teaching' | 'all' | 'none'>({
        key: 'staff.login_default',
        group: G,
        label: 'New staff get a login',
        help: 'The default of the "Can sign in" switch when adding someone; it can be changed per person.',
        type: 'select',
        default: 'teaching',
        schema: z.enum(['teaching', 'all', 'none']),
        options: [
            { value: 'teaching', label: 'Teaching staff only' },
            { value: 'all', label: 'Everyone' },
            { value: 'none', label: 'Nobody (switch it on per person)' },
        ],
    }),
    username: defineSetting<'name' | 'code'>({
        key: 'staff.username',
        group: G,
        label: 'Staff usernames are made from',
        type: 'select',
        default: 'name',
        schema: z.enum(['name', 'code']),
        options: [
            { value: 'name', label: 'Name (anita.negi)' },
            { value: 'code', label: 'Employee code (EMP/001 → emp001)' },
        ],
    }),
    requiredFields: defineSetting<StaffField[]>({
        key: 'staff.required_fields',
        group: G,
        label: 'Required when adding staff',
        type: 'multiselect',
        default: ['genderId', 'mobile', 'designationId'],
        schema: z.array(fieldEnum),
        options: [...STAFF_FIELDS],
    }),
    hiddenFields: defineSetting<StaffField[]>({
        key: 'staff.hidden_fields',
        group: G,
        label: 'Not used by the school (hidden on forms)',
        type: 'multiselect',
        default: [],
        schema: z.array(fieldEnum),
        options: [...STAFF_FIELDS],
    }),
    selfEdit: defineSetting<SelfEditField[]>({
        key: 'staff.self_edit',
        group: G,
        label: 'Staff can change these on their own record',
        type: 'multiselect',
        default: ['mobile', 'email', 'address', 'emergency'],
        schema: z.array(z.enum(SELF_EDIT.map((f) => f.value) as [SelfEditField, ...SelfEditField[]])),
        options: [...SELF_EDIT],
    }),
};
