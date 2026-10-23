import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { getUserAccess } from '../rbac/access.service';
import { currentYear } from '../academic/years.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { defineReport, registerReportCategory } from '../reports/reports.registry';
import { defineWidget } from '../dashboard/dashboard.registry';
import { takers } from '../exams/marks.service';
import { myHomework } from './homework.service';

/** Homework reports (Report Center) and dashboard widgets. */

registerReportCategory('Homework', 36);

/** Sections whose homework a person may report on: all, or those they teach / class-teach. */
const reportSections = async (userId: string, yearId: string) => {
    const a = await getUserAccess(userId);
    if (a.permissions['homework.view'] === 'all' || a.permissions['homework.give'] === 'all') return null;
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    if (!staff) return [];
    const [own, teach] = await Promise.all([
        db.section.findMany({ where: { academicYearId: yearId, classTeacherId: staff.id }, select: { id: true } }),
        db.teachingAssignment.findMany({ where: { academicYearId: yearId, staffId: staff.id }, select: { sectionId: true } }),
    ]);
    return [...new Set([...own.map((s) => s.id), ...teach.map((t) => t.sectionId)])];
};

const period = (f: Record<string, string>) => {
    if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
    return { gte: dayDate(f.from), lte: dayDate(f.to) };
};
const HANDED_IN = ['submitted', 'late', 'checked', 'redo', 'done'];

defineReport({
    key: 'homework_given',
    category: 'Homework',
    label: 'Homework given (by teacher)',
    description: 'How much homework each teacher gave in a period, in which subjects and sections, and how much of it was handed in and checked.',
    permissions: ['homework.view'],
    orientation: 'landscape',
    filters: [
        { key: 'from', label: 'From', type: 'date', required: true, default: 'monthStart' },
        { key: 'to', label: 'To', type: 'date', required: true, default: 'today' },
    ],
    columns: [
        { key: 'teacher', label: 'Teacher', type: 'text', width: 1.6 },
        { key: 'subjects', label: 'Subjects', type: 'text', width: 1.6 },
        { key: 'sections', label: 'Sections', type: 'text', width: 1.6 },
        { key: 'homework', label: 'Homework', type: 'number', width: 0.7, total: true },
        { key: 'handedIn', label: 'Handed in %', type: 'number', width: 0.8 },
        { key: 'checked', label: 'Checked %', type: 'number', width: 0.8 },
    ],
    async run(f, ctx) {
        const year = await currentYear();
        if (!year) return { rows: [] };
        const secs = await reportSections(ctx.userId, year.id);
        const list = await db.homework.findMany({ where: { academicYearId: year.id, status: 'published', givenOn: period(f), ...(secs ? { sectionId: { in: secs } } : {}) }, select: { id: true, staffId: true, sectionId: true, subjectId: true, academicYearId: true, submissions: { select: { status: true } } } });
        const [staff, subjects, sections] = await Promise.all([
            db.staff.findMany({ where: { id: { in: [...new Set(list.map((h) => h.staffId!).filter(Boolean))] } }, select: { id: true, firstName: true, middleName: true, lastName: true } }),
            db.subject.findMany({ where: { id: { in: [...new Set(list.map((h) => h.subjectId))] } }, select: { id: true, name: true } }),
            db.section.findMany({ where: { id: { in: [...new Set(list.map((h) => h.sectionId))] } }, select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } } } }),
        ]);
        const sub = new Map(subjects.map((s) => [s.id, s.name]));
        const sec = new Map(sections.map((s) => [s.id, sectionLabel(s)]));
        const size = new Map<string, number>();
        const by = new Map<string, { teacher: string; subjects: Set<string>; sections: Set<string>; homework: number; students: number; handedIn: number; checked: number }>();
        for (const h of list) {
            const k = `${h.sectionId}|${h.subjectId}`;
            if (!size.has(k)) size.set(k, (await takers(h.academicYearId, h.sectionId, h.subjectId)).length);
            const st = staff.find((s) => s.id === h.staffId);
            const key = h.staffId ?? 'none';
            const g = by.get(key) ?? { teacher: st ? fullName(st) : '—', subjects: new Set(), sections: new Set(), homework: 0, students: 0, handedIn: 0, checked: 0 };
            g.subjects.add(sub.get(h.subjectId) ?? '');
            g.sections.add(sec.get(h.sectionId) ?? '');
            g.homework++;
            g.students += size.get(k)!;
            g.handedIn += h.submissions.filter((s) => HANDED_IN.includes(s.status)).length;
            g.checked += h.submissions.filter((s) => ['checked', 'done', 'redo'].includes(s.status)).length;
            by.set(key, g);
        }
        const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
        return {
            rows: [...by.values()].sort((a, b) => a.teacher.localeCompare(b.teacher)).map((g) => ({ teacher: g.teacher, subjects: [...g.subjects].join(', '), sections: [...g.sections].join(', '), homework: g.homework, handedIn: pct(g.handedIn, g.students), checked: pct(g.checked, g.students) })),
            subtitle: `${f.from} – ${f.to}`,
        };
    },
});

defineReport({
    key: 'homework_missing',
    category: 'Homework',
    label: 'Students who miss homework',
    description: 'Students who didn’t hand in homework (to hand in online) that was due in a period, with how many they missed.',
    permissions: ['homework.view'],
    orientation: 'portrait',
    about: 'student',
    filters: [
        { key: 'from', label: 'From', type: 'date', required: true, default: 'monthStart' },
        { key: 'to', label: 'To', type: 'date', required: true, default: 'today' },
        { key: 'min', label: 'Missed at least', type: 'select', default: '2', options: [{ value: '1', label: '1 homework' }, { value: '2', label: '2 homework' }, { value: '3', label: '3 homework' }, { value: '5', label: '5 homework' }] },
    ],
    columns: [
        { key: 'roll', label: 'Roll', type: 'number', width: 0.5 },
        { key: 'student', label: 'Student', type: 'text', width: 1.8 },
        { key: 'admissionNo', label: 'Adm. no.', type: 'text', width: 0.9 },
        { key: 'missed', label: 'Missed', type: 'number', width: 0.6 },
        { key: 'due', label: 'Out of', type: 'number', width: 0.6 },
        { key: 'subjects', label: 'Subjects missed', type: 'text', width: 1.8 },
    ],
    async run(f, ctx) {
        const year = await currentYear();
        if (!year) return { rows: [] };
        const secs = await reportSections(ctx.userId, year.id);
        // Only homework already past its due date.
        const to = f.to < todayIST() ? f.to : isoOf(new Date(Date.now() - 86_400_000 + 5.5 * 3_600_000));
        const list = await db.homework.findMany({ where: { academicYearId: year.id, status: 'published', mode: 'online', dueOn: { gte: dayDate(f.from), lte: dayDate(to) }, ...(secs ? { sectionId: { in: secs } } : {}) }, select: { id: true, sectionId: true, subjectId: true, academicYearId: true, submissions: { select: { studentId: true, status: true } } } });
        const subjects = new Map((await db.subject.findMany({ where: { id: { in: [...new Set(list.map((h) => h.subjectId))] } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
        const tally = new Map<string, { student: { id: string; firstName: string; middleName: string | null; lastName: string | null; admissionNo: string }; roll: number | null; sectionId: string; missed: number; due: number; subjects: Set<string> }>();
        for (const h of list) {
            const done = new Set(h.submissions.filter((s) => HANDED_IN.includes(s.status)).map((s) => s.studentId));
            for (const t of await takers(h.academicYearId, h.sectionId, h.subjectId)) {
                const g = tally.get(t.student.id) ?? { student: t.student, roll: t.rollNumber, sectionId: h.sectionId, missed: 0, due: 0, subjects: new Set<string>() };
                g.due++;
                if (!done.has(t.student.id)) {
                    g.missed++;
                    g.subjects.add(subjects.get(h.subjectId) ?? '');
                }
                tally.set(t.student.id, g);
            }
        }
        const min = Number(f.min) || 1;
        const sections = new Map((await db.section.findMany({ where: { id: { in: [...new Set([...tally.values()].map((g) => g.sectionId))] } }, select: { id: true, name: true, sortOrder: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } } })).map((s) => [s.id, s]));
        const rows = [...tally.values()]
            .filter((g) => g.missed >= min)
            .map((g) => {
                const s = sections.get(g.sectionId)!;
                return { studentId: g.student.id, roll: g.roll, student: fullName(g.student), admissionNo: g.student.admissionNo, missed: g.missed, due: g.due, subjects: [...g.subjects].join(', '), groupKey: `${String(s.schoolClass.sortOrder).padStart(4, '0')}${String(s.sortOrder).padStart(3, '0')}`, groupLabel: sectionLabel(s) };
            })
            .sort((a, b) => a.groupKey.localeCompare(b.groupKey) || (a.roll ?? 9999) - (b.roll ?? 9999));
        return { rows, subtitle: `Due ${f.from} – ${to} · missed at least ${min}`, groupedBy: 'Section' };
    },
});

// ─── Dashboard ───────────────────────────────────────────────────────────────

defineWidget({
    key: 'homework_due',
    label: 'Homework due',
    description: 'A student’s (or each child’s) homework due today and tomorrow that isn’t handed in.',
    category: 'Today',
    type: 'list',
    size: 'md',
    href: '/my-homework',
    permissions: ['homework.mine'],
    cacheSeconds: 120,
    async load({ userId }) {
        const today = todayIST();
        const tomorrow = isoOf(new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000));
        const all = await myHomework(userId);
        const items = all.flatMap((c) =>
            c.homework
                .filter((h) => (h.dueOn === today || h.dueOn === tomorrow) && ['pending', 'redo'].includes(h.status))
                .map((h) => ({ title: `${h.subject}: ${h.title}`, sub: `${all.length > 1 ? `${c.student.name} · ` : ''}due ${h.dueOn === today ? 'today' : 'tomorrow'}`, href: '/my-homework', tone: (h.dueOn === today ? 'warn' : 'neutral') as 'warn' | 'neutral' }))
        );
        if (!all.length) return { hidden: true, items: [], empty: '' };
        return { items: items.slice(0, 8), empty: 'Nothing due today or tomorrow. ✓' };
    },
});

defineWidget({
    key: 'homework_to_check',
    label: 'Homework to check',
    description: 'Homework handed in to a teacher and not checked yet.',
    category: 'Today',
    type: 'stat',
    size: 'sm',
    href: '/homework',
    permissions: ['homework.check'],
    cacheSeconds: 120,
    async load({ userId }) {
        const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
        if (!staff) return { hidden: true, value: '' };
        const [waiting, given] = await Promise.all([
            db.homeworkSubmission.count({ where: { status: { in: ['submitted', 'late'] }, homework: { staffId: staff.id } } }),
            db.homework.count({ where: { staffId: staff.id, status: 'published', givenOn: { gte: dayDate(isoOf(new Date(Date.now() - 7 * 86_400_000))) } } }),
        ]);
        return { value: waiting, caption: 'handed in, waiting to be checked', tone: waiting > 20 ? 'warn' : 'neutral', sub: [{ label: 'Given this week', value: given }] };
    },
});
