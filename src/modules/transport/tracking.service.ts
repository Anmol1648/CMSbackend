import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId, runAsSystem, runAsTenant } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { logger } from '../../core/logger';
import { getUserAccess } from '../rbac/access.service';
import { currentYear } from '../academic/years.service';
import { fullName } from '../students/students.service';
import { dayDate, isoOf, minutesIST, todayIST } from '../attendance/attendance.settings';
import { raiseLater } from '../alerts/deliver';
import { defineDailyJob } from '../alerts/jobs';
import { holdersOf, parentsOf, Recipient, studentsOf } from '../alerts/recipients';
import { TRANSPORT } from './transport.settings';

/**
 * Live tracking: the driver (or helper) starts a trip on their phone; it sends the bus's position
 * every few seconds. Each position moves the trip along its stops (reached within N metres), works
 * out how late it is and when it reaches the stops ahead, and tells parents: started, near their
 * stop, late, got on / off, reached school. Parents see only their child's bus, only during trips.
 */

type Kind = 'morning' | 'afternoon' | 'special';
type Point = { lat: number; lng: number };

/** Metres between two points. */
export const metres = (a: Point, b: Point) => {
    const R = 6_371_000;
    const rad = (d: number) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
};
const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const minutesOf = (t: string | null) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
const clock = (d = new Date()) => d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });

/** A route's stops in the order the trip visits them (afternoon: from school, the other way). */
const stopsFor = async (routeId: string, kind: Kind) => {
    const stops = await db.transportStop.findMany({ where: { routeId, isActive: true }, orderBy: { sortOrder: 'asc' } });
    return kind === 'afternoon' ? stops.reverse() : stops;
};
const timeOf = (s: { morningTime: string | null; afternoonTime: string | null }, kind: Kind) => (kind === 'afternoon' ? s.afternoonTime : s.morningTime);

/** Students who use a route today on this trip (pickup in the morning, drop in the afternoon). */
const ridersOf = async (routeId: string, kind: Kind) => {
    const year = await currentYear();
    if (!year) return [];
    const today = dayDate(todayIST());
    const rows = await db.studentTransport.findMany({
        where: { academicYearId: year.id, routeId, fromDate: { lte: today }, OR: [{ toDate: null }, { toDate: { gte: today } }], ...(kind === 'morning' ? { way: { in: ['both', 'pickup'] } } : kind === 'afternoon' ? { way: { in: ['both', 'drop'] } } : {}) },
        select: { studentId: true, stopId: true },
    });
    const active = new Set((await db.student.findMany({ where: { id: { in: rows.map((r) => r.studentId) }, status: 'active' }, select: { id: true } })).map((s) => s.id));
    return rows.filter((r) => active.has(r.studentId));
};

const routeLabel = async (routeId: string, vehicleId: string | null) => {
    const [r, v] = await Promise.all([db.transportRoute.findFirst({ where: { id: routeId }, select: { name: true } }), vehicleId ? db.vehicle.findFirst({ where: { id: vehicleId }, select: { name: true, number: true } }) : null]);
    return { route: r?.name ?? '', vehicle: v ? `${v.name} (${v.number})` : '' };
};

/** Tells the families of some riders (each parent hears about their own children). */
const tellFamilies = async (key: string, studentIds: string[], vars: Record<string, string>, dedupe: string) => {
    if (!studentIds.length) return;
    const names = new Map((await db.student.findMany({ where: { id: { in: studentIds } }, select: { id: true, firstName: true, middleName: true, lastName: true } })).map((s) => [s.id, fullName(s)]));
    raiseLater(key, { parent: () => parentsOf(studentIds), student: () => studentsOf(studentIds) }, vars, { dedupe, perRecipient: (r: Recipient) => ({ student: ((r as Recipient & { studentIds?: string[] }).studentIds ?? []).map((x) => names.get(x)).filter(Boolean).join(', ') }) });
};

// ─── Who drives what ─────────────────────────────────────────────────────────

const powers = async (userId: string) => {
    const a = await getUserAccess(userId);
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    return { all: !!a.permissions['transport.track_all'] || !!a.permissions['transport.manage'], drive: !!a.permissions['transport.drive'], staffId: staff?.id ?? null };
};

const mayRun = async (userId: string, routeId: string) => {
    const p = await powers(userId);
    if (p.all && p.drive) return true;
    if (!p.drive || !p.staffId) return false;
    return !!(await db.transportRoute.findFirst({ where: { id: routeId, OR: [{ driverId: p.staffId }, { helperId: p.staffId }] }, select: { id: true } }));
};

/** The driver's screen: their routes, today's trips, and the one running. */
export const myDriving = async (userId: string) => {
    const p = await powers(userId);
    if (!p.drive) throw forbidden();
    const routes = await db.transportRoute.findMany({ where: { isActive: true, ...(p.all ? {} : { OR: [{ driverId: p.staffId ?? '00000000-0000-0000-0000-000000000000' }, { helperId: p.staffId ?? '00000000-0000-0000-0000-000000000000' }] }) }, orderBy: { name: 'asc' } });
    const trips = await db.trip.findMany({ where: { routeId: { in: routes.map((r) => r.id) }, day: dayDate(todayIST()) }, orderBy: { startedAt: 'asc' } });
    const { ping } = await getSettings({ ping: TRANSPORT.pingSeconds });
    return {
        pingSeconds: ping,
        routes: routes.map((r) => ({ id: r.id, name: r.name, morningStart: r.morningStart, afternoonStart: r.afternoonStart, trips: trips.filter((t) => t.routeId === r.id).map((t) => ({ id: t.id, kind: t.kind, status: t.status, startedAt: t.startedAt, endedAt: t.endedAt })) })),
        running: trips.find((t) => t.status === 'running' && t.source !== 'simulated')?.id ?? null,
    };
};

// ─── A trip ──────────────────────────────────────────────────────────────────

export const startSchema = z.strictObject({ routeId: z.uuid(), kind: z.enum(['morning', 'afternoon', 'special']), source: z.enum(['phone', 'simulated']).default('phone') });

export const startTrip = async (input: z.infer<typeof startSchema>, userId: string | null) => {
    if (userId && !(await mayRun(userId, input.routeId))) throw forbidden('You don’t drive or help on this route');
    const r = await db.transportRoute.findFirst({ where: { id: input.routeId } });
    if (!r) throw notFound('Route not found');
    if (await db.trip.findFirst({ where: { routeId: r.id, status: 'running' } })) throw badRequest('A trip of this route is already running; end it first');
    const t = await db.trip.create({ data: { tenantId: getTenantId()!, routeId: r.id, vehicleId: r.vehicleId, userId, kind: input.kind, day: dayDate(todayIST()), source: input.source, isDemo: input.source === 'simulated' } });
    await db.tripEvent.create({ data: { tenantId: getTenantId()!, tripId: t.id, kind: 'start', userId } });
    const riders = await ridersOf(r.id, input.kind);
    const label = await routeLabel(r.id, r.vehicleId);
    if (input.kind !== 'special') await tellFamilies('bus_started', riders.map((x) => x.studentId), { ...label, time: clock(), trip: input.kind }, `bus-start:${t.id}`);
    await recordAudit({ action: 'trip_started', entity: 'trip', entityId: t.id, changes: { route: r.name, kind: input.kind } });
    return tripView(t.id);
};

export const pingSchema = z.strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), speed: z.number().min(0).max(300).nullable().optional(), accuracy: z.number().min(0).max(100_000).nullable().optional() });

/** A position from the bus: moves the trip along its stops, and alerts as it goes. */
export const ping = async (tripId: string, input: z.infer<typeof pingSchema>, userId: string | null) => {
    const t = await db.trip.findFirst({ where: { id: tripId } });
    if (!t) throw notFound('Trip not found');
    if (t.status !== 'running') throw badRequest('This trip has ended');
    if (userId && t.userId !== userId && !(await mayRun(userId, t.routeId))) throw forbidden();
    const s = await getSettings({ radius: TRANSPORT.stopRadius, near: TRANSPORT.nearMinutes, late: TRANSPORT.lateMinutes, over: TRANSPORT.overspeed, avg: TRANSPORT.avgSpeed, schoolLat: TRANSPORT.schoolLat, schoolLng: TRANSPORT.schoolLng });
    const tenantId = getTenantId()!;
    const now = new Date();
    // Speed from the phone, else from the last position.
    let speed = input.speed ?? null;
    if (speed === null && t.lastLat !== null && t.lastLng !== null && t.lastAt) {
        const secs = (now.getTime() - t.lastAt.getTime()) / 1000;
        if (secs > 0) speed = Math.round((metres({ lat: t.lastLat, lng: t.lastLng }, input) / secs) * 3.6);
    }
    await db.tripPoint.create({ data: { tenantId, tripId, lat: input.lat, lng: input.lng, speed, accuracy: input.accuracy ?? null, at: now } });
    const stops = await stopsFor(t.routeId, t.kind as Kind);
    const here = { lat: input.lat, lng: input.lng };
    let next = t.nextStop;
    let delay = t.delayMin;
    const label = await routeLabel(t.routeId, t.vehicleId);
    const riders = await ridersOf(t.routeId, t.kind as Kind);
    // Reached a stop ahead (the nearest within the radius).
    for (let j = next; j < stops.length; j++) {
        const st = stops[j];
        if (st.lat === null || st.lng === null || metres(here, { lat: st.lat, lng: st.lng }) > s.radius) continue;
        await db.tripEvent.create({ data: { tenantId, tripId, kind: 'stop', stopId: st.id, lat: input.lat, lng: input.lng, at: now } });
        const due = minutesOf(timeOf(st, t.kind as Kind));
        if (due !== null) delay = minutesIST(now) - due;
        next = j + 1;
        break;
    }
    // Late: tell the families still waiting (once a trip).
    if (t.kind !== 'special' && delay >= s.late && t.delayMin < s.late) {
        const waiting = riders.filter((r) => stops.findIndex((x) => x.id === r.stopId) >= next).map((r) => r.studentId);
        await tellFamilies('bus_late', waiting, { ...label, late: String(delay), time: clock(), trip: t.kind }, `bus-late:${tripId}`);
        await db.tripEvent.create({ data: { tenantId, tripId, kind: 'late', note: `${delay} min`, at: now } });
    }
    // Near: the stops ahead within N minutes (once each).
    const kmh = speed && speed >= 5 ? speed : s.avg;
    let along = 0;
    let from: Point = here;
    for (let j = next; j < stops.length; j++) {
        const st = stops[j];
        if (st.lat === null || st.lng === null) continue;
        along += metres(from, { lat: st.lat, lng: st.lng });
        from = { lat: st.lat, lng: st.lng };
        const minutes = Math.round((along / 1000 / kmh) * 60);
        if (minutes > s.near) break;
        const atStop = riders.filter((r) => r.stopId === st.id).map((r) => r.studentId);
        if (t.kind !== 'special') await tellFamilies('bus_near', atStop, { ...label, stop: st.name, minutes: String(Math.max(1, minutes)), time: clock(), trip: t.kind }, `bus-near:${tripId}:${st.id}`);
    }
    // Over the speed limit (at most once in 5 minutes).
    if (speed !== null && speed > s.over) {
        const recent = await db.tripEvent.findFirst({ where: { tripId, kind: 'overspeed', at: { gte: new Date(now.getTime() - 5 * 60_000) } } });
        if (!recent) {
            await db.tripEvent.create({ data: { tenantId, tripId, kind: 'overspeed', note: `${speed} km/h`, lat: input.lat, lng: input.lng, at: now } });
            raiseLater('bus_overspeed', { office: () => holdersOf('transport.track_all') }, { ...label, speed: String(speed), time: clock() }, { dedupe: `overspeed:${tripId}:${Math.floor(now.getTime() / 300_000)}` });
        }
    }
    await db.trip.update({ where: { id: tripId }, data: { lastLat: input.lat, lastLng: input.lng, lastSpeed: speed, lastAt: now, nextStop: next, delayMin: delay } });
    return { nextStop: next, delayMin: delay, stops: stops.length };
};

export const endTrip = async (tripId: string, userId: string | null) => {
    const t = await db.trip.findFirst({ where: { id: tripId } });
    if (!t) throw notFound('Trip not found');
    if (userId && t.userId !== userId && !(await powers(userId)).all && !(await mayRun(userId, t.routeId))) throw forbidden();
    if (t.status !== 'running') return tripView(tripId);
    await db.trip.update({ where: { id: tripId }, data: { status: 'done', endedAt: new Date() } });
    await db.tripEvent.create({ data: { tenantId: getTenantId()!, tripId, kind: 'end', userId } });
    if (t.kind === 'morning') {
        const label = await routeLabel(t.routeId, t.vehicleId);
        const boarded = (await db.tripEvent.findMany({ where: { tripId, kind: 'boarded' }, select: { studentId: true } })).map((e) => e.studentId!).filter(Boolean);
        const riders = boarded.length ? boarded : (await ridersOf(t.routeId, 'morning')).map((r) => r.studentId);
        await tellFamilies('bus_reached', riders, { ...label, time: clock(), trip: t.kind }, `bus-reached:${tripId}`);
    }
    await recordAudit({ action: 'trip_ended', entity: 'trip', entityId: tripId, changes: {} });
    return tripView(tripId);
};

export const boardSchema = z.strictObject({ studentId: z.uuid(), kind: z.enum(['boarded', 'dropped', 'absent']) });

/** The helper marks a student on / off the bus (or not there). */
export const board = async (tripId: string, input: z.infer<typeof boardSchema>, userId: string) => {
    const t = await db.trip.findFirst({ where: { id: tripId } });
    if (!t) throw notFound('Trip not found');
    if (!(await mayRun(userId, t.routeId))) throw forbidden();
    const rider = (await ridersOf(t.routeId, t.kind as Kind)).find((r) => r.studentId === input.studentId);
    if (!rider && t.kind !== 'special') throw badRequest('This student isn’t on this trip');
    const stop = rider ? await db.transportStop.findFirst({ where: { id: rider.stopId }, select: { id: true, name: true } }) : null;
    await db.tripEvent.create({ data: { tenantId: getTenantId()!, tripId, kind: input.kind, studentId: input.studentId, stopId: stop?.id ?? null, lat: t.lastLat, lng: t.lastLng, userId } });
    if (input.kind !== 'absent') {
        const label = await routeLabel(t.routeId, t.vehicleId);
        await tellFamilies('bus_boarded', [input.studentId], { ...label, stop: input.kind === 'dropped' && t.kind === 'morning' ? 'school' : (stop?.name ?? ''), what: input.kind === 'boarded' ? 'got on the bus' : 'got off the bus', time: clock(), trip: t.kind }, `board:${tripId}:${input.studentId}:${input.kind}`);
    }
    return tripView(tripId);
};

export const sosSchema = z.strictObject({ note: z.string().trim().max(300).optional() });
export const sos = async (tripId: string, note: string | undefined, userId: string) => {
    const t = await db.trip.findFirst({ where: { id: tripId } });
    if (!t) throw notFound('Trip not found');
    if (!(await mayRun(userId, t.routeId))) throw forbidden();
    await db.tripEvent.create({ data: { tenantId: getTenantId()!, tripId, kind: 'sos', note: note || null, lat: t.lastLat, lng: t.lastLng, userId } });
    const label = await routeLabel(t.routeId, t.vehicleId);
    const map = t.lastLat !== null ? `https://www.openstreetmap.org/?mlat=${t.lastLat}&mlon=${t.lastLng}#map=17/${t.lastLat}/${t.lastLng}` : 'position not known';
    raiseLater('bus_sos', { office: () => holdersOf('transport.track_all') }, { ...label, note: note || 'No note', map, time: clock() }, { dedupe: `sos:${tripId}:${Date.now()}` });
    await recordAudit({ action: 'trip_sos', entity: 'trip', entityId: tripId, changes: { note } });
    return { sent: true };
};

/** A trip in full: the stops in its order (reached or not), who is on it, its path and what happened. */
export const tripView = async (tripId: string) => {
    const t = await db.trip.findFirst({ where: { id: tripId } });
    if (!t) throw notFound('Trip not found');
    const [stops, riders, events, points, label, route] = await Promise.all([
        stopsFor(t.routeId, t.kind as Kind),
        ridersOf(t.routeId, t.kind as Kind),
        db.tripEvent.findMany({ where: { tripId }, orderBy: { at: 'asc' } }),
        db.tripPoint.findMany({ where: { tripId }, orderBy: { at: 'asc' }, select: { lat: true, lng: true, speed: true, at: true } }),
        routeLabel(t.routeId, t.vehicleId),
        db.transportRoute.findFirst({ where: { id: t.routeId }, select: { color: true } }),
    ]);
    const students = await db.student.findMany({ where: { id: { in: riders.map((r) => r.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } });
    const reached = new Map(events.filter((e) => e.kind === 'stop').map((e) => [e.stopId, e.at]));
    const marks = new Map<string, string>();
    for (const e of events) if (e.studentId && ['boarded', 'dropped', 'absent'].includes(e.kind)) marks.set(e.studentId, e.kind);
    const s = await getSettings({ lat: TRANSPORT.schoolLat, lng: TRANSPORT.schoolLng });
    return {
        id: t.id,
        kind: t.kind,
        status: t.status,
        source: t.source,
        ...label,
        color: route?.color ?? '#1A365D',
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        last: t.lastLat !== null ? { lat: t.lastLat, lng: t.lastLng, speed: t.lastSpeed, at: t.lastAt } : null,
        nextStop: t.nextStop,
        delayMin: t.delayMin,
        school: { lat: s.lat, lng: s.lng },
        stops: stops.map((st, i) => ({
            id: st.id,
            name: st.name,
            lat: st.lat,
            lng: st.lng,
            time: timeOf(st, t.kind as Kind),
            reachedAt: reached.get(st.id) ?? null,
            passed: i < t.nextStop,
            students: riders.filter((r) => r.stopId === st.id).map((r) => {
                const x = students.find((y) => y.id === r.studentId);
                return { id: r.studentId, name: x ? fullName(x) : '', admissionNo: x?.admissionNo ?? '', mark: marks.get(r.studentId) ?? null };
            }),
        })),
        events: events.map((e) => ({ kind: e.kind, at: e.at, note: e.note, stopId: e.stopId, studentId: e.studentId })),
        path: points.map((p) => [p.lat, p.lng] as [number, number]),
    };
};

// ─── Watching ────────────────────────────────────────────────────────────────

/** Every bus today: running (where it is, how late) or not started yet. */
export const liveAll = async () => {
    const [routes, trips] = await Promise.all([db.transportRoute.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }), db.trip.findMany({ where: { day: dayDate(todayIST()) }, orderBy: { startedAt: 'desc' } })]);
    const vehicles = new Map((await db.vehicle.findMany({ select: { id: true, name: true, number: true } })).map((v) => [v.id, v]));
    const s = await getSettings({ lat: TRANSPORT.schoolLat, lng: TRANSPORT.schoolLng, ping: TRANSPORT.pingSeconds, map: TRANSPORT.mapProvider });
    const stopCounts = new Map((await db.transportStop.groupBy({ by: ['routeId'], where: { isActive: true }, _count: { _all: true } })).map((x) => [x.routeId, x._count._all]));
    const sos = await db.tripEvent.findMany({ where: { kind: 'sos', trip: { day: dayDate(todayIST()) } }, select: { tripId: true, at: true, note: true } });
    return {
        school: { lat: s.lat, lng: s.lng },
        pingSeconds: s.ping,
        map: s.map,
        buses: routes.map((r) => {
            const running = trips.find((t) => t.routeId === r.id && t.status === 'running');
            const last = trips.find((t) => t.routeId === r.id);
            const t = running ?? last ?? null;
            const v = r.vehicleId ? vehicles.get(r.vehicleId) : null;
            const stale = running?.lastAt ? Date.now() - running.lastAt.getTime() > 3 * 60_000 : false;
            return {
                routeId: r.id,
                route: r.name,
                color: r.color,
                vehicle: v ? `${v.name} (${v.number})` : null,
                tripId: t?.id ?? null,
                kind: t?.kind ?? null,
                state: running ? (stale ? 'no_signal' : running.delayMin >= 10 ? 'late' : 'moving') : last ? 'done' : 'not_started',
                last: running && running.lastLat !== null ? { lat: running.lastLat, lng: running.lastLng, speed: running.lastSpeed, at: running.lastAt } : null,
                nextStop: running?.nextStop ?? 0,
                stops: stopCounts.get(r.id) ?? 0,
                delayMin: running?.delayMin ?? 0,
                sos: running ? sos.filter((x) => x.tripId === running.id).map((x) => ({ at: x.at, note: x.note })) : [],
            };
        }),
    };
};

/** A parent's / student's view: each child's bus, where it is (during the trip) and when it reaches their stop. */
export const myBus = async (userId: string) => {
    const students = await db.student.findMany({ where: { status: 'active', OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, select: { id: true, firstName: true, middleName: true, lastName: true } });
    const year = await currentYear();
    if (!year || !students.length) return { pingSeconds: 10, children: [] };
    const today = dayDate(todayIST());
    const rows = await db.studentTransport.findMany({ where: { academicYearId: year.id, studentId: { in: students.map((s) => s.id) }, fromDate: { lte: today }, OR: [{ toDate: null }, { toDate: { gte: today } }] } });
    const s = await getSettings({ only: TRANSPORT.parentsDuringTrip, avg: TRANSPORT.avgSpeed, ping: TRANSPORT.pingSeconds, lat: TRANSPORT.schoolLat, lng: TRANSPORT.schoolLng });
    const out = [];
    for (const st of students) {
        const r = rows.find((x) => x.studentId === st.id);
        if (!r) {
            out.push({ student: { id: st.id, name: fullName(st) }, transport: null });
            continue;
        }
        const [route, stop] = await Promise.all([db.transportRoute.findFirst({ where: { id: r.routeId } }), db.transportStop.findFirst({ where: { id: r.stopId } })]);
        const trip = await db.trip.findFirst({ where: { routeId: r.routeId, day: today }, orderBy: { startedAt: 'desc' } });
        const running = trip?.status === 'running' ? trip : null;
        const label = route ? await routeLabel(route.id, route.vehicleId) : { route: '', vehicle: '' };
        const driver = route?.driverId ? await db.staff.findFirst({ where: { id: route.driverId }, select: { firstName: true, lastName: true, mobile: true } }) : null;
        const helper = route?.helperId ? await db.staff.findFirst({ where: { id: route.helperId }, select: { firstName: true, lastName: true, mobile: true } }) : null;
        let eta: number | null = null;
        let stopsBefore: number | null = null;
        let view = null;
        if (running && stop) {
            view = await tripView(running.id);
            const idx = view.stops.findIndex((x) => x.id === stop.id);
            if (idx >= running.nextStop && running.lastLat !== null && running.lastLng !== null) {
                let along = 0;
                let from: Point = { lat: running.lastLat, lng: running.lastLng };
                for (let j = running.nextStop; j <= idx; j++) {
                    const x = view.stops[j];
                    if (x.lat === null || x.lng === null) continue;
                    along += metres(from, { lat: x.lat, lng: x.lng });
                    from = { lat: x.lat, lng: x.lng };
                }
                const kmh = running.lastSpeed && running.lastSpeed >= 5 ? running.lastSpeed : s.avg;
                eta = Math.max(1, Math.round((along / 1000 / kmh) * 60));
                stopsBefore = idx - running.nextStop;
            }
        }
        const mark = running ? await db.tripEvent.findFirst({ where: { tripId: running.id, studentId: st.id }, orderBy: { at: 'desc' }, select: { kind: true, at: true } }) : null;
        const showMap = !!running || !s.only;
        out.push({
            student: { id: st.id, name: fullName(st) },
            transport: {
                route: label.route,
                vehicle: label.vehicle,
                stop: stop ? { id: stop.id, name: stop.name, lat: stop.lat, lng: stop.lng, morningTime: stop.morningTime, afternoonTime: stop.afternoonTime } : null,
                way: r.way,
                driver: driver ? { name: [driver.firstName, driver.lastName].filter(Boolean).join(' '), mobile: driver.mobile } : null,
                helper: helper ? { name: [helper.firstName, helper.lastName].filter(Boolean).join(' '), mobile: helper.mobile } : null,
                trip: running ? { id: running.id, kind: running.kind, startedAt: running.startedAt, delayMin: running.delayMin, eta, stopsBefore, mark: mark ? { kind: mark.kind, at: mark.at } : null } : trip ? { id: trip.id, kind: trip.kind, ended: true, endedAt: trip.endedAt } : null,
                map: showMap && view ? { color: view.color, last: view.last, path: view.path, stops: view.stops.map((x) => ({ id: x.id, name: x.name, lat: x.lat, lng: x.lng, passed: x.passed })), school: view.school } : null,
            },
        });
    }
    return { pingSeconds: s.ping, children: out };
};

/** Trips of a day (or a route), for the history screen. */
export const tripsQuery = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), route: z.uuid().optional() });
export const listTrips = async (q: z.infer<typeof tripsQuery>) => {
    const day = dayDate(q.date ?? todayIST());
    const rows = await db.trip.findMany({ where: { day, ...(q.route ? { routeId: q.route } : {}) }, orderBy: { startedAt: 'asc' } });
    const routes = new Map((await db.transportRoute.findMany({ select: { id: true, name: true } })).map((r) => [r.id, r.name]));
    const events = await db.tripEvent.groupBy({ by: ['tripId', 'kind'], where: { tripId: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
    const users = new Map((await db.user.findMany({ where: { id: { in: rows.map((r) => r.userId!).filter(Boolean) } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
    const count = (id: string, k: string) => events.find((e) => e.tripId === id && e.kind === k)?._count._all ?? 0;
    return rows.map((t) => ({ id: t.id, route: routes.get(t.routeId) ?? '', kind: t.kind, status: t.status, source: t.source, by: t.userId ? (users.get(t.userId) ?? null) : null, startedAt: t.startedAt, endedAt: t.endedAt, delayMin: t.delayMin, stopsReached: count(t.id, 'stop'), boarded: count(t.id, 'boarded'), sos: count(t.id, 'sos'), overspeed: count(t.id, 'overspeed') }));
};

// ─── A simulated bus (for the demo: no phone needed) ─────────────────────────

/** Where a simulated bus is after `secs` seconds: along the stops at the average speed. */
const simulatedPosition = (path: Point[], kmh: number, secs: number) => {
    let left = (kmh / 3.6) * secs;
    for (let i = 0; i < path.length - 1; i++) {
        const d = metres(path[i], path[i + 1]);
        if (left <= d) {
            const f = d ? left / d : 0;
            return { lat: path[i].lat + (path[i + 1].lat - path[i].lat) * f, lng: path[i].lng + (path[i + 1].lng - path[i].lng) * f, done: false };
        }
        left -= d;
    }
    return { ...path[path.length - 1], done: true };
};

export const simulate = async (routeId: string, kind: Kind, userId: string) => {
    const p = await powers(userId);
    if (!p.all) throw forbidden();
    const stops = (await stopsFor(routeId, kind)).filter((s) => s.lat !== null && s.lng !== null);
    if (stops.length < 2) throw badRequest('Put at least two stops of the route on the map first');
    return startTrip({ routeId, kind, source: 'simulated' }, null);
};

let simTimer: NodeJS.Timeout | null = null;
/** Moves the simulated buses (every ping interval), and ends them at the last stop. */
export const startSimulator = () => {
    if (simTimer || process.env.NODE_ENV === 'test') return;
    simTimer = setInterval(() => {
        void (async () => {
            const trips = await runAsSystem(() => db.trip.findMany({ where: { status: 'running', source: 'simulated' }, select: { id: true, tenantId: true } }));
            for (const tr of trips)
                await runAsTenant(tr.tenantId, async () => {
                    const t = await db.trip.findFirst({ where: { id: tr.id } });
                    if (!t) return;
                    const s = await getSettings({ avg: TRANSPORT.avgSpeed, lat: TRANSPORT.schoolLat, lng: TRANSPORT.schoolLng });
                    const stops = (await stopsFor(t.routeId, t.kind as Kind)).filter((x) => x.lat !== null && x.lng !== null).map((x) => ({ lat: x.lat!, lng: x.lng! }));
                    const school = { lat: s.lat, lng: s.lng };
                    const path = t.kind === 'afternoon' ? [school, ...stops] : [...stops, school];
                    // Demo buses run fast (3×), so a whole route takes a few minutes.
                    const pos = simulatedPosition(path, s.avg * 3, (Date.now() - t.startedAt.getTime()) / 1000);
                    await ping(t.id, { lat: pos.lat, lng: pos.lng, speed: Math.round(s.avg * (0.8 + Math.random() * 0.5)) }, null).catch(() => null);
                    if (pos.done) await endTrip(t.id, null);
                });
        })().catch((err) => logger.warn('Bus simulator', { error: (err as Error).message }));
    }, 5000);
    simTimer.unref();
};

// Old positions go after the days the school keeps them.
defineDailyJob({
    key: 'transport_cleanup',
    at: async () => '02:45',
    run: async () => {
        const { days } = await getSettings({ days: TRANSPORT.keepDays });
        const r = await db.tripPoint.deleteMany({ where: { at: { lt: new Date(Date.now() - days * 86_400_000) } } });
        return `${r.count} positions`;
    },
});

/** Daily: vehicle papers expiring soon (or expired), to those who manage transport. */
defineDailyJob({
    key: 'vehicle_papers',
    run: async () => {
        const { days } = await getSettings({ days: TRANSPORT.docRemindDays });
        const soon = new Date(Date.parse(`${todayIST()}T00:00:00Z`) + days * 86_400_000);
        const docs = await db.vehicleDocument.findMany({ where: { expiresOn: { lte: soon } }, orderBy: { expiresOn: 'asc' }, include: { vehicle: { select: { name: true, number: true, isActive: true } } } });
        const live = docs.filter((d) => d.vehicle.isActive);
        if (!live.length) return '0 papers';
        const types = new Map((await db.masterValue.findMany({ where: { master: 'vehicle_document' }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
        const list = live.map((d) => `- ${d.vehicle.name} (${d.vehicle.number}): ${d.typeId ? (types.get(d.typeId) ?? 'Paper') : 'Paper'} ${isoOf(d.expiresOn!) < todayIST() ? 'EXPIRED on' : 'expires on'} ${isoOf(d.expiresOn!)}`).join('\n');
        raiseLater('vehicle_papers', { office: () => holdersOf('transport.manage') }, { count: String(live.length), list }, { dedupe: `papers:${todayIST()}` });
        return `${live.length} papers`;
    },
});

export { hhmm };
