import { Prisma } from '@prisma/client';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { currentYear } from '../academic/years.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { ensureForms, teachersBySection } from './feedback.service';
import { Question } from './feedback.settings';

/**
 * Demo teacher feedback: a student round held last month for Classes VI–XII (anonymous, results
 * released, comments screened, a few hidden), and two rounds open now (students; parents) that
 * Shubham Nautiyal and Mahesh Nautiyal can fill. Marked is_demo.
 */

let seed = 1_234;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = <T>(l: readonly T[]) => l[Math.floor(rand() * l.length)];
const DAY = 86_400_000;
const GOOD = ['Explains very well with examples.', 'Very helpful and patient.', 'Best teacher, makes the class interesting.', 'Always ready to clear doubts.'];
const WORK = ['Speaks too fast sometimes.', 'Please give more time for practice questions.', 'Homework is a bit too much on weekends.', 'Could check notebooks more often.'];
const RUDE = ['Boring class.', 'Does not like some students.'];

export const createDemoFeedback = async () => {
    const tenantId = getTenantId()!;
    const year = await currentYear();
    if (!year || (await db.feedbackRound.count({ where: { isDemo: true } }))) return { rounds: 0, responses: 0 };
    await ensureForms();
    const forms = await db.feedbackForm.findMany();
    const studentForm = forms.find((f) => f.audience === 'student')!;
    const parentForm = forms.find((f) => f.audience === 'parent')!;
    const sections = await db.section.findMany({ where: { academicYearId: year.id, schoolClass: { shortName: { in: ['VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'] } } }, select: { id: true } });
    const sectionIds = sections.map((s) => s.id);
    const today = todayIST();
    const at = (n: number) => dayDate(isoOf(new Date(dayDate(today).getTime() + n * DAY)));

    // 1. Held last month: students, anonymous, released.
    const past = await db.feedbackRound.create({ data: { tenantId, academicYearId: year.id, formId: studentForm.id, name: 'Student feedback on teachers: Term 1', audience: 'student', sectionIds, anonymous: true, opensOn: at(-40), closesOn: at(-30), status: 'released', releasedAt: new Date(Date.now() - 25 * DAY), isDemo: true } });
    const teachers = await teachersBySection(year.id, sectionIds);
    const base = new Map<string, number>();
    const questions = studentForm.questions as unknown as Question[];
    const enrol = await db.enrolment.findMany({ where: { academicYearId: year.id, sectionId: { in: sectionIds }, student: { status: 'active', userId: { not: null } } }, select: { sectionId: true, student: { select: { id: true, userId: true } } } });
    const rows: Prisma.FeedbackResponseCreateManyInput[] = [];
    const done: Prisma.FeedbackCompletionCreateManyInput[] = [];
    for (const e of enrol) {
        if (rand() < 0.25) continue;
        for (const t of teachers.get(e.sectionId) ?? []) {
            if (rand() < 0.2) continue;
            if (!base.has(t.staffId)) base.set(t.staffId, 3 + rand() * 1.8);
            const b = base.get(t.staffId)!;
            const answers: Record<string, number | boolean | string> = {};
            for (const q of questions) {
                if (q.kind === 'rating') answers[q.id] = Math.max(1, Math.min(5, Math.round(b + (rand() - 0.5) * 2)));
                else if (q.kind === 'yesno') answers[q.id] = rand() < 0.8;
                else if (rand() < 0.15) answers[q.id] = b > 4 ? pick(GOOD) : rand() < 0.15 ? pick(RUDE) : pick([...GOOD, ...WORK]);
            }
            const text = questions.some((q) => q.kind === 'text' && answers[q.id]);
            const rude = text && RUDE.includes(String(answers[questions.find((q) => q.kind === 'text')!.id]));
            rows.push({ tenantId, roundId: past.id, staffId: t.staffId, sectionId: e.sectionId, respondentKind: 'student', answers, commentStatus: !text ? 'shown' : rude ? 'hidden' : 'shown', createdAt: new Date(Date.now() - (30 + rand() * 9) * DAY), isDemo: true });
            done.push({ tenantId, roundId: past.id, userId: e.student.userId!, studentId: e.student.id, staffId: t.staffId, isDemo: true });
        }
    }
    await db.feedbackResponse.createMany({ data: rows });
    await db.feedbackCompletion.createMany({ data: done, skipDuplicates: true });

    // 2. Open now: students, and parents (Shubham and Mahesh haven’t filled yet).
    const open1 = await db.feedbackRound.create({ data: { tenantId, academicYearId: year.id, formId: studentForm.id, name: 'Student feedback on teachers: Term 2', audience: 'student', sectionIds, anonymous: true, opensOn: at(-2), closesOn: at(8), status: 'open', isDemo: true } });
    await db.feedbackRound.create({ data: { tenantId, academicYearId: year.id, formId: parentForm.id, name: 'Parent feedback on teachers: Term 2', audience: 'parent', sectionIds, anonymous: true, opensOn: at(-2), closesOn: at(8), status: 'open', isDemo: true } });
    // A few students already filled the open student round.
    const shubham = await db.student.findFirst({ where: { OR: [{ admissionNo: '2025/0235' }, { user: { username: '20250235' } }] }, select: { id: true } });
    const some: Prisma.FeedbackResponseCreateManyInput[] = [];
    const someDone: Prisma.FeedbackCompletionCreateManyInput[] = [];
    for (const e of enrol.filter((x) => x.student.id !== shubham?.id).slice(0, 60)) {
        const t = pick(teachers.get(e.sectionId) ?? []);
        if (!t) continue;
        const answers: Record<string, number | boolean> = {};
        for (const q of questions) if (q.kind === 'rating') answers[q.id] = Math.max(1, Math.min(5, Math.round((base.get(t.staffId) ?? 4) + (rand() - 0.5) * 2)));
        some.push({ tenantId, roundId: open1.id, staffId: t.staffId, sectionId: e.sectionId, respondentKind: 'student', answers, isDemo: true });
        someDone.push({ tenantId, roundId: open1.id, userId: e.student.userId!, studentId: e.student.id, staffId: t.staffId, isDemo: true });
    }
    await db.feedbackResponse.createMany({ data: some });
    await db.feedbackCompletion.createMany({ data: someDone, skipDuplicates: true });
    return { rounds: 3, responses: rows.length + some.length };
};

export const clearDemoFeedback = async () => {
    await db.feedbackRound.deleteMany({ where: { isDemo: true } });
};
