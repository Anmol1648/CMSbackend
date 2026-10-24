import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { fullName } from '../students/students.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { defineReport, registerReportCategory } from '../reports/reports.registry';
import { defineDefaultLayout, defineWidget } from '../dashboard/dashboard.registry';
import { gateToday, myVisitors } from './visitors.service';

/** Visitor reports (Report Center) and dashboard widgets. */

registerReportCategory('Visitors', 48);

const period = (f: Record<string, string>) => {
    if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
    return { gte: dayDate(f.from), lte: dayDate(f.to) };
};
const range = [
    { key: 'from', label: 'From', type: 'date' as const, required: true, default: 'monthStart' },
    { key: 'to', label: 'To', type: 'date' as const, required: true, default: 'today' },
];
const clock = (d: Date | null) => (d ? d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }) : '');
const staffName = (s: { firstName: string; middleName?: string | null; lastName?: string | null }) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');
const STATUS: Record<string, string> = { in: 'Inside', out: 'Left', waiting: 'Waiting', denied: 'Not allowed', expected: 'Expected', no_show: 'Didn’t come' };

defineReport({
    key: 'visitor_log',
    category: 'Visitors',
    label: 'Visitor log',
    description: 'Every visitor in a period: whom they met, why, when they came and left.',
    permissions: ['visitor.view'],
    orientation: 'landscape',
    filters: [...range, { key: 'purpose', label: 'Purpose', type: 'master', master: 'visit_purpose' }],
    columns: [
        { key: 'day', label: 'Date', type: 'date', width: 0.8 },
        { key: 'passNo', label: 'Pass', type: 'text', width: 1 },
        { key: 'visitor', label: 'Visitor', type: 'text', width: 1.4 },
        { key: 'mobile', label: 'Mobile', type: 'text', width: 0.9 },
        { key: 'purpose', label: 'Purpose', type: 'text', width: 1.2 },
        { key: 'met', label: 'Met', type: 'text', width: 1.4 },
        { key: 'inAt', label: 'In', type: 'text', width: 0.6 },
        { key: 'outAt', label: 'Out', type: 'text', width: 0.6 },
        { key: 'state', label: 'State', type: 'text', width: 0.7 },
    ],
    async run(f) {
        const purposeId = f.purpose ? (await db.masterValue.findFirst({ where: { master: 'visit_purpose', OR: [{ code: f.purpose }, { id: /^[0-9a-f-]{36}$/.test(f.purpose) ? f.purpose : undefined }] }, select: { id: true } }))?.id : undefined;
        const visits = await db.visit.findMany({ where: { day: period(f), status: { notIn: ['expected'] }, ...(purposeId ? { purposeId } : {}) }, orderBy: [{ day: 'asc' }, { inAt: 'asc' }], include: { visitor: { select: { name: true, mobile: true } } } });
        const [purposes, staff, students] = await Promise.all([db.masterValue.findMany({ where: { master: 'visit_purpose' }, select: { id: true, name: true } }), db.staff.findMany({ where: { id: { in: visits.map((v) => v.staffId!).filter(Boolean) } }, select: { id: true, firstName: true, middleName: true, lastName: true } }), db.student.findMany({ where: { id: { in: visits.map((v) => v.studentId!).filter(Boolean) } }, select: { id: true, firstName: true, middleName: true, lastName: true } })]);
        return {
            subtitle: `${f.from} – ${f.to}`,
            rows: visits.map((v) => ({ day: isoOf(v.day), passNo: v.passNo ?? '', visitor: v.visitor.name, mobile: v.visitor.mobile ?? '', purpose: purposes.find((p) => p.id === v.purposeId)?.name ?? '', met: v.staffId ? staffName(staff.find((s) => s.id === v.staffId) ?? { firstName: '' }) : v.studentId ? `About ${fullName(students.find((s) => s.id === v.studentId) ?? { firstName: '' })}` : 'Office', inAt: clock(v.inAt), outAt: clock(v.outAt), state: STATUS[v.status] ?? v.status })),
        };
    },
});

defineReport({
    key: 'visitor_daily',
    category: 'Visitors',
    label: 'Visitors per day',
    description: 'How many visitors came each day in a period, by purpose, and the busiest hour.',
    permissions: ['visitor.view'],
    orientation: 'landscape',
    filters: range,
    columns: [
        { key: 'day', label: 'Date', type: 'date', width: 0.8 },
        { key: 'visits', label: 'Visits', type: 'number', width: 0.6, total: true },
        { key: 'people', label: 'People', type: 'number', width: 0.6, total: true },
        { key: 'parents', label: 'About a student', type: 'number', width: 0.8, total: true },
        { key: 'staff', label: 'Met staff', type: 'number', width: 0.7, total: true },
        { key: 'office', label: 'Office', type: 'number', width: 0.6, total: true },
        { key: 'peak', label: 'Busiest hour', type: 'text', width: 0.9 },
    ],
    async run(f) {
        const visits = await db.visit.findMany({ where: { day: period(f), status: { in: ['in', 'out'] } }, select: { day: true, people: true, hostKind: true, inAt: true } });
        const days = [...new Set(visits.map((v) => isoOf(v.day)))].sort();
        return {
            subtitle: `${f.from} – ${f.to}`,
            rows: days.map((d) => {
                const mine = visits.filter((v) => isoOf(v.day) === d);
                const hours = new Map<number, number>();
                for (const v of mine) if (v.inAt) {
                    const h = Number(v.inAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }));
                    hours.set(h, (hours.get(h) ?? 0) + 1);
                }
                const peak = [...hours.entries()].sort((a, b) => b[1] - a[1])[0];
                return { day: d, visits: mine.length, people: mine.reduce((a, v) => a + v.people, 0), parents: mine.filter((v) => v.hostKind === 'student').length, staff: mine.filter((v) => v.hostKind === 'staff').length, office: mine.filter((v) => v.hostKind === 'office').length, peak: peak ? `${String(peak[0]).padStart(2, '0')}:00 (${peak[1]})` : '' };
            }),
        };
    },
});

defineReport({
    key: 'student_pickups',
    category: 'Visitors',
    label: 'Students collected early',
    description: 'Early pickups in a period: who collected each student, when and why, and those not on the list.',
    permissions: ['visitor.view', 'visitor.manage'],
    orientation: 'landscape',
    about: 'student',
    filters: range,
    columns: [
        { key: 'day', label: 'Date', type: 'date', width: 0.8 },
        { key: 'time', label: 'Time', type: 'text', width: 0.6 },
        { key: 'student', label: 'Student', type: 'text', width: 1.6 },
        { key: 'by', label: 'Collected by', type: 'text', width: 1.6 },
        { key: 'reason', label: 'Reason', type: 'text', width: 1.6 },
        { key: 'state', label: 'State', type: 'text', width: 1 },
    ],
    async run(f) {
        const p = period(f);
        const rows = await db.studentPickup.findMany({ where: { at: { gte: p.gte, lt: new Date(p.lte.getTime() + 86_400_000) } }, orderBy: { at: 'asc' } });
        const students = await db.student.findMany({ where: { id: { in: rows.map((r) => r.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true } });
        return {
            subtitle: `${f.from} – ${f.to}`,
            rows: rows.map((r) => ({ studentId: r.studentId, day: isoOf(new Date(r.at.getTime() + 5.5 * 3_600_000)), time: clock(r.at), student: fullName(students.find((s) => s.id === r.studentId) ?? { firstName: '' }), by: `${r.name}${r.relation ? ` (${r.relation})` : ''}`, reason: r.reason ?? '', state: r.byKind === 'other' ? (r.status === 'refused' ? 'Not on the list: refused' : r.status === 'waiting' ? 'Not on the list: waiting' : 'Not on the list: allowed') : 'On the list' })),
        };
    },
});

defineReport({
    key: 'visitor_not_out',
    category: 'Visitors',
    label: 'Visitors who didn’t check out',
    description: 'Visits closed by the system at the end of the day (the visitor left without checking out), or still inside.',
    permissions: ['visitor.view'],
    orientation: 'portrait',
    filters: range,
    columns: [
        { key: 'day', label: 'Date', type: 'date', width: 0.8 },
        { key: 'visitor', label: 'Visitor', type: 'text', width: 1.6 },
        { key: 'mobile', label: 'Mobile', type: 'text', width: 1 },
        { key: 'inAt', label: 'In', type: 'text', width: 0.6 },
        { key: 'state', label: 'State', type: 'text', width: 1.2 },
    ],
    async run(f) {
        const visits = await db.visit.findMany({ where: { day: period(f), OR: [{ status: 'in' }, { status: 'out', answerNote: { startsWith: 'Checked out by the system' } }] }, orderBy: { day: 'asc' }, include: { visitor: { select: { name: true, mobile: true } } } });
        return { subtitle: `${f.from} – ${f.to}`, rows: visits.map((v) => ({ day: isoOf(v.day), visitor: v.visitor.name, mobile: v.visitor.mobile ?? '', inAt: clock(v.inAt), state: v.status === 'in' ? 'Still inside' : 'Closed by the system' })) };
    },
});

// ─── Widgets ─────────────────────────────────────────────────────────────────

defineWidget({
    key: 'visitors_now',
    label: 'Visitors now',
    description: 'Visitors inside the school now, waiting at the gate, and expected today.',
    category: 'Today',
    type: 'stat',
    size: 'sm',
    href: '/visitors',
    permissions: ['visitor.gate', 'visitor.view'],
    cacheSeconds: 60,
    async load() {
        const t = await gateToday();
        return { value: t.inside.length, caption: 'inside now', tone: t.waiting.length ? 'warn' : 'neutral', sub: [{ label: 'Came today', value: t.inToday }, { label: 'Waiting for an OK', value: t.waiting.length, tone: t.waiting.length ? 'warn' : undefined }, { label: 'Expected today', value: t.expected.length }] };
    },
});

defineWidget({
    key: 'my_visitors',
    label: 'My visitors',
    description: 'Visitors waiting at the gate for a staff member’s OK, and those they expect.',
    category: 'Today',
    type: 'list',
    size: 'md',
    href: '/visitors/mine',
    permissions: ['visitor.expect'],
    cacheSeconds: 30,
    async load({ userId }) {
        const m = await myVisitors(userId);
        if (!m.waiting.length && !m.expected.length) return { hidden: true, items: [], empty: '' };
        return { items: [...m.waiting.map((v) => ({ title: `${v.visitor.name} is at the gate`, sub: v.purpose ?? undefined, tone: 'warn' as const, href: '/visitors/mine' })), ...m.expected.map((v) => ({ title: `${v.visitor.name} expected`, sub: v.day === todayIST() ? 'today' : v.day, href: '/visitors/mine' }))].slice(0, 6), empty: '' };
    },
});

defineDefaultLayout('security-guard', ['visitors_now', 'my_checkin', 'notices_latest', 'upcoming_events']);
