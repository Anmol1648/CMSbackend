import { db } from '../../core/db';
import { defineAlert } from '../alerts/alerts.registry';
import { raise, raiseLater } from '../alerts/deliver';
import { defineDailyJob } from '../alerts/jobs';
import { parentsOf, Recipient, staffOf, studentsOf } from '../alerts/recipients';
import { addDays, fmtDate } from '../alerts/format';
import { todayIST } from '../attendance/attendance.settings';
import { fullName } from '../students/students.service';
import { progress } from './marks.service';

/** Exam alerts: results published, date sheet published, marks entry closing with sheets pending. */

const families = [
    { key: 'parent', label: 'Parents' },
    { key: 'student', label: 'Students' },
];

defineAlert({
    key: 'exam_results_published',
    label: 'Results published',
    description: 'When an exam’s results (or a term’s / the final result) are published: the report card is ready to see.',
    type: 'exams',
    when: 'instant',
    recipients: families,
    fields: [
        { key: 'exam', label: 'Exam or result', example: 'Half-Yearly' },
        { key: 'student', label: 'Student(s)', example: 'Manish Rana' },
    ],
    defaults: {
        enabled: true,
        channels: ['in_app', 'email'],
        recipients: ['parent', 'student'],
        subject: '{{exam}} results are out',
        body: 'Dear {{name}},\n\nThe {{exam}} results of {{student}} are now published. You can see the marks and download the report card in the school app (My Results).',
        shortText: '{{school}}: {{exam}} results of {{student}} are out. See My Results in the app.',
    },
    link: '/my-results',
});

defineAlert({
    key: 'exam_datesheet_published',
    label: 'Date sheet published',
    description: 'When an exam’s date sheet is published.',
    type: 'exams',
    when: 'instant',
    recipients: families,
    fields: [
        { key: 'exam', label: 'Exam', example: 'Annual' },
        { key: 'from', label: 'First paper', example: '2 Mar 2027' },
        { key: 'to', label: 'Last paper', example: '14 Mar 2027' },
        { key: 'student', label: 'Student(s)', example: 'Manish Rana' },
    ],
    defaults: {
        enabled: true,
        channels: ['in_app'],
        recipients: ['parent', 'student'],
        subject: '{{exam}} date sheet',
        body: 'Dear {{name}},\n\nThe date sheet of the {{exam}} exam is out: from {{from}} to {{to}}. It is on the notice board and the school calendar.',
        shortText: '{{school}}: {{exam}} from {{from}} to {{to}}. See the notice board for the date sheet.',
    },
    link: '/events',
});

defineAlert({
    key: 'exam_marks_pending',
    label: 'Marks entry closes tomorrow',
    description: 'Daily: the day before the last date of marks entry, to teachers whose sheets aren’t complete.',
    type: 'exams',
    when: 'daily',
    recipients: [{ key: 'teacher', label: 'Subject teachers' }],
    fields: [
        { key: 'exam', label: 'Exam', example: 'Half-Yearly' },
        { key: 'deadline', label: 'Last date', example: '24 Oct 2026' },
        { key: 'sheets', label: 'Their pending sheets', example: 'VII-B Hindi, VIII-B Hindi' },
    ],
    defaults: {
        enabled: true,
        channels: ['in_app', 'email'],
        recipients: ['teacher'],
        subject: '{{exam}}: marks entry closes {{deadline}}',
        body: 'Dear {{name}},\n\nMarks entry for {{exam}} closes on {{deadline}}. These sheets are not complete yet: {{sheets}}.',
        shortText: '{{school}}: {{exam}} marks close {{deadline}}. Pending: {{sheets}}.',
    },
    link: '/exams/marks',
});

/** Students of these classes (or sections) in a session, with their names. */
const studentsIn = async (yearId: string, where: { classIds?: string[]; sectionIds?: string[] }) => {
    const rows = await db.enrolment.findMany({
        where: { academicYearId: yearId, student: { status: 'active' }, ...(where.sectionIds ? { sectionId: { in: where.sectionIds } } : { section: { classId: { in: where.classIds ?? [] } } }) },
        select: { studentId: true, sectionId: true, student: { select: { firstName: true, middleName: true, lastName: true } } },
    });
    return { ids: rows.map((r) => r.studentId), names: new Map(rows.map((r) => [r.studentId, fullName(r.student)])), sectionIds: [...new Set(rows.map((r) => r.sectionId))] };
};

const forFamilies = (s: Awaited<ReturnType<typeof studentsIn>>) => ({
    to: { parent: () => parentsOf(s.ids), student: () => studentsOf(s.ids) },
    perRecipient: (r: Recipient) => ({ student: ((r as Recipient & { studentIds?: string[] }).studentIds ?? []).map((id) => s.names.get(id)).filter(Boolean).join(', ') }),
});

/** An exam's results published (or a term's / the final result: label, year and classes given). */
export const alertResults = (what: { key: string; label: string; yearId: string; classIds?: string[] }) => {
    void (async () => {
        const s = what.classIds
            ? await studentsIn(what.yearId, { classIds: what.classIds })
            : await studentsIn(what.yearId, { sectionIds: (await db.section.findMany({ where: { academicYearId: what.yearId }, select: { id: true } })).map((x) => x.id) });
        const f = forFamilies(s);
        raiseLater('exam_results_published', f.to, { exam: what.label }, { dedupe: `results:${what.key}`, perRecipient: f.perRecipient, sectionIds: s.sectionIds });
    })();
};

export const alertDatesheet = (examId: string) => {
    void (async () => {
        const e = await db.exam.findFirst({ where: { id: examId }, select: { id: true, name: true, academicYearId: true, classIds: true } });
        if (!e) return;
        const papers = await db.examSubject.findMany({ where: { examId, date: { not: null } }, select: { date: true }, orderBy: { date: 'asc' } });
        const s = await studentsIn(e.academicYearId, { classIds: e.classIds });
        const f = forFamilies(s);
        raiseLater(
            'exam_datesheet_published',
            f.to,
            { exam: e.name, from: fmtDate(papers[0]?.date ?? null), to: fmtDate(papers[papers.length - 1]?.date ?? null) },
            { dedupe: `datesheet:${e.id}:${todayIST()}`, perRecipient: f.perRecipient, sectionIds: s.sectionIds }
        );
    })();
};

defineDailyJob({
    key: 'exam_marks_pending',
    run: async () => {
        const tomorrow = addDays(todayIST(), 1);
        const exams = await db.exam.findMany({ where: { status: 'open', entryDeadline: { gte: new Date(`${tomorrow}T00:00:00+05:30`), lt: new Date(`${addDays(tomorrow, 1)}T00:00:00+05:30`) } }, select: { id: true, name: true, academicYearId: true, entryDeadline: true } });
        let teachers = 0;
        for (const e of exams) {
            const p = await progress(e.id);
            const pending = p.rows.filter((r) => r.students && r.entered < r.students);
            if (!pending.length) continue;
            const subjects = new Map((await db.examSubject.findMany({ where: { id: { in: pending.map((r) => r.examSubjectId) } }, select: { id: true, subjectId: true } })).map((x) => [x.id, x.subjectId]));
            const assign = await db.teachingAssignment.findMany({ where: { academicYearId: e.academicYearId, sectionId: { in: pending.map((r) => r.sectionId) } }, select: { staffId: true, sectionId: true, subjectId: true } });
            const byStaff = new Map<string, string[]>();
            for (const r of pending) for (const a of assign.filter((x) => x.sectionId === r.sectionId && x.subjectId === subjects.get(r.examSubjectId))) byStaff.set(a.staffId, [...(byStaff.get(a.staffId) ?? []), `${r.section} ${r.subject}`]);
            for (const [staffId, sheets] of byStaff) {
                await raise('exam_marks_pending', { teacher: () => staffOf([staffId]) }, { exam: e.name, deadline: fmtDate(e.entryDeadline), sheets: sheets.join(', ') }, { dedupe: `marks-pending:${e.id}:${staffId}` });
                teachers++;
            }
        }
        return `${teachers} teachers`;
    },
});
