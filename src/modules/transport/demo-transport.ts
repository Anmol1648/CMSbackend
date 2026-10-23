import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { hashPassword } from '../../core/password';
import { seedMasters } from '../masters/masters.service';
import { currentYear } from '../academic/years.service';
import { dayDate, todayIST } from '../attendance/attendance.settings';
import { metres } from './tracking.service';

/**
 * Demo transport for Joshimath: three routes with their stops on the map, a vehicle each (one
 * paper expiring soon, one expired), the demo drivers with logins (Driver / Bus Helper role),
 * VII-B and some other students on the buses, and yesterday's trips for the history. A live bus is
 * started from Transport → Live Map → "Run a demo bus". Marked is_demo.
 */

const DAY = 86_400_000;
const PASSWORD = 'Demo@2026';

const ROUTES = [
    {
        name: 'Route 1: Marwari',
        code: 'R1',
        color: '#2B6CB0',
        vehicle: { number: 'UK07 PA 1234', name: 'Bus 1', type: 'Bus', capacity: 42, make: 'Tata', model: 'Starbus', year: 2021 },
        morningStart: '07:00',
        stops: [
            ['Marwari Chowk', 30.5702, 79.5551, 700],
            ['Ravigram', 30.5664, 79.5583, 650],
            ['Gandhi Nagar', 30.5631, 79.5607, 600],
            ['Main Market', 30.5598, 79.5622, 500],
        ],
    },
    {
        name: 'Route 2: Sunil – Auli Road',
        code: 'R2',
        color: '#C05621',
        vehicle: { number: 'UK07 PB 4521', name: 'Bus 2', type: 'Bus', capacity: 32, make: 'Eicher', model: 'Skyline', year: 2019 },
        morningStart: '07:05',
        stops: [
            ['Sunil Village', 30.5452, 79.5781, 800],
            ['Auli Road Bend', 30.5481, 79.5735, 700],
            ['Ropeway', 30.5503, 79.5698, 600],
            ['Nrsingh Temple', 30.5528, 79.5671, 500],
        ],
    },
    {
        name: 'Route 3: Singhdhar',
        code: 'R3',
        color: '#2F855A',
        vehicle: { number: 'UK07 TA 0877', name: 'Van 1', type: 'Van', capacity: 12, make: 'Maruti', model: 'Eeco', year: 2022 },
        morningStart: '07:15',
        stops: [
            ['Singhdhar', 30.5489, 79.5552, 600],
            ['Upper Bazaar', 30.5518, 79.5590, 500],
        ],
    },
] as const;

const SCHOOL = { lat: 30.5551, lng: 79.5646 };
const at = (hhmm: string, plus: number) => {
    const m = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) + plus;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export const createDemoTransport = async () => {
    const tenantId = getTenantId()!;
    const year = await currentYear();
    if (!year || (await db.transportRoute.count({ where: { isDemo: true } }))) return { routes: 0, students: 0, trips: 0, drivers: [] as string[] };
    await seedMasters();
    if (!(await db.masterValue.findFirst({ where: { master: 'notification_type', code: 'transport' } })))
        await db.masterValue.create({ data: { tenantId, master: 'notification_type', name: 'Transport', code: 'transport', sortOrder: 99, extra: { icon: 'directions_bus' } } });
    const masters = await db.masterValue.findMany({ where: { master: { in: ['vehicle_type', 'vehicle_document'] } }, select: { id: true, name: true, master: true } });
    const m = (master: string, name: string) => masters.find((x) => x.master === master && x.name === name)?.id ?? null;

    // Drivers (and a helper) get logins with the Driver / Bus Helper role.
    let role = await db.role.findFirst({ where: { slug: 'driver' } });
    role ??= await db.role.create({ data: { tenantId, slug: 'driver', name: 'Driver / Bus Helper', description: 'Runs the trips of their bus (sends its position, marks students on and off).' } });
    const designation = await db.masterValue.findMany({ where: { master: 'designation', name: { in: ['Driver', 'Sub Staff (MTS)'] } }, select: { id: true, name: true } });
    const crew = await db.staff.findMany({ where: { isDemo: true, designationId: { in: designation.map((d) => d.id) } }, orderBy: { employeeCode: 'asc' }, select: { id: true, firstName: true, lastName: true, userId: true, designationId: true } });
    const drivers = crew.filter((c) => designation.find((d) => d.id === c.designationId)?.name === 'Driver');
    const helpers = crew.filter((c) => designation.find((d) => d.id === c.designationId)?.name !== 'Driver');
    const passwordHash = await hashPassword(PASSWORD);
    const logins: string[] = [];
    for (const p of [...drivers, ...helpers.slice(0, 1)]) {
        let userId = p.userId;
        if (!userId) {
            let username = `${p.firstName}.${p.lastName ?? ''}`.toLowerCase().replace(/[^a-z.]/g, '');
            for (let i = 2; await db.user.findFirst({ where: { username } }); i++) username = `${p.firstName}.${p.lastName ?? ''}${i}`.toLowerCase().replace(/[^a-z0-9.]/g, '');
            const u = await db.user.create({ data: { tenantId, kind: 'staff', username, displayName: [p.firstName, p.lastName].filter(Boolean).join(' '), passwordHash, mustChangePassword: false, isDemo: true } });
            await db.staff.update({ where: { id: p.id }, data: { userId: u.id } });
            userId = u.id;
        }
        await db.userRole.createMany({ data: [{ tenantId, userId, roleId: role.id }], skipDuplicates: true });
        const u = await db.user.findFirst({ where: { id: userId }, select: { username: true } });
        if (u) logins.push(u.username);
    }

    // Vehicles, routes and stops.
    const today = todayIST();
    const routes: { id: string; vehicleId: string; stops: { id: string; lat: number; lng: number; morningTime: string; afternoonTime: string }[]; morningStart: string }[] = [];
    for (const [i, r] of ROUTES.entries()) {
        const v = await db.vehicle.create({ data: { tenantId, number: r.vehicle.number, name: r.vehicle.name, typeId: m('vehicle_type', r.vehicle.type), capacity: r.vehicle.capacity, make: r.vehicle.make, model: r.vehicle.model, year: r.vehicle.year, isDemo: true } });
        const papers: [string, number][] = [
            ['Registration (RC)', 2400],
            ['Fitness certificate', i === 1 ? 12 : 200],
            ['Insurance', i === 0 ? 20 : 300],
            ['Permit', 600],
            ['Pollution (PUC)', i === 2 ? -5 : 90],
        ];
        await db.vehicleDocument.createMany({ data: papers.map(([name, days], k) => ({ tenantId, vehicleId: v.id, typeId: m('vehicle_document', name), number: `${r.code}-${k + 1}${String(1000 + i * 37 + k)}`, issuedOn: dayDate(new Date(Date.parse(today) + (days - 365) * DAY).toISOString().slice(0, 10)), expiresOn: dayDate(new Date(Date.parse(today) + days * DAY).toISOString().slice(0, 10)), isDemo: true })) });
        const afternoonStart = '14:00';
        const route = await db.transportRoute.create({ data: { tenantId, name: r.name, code: r.code, vehicleId: v.id, driverId: drivers[i % Math.max(1, drivers.length)]?.id ?? null, helperId: i === 0 ? (helpers[0]?.id ?? null) : null, morningStart: r.morningStart, afternoonStart, schoolLat: SCHOOL.lat, schoolLng: SCHOOL.lng, color: r.color, isDemo: true } });
        const stops = [];
        for (const [k, [name, lat, lng, fare]] of r.stops.entries()) {
            const n = r.stops.length;
            const s = await db.transportStop.create({ data: { tenantId, routeId: route.id, name, lat, lng, sortOrder: k + 1, morningTime: at(r.morningStart, k * 6), afternoonTime: at(afternoonStart, (n - k) * 6), fare, isDemo: true } });
            stops.push({ id: s.id, lat, lng, morningTime: s.morningTime!, afternoonTime: s.afternoonTime! });
        }
        routes.push({ id: route.id, vehicleId: v.id, stops, morningStart: r.morningStart });
    }

    // Students: VII-B (all on Route 1 and 2), and a few from each other section.
    const enrol = await db.enrolment.findMany({ where: { academicYearId: year.id, student: { status: 'active' } }, select: { studentId: true, section: { select: { name: true, schoolClass: { select: { name: true } } } } }, orderBy: { studentId: 'asc' } });
    const viiB = enrol.filter((e) => e.section.name === 'B' && e.section.schoolClass.name === 'Class VII').map((e) => e.studentId);
    const shubham = await db.student.findFirst({ where: { admissionNo: '20250235' }, select: { id: true } });
    const others = enrol.filter((e) => !viiB.includes(e.studentId)).filter((_, k) => k % 9 === 0).map((e) => e.studentId);
    const from = dayDate(year.startDate.toISOString().slice(0, 10));
    const rows = [];
    for (const [k, studentId] of [...viiB, ...others].entries()) {
        // Shubham Nautiyal: Route 1, Gandhi Nagar, both ways.
        const route = studentId === shubham?.id ? routes[0] : routes[k % 3];
        const stop = studentId === shubham?.id ? route.stops[2] : route.stops[k % route.stops.length];
        rows.push({ tenantId, academicYearId: year.id, studentId, routeId: route.id, stopId: stop.id, way: k % 11 === 5 ? 'pickup' : k % 13 === 7 ? 'drop' : 'both', fromDate: from, isDemo: true });
    }
    if (rows.length) await db.studentTransport.createMany({ data: rows });

    // Yesterday's trips (morning and afternoon of each route), with their path and stops.
    const yesterday = new Date(Date.parse(today) - DAY).toISOString().slice(0, 10);
    let trips = 0;
    for (const r of routes) {
        for (const kind of ['morning', 'afternoon'] as const) {
            const path = kind === 'morning' ? [...r.stops, SCHOOL] : [SCHOOL, ...[...r.stops].reverse()];
            const startMin = Number((kind === 'morning' ? r.morningStart : '14:00').slice(0, 2)) * 60 + Number((kind === 'morning' ? r.morningStart : '14:00').slice(3, 5));
            const t0 = new Date(Date.parse(`${yesterday}T00:00:00+05:30`) + startMin * 60_000);
            const late = kind === 'morning' && r === routes[1] ? 12 : 0;
            const points: { tenantId: string; tripId: string; lat: number; lng: number; speed: number; at: Date }[] = [];
            const events: { tenantId: string; tripId: string; kind: string; stopId?: string; at: Date; note?: string }[] = [];
            const trip = await db.trip.create({ data: { tenantId, routeId: r.id, vehicleId: r.vehicleId, kind, day: dayDate(yesterday), startedAt: t0, status: 'done', source: 'simulated', isDemo: true } });
            let clock = t0.getTime() + late * 60_000;
            events.push({ tenantId, tripId: trip.id, kind: 'start', at: t0 });
            for (let j = 0; j < path.length - 1; j++) {
                const a = path[j];
                const b = path[j + 1];
                const secs = (metres(a, b) / 1000 / 22) * 3600;
                for (let s = 0; s < 6; s++) points.push({ tenantId, tripId: trip.id, lat: a.lat + ((b.lat - a.lat) * s) / 6, lng: a.lng + ((b.lng - a.lng) * s) / 6, speed: 18 + ((j + s) % 4) * 4, at: new Date(clock + (secs * 1000 * s) / 6) });
                clock += secs * 1000 + 60_000;
                const stop = 'id' in b ? (b as { id: string }) : null;
                if (stop) events.push({ tenantId, tripId: trip.id, kind: 'stop', stopId: stop.id, at: new Date(clock) });
            }
            if (late) events.push({ tenantId, tripId: trip.id, kind: 'late', note: `${late} min`, at: new Date(t0.getTime() + 15 * 60_000) });
            const end = path[path.length - 1];
            points.push({ tenantId, tripId: trip.id, lat: end.lat, lng: end.lng, speed: 0, at: new Date(clock) });
            events.push({ tenantId, tripId: trip.id, kind: 'end', at: new Date(clock) });
            await db.tripPoint.createMany({ data: points });
            await db.tripEvent.createMany({ data: events });
            await db.trip.update({ where: { id: trip.id }, data: { endedAt: new Date(clock), nextStop: r.stops.length, delayMin: late, lastLat: end.lat, lastLng: end.lng, lastAt: new Date(clock) } });
            trips++;
        }
    }
    return { routes: routes.length, students: rows.length, trips, drivers: logins };
};

export const clearDemoTransport = async () => {
    const routes = (await db.transportRoute.findMany({ where: { isDemo: true }, select: { id: true } })).map((r) => r.id);
    await db.trip.deleteMany({ where: { OR: [{ isDemo: true }, { routeId: { in: routes } }] } });
    await db.studentTransport.deleteMany({ where: { OR: [{ isDemo: true }, { routeId: { in: routes } }] } });
    await db.transportRoute.deleteMany({ where: { isDemo: true } });
    await db.vehicle.deleteMany({ where: { isDemo: true } });
};
