import { z } from 'zod';
import { defineSetting } from '../../core/settings';

/** System Settings → Students. */

const G = 'Students';

/** Fields a school can make required or hide (the name, class and section are always required). */
export const STUDENT_FIELDS = [
    { value: 'middleName', label: 'Middle name' },
    { value: 'lastName', label: 'Last name' },
    { value: 'dateOfBirth', label: 'Date of birth' },
    { value: 'genderId', label: 'Gender' },
    { value: 'bloodGroupId', label: 'Blood group' },
    { value: 'religionId', label: 'Religion' },
    { value: 'casteCategoryId', label: 'Caste category' },
    { value: 'categoryId', label: 'Admission category' },
    { value: 'motherTongueId', label: 'Mother tongue' },
    { value: 'nationalityId', label: 'Nationality' },
    { value: 'disabilityId', label: 'Disability (CWSN)' },
    { value: 'aadhaar', label: 'Aadhaar' },
    { value: 'apaarId', label: 'APAAR ID' },
    { value: 'pen', label: 'PEN (UDISE+)' },
    { value: 'mobile', label: 'Student mobile' },
    { value: 'email', label: 'Student email' },
    { value: 'address', label: 'Address' },
    { value: 'previousSchool', label: 'Previous school' },
    { value: 'medicalNotes', label: 'Medical notes' },
    { value: 'emergency', label: 'Emergency contact' },
    { value: 'guardian', label: 'At least one parent / guardian' },
] as const;
export type StudentField = (typeof STUDENT_FIELDS)[number]['value'];
const fieldEnum = z.enum(STUDENT_FIELDS.map((f) => f.value) as [StudentField, ...StudentField[]]);

export const STUDENTS = {
    admissionPattern: defineSetting<string>({
        key: 'students.admission_number_pattern',
        group: G,
        label: 'Admission number looks like',
        help: 'Any text, plus: {SEQ} the running number ({SEQ:4} = 0001), {YYYY} / {YY} year of admission, {AY} academic year (2026-27), {CLASS} class short name. E.g. KVJ/{YYYY}/{SEQ:3}.',
        type: 'text',
        default: '{YYYY}/{SEQ:4}',
        schema: z
            .string()
            .trim()
            .min(1)
            .max(40)
            .refine((p) => /\{SEQ(:\d)?\}/.test(p), 'must contain {SEQ} (the running number)')
            .refine((p) => !/\{(?!SEQ(:\d)?\}|YYYY\}|YY\}|AY\}|CLASS\})[^}]*\}/.test(p), 'uses an unknown {…} part'),
    }),
    admissionReset: defineSetting<'never' | 'academic_year' | 'calendar_year' | 'class'>({
        key: 'students.admission_number_reset',
        group: G,
        label: 'The running number starts again',
        type: 'select',
        default: 'never',
        schema: z.enum(['never', 'academic_year', 'calendar_year', 'class']),
        options: [
            { value: 'never', label: 'Never (keeps counting)' },
            { value: 'academic_year', label: 'Every academic year' },
            { value: 'calendar_year', label: 'Every calendar year' },
            { value: 'class', label: 'For each class' },
        ],
    }),
    admissionStart: defineSetting<number>({
        key: 'students.admission_number_start',
        group: G,
        label: 'The running number starts at',
        help: 'For a new counter (e.g. continue from your old register: 1251).',
        type: 'number',
        default: 1,
        schema: z.number().int().min(0).max(9_999_999),
    }),
    admissionEditable: defineSetting<boolean>({
        key: 'students.admission_number_editable',
        group: G,
        label: 'Admission number can be typed by hand at admission',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
    rollOrder: defineSetting<'first_name' | 'last_name' | 'admission_number' | 'admission_date' | 'girls_first' | 'boys_first' | 'manual'>({
        key: 'students.roll_number_order',
        group: G,
        label: 'Roll numbers are given in the order of',
        help: 'Used when a section is renumbered (Students → Renumber rolls).',
        type: 'select',
        default: 'first_name',
        schema: z.enum(['first_name', 'last_name', 'admission_number', 'admission_date', 'girls_first', 'boys_first', 'manual']),
        options: [
            { value: 'first_name', label: 'Name (A–Z by first name)' },
            { value: 'last_name', label: 'Surname (A–Z by last name)' },
            { value: 'admission_number', label: 'Admission number' },
            { value: 'admission_date', label: 'Date of admission' },
            { value: 'girls_first', label: 'Girls first, then boys (each A–Z)' },
            { value: 'boys_first', label: 'Boys first, then girls (each A–Z)' },
            { value: 'manual', label: 'Typed by hand only' },
        ],
    }),
    rollOnJoin: defineSetting<'next' | 'renumber' | 'blank'>({
        key: 'students.roll_number_on_join',
        group: G,
        label: 'When a student joins a section',
        type: 'select',
        default: 'next',
        schema: z.enum(['next', 'renumber', 'blank']),
        options: [
            { value: 'next', label: 'Give the next roll number' },
            { value: 'renumber', label: 'Renumber the whole section in the order above' },
            { value: 'blank', label: 'Leave the roll number empty' },
        ],
    }),
    capacityCheck: defineSetting<'warn' | 'block' | 'off'>({
        key: 'students.section_capacity',
        group: G,
        label: 'When a section is full',
        type: 'select',
        default: 'warn',
        schema: z.enum(['warn', 'block', 'off']),
        options: [
            { value: 'warn', label: 'Allow, with a warning' },
            { value: 'block', label: "Don't allow more students" },
            { value: 'off', label: 'Ignore capacity' },
        ],
    }),
    studentLogin: defineSetting<'auto' | 'on_request' | 'off'>({
        key: 'students.student_login',
        group: G,
        label: 'Student logins',
        type: 'select',
        default: 'auto',
        schema: z.enum(['auto', 'on_request', 'off']),
        options: [
            { value: 'auto', label: 'Created automatically at admission' },
            { value: 'on_request', label: 'Created when asked (button on the student)' },
            { value: 'off', label: 'No student logins' },
        ],
    }),
    studentUsername: defineSetting<'admission_number' | 'name'>({
        key: 'students.student_username',
        group: G,
        label: 'Student usernames are made from',
        type: 'select',
        default: 'admission_number',
        schema: z.enum(['admission_number', 'name']),
        options: [
            { value: 'admission_number', label: 'Admission number (2026/0001 → 20260001)' },
            { value: 'name', label: 'Name (riya.sharma)' },
        ],
    }),
    parentLogin: defineSetting<'auto' | 'on_request' | 'off'>({
        key: 'students.parent_login',
        group: G,
        label: 'Parent logins',
        help: 'One login per parent shows all their children.',
        type: 'select',
        default: 'off',
        schema: z.enum(['auto', 'on_request', 'off']),
        options: [
            { value: 'auto', label: 'Created automatically for the main contact' },
            { value: 'on_request', label: 'Created when asked' },
            { value: 'off', label: 'No parent logins' },
        ],
    }),
    requiredFields: defineSetting<StudentField[]>({
        key: 'students.required_fields',
        group: G,
        label: 'Required at admission',
        type: 'multiselect',
        default: ['dateOfBirth', 'genderId', 'guardian'],
        schema: z.array(fieldEnum),
        options: [...STUDENT_FIELDS],
    }),
    hiddenFields: defineSetting<StudentField[]>({
        key: 'students.hidden_fields',
        group: G,
        label: 'Not used by the school (hidden on forms)',
        type: 'multiselect',
        default: [],
        schema: z.array(fieldEnum),
        options: STUDENT_FIELDS.filter((f) => f.value !== 'guardian'),
    }),
};
