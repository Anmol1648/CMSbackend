import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { classesOfYear } from '../academic/year-classes.service';
import { createExam } from './setup.service';
import { makeSeating, rooms } from './hall.service';
import { autoFill, savePaper } from './papers.service';
import { saveHealth } from './entry2.service';
import { createSupplementary, supplementaryCandidates } from './after.service';

/**
 * Demo for Exams v2: CBSE report card design for the school; remark bank bands; an upcoming
 * Periodic Test 2 with its date sheet, seating plan and invigilation duties for the first two papers;
 * a VII Science question paper from the question bank; health and activities of VII-B; a
 * supplementary exam for a few VII-B students (one already passed); a re-check request from
 * Shubham Nautiyal's parent waiting. Marked is_demo where the tables allow.
 */

let seed = 7_373;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const DAY = 86_400_000;
const addDays = (iso: string, n: number) => isoOf(new Date(dayDate(iso).getTime() + n * DAY));

const BANDS: Record<string, string> = {
    'Keeps working hard.': 'high',
    'Shows good progress this term.': 'high',
    'A cheerful and helpful student.': 'high',
    'Is regular and sincere.': 'mid',
    'Takes part well in class.': 'mid',
    'Should practise mathematics more.': 'low',
    'Needs to complete homework on time.': 'low',
    'Can do better with more effort.': 'low',
    'Reads well; must improve handwriting.': 'mid',
};

export const createDemoExams2 = async () => {
    const tenantId = getTenantId()!;
    const year = await db.academicYear.findFirst({ where: { isCurrent: true } });
    if (!year || (await db.exam.count({ where: { isDemo: true, name: 'Periodic Test 2' } }))) return { exam: null as string | null, seats: 0 };
    const office = await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: 'office-staff' } } } }, select: { id: true } });
    const by = office?.id ?? (await db.user.findFirst({ select: { id: true } }))!.id;

    // The school is CBSE: term-wise report cards (pre-primary rule keeps its own design).
    await db.resultRule.updateMany({ where: { descriptive: false }, data: { cardFormat: 'cbse' } });
    await db.resultRule.updateMany({ where: { descriptive: true }, data: { cardFormat: 'preprimary' } });
    for (const [name, band] of Object.entries(BANDS)) await db.masterValue.updateMany({ where: { master: 'report_remark', name }, data: { extra: { band } } });
    if (!(await db.masterValue.findFirst({ where: { master: 'fee_head', code: 'RECHECK' } }))) await db.masterValue.create({ data: { tenantId, master: 'fee_head', name: 'Re-check fee', code: 'RECHECK', sortOrder: 99, extra: { one_time: true, refundable: false } } });

    // Periodic Test 2 (Term 2), starting a week from today: one paper a day, 9:00–10:30, no Sundays.
    const term2 = await db.examTerm.findFirst({ where: { academicYearId: year.id, name: 'Term 2' }, select: { id: true } });
    const classIds = (await classesOfYear(year.id)).map((c) => c.id);
    const pt2 = await createExam(year.id, { name: 'Periodic Test 2', shortName: 'PT 2', termId: term2?.id ?? null, classIds, components: [{ key: 'th', label: 'Written', max: 40 }], weightage: 10, countsInResult: true, entryDeadline: null });
    await db.exam.update({ where: { id: pt2.id }, data: { isDemo: true, status: 'open' } });
    const subs = await db.examSubject.findMany({ where: { examId: pt2.id }, orderBy: [{ classId: 'asc' }, { sortOrder: 'asc' }] });
    const dayOf = (k: number) => {
        let d = addDays(todayIST(), 7);
        let n = 0;
        while (true) {
            if (dayDate(d).getUTCDay() !== 0) {
                if (n === k) return d;
                n++;
            }
            d = addDays(d, 1);
        }
    };
    const perClass = new Map<string, number>();
    for (const s of subs) {
        const k = perClass.get(s.classId) ?? 0;
        perClass.set(s.classId, k + 1);
        await db.examSubject.update({ where: { id: s.id }, data: { date: dayDate(dayOf(k)), startTime: '09:00', endTime: '10:30' } });
    }

    // Seating and duties for the first two papers, in the classrooms and labs.
    const all = await rooms();
    const roomIds = all.filter((r) => /^Room |Lab|Hall/.test(r.name)).map((r) => r.id);
    let seats = 0;
    if (roomIds.length)
        for (const k of [0, 1]) {
            try {
                const s = await makeSeating(pt2.id, { date: dayOf(k), startTime: '09:00', roomIds, duties: true }, by, { isDemo: true });
                seats += s.rooms.reduce((a, r) => a + r.seats.length, 0);
            } catch {
                // Not enough seats in the demo rooms: leave it for the user to try.
            }
        }

    const principal = await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: { in: ['principal', 'school-admin'] } } } } }, select: { id: true } });
    await demoPaper(pt2.id, principal?.id ?? by).catch(() => false);

    // Health and activities of VII-B (Term 1).
    const deepak = await db.staff.findFirst({ where: { user: { username: 'deepak.rautela' } }, select: { id: true, userId: true } });
    const viib = deepak ? await db.section.findFirst({ where: { academicYearId: year.id, classTeacherId: deepak.id }, select: { id: true } }) : null;
    const term1 = await db.examTerm.findFirst({ where: { academicYearId: year.id, name: 'Term 1' }, select: { id: true } });
    if (viib && term1) {
        const kids = await db.enrolment.findMany({ where: { sectionId: viib.id, student: { status: 'active' } }, select: { studentId: true } });
        const acts = ['Football, drawing', 'Music (tabla)', 'Debate club', 'Cricket', 'Dance', 'Science club', 'Yoga', 'Chess, quiz'];
        await saveHealth(viib.id, { termKey: term1.id, rows: kids.map((k) => ({ studentId: k.studentId, heightCm: Math.round(130 + rand() * 25), weightKg: Math.round(28 + rand() * 18), vision: rand() < 0.85 ? '6/6' : '6/9', activities: acts[Math.floor(rand() * acts.length)] })) }, deepak?.userId ?? by, { isDemo: true });
    }

    // Supplementary: up to 3 students of VII-B who fail 1–2 subjects of the result so far; one has passed it.
    if (viib) {
        const c = await supplementaryCandidates(year.id).catch(() => null);
        const sec = c?.sections.find((x) => x.sectionId === viib.id) ?? c?.sections[0];
        const list = sec?.students.slice(0, 3) ?? [];
        if (list.length) {
            const r = await createSupplementary(year.id, { name: 'Supplementary Exam 2026', candidates: Object.fromEntries(list.map((s) => [s.studentId, s.subjects.map((x) => x.subjectId)])) }, by, { isDemo: true });
            const first = list[0];
            const ses = await db.examSubject.findMany({ where: { examId: r.id, subjectId: { in: first.subjects.map((x) => x.subjectId) } } });
            for (const es of ses) {
                const parts = es.components as { key: string; max: number }[];
                const marks = Object.fromEntries(parts.map((p) => [p.key, Math.round(p.max * 0.55)]));
                await db.examMark.create({ data: { tenantId, examSubjectId: es.id, studentId: first.studentId, status: 'P', marks, total: Object.values(marks).reduce((a, b) => a + b, 0), enteredBy: by } });
            }
        }
    }

    await demoRecheck(year.id);
    return { exam: pt2.name, seats };
};

/** A question paper for the class + subject of the exam with the most approved bank questions. */
export const demoPaper = async (examId: string, by: string) => {
    const subs = await db.examSubject.findMany({ where: { examId }, select: { classId: true, subjectId: true } });
    const counts = await db.question.groupBy({ by: ['classId', 'subjectId'], where: { status: 'approved' }, _count: { _all: true } });
    const best = counts.filter((c) => subs.some((s) => s.classId === c.classId && s.subjectId === c.subjectId)).sort((x, y) => y._count._all - x._count._all)[0];
    if (!best) return false;
    const types = await db.question.groupBy({ by: ['type'], where: { classId: best.classId, subjectId: best.subjectId, status: 'approved' }, _count: { _all: true } });
    const marksOf = (t: string) => (['mcq', 'multi', 'true_false', 'fill'].includes(t) ? 1 : t === 'short' ? 3 : 5);
    const plan = types.slice(0, 4).map((t, i) => ({ section: String.fromCharCode(65 + i), type: t.type, marks: marksOf(t.type), count: Math.min(t._count._all, marksOf(t.type) === 1 ? 6 : 3) }));
    const f = await autoFill(examId, best.classId, best.subjectId, { chapterIds: [], plan }, by);
    const [cls, sub] = await Promise.all([db.schoolClass.findUnique({ where: { id: best.classId }, select: { name: true } }), db.subject.findUnique({ where: { id: best.subjectId }, select: { name: true } })]);
    await savePaper(examId, best.classId, best.subjectId, { title: `Periodic Test 2: ${sub?.name ?? ''} (${cls?.name ?? ''})`, instructions: 'All questions are compulsory.\nSection A: one mark each.\nDraw diagrams where needed.', durationMins: 90, lines: f.lines, fileId: null, status: 'final' }, by, { isDemo: true });
    return true;
};

/** A re-check request from Shubham Nautiyal's parent for a published exam with his marks (window kept open). */
export const demoRecheck = async (yearId: string) => {
    const tenantId = getTenantId()!;
    const shubham = await db.student.findFirst({ where: { OR: [{ admissionNo: '2025/0235' }, { user: { username: '20250235' } }] }, select: { id: true, family: { select: { guardians: { where: { userId: { not: null } }, select: { userId: true } } } } } });
    if (!shubham) return false;
    const exams = await db.exam.findMany({ where: { academicYearId: yearId, status: 'published', kind: 'regular' }, orderBy: { sortOrder: 'desc' } });
    const maths = await db.subject.findMany({ where: { name: { startsWith: 'Math' } }, select: { id: true } });
    for (const ex of exams) {
        const marks = await db.examMark.findMany({ where: { studentId: shubham.id, status: 'P', examSubject: { examId: ex.id } }, include: { examSubject: true } });
        const m = marks.find((x) => maths.some((y) => y.id === x.examSubject.subjectId)) ?? marks[0];
        if (!m) continue;
        if (!(await db.examRecheck.findFirst({ where: { examSubjectId: m.examSubjectId, studentId: shubham.id } })))
            await db.examRecheck.create({ data: { tenantId, academicYearId: yearId, examId: ex.id, examSubjectId: m.examSubjectId, studentId: shubham.id, requestedBy: shubham.family?.guardians[0]?.userId ?? null, reason: 'He expected more marks; please check the long answers.', oldMarks: m.marks as object, oldTotal: m.total, isDemo: true } });
        if (!ex.publishedAt || ex.publishedAt.getTime() < Date.now() - 5 * DAY) await db.exam.update({ where: { id: ex.id }, data: { publishedAt: new Date(Date.now() - 2 * DAY) } });
        return true;
    }
    return false;
};

export const clearDemoExams2 = async () => {
    await db.examRecheck.deleteMany({ where: { isDemo: true } });
    await db.studentHealth.deleteMany({ where: { isDemo: true } });
    await db.examPaper.deleteMany({ where: { isDemo: true } });
    await db.examSeat.deleteMany({ where: { isDemo: true } });
    await db.examDuty.deleteMany({ where: { isDemo: true } });
};
