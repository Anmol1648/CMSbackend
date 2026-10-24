import { z } from 'zod';
import { defineSetting } from '../../core/settings';

/**
 * System Settings → Teacher feedback: privacy (anonymous, minimum responses), what teachers see,
 * comment screening, reminders and the rating scale. Who runs rounds, sees results or fills forms
 * is in Roles & Permissions (feedback.*). Question sets are on the Teacher Feedback page.
 */

const G = 'Teacher feedback';
const bool = (key: string, label: string, def: boolean, help?: string) => defineSetting<boolean>({ key, group: G, label, help, type: 'boolean', default: def, schema: z.boolean() });
const num = (key: string, label: string, def: number, min: number, max: number, help?: string) =>
    defineSetting<number>({ key, group: G, label, help, type: 'number', default: def, schema: z.number().int().min(min).max(max) });

export const FEEDBACK = {
    anonymous: bool('feedback.anonymous', 'New rounds are anonymous (no one sees who wrote what)', true),
    minResponses: num('feedback.min_responses', 'Show a teacher’s results only when at least this many people answered', 5, 1, 100, 'So no one can guess who wrote what.'),
    teachersSee: bool('feedback.teachers_see', 'Teachers see their own results (after the round is released)', true),
    teachersSeeComments: bool('feedback.teachers_see_comments', 'Teachers see the comments about them (screened ones only)', true),
    screenComments: bool('feedback.screen_comments', 'Comments are screened by the principal before teachers see them', true),
    remindDays: num('feedback.remind_days', 'Remind those who haven’t filled in, this many days before a round closes (0 = no reminder)', 2, 0, 30),
    scale: defineSetting<string>({ key: 'feedback.scale', group: G, label: 'Rating questions are out of', type: 'select', default: '5', schema: z.enum(['5', '10']), options: [{ value: '5', label: '5 (1–5 stars)' }, { value: '10', label: '10' }] }),
};

export type Question = { id: string; kind: 'rating' | 'yesno' | 'text'; text: string; required?: boolean };

/** The question sets a school starts with. */
export const STARTER_FORMS: { name: string; audience: string; questions: Question[] }[] = [
    {
        name: 'Student feedback on teachers',
        audience: 'student',
        questions: [
            { id: 'q1', kind: 'rating', text: 'Explains the lessons clearly', required: true },
            { id: 'q2', kind: 'rating', text: 'Comes to class on time and uses the period well', required: true },
            { id: 'q3', kind: 'rating', text: 'Gives time for our doubts and questions', required: true },
            { id: 'q4', kind: 'rating', text: 'Checks homework and class work and tells us our mistakes', required: true },
            { id: 'q5', kind: 'rating', text: 'Treats all students fairly and politely', required: true },
            { id: 'q6', kind: 'rating', text: 'Makes the subject interesting (examples, activities)', required: true },
            { id: 'q7', kind: 'yesno', text: 'Is the syllabus being completed on time?' },
            { id: 'q8', kind: 'text', text: 'What should this teacher do better? (optional)' },
        ],
    },
    {
        name: 'Parent feedback on teachers',
        audience: 'parent',
        questions: [
            { id: 'q1', kind: 'rating', text: 'Keeps me informed about my child’s progress', required: true },
            { id: 'q2', kind: 'rating', text: 'Is approachable at PTMs and when I contact them', required: true },
            { id: 'q3', kind: 'rating', text: 'My child understands and enjoys this subject', required: true },
            { id: 'q4', kind: 'rating', text: 'Homework given is useful and reasonable', required: true },
            { id: 'q5', kind: 'rating', text: 'Cares about my child’s overall development', required: true },
            { id: 'q6', kind: 'text', text: 'Any suggestion for this teacher? (optional)' },
        ],
    },
];
