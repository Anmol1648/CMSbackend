import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/**
 * System Settings → Exams, and the exam lists (Masters → Exams). Grading scales and result rules
 * (pass %, grace, rank) have their own screen: Exams → Grading & Result Rules.
 */

const G = 'Exams';
const name = (key: string, label: string, fallback: string) =>
    defineSetting<string>({ key, group: G, label, help: 'What screens and report cards call it.', type: 'text', default: fallback, schema: z.string().trim().min(1).max(40) });

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
    subjectTeacherSees: defineSetting<string>({
        key: 'exams.subject_teacher_sees',
        group: G,
        label: 'Subject teachers see results of the sections they teach',
        help: 'Their own subject only: just their subject’s marks and analysis, no totals, ranks or report cards. Class teachers always see their own section in full.',
        type: 'select',
        default: 'own_subject',
        schema: z.enum(['own_subject', 'whole_section']),
        options: [
            { value: 'own_subject', label: 'Their own subject only' },
            { value: 'whole_section', label: 'The whole section' },
        ],
    }),
    lockBeforePublish: defineSetting<boolean>({
        key: 'exams.lock_before_publish',
        group: G,
        label: 'Marks entry must be locked before results are published',
        help: 'Off: results can be published straight from “marks entry open” (entry closes when they are).',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
    presentName: name('exams.name_present', 'Name for “present” on the marks sheet', 'Present'),
    draftName: name('exams.name_draft', 'Name of the stage: being set up', 'Being set up'),
    openName: name('exams.name_open', 'Name of the stage: marks entry open', 'Marks entry open'),
    lockedName: name('exams.name_locked', 'Name of the stage: entry locked', 'Entry locked'),
    publishedName: name('exams.name_published', 'Name of the stage: results published', 'Results published'),
    finalName: name('exams.name_final', 'Name of the session’s result (report card title)', 'Final result'),
    marksKindName: name('exams.name_kind_marks', 'Name of grade scales worked out from marks %', 'By marks %'),
    descriptiveKindName: name('exams.name_kind_descriptive', 'Name of grade scales the teacher chooses from', 'Grades chosen by the teacher'),
};

/** How a mark status other than “present” counts in the result. */
export const MARK_COUNTS = [
    { value: 'zero', label: 'Counted as 0 marks' },
    { value: 'leave_out', label: 'Left out of the total' },
    { value: 'average', label: 'Given the average of the student’s other papers in the exam' },
] as const;

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
    key: 'exam_mark_status',
    label: 'Mark status',
    plural: 'Mark statuses',
    description: 'What a teacher can mark instead of marks (absent, medical…), the short form shown on marks sheets and report cards (the code), and how it counts in the result.',
    group: 'exams',
    order: 15,
    code: 'required',
    ordering: 'manual',
    fields: [{ key: 'counts', label: 'In the result it is', type: 'select', required: true, options: [...MARK_COUNTS] }],
    seed: [
        { name: 'Absent', code: 'AB', extra: { counts: 'zero' } },
        { name: 'Medical', code: 'ML', extra: { counts: 'leave_out' } },
        { name: 'Not taking', code: 'NA', extra: { counts: 'leave_out' } },
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
