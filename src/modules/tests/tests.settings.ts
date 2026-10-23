import { z } from 'zod';
import { defineSetting } from '../../core/settings';

/** System Settings → Online Tests: the defaults of a new test and how answers are marked. */

const G = 'Online Tests';
const bool = (key: string, label: string, def: boolean, help?: string) => defineSetting<boolean>({ key, group: G, label, help, type: 'boolean', default: def, schema: z.boolean() });

export const TESTS = {
    duration: defineSetting<number>({ key: 'tests.duration', group: G, label: 'Time for a new test (minutes)', type: 'number', default: 30, schema: z.number().int().min(1).max(600) }),
    shuffleQuestions: bool('tests.shuffle_questions', 'New tests show the questions in a different order to each student', true),
    shuffleOptions: bool('tests.shuffle_options', 'New tests shuffle the choices of multiple-choice questions', true),
    showResult: defineSetting<string>({
        key: 'tests.show_result',
        group: G,
        label: 'Students see their result',
        type: 'select',
        default: 'after_review',
        schema: z.enum(['instant', 'after_review']),
        options: [
            { value: 'instant', label: 'As soon as they submit (tests with only objective questions)' },
            { value: 'after_review', label: 'When the teacher publishes the results' },
        ],
    }),
    negative: defineSetting<number>({ key: 'tests.negative', group: G, label: 'Marks taken off for a wrong objective answer, in new tests (0 = none)', type: 'number', default: 0, schema: z.number().min(0).max(10) }),
    multiPartial: bool('tests.multi_partial', 'Several-answer questions give part marks (right ticks minus wrong ticks)', false, 'Off: all the right answers and none wrong, or no marks.'),
    joinMinutes: defineSetting<number>({ key: 'tests.join_minutes', group: G, label: 'Students can start a test up to this many minutes after it opens (0 = until it closes)', type: 'number', default: 0, schema: z.number().int().min(0).max(1440) }),
    aiMarking: bool('tests.ai_marking', 'AI suggests marks for written answers (the teacher decides)', true),
};
