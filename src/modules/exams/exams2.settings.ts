import { z } from 'zod';
import { defineSetting } from '../../core/settings';

/**
 * System Settings → Exams (more): admit cards, seating and invigilation, supplementary exams,
 * re-checks and AI remarks. Who does each is in Roles & Permissions (exam.admit, exam.seating,
 * exam.papers, exam.recheck, exam.analysis).
 */

const G = 'Exams';
const bool = (key: string, label: string, def: boolean, help?: string) => defineSetting<boolean>({ key, group: G, label, help, type: 'boolean', default: def, schema: z.boolean() });
const num = (key: string, label: string, def: number, min: number, max: number, help?: string) =>
    defineSetting<number>({ key, group: G, label, help, type: 'number', default: def, schema: z.number().int().min(min).max(max) });

export const EXAMS2 = {
    admitFeeHold: bool('exams.admit_fee_hold', 'Hold the admit card when fees are due', false, 'The office can still give it to a student (Admit cards → Give anyway).'),
    admitFeeLimit: num('exams.admit_fee_limit', 'Hold only when the overdue fees are more than (₹)', 0, 0, 10_000_000),
    admitInstructions: defineSetting<string>({
        key: 'exams.admit_instructions',
        group: G,
        label: 'Instructions on the admit card (one per line)',
        type: 'text',
        default: 'Reach the exam room 15 minutes before the paper starts.\nBring this admit card and your school ID card to every paper.\nMobile phones and smart watches are not allowed.\nNo one may leave in the first hour.',
        schema: z.string().trim().max(1500),
    }),
    alternateClasses: bool('exams.seat_alternate', 'Seating: seat students of different classes next to each other', true, 'Off: one class after another in each room.'),
    perInvigilator: num('exams.students_per_invigilator', 'One invigilator for every this many students in a room', 30, 5, 200),
    dutyReminder: bool('exams.duty_reminder', 'Remind teachers of their invigilation duty the day before', true),
    supplementarySubjects: num('exams.supplementary_subjects', 'Supplementary exam allowed for students who failed in up to this many subjects (0 = none)', 2, 0, 10),
    recheck: bool('exams.recheck', 'Parents may ask for a re-check of marks', true),
    recheckDays: num('exams.recheck_days', 'Re-check can be asked for within this many days of the results', 7, 1, 60),
    recheckFee: num('exams.recheck_fee', 'Re-check fee per subject (₹, 0 = free; added to the fees)', 0, 0, 10_000),
    recheckFeeHead: defineSetting<string>({ key: 'exams.recheck_fee_head', group: G, label: 'Fee head the re-check fee is charged under (its code in Masters → Fee heads)', type: 'text', default: 'RECHECK', schema: z.string().trim().min(1).max(20) }),
    aiRemarks: bool('exams.ai_remarks', 'Class teachers can ask the AI to suggest a report card remark', true),
};
