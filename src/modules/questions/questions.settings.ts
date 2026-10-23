import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/** System Settings → Question Bank, and its lists (Masters → Question Bank). */

const G = 'Question Bank';

export const QUESTION_TYPES = ['mcq', 'multi', 'true_false', 'fill', 'short', 'long'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const TYPE_LABEL: Record<QuestionType, string> = { mcq: 'Multiple choice (one answer)', multi: 'Multiple choice (several answers)', true_false: 'True / false', fill: 'Fill in the blank', short: 'Short answer', long: 'Long answer' };

export const QUESTIONS = {
    approval: defineSetting<boolean>({ key: 'questions.approval', group: G, label: 'Teachers’ questions wait for a reviewer before tests can use them', help: 'Off: they can be used at once. Reviewers are those with “Approve questions”.', type: 'boolean', default: true, schema: z.boolean() }),
    aiReview: defineSetting<boolean>({ key: 'questions.ai_review', group: G, label: 'Questions written by AI start as drafts, to be read and sent on by a teacher', type: 'boolean', default: true, schema: z.boolean() }),
    types: defineSetting<string[]>({
        key: 'questions.types',
        group: G,
        label: 'Kinds of questions used',
        type: 'multiselect',
        default: [...QUESTION_TYPES],
        schema: z.array(z.enum(QUESTION_TYPES)).min(1),
        options: QUESTION_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] })),
    }),
    maxOptions: defineSetting<number>({ key: 'questions.max_options', group: G, label: 'Choices a multiple-choice question can have', type: 'number', default: 6, schema: z.number().int().min(2).max(10) }),
};

defineMasterGroup({ key: 'questions', label: 'Question Bank', order: 16 });
defineMaster({
    key: 'question_difficulty',
    label: 'Difficulty',
    plural: 'Difficulty levels',
    description: 'How hard a question is (tests can be made with a mix).',
    group: 'questions',
    order: 10,
    code: 'optional',
    ordering: 'manual',
    seed: [
        { name: 'Easy', code: 'E' },
        { name: 'Medium', code: 'M' },
        { name: 'Hard', code: 'H' },
    ],
});
defineMaster({
    key: 'question_level',
    label: 'Thinking level',
    plural: 'Thinking levels',
    description: 'What a question asks the student to do (Bloom’s levels, as CBSE uses them).',
    group: 'questions',
    order: 20,
    code: 'optional',
    ordering: 'manual',
    seed: [{ name: 'Remember' }, { name: 'Understand' }, { name: 'Apply' }, { name: 'Analyse' }, { name: 'Evaluate' }, { name: 'Create' }],
});
