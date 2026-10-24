import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { fullName } from '../students/students.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { currentYear } from '../academic/years.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { defineReport, registerReportCategory } from '../reports/reports.registry';
import { defineDefaultLayout, defineWidget } from '../dashboard/dashboard.registry';

/** Hostel reports (Report Center) and a dashboard widget. */

registerReportCategory('Hostel', 62);

const VIEW = ['hostel.view', 'hostel.warden', 'hostel.setup'];
const range = [
    { key: 'from', label: 'From', type: 'date' as const, required: true, default: 'monthStart' },
    { key: 'to', label: 'To', type: 'date' as const, required: true, default: 'today' },
];
const between = (f: Record<string, string>) => {
    if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
    return { gte: dayDate(f.from), lt: new Date(dayDate(f.to).getTime() + 86_400_000) };
};
const when = (d: Date | null) => (d ? d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' }) : '');
const studentsOf = async (ids: string[]) => {
    const year = await currentYear();
    const [st, en] = await Promise.all([db.student.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } }), year ? db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: ids } }, select: { studentId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } }) : []]);
    return (id: string) => {
        const s = st.find((x) => x.id === id);
        const e = en.find((x) => x.studentId === id);
        return { name: s ? fullName(s) : '', admissionNo: s?.admissionNo ?? '', section: e ? sectionLabel(e.section) : '' };
    };
};

defineReport({
    key: 'hostel_boarders',
    category: 'Hostel',
    label: 'Boarders by room',
    description: 'Every boarder with the room and bed, grouped by hostel.',
    permissions: VIEW,
    orientation: 'portrait',
    about: 'student',
    filters: [],
    columns: [
        { key: 'room', label: 'Room', type: 'text', width: 0.6 },
        { key: 'bed', label: 'Bed', type: 'number', width: 0.4 },
        { key: 'name', label: 'Student', type: 'text', width: 1.6 },
        { key: 'admissionNo', label: 'Adm. no.', type: 'text', width: 0.8 },
        { key: 'section', label: 'Class', type: 'text', width: 0.7 },
        { key: 'since', label: 'Since', type: 'date', width: 0.7 },
    ],
    async run() {
        const allots = await db.hostelAllotment.findMany({ where: { status: 'active' } });
        const [hostels, rooms, of] = await Promise.all([db.hostel.findMany({ select: { id: true, name: true } }), db.hostelRoom.findMany({ where: { id: { in: allots.map((a) => a.roomId) } }, select: { id: true, number: true } }), studentsOf(allots.map((a) => a.studentId))]);
        return {
            subtitle: `${allots.length} boarders`,
            groupedBy: 'Hostel',
            rows: allots
                .map((a) => ({ studentId: a.studentId, groupKey: a.hostelId, groupLabel: hostels.find((h) => h.id === a.hostelId)?.name ?? '', room: rooms.find((r) => r.id === a.roomId)?.number ?? '', bed: a.bed, ...of(a.studentId), since: isoOf(a.fromDate) }))
                .sort((x, y) => x.groupLabel.localeCompare(y.groupLabel) || x.room.localeCompare(y.room, 'en', { numeric: true }) || x.bed - y.bed),
        };
    },
});

defineReport({
    key: 'hostel_occupancy',
    category: 'Hostel',
    label: 'Occupancy',
    description: 'Rooms, beds, boarders and empty beds of each hostel and room type.',
    permissions: VIEW,
    orientation: 'portrait',
    filters: [],
    columns: [
        { key: 'hostel', label: 'Hostel', type: 'text', width: 1.4 },
        { key: 'type', label: 'Room type', type: 'text', width: 1.2 },
        { key: 'rooms', label: 'Rooms', type: 'number', width: 0.5, total: true },
        { key: 'beds', label: 'Beds', type: 'number', width: 0.5, total: true },
        { key: 'used', label: 'Boarders', type: 'number', width: 0.6, total: true },
        { key: 'free', label: 'Empty beds', type: 'number', width: 0.6, total: true },
    ],
    async run() {
        const [hostels, rooms, allots, types] = await Promise.all([db.hostel.findMany({ select: { id: true, name: true } }), db.hostelRoom.findMany({ where: { isActive: true } }), db.hostelAllotment.groupBy({ by: ['roomId'], where: { status: 'active' }, _count: { _all: true } }), db.masterValue.findMany({ where: { master: 'hostel_room_type' }, select: { id: true, name: true } })]);
        const rows = new Map<string, { hostel: string; type: string; rooms: number; beds: number; used: number; free: number }>();
        for (const r of rooms) {
            const k = `${r.hostelId}|${r.roomTypeId ?? ''}`;
            const row = rows.get(k) ?? { hostel: hostels.find((h) => h.id === r.hostelId)?.name ?? '', type: types.find((t) => t.id === r.roomTypeId)?.name ?? '—', rooms: 0, beds: 0, used: 0, free: 0 };
            const used = allots.find((a) => a.roomId === r.id)?._count._all ?? 0;
            row.rooms++;
            row.beds += r.beds;
            row.used += used;
            row.free += Math.max(0, r.beds - used);
            rows.set(k, row);
        }
        return { rows: [...rows.values()].sort((a, b) => a.hostel.localeCompare(b.hostel) || a.type.localeCompare(b.type)) };
    },
});

defineReport({
    key: 'hostel_absences',
    category: 'Hostel',
    label: 'Roll call absences',
    description: 'Boarders marked absent at the night roll call in a period.',
    permissions: VIEW,
    orientation: 'portrait',
    about: 'student',
    filters: range,
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 0.7 },
        { key: 'hostel', label: 'Hostel', type: 'text', width: 1.2 },
        { key: 'name', label: 'Student', type: 'text', width: 1.6 },
        { key: 'admissionNo', label: 'Adm. no.', type: 'text', width: 0.8 },
        { key: 'section', label: 'Class', type: 'text', width: 0.7 },
    ],
    async run(f) {
        const rcs = await db.hostelRollCall.findMany({ where: { date: between(f) }, orderBy: { date: 'asc' } });
        const absent = rcs.flatMap((r) => Object.entries((r.marks ?? {}) as Record<string, string>).filter(([, m]) => m === 'absent').map(([id]) => ({ id, r })));
        const [hostels, of] = await Promise.all([db.hostel.findMany({ select: { id: true, name: true } }), studentsOf(absent.map((a) => a.id))]);
        return { subtitle: `${f.from} – ${f.to} · ${rcs.length} roll calls`, rows: absent.map(({ id, r }) => ({ studentId: id, date: isoOf(r.date), hostel: hostels.find((h) => h.id === r.hostelId)?.name ?? '', ...of(id) })) };
    },
});

defineReport({
    key: 'hostel_leave',
    category: 'Hostel',
    label: 'Leave register',
    description: 'Hostel leave in a period: when they went out and came back, and late returns.',
    permissions: [...VIEW, 'hostel.gate'],
    orientation: 'landscape',
    about: 'student',
    filters: [...range, { key: 'late', label: 'Show', type: 'select', default: '', options: [{ value: '', label: 'All' }, { value: 'late', label: 'Late returns only' }] }],
    columns: [
        { key: 'name', label: 'Student', type: 'text', width: 1.5 },
        { key: 'section', label: 'Class', type: 'text', width: 0.6 },
        { key: 'from', label: 'From', type: 'text', width: 1 },
        { key: 'to', label: 'To', type: 'text', width: 1 },
        { key: 'reason', label: 'Reason', type: 'text', width: 1.4 },
        { key: 'out', label: 'Went out', type: 'text', width: 1 },
        { key: 'in', label: 'Came back', type: 'text', width: 1 },
        { key: 'status', label: 'Status', type: 'text', width: 0.8 },
    ],
    async run(f) {
        const rows = await db.hostelLeave.findMany({ where: { fromAt: between(f), ...(f.late ? { late: true } : {}) }, orderBy: { fromAt: 'asc' } });
        const of = await studentsOf(rows.map((r) => r.studentId));
        return { subtitle: `${f.from} – ${f.to}`, rows: rows.map((r) => ({ studentId: r.studentId, ...of(r.studentId), from: when(r.fromAt), to: when(r.toAt), reason: r.reason, out: when(r.outAt), in: when(r.inAt), status: r.late ? 'Back late' : r.status[0].toUpperCase() + r.status.slice(1) })) };
    },
});

defineReport({
    key: 'hostel_medical',
    category: 'Hostel',
    label: 'Sick bay register',
    description: 'Sick-bay visits of boarders in a period.',
    permissions: VIEW,
    orientation: 'portrait',
    about: 'student',
    filters: range,
    columns: [
        { key: 'at', label: 'When', type: 'text', width: 0.9 },
        { key: 'name', label: 'Student', type: 'text', width: 1.4 },
        { key: 'complaint', label: 'Complaint', type: 'text', width: 1.4 },
        { key: 'treatment', label: 'Treatment / medicine', type: 'text', width: 1.6 },
        { key: 'referred', label: 'Referred', type: 'text', width: 0.5 },
    ],
    async run(f) {
        const rows = await db.hostelMedical.findMany({ where: { at: between(f) }, orderBy: { at: 'asc' } });
        const of = await studentsOf(rows.map((r) => r.studentId));
        return { subtitle: `${f.from} – ${f.to}`, rows: rows.map((r) => ({ studentId: r.studentId, at: when(r.at), name: of(r.studentId).name, complaint: r.complaint, treatment: [r.treatment, r.medicine].filter(Boolean).join(' · '), referred: r.referred ? 'Yes' : '' })) };
    },
});

defineReport({
    key: 'hostel_fines',
    category: 'Hostel',
    label: 'Inspections and fines',
    description: 'Room inspections and fines in a period (fines go into the fees).',
    permissions: VIEW,
    orientation: 'portrait',
    filters: [...range, { key: 'kind', label: 'Show', type: 'select', default: '', options: [{ value: '', label: 'All' }, { value: 'fine', label: 'Fines only' }, { value: 'inspection', label: 'Inspections only' }] }],
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 0.7 },
        { key: 'hostel', label: 'Hostel', type: 'text', width: 1.1 },
        { key: 'room', label: 'Room', type: 'text', width: 0.5 },
        { key: 'name', label: 'Student', type: 'text', width: 1.3 },
        { key: 'note', label: 'Note', type: 'text', width: 2 },
        { key: 'fine', label: 'Fine', type: 'money', width: 0.6, total: true },
    ],
    async run(f) {
        const rows = await db.hostelNote.findMany({ where: { at: between(f), ...(f.kind ? { kind: f.kind } : {}) }, orderBy: { at: 'asc' } });
        const [hostels, rooms, of] = await Promise.all([db.hostel.findMany({ select: { id: true, name: true } }), db.hostelRoom.findMany({ where: { id: { in: rows.map((r) => r.roomId!).filter(Boolean) } }, select: { id: true, number: true } }), studentsOf(rows.map((r) => r.studentId!).filter(Boolean))]);
        return { subtitle: `${f.from} – ${f.to}`, rows: rows.map((r) => ({ date: isoOf(r.at), hostel: hostels.find((h) => h.id === r.hostelId)?.name ?? '', room: rooms.find((x) => x.id === r.roomId)?.number ?? '', name: r.studentId ? of(r.studentId).name : '', note: r.note, fine: r.fine ?? 0 })) };
    },
});

defineWidget({
    key: 'hostel_status',
    label: 'Hostel',
    description: 'Boarders, empty beds, tonight’s roll call, leave to answer and boarders out.',
    category: 'Today',
    type: 'stat',
    size: 'sm',
    href: '/hostel/leave',
    permissions: VIEW,
    cacheSeconds: 300,
    async load() {
        const today = todayIST();
        const [boarders, beds, hostels, taken, pending, out, late] = await Promise.all([
            db.hostelAllotment.count({ where: { status: 'active' } }),
            db.hostelRoom.aggregate({ where: { isActive: true }, _sum: { beds: true } }),
            db.hostel.count({ where: { isActive: true } }),
            db.hostelRollCall.count({ where: { date: dayDate(today) } }),
            db.hostelLeave.count({ where: { status: 'pending' } }),
            db.hostelLeave.count({ where: { status: 'out' } }),
            db.hostelLeave.count({ where: { status: 'out', toAt: { lt: new Date() } } }),
        ]);
        return { value: boarders, caption: `boarders · ${Math.max(0, (beds._sum.beds ?? 0) - boarders)} empty beds`, tone: late || pending ? 'warn' : 'neutral', sub: [{ label: 'Leave to answer', value: pending, tone: pending ? 'warn' : undefined }, { label: 'Out on leave', value: out }, { label: 'Overdue back', value: late, tone: late ? 'bad' : undefined }, { label: 'Roll calls taken today', value: `${taken} / ${hostels}` }] };
    },
});

defineDefaultLayout('warden', ['hostel_status', 'my_checkin', 'approvals', 'my_leave', 'notices_latest', 'upcoming_events']);
