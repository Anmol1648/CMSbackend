import { Prisma } from '@prisma/client';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { currentYear } from '../academic/years.service';
import { takers } from '../exams/marks.service';
import { submitAttempt } from './tests.service';

/**
 * Demo online tests for Class VII-B, from the demo question bank: a Science test taken last week
 * (marked, results out), a Mathematics test open now (for the demo student to take) and one coming
 * next week. Students are not alerted. Marked is_demo.
 */

let seed = 6_271;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const DAY = 86_400_000;
const at = (days: number, hour: number) => new Date(Date.now() - (Date.now() % DAY) + days * DAY + (hour - 5.5) * 3_600_000);

export const createDemoTests = async () => {
    const tenantId = getTenantId()!;
    const year = await currentYear();
    if (!year || (await db.onlineTest.count({ where: { isDemo: true } }))) return { tests: 0, attempts: 0 };
    const section = await db.section.findFirst({ where: { academicYearId: year.id, name: 'B', schoolClass: { name: 'Class VII' } }, select: { id: true, classId: true, classTeacher: { select: { id: true, userId: true } } } });
    const subjects = await db.subject.findMany({ where: { name: { in: ['Science', 'Mathematics'] } }, select: { id: true, name: true } });
    if (!section || subjects.length < 2) return { tests: 0, attempts: 0 };
    const subj = (n: string) => subjects.find((s) => s.name === n)!.id;
    const teacher = async (subjectId: string) => (await db.teachingAssignment.findFirst({ where: { sectionId: section.id, subjectId }, select: { staff: { select: { id: true, userId: true } } } }))?.staff ?? section.classTeacher;

    const make = async (o: { subject: string; title: string; starts: Date; ends: Date; minutes: number; pick: { type: string; n: number }[]; status: string }) => {
        const subjectId = subj(o.subject);
        const by = await teacher(subjectId);
        const t = await db.onlineTest.create({
            data: { tenantId, academicYearId: year.id, classId: section.classId, subjectId, sectionIds: [section.id], title: o.title, instructions: 'Read every question carefully. You can change an answer until you submit. The test is submitted by itself when time is up.', durationMin: o.minutes, startsAt: o.starts, endsAt: o.ends, shuffleQuestions: true, shuffleOptions: true, showResult: 'after_review', status: o.status, alertedAt: new Date(), staffId: by?.id ?? null, createdBy: by?.userId ?? null, isDemo: true, ...(o.status === 'results' ? { resultsAt: o.ends } : {}) },
        });
        let order = 1;
        let total = 0;
        for (const p of o.pick) {
            const qs = await db.question.findMany({ where: { classId: section.classId, subjectId, status: 'approved', type: p.type }, take: p.n, orderBy: { createdAt: 'asc' } });
            for (const q of qs) {
                await db.onlineTestQuestion.create({ data: { tenantId, testId: t.id, questionId: q.id, sortOrder: order++, marks: q.marks, snapshot: { type: q.type, text: q.text, options: q.options, answer: q.answer, explanation: q.explanation, imageFileId: q.imageFileId, chapterId: q.chapterId } as Prisma.InputJsonValue } });
                total += q.marks;
            }
        }
        await db.onlineTest.update({ where: { id: t.id }, data: { totalMarks: total } });
        return { t, by };
    };

    const science = await make({ subject: 'Science', title: 'Science test: Nutrition, Heat and Acids', starts: at(-6, 10), ends: at(-6, 18), minutes: 30, pick: [{ type: 'mcq', n: 8 }, { type: 'true_false', n: 3 }, { type: 'fill', n: 3 }, { type: 'short', n: 2 }], status: 'results' });
    await make({ subject: 'Mathematics', title: 'Maths practice test: Integers and Equations', starts: at(-1, 8), ends: at(6, 20), minutes: 25, pick: [{ type: 'mcq', n: 10 }, { type: 'true_false', n: 2 }, { type: 'fill', n: 2 }], status: 'published' });
    await make({ subject: 'Science', title: 'Science unit test: Respiration and Motion', starts: at(7, 10), ends: at(7, 16), minutes: 40, pick: [{ type: 'mcq', n: 5 }, { type: 'short', n: 1 }], status: 'published' });

    // Last week's test: every student took it (all but two), answers mostly right, written ones marked.
    const qs = await db.onlineTestQuestion.findMany({ where: { testId: science.t.id }, orderBy: { sortOrder: 'asc' } });
    const students = await takers(year.id, section.id, science.t.subjectId);
    let attempts = 0;
    for (const [i, s] of students.entries()) {
        if (i === 3 || i === 9) continue; // absent
        const skill = 0.45 + rand() * 0.5;
        const answers: Record<string, unknown> = {};
        for (const q of qs) {
            const snap = q.snapshot as { type: string; options: { correct: boolean }[]; answer: string | null };
            const right = rand() < skill;
            if (snap.type === 'mcq') {
                const ok = snap.options.findIndex((o) => o.correct);
                answers[q.id] = right ? ok : (ok + 1 + Math.floor(rand() * 3)) % snap.options.length;
            } else if (snap.type === 'true_false') answers[q.id] = right ? snap.answer : snap.answer === 'true' ? 'false' : 'true';
            else if (snap.type === 'fill') answers[q.id] = right ? (snap.answer ?? '').split('|')[0] : 'not sure';
            else answers[q.id] = right ? 'Leaves make food by photosynthesis using sunlight, water and carbon dioxide.' : 'I don’t remember.';
        }
        const a = await db.testAttempt.create({ data: { tenantId, testId: science.t.id, studentId: s.student.id, startedAt: at(-6, 11), dueAt: at(-6, 11.5), answers: answers as Prisma.InputJsonValue, layout: { questions: qs.map((q) => q.id) }, isDemo: true } });
        const marked = await submitAttempt(a.id);
        // The teacher's marks for the written answers.
        const marks = { ...((marked?.marks ?? {}) as Record<string, { marks: number | null; by: string; note?: string | null }>) };
        for (const q of qs) if (marks[q.id]?.marks === null) marks[q.id] = { marks: String(answers[q.id]).startsWith('Leaves') ? q.marks : 0, by: 'teacher', note: String(answers[q.id]).startsWith('Leaves') ? 'Good' : 'Revise this chapter' };
        const score = Math.round(Object.values(marks).reduce((x, m) => x + (m.marks ?? 0), 0) * 100) / 100;
        await db.testAttempt.update({ where: { id: a.id }, data: { submittedAt: at(-6, 11.4), marks: marks as Prisma.InputJsonValue, score, status: 'marked', markedAt: at(-5, 9), markedBy: science.by?.userId ?? null } });
        attempts++;
    }
    return { tests: 3, attempts };
};

export const clearDemoTests = async () => {
    await db.onlineTest.deleteMany({ where: { isDemo: true } });
};
