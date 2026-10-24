import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { currentYear } from '../academic/years.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { dayDate, isoOf } from '../attendance/attendance.settings';
import { defineReport, registerReportCategory } from '../reports/reports.registry';
import { defineWidget } from '../dashboard/dashboard.registry';
import { pendingActions, scopeOf } from './discipline.service';

/** Discipline reports (Report Center) and dashboard widgets; limited to the sections a person reaches. */

registerReportCategory('Discipline', 52);

const range = [
    { key: 'from', label: 'From', type: 'date' as const, required: true, default: 'sessionStart' },
    { key: 'to', label: 'To', type: 'date' as const, required: true, default: 'today' },
];
const between = (f: Record<string, string>) => {
    if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
    return { gte: dayDate(f.from), lt: new Date(dayDate(f.to).getTime() + 86_400_000) };
};
const istDay = (d: Date) => isoOf(new Date(d.getTime() + 5.5 * 3_600_000));

/** The incident-students of a period within the person's reach. */
const rowsFor = async (userId: string, f: Record<string, string>, positive: boolean) => {
    const scope = await scopeOf(userId, 'discipline.view');
    return db.incidentStudent.findMany({ where: { ...(scope === 'all' ? {} : { sectionId: { in: scope } }), incident: { positive, occurredAt: between(f) } }, include: { incident: { select: { id: true, title: true, typeId: true, severity: true, occurredAt: true, status: true } } } });
};

defineReport({
    key: 'discipline_by_class',
    category: 'Discipline',
    label: 'Incidents by class',
    description: 'For each section: incidents (by severity), students involved, positive notes and the net conduct points in a period.',
    permissions: ['discipline.view'],
    orientation: 'landscape',
    filters: range,
    columns: [
        { key: 'section', label: 'Section', type: 'text', width: 0.9 },
        { key: 'incidents', label: 'Incidents', type: 'number', width: 0.7, total: true },
        { key: 'minor', label: 'Minor', type: 'number', width: 0.6, total: true },
        { key: 'moderate', label: 'Moderate', type: 'number', width: 0.7, total: true },
        { key: 'serious', label: 'Serious', type: 'number', width: 0.6, total: true },
        { key: 'students', label: 'Students involved', type: 'number', width: 0.8, total: true },
        { key: 'positive', label: 'Positive notes', type: 'number', width: 0.7, total: true },
        { key: 'points', label: 'Net points', type: 'number', width: 0.6, total: true },
    ],
    async run(f, ctx) {
        const [bad, good] = await Promise.all([rowsFor(ctx.userId, f, false), rowsFor(ctx.userId, f, true)]);
        const ids = [...new Set([...bad, ...good].map((r) => r.sectionId).filter((x): x is string => !!x))];
        const sections = await db.section.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, sortOrder: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } } });
        return {
            subtitle: `${f.from} – ${f.to}`,
            rows: sections
                .sort((a, b) => a.schoolClass.sortOrder - b.schoolClass.sortOrder || a.sortOrder - b.sortOrder)
                .map((s) => {
                    const b = bad.filter((r) => r.sectionId === s.id && r.role === 'did');
                    const inc = new Map(b.map((r) => [r.incident.id, r.incident.severity]));
                    const sev = (x: string) => [...inc.values()].filter((v) => v === x).length;
                    return { section: sectionLabel(s), incidents: inc.size, minor: sev('minor'), moderate: sev('moderate'), serious: sev('serious'), students: new Set(b.map((r) => r.studentId)).size, positive: good.filter((r) => r.sectionId === s.id).length, points: [...bad, ...good].filter((r) => r.sectionId === s.id).reduce((a, r) => a + r.points, 0) };
                }),
        };
    },
});

defineReport({
    key: 'discipline_repeat',
    category: 'Discipline',
    label: 'Students with repeated incidents',
    description: 'Students involved in at least a number of incidents in a period, with their points and the last incident.',
    permissions: ['discipline.view'],
    orientation: 'landscape',
    about: 'student',
    filters: [...range, { key: 'min', label: 'At least', type: 'select', default: '2', options: [{ value: '2', label: '2 incidents' }, { value: '3', label: '3 incidents' }, { value: '5', label: '5 incidents' }] }],
    columns: [
        { key: 'student', label: 'Student', type: 'text', width: 1.6 },
        { key: 'admissionNo', label: 'Adm. no.', type: 'text', width: 0.8 },
        { key: 'section', label: 'Section', type: 'text', width: 0.7 },
        { key: 'incidents', label: 'Incidents', type: 'number', width: 0.6 },
        { key: 'serious', label: 'Serious', type: 'number', width: 0.6 },
        { key: 'points', label: 'Points', type: 'number', width: 0.6 },
        { key: 'last', label: 'Last', type: 'text', width: 1.8 },
    ],
    async run(f, ctx) {
        const rows = (await rowsFor(ctx.userId, f, false)).filter((r) => r.role === 'did');
        const by = new Map<string, typeof rows>();
        for (const r of rows) by.set(r.studentId, [...(by.get(r.studentId) ?? []), r]);
        const keep = [...by.entries()].filter(([, l]) => l.length >= Number(f.min || 2));
        const year = await currentYear();
        const [students, enrol] = await Promise.all([db.student.findMany({ where: { id: { in: keep.map(([id]) => id) } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } }), year ? db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: keep.map(([id]) => id) } }, select: { studentId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } }) : []]);
        return {
            subtitle: `${f.from} – ${f.to} · at least ${f.min || 2} incidents`,
            rows: keep
                .map(([id, l]) => {
                    const st = students.find((s) => s.id === id);
                    const e = enrol.find((x) => x.studentId === id);
                    const last = [...l].sort((a, b) => b.incident.occurredAt.getTime() - a.incident.occurredAt.getTime())[0];
                    return { studentId: id, student: st ? fullName(st) : '', admissionNo: st?.admissionNo ?? '', section: e ? sectionLabel(e.section) : '', incidents: l.length, serious: l.filter((r) => r.incident.severity === 'serious').length, points: l.reduce((a, r) => a + r.points, 0), last: `${istDay(last.incident.occurredAt)}: ${last.incident.title}` };
                })
                .sort((a, b) => b.incidents - a.incidents),
        };
    },
});

defineReport({
    key: 'discipline_actions',
    category: 'Discipline',
    label: 'Discipline actions taken',
    description: 'Warnings, detentions, suspensions… decided in a period, with who decided and approved.',
    permissions: ['discipline.view'],
    orientation: 'landscape',
    filters: range,
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 0.7 },
        { key: 'action', label: 'Action', type: 'text', width: 1.2 },
        { key: 'student', label: 'Student', type: 'text', width: 1.4 },
        { key: 'incident', label: 'Incident', type: 'text', width: 1.8 },
        { key: 'dates', label: 'Dates', type: 'text', width: 1 },
        { key: 'status', label: 'Status', type: 'text', width: 0.8 },
        { key: 'by', label: 'Decided by', type: 'text', width: 1 },
    ],
    async run(f, ctx) {
        const scope = await scopeOf(ctx.userId, 'discipline.view');
        const actions = await db.incidentAction.findMany({ where: { createdAt: between(f), ...(scope === 'all' ? {} : { incident: { students: { some: { sectionId: { in: scope } } } } }) }, orderBy: { createdAt: 'asc' }, include: { incident: { select: { title: true } } } });
        const [m, students, users] = await Promise.all([db.masterValue.findMany({ where: { id: { in: actions.map((a) => a.actionId!).filter(Boolean) } }, select: { id: true, name: true } }), db.student.findMany({ where: { id: { in: actions.map((a) => a.studentId!).filter(Boolean) } }, select: { id: true, firstName: true, middleName: true, lastName: true } }), db.user.findMany({ where: { id: { in: actions.map((a) => a.decidedBy!).filter(Boolean) } }, select: { id: true, displayName: true } })]);
        const STATUS: Record<string, string> = { done: 'Done', pending: 'Waiting for approval', rejected: 'Refused' };
        return { subtitle: `${f.from} – ${f.to}`, rows: actions.map((a) => ({ date: istDay(a.createdAt), action: m.find((x) => x.id === a.actionId)?.name ?? '', student: a.studentId ? fullName(students.find((s) => s.id === a.studentId) ?? { firstName: '' }) : 'All involved', incident: a.incident.title, dates: a.fromDate ? `${isoOf(a.fromDate)}${a.toDate ? ` – ${isoOf(a.toDate)}` : ''}` : '', status: STATUS[a.status] ?? a.status, by: users.find((u) => u.id === a.decidedBy)?.displayName ?? '' })) };
    },
});

defineReport({
    key: 'discipline_stars',
    category: 'Discipline',
    label: 'Positive notes (star students)',
    description: 'Students with the most positive notes in a period.',
    permissions: ['discipline.view'],
    orientation: 'portrait',
    about: 'student',
    filters: range,
    columns: [
        { key: 'student', label: 'Student', type: 'text', width: 1.8 },
        { key: 'section', label: 'Section', type: 'text', width: 0.8 },
        { key: 'notes', label: 'Positive notes', type: 'number', width: 0.8, total: true },
        { key: 'points', label: 'Points', type: 'number', width: 0.6 },
        { key: 'last', label: 'Latest', type: 'text', width: 1.8 },
    ],
    async run(f, ctx) {
        const rows = await rowsFor(ctx.userId, f, true);
        const by = new Map<string, typeof rows>();
        for (const r of rows) by.set(r.studentId, [...(by.get(r.studentId) ?? []), r]);
        const year = await currentYear();
        const ids = [...by.keys()];
        const [students, enrol] = await Promise.all([db.student.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, middleName: true, lastName: true } }), year ? db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: ids } }, select: { studentId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } }) : []]);
        return {
            subtitle: `${f.from} – ${f.to}`,
            rows: [...by.entries()]
                .map(([id, l]) => {
                    const e = enrol.find((x) => x.studentId === id);
                    const last = [...l].sort((a, b) => b.incident.occurredAt.getTime() - a.incident.occurredAt.getTime())[0];
                    return { studentId: id, student: fullName(students.find((s) => s.id === id) ?? { firstName: '' }), section: e ? sectionLabel(e.section) : '', notes: l.length, points: l.reduce((a, r) => a + r.points, 0), last: last.incident.title };
                })
                .sort((a, b) => b.notes - a.notes)
                .slice(0, 100),
        };
    },
});

// ─── Widgets ─────────────────────────────────────────────────────────────────

defineWidget({
    key: 'discipline_week',
    label: 'Discipline this week',
    description: 'Incidents in the last 7 days (in the sections you reach), serious ones, and actions waiting for approval.',
    category: 'Today',
    type: 'stat',
    size: 'sm',
    href: '/discipline',
    permissions: ['discipline.view', 'discipline.approve'],
    cacheSeconds: 300,
    async load({ userId, permissions }) {
        const scope = await scopeOf(userId, 'discipline.view');
        const since = new Date(Date.now() - 7 * 86_400_000);
        const where = { positive: false, occurredAt: { gte: since }, ...(scope === 'all' ? {} : { students: { some: { sectionId: { in: scope } } } }) };
        const [n, serious, pending] = await Promise.all([db.incident.count({ where }), db.incident.count({ where: { ...where, severity: 'serious' } }), permissions['discipline.approve'] ? pendingActions().then((p) => p.length) : Promise.resolve(0)]);
        return { value: n, caption: 'incidents in 7 days', tone: serious || pending ? 'warn' : 'neutral', sub: [{ label: 'Serious', value: serious, tone: serious ? 'bad' : undefined }, ...(permissions['discipline.approve'] ? [{ label: 'Waiting for your approval', value: pending, tone: pending ? ('warn' as const) : undefined }] : [])] };
    },
});
