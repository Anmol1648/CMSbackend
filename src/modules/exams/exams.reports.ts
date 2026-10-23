import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { sectionLabel } from '../timetable/tt-setup.service';
import { defineReport, registerReportCategory } from '../reports/reports.registry';
import { defineDataSource } from '../reports/datasources.registry';
import { defineWidget } from '../dashboard/dashboard.registry';
import { currentYear } from '../academic/years.service';
import { analyse, computeResults, limitIn, limitResults, sectionLimits, seesInFull } from './results.service';
import { progress } from './marks.service';
import { myResults } from './results.service';

/** Exam reports (Report Center), the marks data source (Report Builder) and dashboard widgets. */

registerReportCategory('Exams', 35);

/**
 * The sections of an exam the person may see (one class, or all). `inFull`: only those they see in
 * full (overall results, toppers); otherwise subject teachers get their sections, `limit`ed to their subjects.
 */
const sectionsOf = async (examId: string, userId: string, classId?: string, inFull = false) => {
    const e = await db.exam.findFirst({ where: { id: examId } });
    if (!e) throw badRequest('Choose an exam');
    const limits = await sectionLimits(userId, e.academicYearId);
    const ids = limits === 'all' ? null : [...limits.keys()].filter((id) => !inFull || seesInFull(limits, id));
    const sections = await db.section.findMany({
        where: { academicYearId: e.academicYearId, classId: classId ? classId : { in: e.classIds }, isActive: true, ...(ids ? { id: { in: ids } } : {}) },
        select: { id: true, name: true, sortOrder: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } },
        orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
    });
    return { exam: e, sections, limit: (sectionId: string) => limitIn(limits, sectionId) };
};

defineReport({
    key: 'exam_result_list',
    category: 'Exams',
    label: 'Exam result (class-wise)',
    description: 'Each student’s total, %, grade, rank and result in an exam, section by section, with the subjects not passed.',
    permissions: ['exam.view', 'exam.publish'],
    orientation: 'landscape',
    filters: [
        { key: 'year', label: 'Session', type: 'year', required: true, default: 'current' },
        { key: 'exam', label: 'Exam', type: 'exam', required: true },
        { key: 'class', label: 'Class', type: 'class' },
    ],
    columns: [
        { key: 'roll', label: 'Roll', type: 'number', width: 0.5 },
        { key: 'student', label: 'Student', type: 'text', width: 1.8 },
        { key: 'admissionNo', label: 'Adm. no.', type: 'text', width: 0.9 },
        { key: 'total', label: 'Total', type: 'text', width: 0.9 },
        { key: 'percent', label: '%', type: 'number', width: 0.6 },
        { key: 'grade', label: 'Grade', type: 'text', width: 0.6 },
        { key: 'rank', label: 'Rank', type: 'number', width: 0.5 },
        { key: 'result', label: 'Result', type: 'text', width: 1 },
        { key: 'failed', label: 'Not passed in', type: 'text', width: 1.6 },
    ],
    async run(f, ctx) {
        const { exam, sections } = await sectionsOf(f.exam, ctx.userId, f.class, true);
        const rows = [];
        for (const s of sections) {
            const r = await computeResults('exam', exam.id, s.id);
            for (const st of r.students)
                rows.push({
                    groupKey: `${String(s.schoolClass.sortOrder).padStart(4, '0')}${String(s.sortOrder).padStart(3, '0')}`,
                    groupLabel: sectionLabel(s),
                    roll: st.student.roll,
                    student: st.student.name,
                    admissionNo: st.student.admissionNo,
                    total: st.totalMax ? `${st.totalObtained} / ${st.totalMax}` : null,
                    percent: st.percent,
                    grade: st.grade,
                    rank: st.rank,
                    result: st.result,
                    failed: st.failedSubjects.join(', ') || null,
                });
        }
        return { rows, subtitle: exam.name, groupedBy: 'Section' };
    },
});

defineReport({
    key: 'exam_subject_analysis',
    category: 'Exams',
    label: 'Subject-wise analysis',
    description: 'For each section and subject of an exam: students, average %, highest, lowest and pass %, with the subject teacher.',
    permissions: ['exam.view', 'exam.publish'],
    orientation: 'landscape',
    filters: [
        { key: 'year', label: 'Session', type: 'year', required: true, default: 'current' },
        { key: 'exam', label: 'Exam', type: 'exam', required: true },
        { key: 'class', label: 'Class', type: 'class' },
    ],
    columns: [
        { key: 'subject', label: 'Subject', type: 'text', width: 1.4 },
        { key: 'teacher', label: 'Teacher', type: 'text', width: 1.4 },
        { key: 'students', label: 'Students', type: 'number', width: 0.7 },
        { key: 'average', label: 'Average %', type: 'number', width: 0.8 },
        { key: 'highest', label: 'Highest %', type: 'number', width: 0.8 },
        { key: 'lowest', label: 'Lowest %', type: 'number', width: 0.8 },
        { key: 'pass', label: 'Pass %', type: 'number', width: 0.7 },
    ],
    async run(f, ctx) {
        const { exam, sections, limit } = await sectionsOf(f.exam, ctx.userId, f.class);
        const teachers = await db.teachingAssignment.findMany({ where: { sectionId: { in: sections.map((s) => s.id) } }, select: { sectionId: true, subject: { select: { name: true } }, staff: { select: { firstName: true, lastName: true } } } });
        const rows = [];
        for (const s of sections) {
            const a = analyse(limitResults(await computeResults('exam', exam.id, s.id), limit(s.id)));
            for (const sub of a.subjects) {
                const t = teachers.find((x) => x.sectionId === s.id && x.subject.name === sub.subject);
                rows.push({ groupKey: `${String(s.schoolClass.sortOrder).padStart(4, '0')}${String(s.sortOrder).padStart(3, '0')}`, groupLabel: sectionLabel(s), subject: sub.subject, teacher: t ? [t.staff.firstName, t.staff.lastName].filter(Boolean).join(' ') : null, students: sub.students, average: sub.average, highest: sub.highest, lowest: sub.lowest, pass: sub.passPercent });
            }
        }
        return { rows, subtitle: exam.name, groupedBy: 'Section' };
    },
});

defineReport({
    key: 'exam_toppers',
    category: 'Exams',
    label: 'Toppers',
    description: 'The top students of each class in an exam (by overall %).',
    permissions: ['exam.view', 'exam.publish'],
    orientation: 'portrait',
    filters: [
        { key: 'year', label: 'Session', type: 'year', required: true, default: 'current' },
        { key: 'exam', label: 'Exam', type: 'exam', required: true },
        { key: 'top', label: 'How many per class', type: 'select', default: '3', options: [{ value: '3', label: 'Top 3' }, { value: '5', label: 'Top 5' }, { value: '10', label: 'Top 10' }] },
    ],
    columns: [
        { key: 'position', label: 'Position', type: 'number', width: 0.6 },
        { key: 'student', label: 'Student', type: 'text', width: 2 },
        { key: 'section', label: 'Section', type: 'text', width: 0.8 },
        { key: 'percent', label: '%', type: 'number', width: 0.6 },
        { key: 'grade', label: 'Grade', type: 'text', width: 0.6 },
    ],
    async run(f, ctx) {
        const { exam, sections } = await sectionsOf(f.exam, ctx.userId, undefined, true);
        const byClass = new Map<string, { label: string; order: number; list: { student: string; section: string; percent: number; grade: string | null }[] }>();
        for (const s of sections) {
            const r = await computeResults('exam', exam.id, s.id);
            const g = byClass.get(s.schoolClass.name) ?? { label: s.schoolClass.name, order: s.schoolClass.sortOrder, list: [] };
            for (const st of r.students) if (st.percent != null) g.list.push({ student: st.student.name, section: sectionLabel(s), percent: st.percent, grade: st.grade });
            byClass.set(s.schoolClass.name, g);
        }
        const n = Number(f.top) || 3;
        const rows = [...byClass.values()]
            .sort((a, b) => a.order - b.order)
            .flatMap((g) =>
                g.list
                    .sort((a, b) => b.percent - a.percent)
                    .slice(0, n)
                    .map((x, i) => ({ groupKey: String(g.order).padStart(4, '0'), groupLabel: g.label, position: i + 1, ...x }))
            );
        return { rows, subtitle: exam.name, groupedBy: 'Class' };
    },
});

defineDataSource({
    key: 'exam_marks',
    label: 'Exam marks',
    description: 'Every mark of an exam: student, section, subject, marks of each part, total, %, grade.',
    category: 'Exams',
    permissions: ['exam.view', 'exam.publish'],
    params: [
        { key: 'year', label: 'Session', type: 'year', required: true, default: 'current' },
        { key: 'exam', label: 'Exam', type: 'exam', required: true },
    ],
    fields: [
        { key: 'student', label: 'Student', type: 'text' },
        { key: 'admissionNo', label: 'Admission no.', type: 'text' },
        { key: 'roll', label: 'Roll no.', type: 'number' },
        { key: 'section', label: 'Section', type: 'text' },
        { key: 'className', label: 'Class', type: 'text' },
        { key: 'subject', label: 'Subject', type: 'text', group: 'Marks' },
        { key: 'status', label: 'Present / absent', type: 'text', group: 'Marks' },
        { key: 'marks', label: 'Marks', type: 'number', group: 'Marks' },
        { key: 'max', label: 'Out of', type: 'number', group: 'Marks' },
        { key: 'percent', label: '%', type: 'number', group: 'Marks' },
        { key: 'grade', label: 'Grade', type: 'text', group: 'Marks' },
        { key: 'passed', label: 'Passed', type: 'boolean', group: 'Marks' },
    ],
    async load(p, ctx) {
        const { exam, sections, limit } = await sectionsOf(p.exam, ctx.userId);
        const rows: Record<string, unknown>[] = [];
        for (const s of sections) {
            const r = limitResults(await computeResults('exam', exam.id, s.id), limit(s.id));
            for (const st of r.students)
                for (const sub of st.subjects) {
                    const x = sub.exams[0];
                    if (!x) continue;
                    rows.push({ student: st.student.name, admissionNo: st.student.admissionNo, roll: st.student.roll, section: r.section.label, className: r.section.className, subject: sub.subject, status: x.status === 'none' ? 'Not entered' : x.status === 'P' ? 'Present' : x.status, marks: x.obtained, max: x.max, percent: sub.percent, grade: sub.grade, passed: sub.passed });
                }
        }
        return rows;
    },
});

// ─── Dashboard widgets ───────────────────────────────────────────────────────

defineWidget({
    key: 'exam_entry_progress',
    label: 'Marks entry',
    description: 'How far marks entry is for the exam open for entry: sheets complete, and the ones not started.',
    category: 'Today',
    type: 'stat',
    size: 'sm',
    href: '/exams',
    permissions: ['exam.setup', 'exam.marks_any', 'exam.publish'],
    cacheSeconds: 300,
    async load() {
        const year = await currentYear();
        const e = year ? await db.exam.findFirst({ where: { academicYearId: year.id, status: 'open' }, orderBy: { sortOrder: 'desc' } }) : null;
        if (!e) return { hidden: true, value: '' };
        const p = await progress(e.id);
        const notStarted = p.rows.filter((r) => r.students && !r.entered).length;
        return {
            value: `${p.totals.complete}/${p.totals.sheets}`,
            caption: `subject sheets complete · ${e.name}`,
            tone: p.totals.complete === p.totals.sheets ? 'good' : notStarted ? 'warn' : 'neutral',
            progress: { value: p.totals.entered, max: p.totals.students, label: `${p.totals.entered} of ${p.totals.students} marks entered` },
            sub: [{ label: 'Not started', value: notStarted, tone: notStarted ? 'warn' : undefined }, ...(e.entryDeadline ? [{ label: 'Last date', value: e.entryDeadline.toISOString().slice(5, 10).split('-').reverse().join('/') }] : [])],
        };
    },
});

defineWidget({
    key: 'exam_last_result',
    label: 'Last exam result',
    description: 'The latest published exam: pass %, average and the subject with the lowest pass %.',
    category: 'Today',
    type: 'stat',
    size: 'sm',
    href: '/exams/results',
    permissions: ['exam.view', 'exam.publish'],
    cacheSeconds: 900,
    async load({ userId }) {
        const year = await currentYear();
        const e = year ? await db.exam.findFirst({ where: { academicYearId: year.id, status: 'published' }, orderBy: { publishedAt: 'desc' } }) : null;
        if (!e) return { hidden: true, value: '' };
        const limits = await sectionLimits(userId, e.academicYearId);
        const sections = await db.section.findMany({ where: { academicYearId: e.academicYearId, classId: { in: e.classIds }, isActive: true, ...(limits === 'all' ? {} : { id: { in: [...limits.keys()] } }) }, select: { id: true } });
        let passed = 0;
        let total = 0;
        let sum = 0;
        let n = 0;
        const subj = new Map<string, { pass: number; count: number }>();
        for (const s of sections) {
            const a = analyse(limitResults(await computeResults('exam', e.id, s.id), limitIn(limits, s.id)));
            passed += a.passed;
            total += a.withResult;
            if (a.average != null) {
                sum += a.average * a.withResult;
                n += a.withResult;
            }
            for (const x of a.subjects) {
                const c = subj.get(x.subject) ?? { pass: 0, count: 0 };
                c.pass += ((x.passPercent ?? 0) / 100) * x.students;
                c.count += x.students;
                subj.set(x.subject, c);
            }
        }
        const weakest = [...subj.entries()].filter(([, c]) => c.count).sort((a, b) => a[1].pass / a[1].count - b[1].pass / b[1].count)[0];
        const pct = total ? Math.round((passed / total) * 1000) / 10 : null;
        return {
            value: pct == null ? '—' : `${pct}%`,
            caption: `passed · ${e.name}`,
            tone: pct == null ? 'neutral' : pct >= 90 ? 'good' : pct >= 75 ? 'warn' : 'bad',
            sub: [{ label: 'Average', value: n ? `${Math.round((sum / n) * 10) / 10}%` : '—' }, ...(weakest ? [{ label: `Lowest: ${weakest[0]}`, value: `${Math.round((weakest[1].pass / weakest[1].count) * 100)}%`, tone: 'warn' as const }] : [])],
        };
    },
});

defineWidget({
    key: 'child_results',
    label: 'Results',
    description: 'For a student or parent: the published results and report cards.',
    category: 'My child',
    type: 'list',
    size: 'sm',
    href: '/my-results',
    permissions: ['exam.mine'],
    cacheSeconds: 600,
    async load({ userId }) {
        const list = await myResults(userId);
        const items = list.flatMap((c) => c.cards.slice(-3).reverse().map((card) => ({ title: card.label, sub: `${c.student.name} · ${card.year}`, href: '/my-results' })));
        if (!items.length) return { hidden: true, items: [], empty: '' };
        return { items, empty: 'No results published yet.' };
    },
});

