import { z } from 'zod';
import { defineSetting } from '../../core/settings';

/** System Settings → Academic. */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const ACADEMIC = {
    /** Month number as text ('4' = April), as the settings screen's dropdowns send text. */
    yearStartMonth: defineSetting<string>({
        key: 'academic.year_start_month',
        group: 'Academic',
        label: 'The academic year starts in',
        help: 'Used to suggest the dates of a new academic year.',
        type: 'select',
        default: '4',
        schema: z.enum(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']),
        options: MONTHS.map((label, i) => ({ value: String(i + 1), label })),
    }),
    yearNameFormat: defineSetting<'short' | 'long'>({
        key: 'academic.year_name_format',
        group: 'Academic',
        label: 'Academic year names look like',
        type: 'select',
        default: 'short',
        schema: z.enum(['short', 'long']),
        options: [
            { value: 'short', label: '2026–27' },
            { value: 'long', label: '2026–2027' },
        ],
    }),
    housesEnabled: defineSetting<boolean>({
        key: 'academic.houses_enabled',
        group: 'Academic',
        label: 'The school has houses (Red, Blue…)',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
    oneSectionPerClassTeacher: defineSetting<boolean>({
        key: 'academic.one_section_per_class_teacher',
        group: 'Academic',
        label: 'A teacher can be class teacher of only one section a year',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
};

/** "2026–27" or "2026–2027" for a year starting in 2026. */
export const yearName = (startYear: number, format: 'short' | 'long') =>
    `${startYear}–${format === 'short' ? String(startYear + 1).slice(-2) : startYear + 1}`;
