import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/**
 * System Settings → Exams, and the exam lists (Masters → Exams). Grading scales and result rules
 * (pass %, grace, rank) have their own screen: Exams → Grading & Result Rules.
 */

const G = 'Exams';

export const EXAMS = {
    halfMarks: defineSetting<boolean>({
        key: 'exams.half_marks',
        group: G,
        label: 'Half marks can be given (e.g. 37.5)',
        help: 'Off: only whole marks.',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
    reportCardShows: defineSetting<string>({
        key: 'exams.report_card_shows',
        group: G,
        label: 'Report cards show',
        help: 'Grades only: each subject shows its grade (many schools do this up to Class VIII). The marks are still kept.',
        type: 'select',
        default: 'marks_and_grades',
        schema: z.enum(['marks_and_grades', 'grades_only']),
        options: [
            { value: 'marks_and_grades', label: 'Marks and grades' },
            { value: 'grades_only', label: 'Grades only' },
        ],
    }),
    classTeacherAll: defineSetting<boolean>({
        key: 'exams.class_teacher_enters_all',
        group: G,
        label: 'Class teachers can enter the marks of every subject of their own section',
        help: 'Off: each subject’s marks are entered by its teacher (Staff → Subject Teachers), or the office.',
        type: 'boolean',
        default: false,
        schema: z.boolean(),
    }),
    datesheetNotice: defineSetting<boolean>({
        key: 'exams.datesheet_notice',
        group: G,
        label: 'Publishing a date sheet also puts a notice on the notice board',
        help: 'It always goes on the School Calendar.',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
};

defineMasterGroup({ key: 'exams', label: 'Exams', order: 13 });
defineMaster({
    key: 'exam_type',
    label: 'Exam type',
    plural: 'Exam types',
    description: 'The kinds of exams the school holds. Choosing one when adding an exam fills in its parts and weightage (they can still be changed).',
    group: 'exams',
    order: 10,
    code: 'optional',
    ordering: 'manual',
    fields: [
        { key: 'parts', label: 'Parts with maximum marks', type: 'text', max: 120, help: 'Like “Written 80, Internal 20”.', example: 'Written 80, Internal 20' },
        { key: 'weightage', label: 'Weightage in the result (%)', type: 'number', example: '30' },
    ],
    seed: [
        { name: 'Periodic Test', code: 'PT', extra: { parts: 'Written 40', weightage: 10 } },
        { name: 'Half-Yearly', code: 'HY', extra: { parts: 'Written 80, Internal 20', weightage: 30 } },
        { name: 'Annual', code: 'AN', extra: { parts: 'Written 80, Internal 20', weightage: 50 } },
        { name: 'Pre-Board', code: 'PB', extra: { parts: 'Written 80, Internal 20', weightage: 0 } },
        { name: 'Class Test', code: 'CT', extra: { parts: 'Written 20', weightage: 0 } },
    ],
});
defineMaster({
    key: 'report_remark',
    label: 'Report card remark',
    plural: 'Report card remarks',
    description: 'Ready remarks class teachers pick from on the report card (they can still write their own).',
    group: 'exams',
    order: 20,
    code: 'none',
    ordering: 'manual',
    seed: [
        { name: 'Keeps working hard.' },
        { name: 'Is regular and sincere.' },
        { name: 'Takes part well in class.' },
        { name: 'Shows good progress this term.' },
        { name: 'A cheerful and helpful student.' },
        { name: 'Should practise mathematics more.' },
        { name: 'Reads well; must improve handwriting.' },
        { name: 'Needs to complete homework on time.' },
        { name: 'Can do better with more effort.' },
    ],
});
