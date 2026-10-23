import { db } from '../../core/db';
import { defineAlert } from '../alerts/alerts.registry';
import { raiseLater } from '../alerts/deliver';
import { parentsOf, Recipient, studentsOf } from '../alerts/recipients';
import { fullName } from '../students/students.service';
import { takers } from '../exams/marks.service';

/** Online test alerts: a test is coming (published), results are out. */

const families = [
    { key: 'student', label: 'Students' },
    { key: 'parent', label: 'Parents' },
];
const fields = [
    { key: 'title', label: 'Test', example: 'Science test: Heat' },
    { key: 'subject', label: 'Subject', example: 'Science' },
    { key: 'opens', label: 'Opens', example: '26 Oct, 10:00 am' },
    { key: 'closes', label: 'Closes', example: '26 Oct, 6:00 pm' },
    { key: 'minutes', label: 'Time allowed (minutes)', example: '30' },
    { key: 'student', label: 'Student(s)', example: 'Shubham Nautiyal' },
];

defineAlert({
    key: 'test_published',
    label: 'Online test published',
    description: 'When a teacher publishes an online test: when it opens and closes.',
    type: 'exams',
    when: 'instant',
    recipients: families,
    fields,
    defaults: {
        enabled: true,
        channels: ['in_app'],
        recipients: ['student', 'parent'],
        subject: 'Online test: {{title}}',
        body: 'Dear {{name}},\n\nThe online test “{{title}}” ({{subject}}) opens on {{opens}} and closes on {{closes}}. It takes {{minutes}} minutes once started.',
        shortText: '{{school}}: online test “{{title}}” opens {{opens}}, closes {{closes}}.',
    },
    link: '/my-tests',
});

defineAlert({
    key: 'test_results',
    label: 'Online test results',
    description: 'When a teacher publishes the results of an online test.',
    type: 'exams',
    when: 'instant',
    recipients: families,
    fields: [...fields, { key: 'score', label: 'Score (marks out of total)', example: '18 / 25' }],
    defaults: {
        enabled: true,
        channels: ['in_app'],
        recipients: ['student', 'parent'],
        subject: 'Result: {{title}}',
        body: 'Dear {{name}},\n\nThe result of the online test “{{title}}” is out: {{student}} scored {{score}}. See the answers in My Tests.',
        shortText: '{{school}}: {{student}} scored {{score}} in “{{title}}”.',
    },
    link: '/my-tests',
});

const when = (d: Date) => d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });

const studentsOfTest = async (t: { academicYearId: string; sectionIds: string[]; subjectId: string }) => {
    const list = [];
    for (const s of t.sectionIds) list.push(...(await takers(t.academicYearId, s, t.subjectId)));
    return list;
};

export const alertTestPublished = (id: string) => {
    void (async () => {
        const t = await db.onlineTest.findFirst({ where: { id } });
        if (!t || t.alertedAt) return;
        await db.onlineTest.update({ where: { id }, data: { alertedAt: new Date() } });
        const list = await studentsOfTest(t);
        const ids = list.map((x) => x.student.id);
        const names = new Map(list.map((x) => [x.student.id, fullName(x.student)]));
        const subject = (await db.subject.findFirst({ where: { id: t.subjectId }, select: { name: true } }))?.name ?? '';
        raiseLater(
            'test_published',
            { student: () => studentsOf(ids), parent: () => parentsOf(ids) },
            { title: t.title, subject, opens: when(t.startsAt), closes: when(t.endsAt), minutes: String(t.durationMin) },
            { dedupe: `test:${id}`, perRecipient: (r: Recipient) => ({ student: ((r as Recipient & { studentIds?: string[] }).studentIds ?? []).map((x) => names.get(x)).filter(Boolean).join(', ') }), sectionIds: t.sectionIds }
        );
    })();
};

export const alertResults = (id: string) => {
    void (async () => {
        const t = await db.onlineTest.findFirst({ where: { id } });
        if (!t) return;
        const attempts = await db.testAttempt.findMany({ where: { testId: id, status: { in: ['submitted', 'marked'] } }, select: { studentId: true, score: true } });
        if (!attempts.length) return;
        const ids = attempts.map((a) => a.studentId);
        const score = new Map(attempts.map((a) => [a.studentId, a.score ?? 0]));
        const students = await db.student.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, middleName: true, lastName: true } });
        const names = new Map(students.map((s) => [s.id, fullName(s)]));
        const subject = (await db.subject.findFirst({ where: { id: t.subjectId }, select: { name: true } }))?.name ?? '';
        const total = Number.isInteger(t.totalMarks) ? String(t.totalMarks) : t.totalMarks.toFixed(1);
        raiseLater(
            'test_results',
            { student: () => studentsOf(ids), parent: () => parentsOf(ids) },
            { title: t.title, subject, opens: when(t.startsAt), closes: when(t.endsAt), minutes: String(t.durationMin) },
            {
                dedupe: `test-results:${id}`,
                sectionIds: t.sectionIds,
                perRecipient: (r: Recipient) => {
                    const mine = ((r as Recipient & { studentIds?: string[] }).studentIds ?? []).filter((x) => score.has(x));
                    return { student: mine.map((x) => names.get(x)).filter(Boolean).join(', '), score: mine.map((x) => `${score.get(x)} / ${total}`).join(', ') };
                },
            }
        );
    })();
};
