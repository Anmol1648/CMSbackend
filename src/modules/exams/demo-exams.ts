import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { classesOfYear } from '../academic/year-classes.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { createExam, ensureExamSetup, Part, ruleFor } from './setup.service';
import { takers } from './marks.service';

/**
 * Demo exams: Term 1 / Term 2, Periodic Test 1 and the Half-Yearly for every class of the session,
 * with marks that look real (each student has a level; a few absent), co-scholastic grades and
 * remarks; both published. Marked is_demo.
 */

let seed = 9_157;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const DAY = 86_400_000;
const addDays = (iso: string, n: number) => isoOf(new Date(dayDate(iso).getTime() + n * DAY));

const REMARKS = ['Keeps working hard.', 'Is regular and sincere.', 'Takes part well in class.', 'Should practise mathematics more.', 'Reads well; must improve handwriting.', 'A cheerful and helpful student.', 'Needs to complete homework on time.', 'Shows good progress this term.'];

export const createDemoExams = async () => {
    const year = await db.academicYear.findFirst({ where: { isCurrent: true } });
    if (!year) return { exams: 0, marks: 0 };
    await ensureExamSetup();
    const tenantId = getTenantId()!;
    const start = isoOf(year.startDate);
    const end = isoOf(year.endDate);
    const mid = addDays(start, 182);
    const t1 = await db.examTerm.create({ data: { tenantId, academicYearId: year.id, name: 'Term 1', startDate: dayDate(start), endDate: dayDate(mid), sortOrder: 1, isDemo: true } });
    await db.examTerm.create({ data: { tenantId, academicYearId: year.id, name: 'Term 2', startDate: dayDate(addDays(mid, 1)), endDate: dayDate(end), sortOrder: 2, isDemo: true } });
    const classIds = (await classesOfYear(year.id)).map((c) => c.id);
    if (!classIds.length) return { exams: 0, marks: 0 };
    const pt = await createExam(year.id, { name: 'Periodic Test 1', shortName: 'PT 1', termId: t1.id, classIds, components: [{ key: 'th', label: 'Written', max: 40 }], weightage: 10, countsInResult: true, entryDeadline: null });
    const hy = await createExam(year.id, { name: 'Half-Yearly', shortName: 'HY', termId: t1.id, classIds, components: [{ key: 'th', label: 'Written', max: 80 }, { key: 'ia', label: 'Internal', max: 20 }], weightage: 40, countsInResult: true, entryDeadline: null });
    await db.exam.updateMany({ where: { id: { in: [pt.id, hy.id] } }, data: { isDemo: true } });

    // Date sheets: PT in July, Half-Yearly in September (one paper a day, 9:00–12:00).
    const sheet = async (examId: string, from: string, time: [string, string]) => {
        const subjects = await db.examSubject.findMany({ where: { examId }, orderBy: [{ classId: 'asc' }, { sortOrder: 'asc' }] });
        const n = new Map<string, number>();
        for (const s of subjects) {
            const k = (n.get(s.classId) ?? 0) + 1;
            n.set(s.classId, k);
            await db.examSubject.update({ where: { id: s.id }, data: { date: dayDate(addDays(from, k + Math.floor(k / 6))), startTime: time[0], endTime: time[1] } });
        }
    };
    await sheet(pt.id, addDays(start, 95), ['09:00', '10:30']);
    await sheet(hy.id, addDays(start, 160), ['09:00', '12:00']);

    // Each student has a level; marks scatter around it.
    const level = new Map<string, number>();
    const lv = (id: string) => {
        if (!level.has(id)) level.set(id, clamp(0.35 + rand() * 0.55 + (rand() - 0.5) * 0.1, 0.2, 0.97));
        return level.get(id)!;
    };
    const sections = await db.section.findMany({ where: { academicYearId: year.id, classId: { in: classIds }, isActive: true }, select: { id: true, classId: true } });
    const tenant = { tenantId };
    let count = 0;
    for (const exam of [pt, hy]) {
        const subjects = await db.examSubject.findMany({ where: { examId: exam.id } });
        const rows = [];
        for (const sec of sections) {
            const rule = await ruleFor(sec.classId);
            for (const sub of subjects.filter((s) => s.classId === sec.classId)) {
                const students = await takers(year.id, sec.id, sub.subjectId);
                const parts = sub.components as Part[];
                for (const st of students) {
                    const id = st.student.id;
                    if (rand() < 0.02) {
                        rows.push({ ...tenant, examSubjectId: sub.id, studentId: id, status: 'AB', marks: {}, total: null });
                        continue;
                    }
                    if (rule.descriptive) {
                        const grades = rule.scale.bands.map((b) => b.grade);
                        const idx = clamp(Math.floor((1 - lv(id)) * grades.length + (rand() - 0.5)), 0, grades.length - 1);
                        rows.push({ ...tenant, examSubjectId: sub.id, studentId: id, status: 'P', marks: { grade: grades[idx] }, total: null });
                        continue;
                    }
                    const marks: Record<string, number> = {};
                    let total = 0;
                    for (const p of parts) {
                        // Internal marks run higher than written ones.
                        const base = p.key === 'ia' ? clamp(lv(id) + 0.15, 0, 1) : lv(id);
                        const v = Math.round(clamp(base + (rand() - 0.5) * 0.25, 0.05, 1) * p.max * 2) / 2;
                        marks[p.key] = v;
                        total += v;
                    }
                    rows.push({ ...tenant, examSubjectId: sub.id, studentId: id, status: 'P', marks, total });
                }
            }
        }
        for (let i = 0; i < rows.length; i += 2000) await db.examMark.createMany({ data: rows.slice(i, i + 2000), skipDuplicates: true });
        count += rows.length;
    }
    // Co-scholastic grades, discipline and a remark on the Half-Yearly.
    const notes = [];
    for (const sec of sections) {
        const co = await db.classSubject.findMany({ where: { academicYearId: year.id, classId: sec.classId, subject: { assessment: 'co_scholastic' } }, select: { subjectId: true } });
        const enrol = await db.enrolment.findMany({ where: { academicYearId: year.id, sectionId: sec.id, student: { status: 'active' } }, select: { studentId: true } });
        for (const e of enrol) {
            const pick = () => (lv(e.studentId) > 0.7 ? 'A' : lv(e.studentId) > 0.45 ? (rand() < 0.5 ? 'A' : 'B') : rand() < 0.5 ? 'B' : 'C');
            notes.push({ ...tenant, examId: hy.id, studentId: e.studentId, coGrades: Object.fromEntries(co.map((c) => [c.subjectId, pick()])), discipline: pick(), remark: REMARKS[Math.floor(rand() * REMARKS.length)] });
        }
    }
    if (notes.length) await db.examStudentNote.createMany({ data: notes, skipDuplicates: true });
    // Both published (the Half-Yearly only once its dates have passed).
    const hyDone = addDays(start, 175) <= todayIST();
    await db.exam.update({ where: { id: pt.id }, data: { status: 'published', publishedAt: new Date() } });
    await db.exam.update({ where: { id: hy.id }, data: { status: hyDone ? 'published' : 'locked', publishedAt: hyDone ? new Date() : null } });
    return { exams: 2, marks: count };
};

export const clearDemoExams = async () => {
    const exams = await db.exam.findMany({ where: { isDemo: true }, select: { id: true } });
    await db.exam.deleteMany({ where: { id: { in: exams.map((e) => e.id) } } });
    await db.examTerm.deleteMany({ where: { isDemo: true } });
    return exams.length;
};
