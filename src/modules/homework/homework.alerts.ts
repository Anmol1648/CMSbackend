import { db } from '../../core/db';
import { runAsSystem, runAsTenant } from '../../core/context';
import { defineAlert } from '../alerts/alerts.registry';
import { raise, raiseLater } from '../alerts/deliver';
import { defineDailyJob } from '../alerts/jobs';
import { onQueuePass } from '../alerts/queue';
import { parentsOf, Recipient, studentsOf } from '../alerts/recipients';
import { addDays, fmtDate } from '../alerts/format';
import { dayDate, todayIST } from '../attendance/attendance.settings';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { takers } from '../exams/marks.service';

/** Homework alerts: new homework, due tomorrow, not handed in, checked / sent back. */

const families = [
    { key: 'student', label: 'Students' },
    { key: 'parent', label: 'Parents' },
];
const fields = [
    { key: 'subject', label: 'Subject', example: 'Hindi' },
    { key: 'title', label: 'Homework', example: 'Write an essay on Diwali' },
    { key: 'due', label: 'Due date', example: '25 Oct 2026' },
    { key: 'class', label: 'Class', example: 'VII-B' },
    { key: 'teacher', label: 'Teacher', example: 'Deepak Rautela' },
    { key: 'student', label: 'Student(s)', example: 'Shubham Nautiyal' },
];

defineAlert({
    key: 'homework_new',
    label: 'New homework',
    description: 'When homework is published (or its scheduled time comes).',
    type: 'homework',
    when: 'instant',
    recipients: families,
    fields,
    defaults: {
        enabled: true,
        channels: ['in_app'],
        recipients: ['student', 'parent'],
        subject: '{{subject}} homework: {{title}}',
        body: 'Dear {{name}},\n\nNew {{subject}} homework for {{class}}: {{title}}. It is due on {{due}}.',
        shortText: '{{school}}: {{subject}} homework for {{class}} due {{due}}: {{title}}',
    },
    link: '/my-homework',
});

defineAlert({
    key: 'homework_due_tomorrow',
    label: 'Homework due tomorrow',
    description: 'Daily: homework to hand in online tomorrow, to students who haven’t handed it in yet.',
    type: 'homework',
    when: 'daily',
    recipients: families,
    fields,
    defaults: {
        enabled: true,
        channels: ['in_app'],
        recipients: ['student'],
        subject: 'Due tomorrow: {{subject}} homework',
        body: 'Dear {{name}},\n\n{{subject}} homework “{{title}}” is due tomorrow ({{due}}) and hasn’t been handed in yet.',
        shortText: '{{school}}: {{subject}} homework “{{title}}” is due tomorrow.',
    },
    link: '/my-homework',
});

defineAlert({
    key: 'homework_missed',
    label: 'Homework not handed in',
    description: 'Daily: the day after the due date, for homework to hand in online that a student hasn’t.',
    type: 'homework',
    when: 'daily',
    recipients: families,
    fields,
    defaults: {
        enabled: true,
        channels: ['in_app'],
        recipients: ['parent'],
        subject: '{{student}} didn’t hand in {{subject}} homework',
        body: 'Dear {{name}},\n\n{{student}} ({{class}}) didn’t hand in the {{subject}} homework “{{title}}”, due on {{due}}.',
        shortText: '{{school}}: {{student}} didn’t hand in {{subject}} homework due {{due}}.',
    },
    link: '/my-homework',
});

defineAlert({
    key: 'homework_checked',
    label: 'Homework checked',
    description: 'When the teacher checks a student’s homework, or sends it back to do again.',
    type: 'homework',
    when: 'instant',
    recipients: families,
    fields: [...fields, { key: 'result', label: 'Checked / sent back to redo', example: 'checked' }, { key: 'grade', label: 'Grade', example: 'Good' }, { key: 'remark', label: 'Remark', example: 'Neat work' }],
    defaults: {
        enabled: true,
        channels: ['in_app'],
        recipients: ['student'],
        subject: '{{subject}} homework {{result}}',
        body: 'Dear {{name}},\n\nYour {{subject}} homework “{{title}}” was {{result}}. {{grade}} {{remark}}',
        shortText: '{{school}}: {{subject}} homework {{result}}. {{grade}}',
    },
    link: '/my-homework',
});

const load = (id: string) => db.homework.findFirst({ where: { id }, include: { submissions: { select: { studentId: true, status: true } } } });
type Hw = NonNullable<Awaited<ReturnType<typeof load>>>;

const varsOf = async (h: Hw) => {
    const [section, subject, staff] = await Promise.all([
        db.section.findFirst({ where: { id: h.sectionId }, select: { name: true, schoolClass: { select: { name: true, shortName: true } } } }),
        db.subject.findFirst({ where: { id: h.subjectId }, select: { name: true } }),
        h.staffId ? db.staff.findFirst({ where: { id: h.staffId }, select: { firstName: true, lastName: true } }) : null,
    ]);
    return { subject: subject?.name ?? '', title: h.title, due: fmtDate(h.dueOn), class: section ? sectionLabel(section) : '', teacher: staff ? [staff.firstName, staff.lastName].filter(Boolean).join(' ') : '' };
};

/** Students of these (with names), and the student a parent / student message is about. */
const forStudents = async (list: { student: { id: string; firstName: string; middleName: string | null; lastName: string | null } }[]) => {
    const ids = list.map((t) => t.student.id);
    const names = new Map(list.map((t) => [t.student.id, fullName(t.student)]));
    return {
        to: { student: () => studentsOf(ids), parent: () => parentsOf(ids) },
        perRecipient: (r: Recipient) => ({ student: ((r as Recipient & { studentIds?: string[] }).studentIds ?? []).map((x) => names.get(x)).filter(Boolean).join(', ') }),
    };
};

export const alertNewHomework = (id: string) => {
    void (async () => {
        const h = await load(id);
        if (!h || h.status !== 'published' || (h.publishAt && h.publishAt > new Date())) return;
        await db.homework.update({ where: { id }, data: { alertedAt: new Date() } });
        const f = await forStudents(await takers(h.academicYearId, h.sectionId, h.subjectId));
        raiseLater('homework_new', f.to, await varsOf(h), { dedupe: `homework:${id}`, perRecipient: f.perRecipient, sectionIds: [h.sectionId] });
    })();
};

export const alertChecked = (id: string, studentId: string, status: string, gradeId: string | null, remark: string | null) => {
    void (async () => {
        const h = await load(id);
        if (!h) return;
        const grade = gradeId ? (await db.masterValue.findFirst({ where: { id: gradeId }, select: { name: true } }))?.name ?? '' : '';
        const st = await db.student.findFirst({ where: { id: studentId }, select: { firstName: true, middleName: true, lastName: true } });
        raiseLater(
            'homework_checked',
            { student: () => studentsOf([studentId]), parent: () => parentsOf([studentId]) },
            { ...(await varsOf(h)), student: st ? fullName(st) : '', result: status === 'redo' ? 'sent back to do again' : 'checked', grade: grade ? `Grade: ${grade}.` : '', remark: remark ?? '' },
            { dedupe: `homework-checked:${id}:${studentId}:${status}:${gradeId ?? ''}`, sectionIds: [h.sectionId] }
        );
    })();
};

const handedIn = new Set(['submitted', 'late', 'checked', 'redo', 'done']);

defineDailyJob({
    key: 'homework_due_tomorrow',
    run: async () => {
        const tomorrow = addDays(todayIST(), 1);
        const list = await db.homework.findMany({ where: { dueOn: dayDate(tomorrow), status: 'published', mode: 'online', OR: [{ publishAt: null }, { publishAt: { lte: new Date() } }] }, include: { submissions: { select: { studentId: true, status: true } } } });
        let students = 0;
        for (const h of list) {
            const done = new Set(h.submissions.filter((s) => handedIn.has(s.status)).map((s) => s.studentId));
            const left = (await takers(h.academicYearId, h.sectionId, h.subjectId)).filter((t) => !done.has(t.student.id));
            if (!left.length) continue;
            const f = await forStudents(left);
            await raise('homework_due_tomorrow', f.to, await varsOf(h), { dedupe: `homework-due:${h.id}`, perRecipient: f.perRecipient, sectionIds: [h.sectionId] });
            students += left.length;
        }
        return `${list.length} homework, ${students} students`;
    },
});

defineDailyJob({
    key: 'homework_missed',
    run: async () => {
        const yesterday = addDays(todayIST(), -1);
        const list = await db.homework.findMany({ where: { dueOn: dayDate(yesterday), status: 'published', mode: 'online' }, include: { submissions: { select: { studentId: true, status: true } } } });
        let students = 0;
        for (const h of list) {
            const done = new Set(h.submissions.filter((s) => handedIn.has(s.status)).map((s) => s.studentId));
            const left = (await takers(h.academicYearId, h.sectionId, h.subjectId)).filter((t) => !done.has(t.student.id));
            const vars = await varsOf(h);
            // One message per student, so each parent hears about their own child.
            for (const t of left) {
                const f = await forStudents([t]);
                await raise('homework_missed', f.to, { ...vars, student: fullName(t.student) }, { dedupe: `homework-missed:${h.id}:${t.student.id}`, sectionIds: [h.sectionId] });
            }
            students += left.length;
        }
        return `${list.length} homework, ${students} students`;
    },
});

// Scheduled homework: students are told when its time comes.
onQueuePass(async () => {
    const due = await runAsSystem(() => db.homework.findMany({ where: { status: 'published', alertedAt: null, publishAt: { lte: new Date(), gte: new Date(Date.now() - 3 * 86_400_000) } }, select: { id: true, tenantId: true }, take: 100 }));
    for (const h of due) await runAsTenant(h.tenantId, async () => alertNewHomework(h.id));
});
