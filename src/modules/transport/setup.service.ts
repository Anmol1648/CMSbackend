import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { currentYear } from '../academic/years.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { registerFeeSource } from '../fees/dues.service';
import { TRANSPORT } from './transport.settings';

/**
 * Transport set-up: vehicles, routes (vehicle, driver, helper, times) with their stops in order on
 * the map, and each student's route and stop for the session. The stop's fare is charged with the
 * fees (System Settings → Transport: which fee head; one-way share).
 */

const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour time like 07:30');
const staffName = (s: { firstName: string; middleName?: string | null; lastName?: string | null }) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');

// ─── Vehicles ────────────────────────────────────────────────────────────────

export const vehicleSchema = z.strictObject({
    number: z.string().trim().toUpperCase().min(4, 'is required').max(20),
    name: z.string().trim().min(1, 'is required').max(60),
    typeId: z.uuid().nullable().optional(),
    capacity: z.number().int().min(1).max(200),
    make: z.string().trim().max(60).nullable().optional(),
    model: z.string().trim().max(60).nullable().optional(),
    year: z.number().int().min(1980).max(2100).nullable().optional(),
    gpsDeviceId: z.string().trim().max(80).nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    isActive: z.boolean().default(true),
});

export const listVehicles = async () => {
    const [rows, routes, types, docs] = await Promise.all([
        db.vehicle.findMany({ orderBy: { name: 'asc' } }),
        db.transportRoute.findMany({ where: { vehicleId: { not: null } }, select: { vehicleId: true, name: true } }),
        db.masterValue.findMany({ where: { master: 'vehicle_type' }, select: { id: true, name: true } }),
        db.vehicleDocument.findMany({ select: { vehicleId: true, expiresOn: true } }),
    ]);
    const { remind } = await getSettings({ remind: TRANSPORT.docRemindDays });
    const today = todayIST();
    const soon = isoOf(new Date(Date.parse(`${today}T00:00:00Z`) + remind * 86_400_000));
    return rows.map((v) => {
        const mine = docs.filter((d) => d.vehicleId === v.id && d.expiresOn);
        return {
            ...v,
            type: types.find((t) => t.id === v.typeId)?.name ?? null,
            routes: routes.filter((r) => r.vehicleId === v.id).map((r) => r.name),
            expired: mine.filter((d) => isoOf(d.expiresOn!) < today).length,
            expiring: mine.filter((d) => isoOf(d.expiresOn!) >= today && isoOf(d.expiresOn!) <= soon).length,
        };
    });
};

export const saveVehicle = async (id: string | null, input: z.infer<typeof vehicleSchema>, userId: string) => {
    if (await db.vehicle.findFirst({ where: { number: input.number, ...(id ? { id: { not: id } } : {}) } })) throw badRequest('A vehicle with this number exists', [{ field: 'number', message: 'is taken' }]);
    const data = { ...input, typeId: input.typeId ?? null, make: input.make ?? null, model: input.model ?? null, year: input.year ?? null, gpsDeviceId: input.gpsDeviceId || null, notes: input.notes ?? null };
    const v = id ? await db.vehicle.update({ where: { id }, data }) : await db.vehicle.create({ data: { ...data, tenantId: getTenantId()! } });
    await recordAudit({ action: id ? 'vehicle_changed' : 'vehicle_added', entity: 'vehicle', entityId: v.id, changes: { number: v.number } });
    void userId;
    return v;
};

export const deleteVehicle = async (id: string) => {
    if (await db.transportRoute.count({ where: { vehicleId: id } })) throw conflict('A route uses this vehicle. Change the route first, or make the vehicle inactive.');
    if (await db.trip.count({ where: { vehicleId: id } })) throw conflict('This vehicle has trips on record; make it inactive instead.');
    await db.vehicle.delete({ where: { id } });
    await recordAudit({ action: 'vehicle_deleted', entity: 'vehicle', entityId: id, changes: {} });
    return { id, deleted: true };
};

// ─── Vehicle papers ──────────────────────────────────────────────────────────

export const documentSchema = z.strictObject({
    typeId: z.uuid().nullable().optional(),
    number: z.string().trim().max(60).nullable().optional(),
    issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    fileId: z.uuid().nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
});

export const listDocuments = async (vehicleId: string) => {
    const [docs, types] = await Promise.all([db.vehicleDocument.findMany({ where: { vehicleId }, orderBy: [{ expiresOn: 'asc' }] }), db.masterValue.findMany({ where: { master: 'vehicle_document' }, select: { id: true, name: true } })]);
    const files = await db.file.findMany({ where: { id: { in: docs.map((d) => d.fileId!).filter(Boolean) } }, select: { id: true, originalName: true } });
    const today = todayIST();
    const { remind } = await getSettings({ remind: TRANSPORT.docRemindDays });
    const soon = isoOf(new Date(Date.parse(`${today}T00:00:00Z`) + remind * 86_400_000));
    return docs.map((d) => ({ id: d.id, typeId: d.typeId, type: types.find((t) => t.id === d.typeId)?.name ?? 'Paper', number: d.number, issuedOn: d.issuedOn ? isoOf(d.issuedOn) : null, expiresOn: d.expiresOn ? isoOf(d.expiresOn) : null, expired: !!d.expiresOn && isoOf(d.expiresOn) < today, expiring: !!d.expiresOn && isoOf(d.expiresOn) >= today && isoOf(d.expiresOn) <= soon, fileId: d.fileId, fileName: files.find((f) => f.id === d.fileId)?.originalName ?? null, notes: d.notes }));
};

const docData = (input: z.infer<typeof documentSchema>) => ({ typeId: input.typeId ?? null, number: input.number || null, issuedOn: input.issuedOn ? dayDate(input.issuedOn) : null, expiresOn: input.expiresOn ? dayDate(input.expiresOn) : null, fileId: input.fileId ?? null, notes: input.notes || null });

export const addDocument = async (vehicleId: string, input: z.infer<typeof documentSchema>) => {
    if (!(await db.vehicle.findFirst({ where: { id: vehicleId } }))) throw notFound('Vehicle not found');
    const d = await db.vehicleDocument.create({ data: { tenantId: getTenantId()!, vehicleId, ...docData(input) } });
    await recordAudit({ action: 'vehicle_paper_added', entity: 'vehicle', entityId: vehicleId, changes: { expiresOn: input.expiresOn } });
    return d;
};
export const updateDocument = async (id: string, input: z.infer<typeof documentSchema>) => {
    const d = await db.vehicleDocument.update({ where: { id }, data: docData(input) });
    await recordAudit({ action: 'vehicle_paper_changed', entity: 'vehicle', entityId: d.vehicleId, changes: { expiresOn: input.expiresOn } });
    return d;
};
export const deleteDocument = async (id: string) => {
    await db.vehicleDocument.delete({ where: { id } });
    return { id, deleted: true };
};

// ─── Routes and stops ────────────────────────────────────────────────────────

export const routeSchema = z.strictObject({
    name: z.string().trim().min(1, 'is required').max(80),
    code: z.string().trim().max(20).nullable().optional(),
    vehicleId: z.uuid().nullable().optional(),
    driverId: z.uuid().nullable().optional(),
    helperId: z.uuid().nullable().optional(),
    morningStart: TIME,
    afternoonStart: TIME,
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#1A365D'),
    isActive: z.boolean().default(true),
});

const countsByStop = async () => {
    const year = await currentYear();
    if (!year) return new Map<string, number>();
    const today = dayDate(todayIST());
    const rows = await db.studentTransport.groupBy({ by: ['stopId'], where: { academicYearId: year.id, fromDate: { lte: today }, OR: [{ toDate: null }, { toDate: { gte: today } }] }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.stopId, r._count._all]));
};

export const listRoutes = async () => {
    const [routes, stops, vehicles, staff, counts] = await Promise.all([
        db.transportRoute.findMany({ orderBy: { name: 'asc' } }),
        db.transportStop.findMany({ orderBy: [{ sortOrder: 'asc' }] }),
        db.vehicle.findMany({ select: { id: true, number: true, name: true, capacity: true } }),
        db.staff.findMany({ select: { id: true, firstName: true, middleName: true, lastName: true, mobile: true } }),
        countsByStop(),
    ]);
    const s = await getSettings({ lat: TRANSPORT.schoolLat, lng: TRANSPORT.schoolLng });
    return {
        school: { lat: s.lat, lng: s.lng },
        routes: routes.map((r) => {
            const mine = stops.filter((x) => x.routeId === r.id);
            const v = vehicles.find((x) => x.id === r.vehicleId);
            const d = staff.find((x) => x.id === r.driverId);
            const h = staff.find((x) => x.id === r.helperId);
            const students = mine.reduce((a, x) => a + (counts.get(x.id) ?? 0), 0);
            return {
                ...r,
                vehicle: v ? `${v.name} (${v.number})` : null,
                capacity: v?.capacity ?? null,
                driver: d ? { name: staffName(d), mobile: d.mobile } : null,
                helper: h ? { name: staffName(h), mobile: h.mobile } : null,
                students,
                stops: mine.map((x) => ({ ...x, students: counts.get(x.id) ?? 0 })),
            };
        }),
    };
};

export const saveRoute = async (id: string | null, input: z.infer<typeof routeSchema>) => {
    if (await db.transportRoute.findFirst({ where: { name: { equals: input.name, mode: 'insensitive' }, ...(id ? { id: { not: id } } : {}) } })) throw badRequest('A route with this name exists', [{ field: 'name', message: 'is taken' }]);
    const data = { ...input, code: input.code ?? null, vehicleId: input.vehicleId ?? null, driverId: input.driverId ?? null, helperId: input.helperId ?? null };
    const r = id ? await db.transportRoute.update({ where: { id }, data }) : await db.transportRoute.create({ data: { ...data, tenantId: getTenantId()! } });
    await recordAudit({ action: id ? 'route_changed' : 'route_added', entity: 'transport_route', entityId: r.id, changes: { name: r.name } });
    return r;
};

export const deleteRoute = async (id: string) => {
    if (await db.studentTransport.count({ where: { routeId: id } })) throw conflict('Students use this route. Move them first, or make the route inactive.');
    await db.transportRoute.delete({ where: { id } });
    await recordAudit({ action: 'route_deleted', entity: 'transport_route', entityId: id, changes: {} });
    return { id, deleted: true };
};

export const stopSchema = z.strictObject({
    name: z.string().trim().min(1, 'is required').max(100),
    landmark: z.string().trim().max(200).nullable().optional(),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
    morningTime: TIME.nullable().optional(),
    afternoonTime: TIME.nullable().optional(),
    fare: z.number().int().min(0).max(1_000_000),
    isActive: z.boolean().default(true),
});

export const addStop = async (routeId: string, input: z.infer<typeof stopSchema>) => {
    if (!(await db.transportRoute.findFirst({ where: { id: routeId } }))) throw notFound('Route not found');
    const max = (await db.transportStop.aggregate({ where: { routeId }, _max: { sortOrder: true } }))._max.sortOrder ?? 0;
    const s = await db.transportStop.create({ data: { tenantId: getTenantId()!, routeId, ...input, landmark: input.landmark ?? null, lat: input.lat ?? null, lng: input.lng ?? null, morningTime: input.morningTime ?? null, afternoonTime: input.afternoonTime ?? null, sortOrder: max + 10 } });
    await recordAudit({ action: 'stop_added', entity: 'transport_stop', entityId: s.id, changes: { name: s.name } });
    return s;
};

export const updateStop = async (id: string, input: z.infer<typeof stopSchema>) => {
    const s = await db.transportStop.update({ where: { id }, data: { ...input, landmark: input.landmark ?? null, lat: input.lat ?? null, lng: input.lng ?? null, morningTime: input.morningTime ?? null, afternoonTime: input.afternoonTime ?? null } });
    await recordAudit({ action: 'stop_changed', entity: 'transport_stop', entityId: id, changes: { name: s.name } });
    return s;
};

export const deleteStop = async (id: string) => {
    if (await db.studentTransport.count({ where: { stopId: id } })) throw conflict('Students use this stop. Move them first, or make the stop inactive.');
    await db.transportStop.delete({ where: { id } });
    return { id, deleted: true };
};

export const moveStop = async (id: string, direction: 'up' | 'down') => {
    const s = await db.transportStop.findFirst({ where: { id } });
    if (!s) throw notFound('Stop not found');
    const list = await db.transportStop.findMany({ where: { routeId: s.routeId }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    const i = list.findIndex((x) => x.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return { moved: false };
    [list[i], list[j]] = [list[j], list[i]];
    for (let k = 0; k < list.length; k++) await db.transportStop.update({ where: { id: list[k].id }, data: { sortOrder: (k + 1) * 10 } });
    return { moved: true };
};

/** Staff who can drive or help (working), for the pickers. */
export const staffOptions = async () => (await db.staff.findMany({ where: { status: 'working' }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true, userId: true }, orderBy: { firstName: 'asc' } })).map((s) => ({ id: s.id, label: `${staffName(s)} (${s.employeeCode})`, hasLogin: !!s.userId }));

// ─── Students' transport ─────────────────────────────────────────────────────

export const assignSchema = z.strictObject({
    studentIds: z.array(z.uuid()).min(1).max(200),
    routeId: z.uuid(),
    stopId: z.uuid(),
    way: z.enum(['both', 'pickup', 'drop']),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    fare: z.number().int().min(0).max(1_000_000).nullable().optional(),
});

/** Gives students a route and stop from a day (their earlier one ends the day before). */
export const assignStudents = async (input: z.infer<typeof assignSchema>, userId: string) => {
    const year = await currentYear();
    if (!year) throw badRequest('No current academic year');
    const stop = await db.transportStop.findFirst({ where: { id: input.stopId, routeId: input.routeId } });
    if (!stop) throw badRequest('Choose a stop of the route');
    const from = dayDate(input.fromDate);
    const before = new Date(from.getTime() - 86_400_000);
    const tenantId = getTenantId()!;
    for (const studentId of input.studentIds) {
        const cur = await db.studentTransport.findMany({ where: { academicYearId: year.id, studentId, OR: [{ toDate: null }, { toDate: { gte: from } }] } });
        for (const c of cur) {
            if (c.fromDate >= from) await db.studentTransport.delete({ where: { id: c.id } });
            else await db.studentTransport.update({ where: { id: c.id }, data: { toDate: before } });
        }
        await db.studentTransport.create({ data: { tenantId, academicYearId: year.id, studentId, routeId: input.routeId, stopId: input.stopId, way: input.way, fromDate: from, fare: input.fare ?? null, createdBy: userId } });
    }
    await recordAudit({ action: 'transport_assigned', entity: 'transport_route', entityId: input.routeId, changes: { students: input.studentIds.length, stop: stop.name, from: input.fromDate } });
    return { assigned: input.studentIds.length };
};

export const endSchema = z.strictObject({ studentIds: z.array(z.uuid()).min(1).max(200), lastDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
/** Stops students' transport after a day (no more fare from the next instalment). */
export const endTransport = async (input: z.infer<typeof endSchema>) => {
    const year = await currentYear();
    const last = dayDate(input.lastDate);
    const r = await db.studentTransport.updateMany({ where: { academicYearId: year?.id, studentId: { in: input.studentIds }, toDate: null, fromDate: { lte: last } }, data: { toDate: last } });
    await db.studentTransport.deleteMany({ where: { academicYearId: year?.id, studentId: { in: input.studentIds }, fromDate: { gt: last } } });
    await recordAudit({ action: 'transport_ended', entity: 'student', entityId: input.studentIds[0], changes: { students: input.studentIds.length, last: input.lastDate } });
    return { ended: r.count };
};

export const studentsQuery = z.object({
    route: z.uuid().optional(),
    stop: z.uuid().optional(),
    section: z.uuid().optional(),
    search: z.string().trim().max(60).optional(),
    show: z.enum(['using', 'not_using', 'all']).default('using'),
});

/** Students of the session with their transport today (or none). */
export const listStudents = async (q: z.infer<typeof studentsQuery>) => {
    const year = await currentYear();
    if (!year) return { rows: [] };
    const today = dayDate(todayIST());
    const enrol = await db.enrolment.findMany({
        where: {
            academicYearId: year.id,
            student: { status: 'active', ...(q.search ? { OR: [{ firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }, { admissionNo: { contains: q.search, mode: 'insensitive' } }] } : {}) },
            ...(q.section ? { sectionId: q.section } : {}),
        },
        select: { rollNumber: true, sectionId: true, section: { select: { name: true, sortOrder: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } } }, student: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } } },
    });
    const ids = enrol.map((e) => e.student.id);
    const current = await db.studentTransport.findMany({ where: { academicYearId: year.id, studentId: { in: ids }, OR: [{ toDate: null }, { toDate: { gte: today } }] }, orderBy: { fromDate: 'asc' } });
    const [routes, stops] = await Promise.all([db.transportRoute.findMany({ select: { id: true, name: true } }), db.transportStop.findMany({ select: { id: true, name: true, fare: true } })]);
    const { pct } = await getSettings({ pct: TRANSPORT.oneWayPercent });
    const rows = enrol
        .map((e) => {
            const t = current.find((c) => c.studentId === e.student.id && c.fromDate <= today) ?? current.find((c) => c.studentId === e.student.id) ?? null;
            const stop = t ? stops.find((s) => s.id === t.stopId) : null;
            const fare = t ? (t.fare ?? stop?.fare ?? 0) : null;
            return {
                id: e.student.id,
                name: fullName(e.student),
                admissionNo: e.student.admissionNo,
                roll: e.rollNumber,
                section: sectionLabel(e.section),
                order: e.section.schoolClass.sortOrder * 1000 + e.section.sortOrder,
                transport: t ? { id: t.id, routeId: t.routeId, route: routes.find((r) => r.id === t.routeId)?.name ?? '', stopId: t.stopId, stop: stop?.name ?? '', way: t.way, fromDate: isoOf(t.fromDate), toDate: t.toDate ? isoOf(t.toDate) : null, fare: t.way === 'both' ? fare : Math.round(((fare ?? 0) * pct) / 100), ownFare: t.fare !== null } : null,
            };
        })
        .filter((r) => (q.show === 'using' ? !!r.transport : q.show === 'not_using' ? !r.transport : true))
        .filter((r) => (!q.route || r.transport?.routeId === q.route) && (!q.stop || r.transport?.stopId === q.stop))
        .sort((a, b) => a.order - b.order || (a.roll ?? 9999) - (b.roll ?? 9999));
    return { rows };
};

// ─── Transport fee, with the other fees ──────────────────────────────────────

registerFeeSource(async (yearId, students, instalments) => {
    const out = new Map<string, { feeHeadId: string; instalmentId: string; amount: number }[]>();
    if (!students.length || !instalments.length) return out;
    const rows = await db.studentTransport.findMany({ where: { academicYearId: yearId, studentId: { in: students.map((s) => s.id) } } });
    if (!rows.length) return out;
    const { code, pct } = await getSettings({ code: TRANSPORT.feeHeadCode, pct: TRANSPORT.oneWayPercent });
    const head = await db.masterValue.findFirst({ where: { master: 'fee_head', code: { equals: code, mode: 'insensitive' } }, select: { id: true } });
    if (!head) return out;
    const fares = new Map((await db.transportStop.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.stopId))] } }, select: { id: true, fare: true } })).map((s) => [s.id, s.fare]));
    const sorted = [...instalments].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
    for (const r of rows) {
        const base = r.fare ?? fares.get(r.stopId) ?? 0;
        const amount = r.way === 'both' ? base : Math.round((base * pct) / 100);
        if (!amount) continue;
        sorted.forEach((inst, i) => {
            // The instalment covers the time since the one before it.
            const periodStart = i === 0 ? new Date(0) : new Date(sorted[i - 1].dueDate.getTime() + 86_400_000);
            const uses = r.fromDate <= inst.dueDate && (!r.toDate || r.toDate >= periodStart);
            if (uses) out.set(r.studentId, [...(out.get(r.studentId) ?? []), { feeHeadId: head.id, instalmentId: inst.id, amount }]);
        });
    }
    // One student, two stops in an instalment (moved): charged once, at the later stop's fare.
    for (const [sid, list] of out) {
        const byInst = new Map<string, { feeHeadId: string; instalmentId: string; amount: number }>();
        for (const l of list) byInst.set(l.instalmentId, l);
        out.set(sid, [...byInst.values()]);
    }
    return out;
});

/** For the parent / student: their transport today. */
export const myTransport = async (studentIds: string[]) => {
    const year = await currentYear();
    if (!year || !studentIds.length) return [];
    const today = dayDate(todayIST());
    const rows = await db.studentTransport.findMany({ where: { academicYearId: year.id, studentId: { in: studentIds }, fromDate: { lte: today }, OR: [{ toDate: null }, { toDate: { gte: today } }] } });
    return rows;
};

export type StopRow = Prisma.TransportStopGetPayload<object>;
