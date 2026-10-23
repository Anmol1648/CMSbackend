import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { currentYear } from '../academic/years.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { computeDues, dueStudents } from '../fees/dues.service';
import { defineReport, registerReportCategory } from '../reports/reports.registry';
import { TRANSPORT } from './transport.settings';

/** Transport reports (Report Center): who uses which bus, seats, fees, papers, punctuality. */

registerReportCategory('Transport', 42);

const VIEW = ['transport.view', 'transport.manage', 'transport.track_all'];
const WAY: Record<string, string> = { both: 'Both ways', pickup: 'Morning only', drop: 'Afternoon only' };
const wayFilter = { key: 'way', label: 'Which way', type: 'select' as const, default: '', options: [{ value: '', label: 'All' }, { value: 'both', label: 'Both ways' }, { value: 'pickup', label: 'Morning only' }, { value: 'drop', label: 'Afternoon only' }] };

/** Students using the bus today (or on a day), with their route, stop and section. */
const riders = async (on: string, way?: string) => {
    const year = await currentYear();
    if (!year) return { year: null, rows: [] };
    const day = dayDate(on);
    const rows = await db.studentTransport.findMany({ where: { academicYearId: year.id, fromDate: { lte: day }, OR: [{ toDate: null }, { toDate: { gte: day } }], ...(way ? { way } : {}) } });
    const [students, enrol, routes, stops] = await Promise.all([
        db.student.findMany({ where: { id: { in: rows.map((r) => r.studentId) }, status: 'active' }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } }),
        db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: rows.map((r) => r.studentId) } }, select: { studentId: true, rollNumber: true, section: { select: { name: true, sortOrder: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } } } } }),
        db.transportRoute.findMany({ select: { id: true, name: true } }),
        db.transportStop.findMany({ select: { id: true, name: true, sortOrder: true, fare: true, morningTime: true } }),
    ]);
    const out = rows
        .map((r) => {
            const s = students.find((x) => x.id === r.studentId);
            const e = enrol.find((x) => x.studentId === r.studentId);
            const st = stops.find((x) => x.id === r.stopId);
            return s ? { r, s, e, route: routes.find((x) => x.id === r.routeId)?.name ?? '', stop: st } : null;
        })
        .filter((x): x is NonNullable<typeof x> => !!x);
    return { year, rows: out };
};

defineReport({
    key: 'transport_students',
    category: 'Transport',
    label: 'Students by route and stop',
    description: 'Every student who comes by bus, grouped by route, in stop order: class, which way, from when, and the fare.',
    permissions: VIEW,
    orientation: 'landscape',
    about: 'student',
    filters: [{ key: 'on', label: 'On', type: 'date', required: true, default: 'today' }, wayFilter],
    columns: [
        { key: 'stop', label: 'Stop', type: 'text', width: 1.4 },
        { key: 'time', label: 'Morning', type: 'text', width: 0.6 },
        { key: 'student', label: 'Student', type: 'text', width: 1.7 },
        { key: 'admissionNo', label: 'Adm. no.', type: 'text', width: 0.8 },
        { key: 'section', label: 'Class', type: 'text', width: 0.8 },
        { key: 'way', label: 'Way', type: 'text', width: 0.9 },
        { key: 'from', label: 'Since', type: 'date', width: 0.8 },
        { key: 'fare', label: 'Fare', type: 'money', width: 0.7, total: true },
    ],
    async run(f) {
        const { rows } = await riders(f.on, f.way || undefined);
        const { pct } = await getSettings({ pct: TRANSPORT.oneWayPercent });
        return {
            groupedBy: 'Route',
            subtitle: [f.on, f.way ? WAY[f.way] : ''].filter(Boolean).join(' · '),
            rows: rows
                .sort((a, b) => a.route.localeCompare(b.route) || (a.stop?.sortOrder ?? 0) - (b.stop?.sortOrder ?? 0) || fullName(a.s).localeCompare(fullName(b.s)))
                .map((x) => {
                    const fare = x.r.fare ?? x.stop?.fare ?? 0;
                    return { groupKey: x.route, groupLabel: x.route, studentId: x.s.id, stop: x.stop?.name ?? '', time: x.stop?.morningTime ?? '', student: fullName(x.s), admissionNo: x.s.admissionNo, section: x.e ? sectionLabel(x.e.section) : '', way: WAY[x.r.way] ?? x.r.way, from: isoOf(x.r.fromDate), fare: x.r.way === 'both' ? fare : Math.round((fare * pct) / 100) };
                }),
        };
    },
});

defineReport({
    key: 'transport_seats',
    category: 'Transport',
    label: 'Seats used per bus',
    description: 'Each route’s vehicle, its seats, how many students use it in the morning and in the afternoon, and seats free.',
    permissions: VIEW,
    orientation: 'portrait',
    filters: [{ key: 'on', label: 'On', type: 'date', required: true, default: 'today' }],
    columns: [
        { key: 'route', label: 'Route', type: 'text', width: 1.6 },
        { key: 'vehicle', label: 'Vehicle', type: 'text', width: 1.4 },
        { key: 'driver', label: 'Driver', type: 'text', width: 1.2 },
        { key: 'seats', label: 'Seats', type: 'number', width: 0.6, total: true },
        { key: 'morning', label: 'Morning', type: 'number', width: 0.7, total: true },
        { key: 'afternoon', label: 'Afternoon', type: 'number', width: 0.7, total: true },
        { key: 'free', label: 'Free (busier trip)', type: 'number', width: 0.8, total: true },
        { key: 'used', label: 'Used %', type: 'number', width: 0.6 },
    ],
    async run(f) {
        const { rows } = await riders(f.on);
        const routes = await db.transportRoute.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
        const [vehicles, staff] = await Promise.all([db.vehicle.findMany({ select: { id: true, name: true, number: true, capacity: true } }), db.staff.findMany({ where: { id: { in: routes.map((r) => r.driverId!).filter(Boolean) } }, select: { id: true, firstName: true, middleName: true, lastName: true } })]);
        return {
            subtitle: f.on,
            rows: routes.map((r) => {
                const v = vehicles.find((x) => x.id === r.vehicleId);
                const d = staff.find((x) => x.id === r.driverId);
                const mine = rows.filter((x) => x.r.routeId === r.id);
                const morning = mine.filter((x) => x.r.way !== 'drop').length;
                const afternoon = mine.filter((x) => x.r.way !== 'pickup').length;
                const seats = v?.capacity ?? 0;
                const busier = Math.max(morning, afternoon);
                return { route: r.name, vehicle: v ? `${v.name} (${v.number})` : '—', driver: d ? fullName(d) : '—', seats, morning, afternoon, free: seats - busier, used: seats ? Math.round((busier / seats) * 1000) / 10 : null };
            }),
        };
    },
});

defineReport({
    key: 'transport_fees',
    category: 'Transport',
    label: 'Transport fees (charged, paid, due)',
    description: 'For each student on the bus: the transport fee charged so far this session, paid, and still due, grouped by route.',
    permissions: ['fee.reports', 'transport.manage'],
    orientation: 'landscape',
    about: 'student',
    filters: [{ key: 'only', label: 'Show', type: 'select', default: '', options: [{ value: '', label: 'Everyone on the bus' }, { value: 'due', label: 'Only those with fees due' }] }],
    columns: [
        { key: 'student', label: 'Student', type: 'text', width: 1.7 },
        { key: 'admissionNo', label: 'Adm. no.', type: 'text', width: 0.8 },
        { key: 'section', label: 'Class', type: 'text', width: 0.8 },
        { key: 'stop', label: 'Stop', type: 'text', width: 1.2 },
        { key: 'charged', label: 'Charged', type: 'money', width: 0.8, total: true },
        { key: 'paid', label: 'Paid', type: 'money', width: 0.8, total: true },
        { key: 'due', label: 'Due', type: 'money', width: 0.8, total: true },
        { key: 'overdue', label: 'Overdue', type: 'money', width: 0.8, total: true },
    ],
    async run(f) {
        const { year, rows } = await riders(todayIST());
        if (!year) return { rows: [] };
        const { code } = await getSettings({ code: TRANSPORT.feeHeadCode });
        const head = await db.masterValue.findFirst({ where: { master: 'fee_head', code: { equals: code, mode: 'insensitive' } }, select: { id: true } });
        if (!head) throw badRequest(`No fee head with the code ${code} (System Settings → Transport)`);
        const ids = rows.map((x) => x.s.id);
        const dues = await computeDues(year.id, await dueStudents(year.id, { id: { in: ids } }));
        const today = todayIST();
        const out = rows.map((x) => {
            const d = dues.get(x.s.id);
            let charged = 0;
            let paid = 0;
            let overdue = 0;
            for (const inst of d?.instalments ?? []) {
                for (const l of inst.lines.filter((l) => l.feeHeadId === head.id)) {
                    if (inst.dueDate > today && !l.paid) continue; // not charged yet
                    charged += l.net;
                    paid += l.paid;
                    if (inst.dueDate < today) overdue += l.balance;
                }
            }
            return { groupKey: x.route, groupLabel: x.route, studentId: x.s.id, student: fullName(x.s), admissionNo: x.s.admissionNo, section: x.e ? sectionLabel(x.e.section) : '', stop: x.stop?.name ?? '', charged, paid, due: charged - paid, overdue };
        });
        return {
            groupedBy: 'Route',
            subtitle: `${year.name} · up to ${today}`,
            rows: out.filter((r) => f.only !== 'due' || r.due > 0).sort((a, b) => a.groupKey.localeCompare(b.groupKey) || a.student.localeCompare(b.student)),
        };
    },
});

defineReport({
    key: 'vehicle_papers',
    category: 'Transport',
    label: 'Vehicle papers and expiry',
    description: 'Each vehicle’s papers (fitness, insurance, permit, PUC…) with their expiry, the expired and those expiring soon first.',
    permissions: VIEW,
    orientation: 'portrait',
    filters: [{ key: 'show', label: 'Show', type: 'select', default: '', options: [{ value: '', label: 'All papers' }, { value: 'soon', label: 'Expired or expiring soon' }] }],
    columns: [
        { key: 'vehicle', label: 'Vehicle', type: 'text', width: 1.4 },
        { key: 'paper', label: 'Paper', type: 'text', width: 1.3 },
        { key: 'number', label: 'Number', type: 'text', width: 1 },
        { key: 'expiresOn', label: 'Expires', type: 'date', width: 0.8 },
        { key: 'state', label: 'State', type: 'text', width: 0.9 },
    ],
    async run(f) {
        const { days } = await getSettings({ days: TRANSPORT.docRemindDays });
        const today = todayIST();
        const soon = isoOf(new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000));
        const [docs, types] = await Promise.all([db.vehicleDocument.findMany({ include: { vehicle: { select: { name: true, number: true, isActive: true } } } }), db.masterValue.findMany({ where: { master: 'vehicle_document' }, select: { id: true, name: true } })]);
        const rows = docs
            .filter((d) => d.vehicle.isActive)
            .map((d) => {
                const exp = d.expiresOn ? isoOf(d.expiresOn) : null;
                const state = !exp ? 'No expiry' : exp < today ? 'Expired' : exp <= soon ? 'Expiring soon' : 'Valid';
                return { vehicle: `${d.vehicle.name} (${d.vehicle.number})`, paper: types.find((t) => t.id === d.typeId)?.name ?? 'Paper', number: d.number ?? '', expiresOn: exp, state, rank: state === 'Expired' ? 0 : state === 'Expiring soon' ? 1 : 2 };
            })
            .filter((r) => f.show !== 'soon' || r.rank < 2)
            .sort((a, b) => a.rank - b.rank || (a.expiresOn ?? '9999').localeCompare(b.expiresOn ?? '9999'));
        return { subtitle: f.show === 'soon' ? `Expired or expiring within ${days} days` : undefined, rows: rows.map(({ rank: _r, ...r }) => r) };
    },
});

defineReport({
    key: 'transport_punctuality',
    category: 'Transport',
    label: 'Trips on time (by route)',
    description: 'For a period: each route’s trips, how many were late and by how much on average, SOS and over-speed alerts.',
    permissions: ['transport.track_all'],
    orientation: 'landscape',
    filters: [
        { key: 'from', label: 'From', type: 'date', required: true, default: 'monthStart' },
        { key: 'to', label: 'To', type: 'date', required: true, default: 'today' },
    ],
    columns: [
        { key: 'route', label: 'Route', type: 'text', width: 1.6 },
        { key: 'trips', label: 'Trips', type: 'number', width: 0.6, total: true },
        { key: 'late', label: 'Late (5+ min)', type: 'number', width: 0.8, total: true },
        { key: 'avgLate', label: 'Avg. late (min)', type: 'number', width: 0.8 },
        { key: 'maxLate', label: 'Most late (min)', type: 'number', width: 0.8 },
        { key: 'sos', label: 'SOS', type: 'number', width: 0.5, total: true },
        { key: 'overspeed', label: 'Over speed', type: 'number', width: 0.7, total: true },
    ],
    async run(f) {
        if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
        const trips = await db.trip.findMany({ where: { day: { gte: dayDate(f.from), lte: dayDate(f.to) }, status: 'done', source: { not: 'simulated' } }, select: { id: true, routeId: true, delayMin: true } });
        const events = await db.tripEvent.groupBy({ by: ['tripId', 'kind'], where: { tripId: { in: trips.map((t) => t.id) }, kind: { in: ['sos', 'overspeed'] } }, _count: { _all: true } });
        const routes = await db.transportRoute.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } });
        return {
            subtitle: `${f.from} – ${f.to} (demo buses not counted)`,
            rows: routes
                .map((r) => {
                    const mine = trips.filter((t) => t.routeId === r.id);
                    const late = mine.filter((t) => t.delayMin >= 5);
                    const n = (k: string) => events.filter((e) => e.kind === k && mine.some((t) => t.id === e.tripId)).reduce((a, e) => a + e._count._all, 0);
                    return { route: r.name, trips: mine.length, late: late.length, avgLate: late.length ? Math.round(late.reduce((a, t) => a + t.delayMin, 0) / late.length) : 0, maxLate: Math.max(0, ...mine.map((t) => t.delayMin)), sos: n('sos'), overspeed: n('overspeed') };
                })
                .filter((r) => r.trips),
        };
    },
});
