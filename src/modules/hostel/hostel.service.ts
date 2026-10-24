import { randomBytes } from 'crypto';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { getUserAccess } from '../rbac/access.service';
import { currentYear } from '../academic/years.service';
import { fullName } from '../students/students.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { registerFeeSource } from '../fees/dues.service';
import { raiseLater } from '../alerts/deliver';
import { holdersOf, parentsOf, staffOf } from '../alerts/recipients';
import { defineDailyJob } from '../alerts/jobs';
import { HOSTEL } from './hostel.settings';

/**
 * Hostel: hostels and rooms (beds), allotment of beds to students (fees by room type into the fee
 * instalments), the night roll call, leave passes (asked by parents or made by the warden, approved,
 * scanned out and in at the gate, late returns flagged), the sick bay register, inspections and
 * fines, and allowed visitors. Wardens with the "assigned" scope see only their own hostels.
 */

const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DAY = 86_400_000;
const staffName = (s: { firstName: string; middleName?: string | null; lastName?: string | null }) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');

/** The hostels a person may run ('all', or those they are warden of). */
export const hostelScope = async (userId: string): Promise<'all' | string[]> => {
    const a = await getUserAccess(userId);
    if (a.permissions['hostel.setup'] || a.permissions['hostel.allot'] || a.permissions['hostel.view'] || a.permissions['hostel.warden'] === 'all') return 'all';
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    if (!staff) return [];
    return (await db.hostel.findMany({ where: { wardenId: staff.id }, select: { id: true } })).map((h) => h.id);
};
const inScope = (scope: 'all' | string[], hostelId: string) => scope === 'all' || scope.includes(hostelId);
const assertHostel = async (userId: string, hostelId: string) => {
    if (!inScope(await hostelScope(userId), hostelId)) throw forbidden('Not your hostel');
};

// ─── Hostels and rooms ───────────────────────────────────────────────────────

export const hostelSchema = z.strictObject({ name: z.string().trim().min(2).max(80), gender: z.enum(['boys', 'girls', 'mixed']), wardenId: z.uuid().nullable().optional(), phone: z.string().trim().max(20).nullable().optional(), isActive: z.boolean().default(true) });
export const saveHostel = async (id: string | null, input: z.infer<typeof hostelSchema>, opts: { isDemo?: boolean } = {}) => {
    const data = { ...input, wardenId: input.wardenId ?? null, phone: input.phone || null };
    const h = id ? await db.hostel.update({ where: { id }, data }) : await db.hostel.create({ data: { ...data, tenantId: getTenantId()!, isDemo: !!opts.isDemo } });
    return h;
};

export const listHostels = async (userId: string) => {
    const scope = await hostelScope(userId);
    const [hostels, rooms, active, staff] = await Promise.all([
        db.hostel.findMany({ where: scope === 'all' ? {} : { id: { in: scope } }, orderBy: { name: 'asc' } }),
        db.hostelRoom.groupBy({ by: ['hostelId'], where: { isActive: true }, _sum: { beds: true }, _count: { _all: true } }),
        db.hostelAllotment.groupBy({ by: ['hostelId'], where: { status: 'active' }, _count: { _all: true } }),
        db.staff.findMany({ where: { status: 'working' }, orderBy: { firstName: 'asc' }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true } }),
    ]);
    return {
        hostels: hostels.map((h) => ({ ...h, warden: h.wardenId ? staffName(staff.find((s) => s.id === h.wardenId) ?? { firstName: '' }) : null, rooms: rooms.find((r) => r.hostelId === h.id)?._count._all ?? 0, beds: rooms.find((r) => r.hostelId === h.id)?._sum.beds ?? 0, boarders: active.find((a) => a.hostelId === h.id)?._count._all ?? 0 })),
        staff: staff.map((s) => ({ id: s.id, name: `${staffName(s)} (${s.employeeCode})` })),
        roomTypes: (await db.masterValue.findMany({ where: { master: 'hostel_room_type', isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, extra: true } })).map((t) => ({ id: t.id, name: t.name, fee: Number((t.extra as { fee?: number })?.fee ?? 0) })),
    };
};

export const roomSchema = z.strictObject({ block: z.string().trim().max(20).nullable().optional(), floor: z.number().int().min(-2).max(50).default(0), number: z.string().trim().min(1).max(20), roomTypeId: z.uuid().nullable().optional(), beds: z.number().int().min(1).max(40), isActive: z.boolean().default(true) });
export const saveRoom = async (hostelId: string, id: string | null, input: z.infer<typeof roomSchema>) => {
    if (id) {
        const used = await db.hostelAllotment.findFirst({ where: { roomId: id, status: 'active', bed: { gt: input.beds } } });
        if (used) throw badRequest(`Bed ${used.bed} is taken: move that boarder before reducing the beds`);
        await db.hostelRoom.update({ where: { id }, data: { ...input, block: input.block || null, roomTypeId: input.roomTypeId ?? null } });
    } else {
        if (await db.hostelRoom.findFirst({ where: { hostelId, number: input.number } })) throw badRequest(`Room ${input.number} is already there`);
        await db.hostelRoom.create({ data: { ...input, block: input.block || null, roomTypeId: input.roomTypeId ?? null, hostelId, tenantId: getTenantId()! } });
    }
    return { ok: true };
};

export const bulkRoomsSchema = z.strictObject({ block: z.string().trim().max(20).nullable().optional(), floor: z.number().int().min(-2).max(50), from: z.number().int().min(1).max(9999), to: z.number().int().min(1).max(9999), prefix: z.string().trim().max(6).default(''), roomTypeId: z.uuid().nullable().optional(), beds: z.number().int().min(1).max(40) });
export const addRooms = async (hostelId: string, input: z.infer<typeof bulkRoomsSchema>, opts: { isDemo?: boolean } = {}) => {
    if (input.to < input.from || input.to - input.from > 200) throw badRequest('Give a range of up to 200 rooms');
    const have = new Set((await db.hostelRoom.findMany({ where: { hostelId }, select: { number: true } })).map((r) => r.number));
    const rows = [];
    for (let n = input.from; n <= input.to; n++) {
        const number = `${input.prefix}${n}`;
        if (!have.has(number)) rows.push({ tenantId: getTenantId()!, hostelId, block: input.block || null, floor: input.floor, number, roomTypeId: input.roomTypeId ?? null, beds: input.beds, isDemo: !!opts.isDemo });
    }
    if (rows.length) await db.hostelRoom.createMany({ data: rows });
    return { added: rows.length };
};

export const deleteRoom = async (id: string) => {
    if (await db.hostelAllotment.count({ where: { roomId: id } })) {
        await db.hostelRoom.update({ where: { id }, data: { isActive: false } });
        return { deactivated: true };
    }
    await db.hostelRoom.delete({ where: { id } });
    return { deactivated: false };
};

/** A hostel's rooms with each bed and who is in it. */
export const occupancy = async (hostelId: string, userId: string) => {
    await assertHostel(userId, hostelId);
    const year = await currentYear();
    const [h, rooms, allots, types] = await Promise.all([
        db.hostel.findFirst({ where: { id: hostelId } }),
        db.hostelRoom.findMany({ where: { hostelId }, orderBy: [{ block: 'asc' }, { floor: 'asc' }, { number: 'asc' }] }),
        db.hostelAllotment.findMany({ where: { hostelId, status: 'active' } }),
        db.masterValue.findMany({ where: { master: 'hostel_room_type' }, select: { id: true, name: true } }),
    ]);
    if (!h) throw notFound('Hostel not found');
    const [students, enrol] = await Promise.all([
        db.student.findMany({ where: { id: { in: allots.map((a) => a.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, photoFileId: true } }),
        year ? db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: allots.map((a) => a.studentId) } }, select: { studentId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } }) : [],
    ]);
    return {
        hostel: h,
        rooms: rooms.map((r) => ({
            ...r,
            type: types.find((t) => t.id === r.roomTypeId)?.name ?? '',
            occupants: allots.filter((a) => a.roomId === r.id).length,
            bedList: Array.from({ length: r.beds }, (_, i) => {
                const a = allots.find((x) => x.roomId === r.id && x.bed === i + 1);
                const s = a ? students.find((x) => x.id === a.studentId) : null;
                const e = a ? enrol.find((x) => x.studentId === a.studentId) : null;
                return { bed: i + 1, allotmentId: a?.id ?? null, studentId: s?.id ?? null, name: s ? fullName(s) : null, admissionNo: s?.admissionNo ?? null, section: e ? sectionLabel(e.section) : null, from: a ? isoOf(a.fromDate) : null };
            }),
        })),
    };
};

/** Students to allot (active, with their current bed if any). */
export const findStudents = async (q: string) => {
    const t = q.trim();
    if (t.length < 2) return [];
    const year = await currentYear();
    const rows = await db.student.findMany({ where: { status: 'active', OR: [{ firstName: { contains: t, mode: 'insensitive' } }, { lastName: { contains: t, mode: 'insensitive' } }, { admissionNo: { contains: t, mode: 'insensitive' } }] }, take: 15, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } });
    const [enrol, allots] = await Promise.all([year ? db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: rows.map((r) => r.id) } }, select: { studentId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } }) : [], db.hostelAllotment.findMany({ where: { status: 'active', studentId: { in: rows.map((r) => r.id) } }, include: {} })]);
    const rooms = await db.hostelRoom.findMany({ where: { id: { in: allots.map((a) => a.roomId) } }, select: { id: true, number: true } });
    return rows.map((r) => {
        const e = enrol.find((x) => x.studentId === r.id);
        const a = allots.find((x) => x.studentId === r.id);
        return { id: r.id, name: fullName(r), admissionNo: r.admissionNo, section: e ? sectionLabel(e.section) : '', current: a ? `Room ${rooms.find((x) => x.id === a.roomId)?.number ?? ''}, bed ${a.bed}` : null };
    });
};

export const allotSchema = z.strictObject({ studentId: z.uuid(), roomId: z.uuid(), bed: z.number().int().min(1).max(40), fromDate: D, note: z.string().trim().max(300).nullable().optional() });
/** Gives a student a bed (moving them if they already have one). */
export const allot = async (input: z.infer<typeof allotSchema>, userId: string, opts: { isDemo?: boolean } = {}) => {
    const room = await db.hostelRoom.findFirst({ where: { id: input.roomId, isActive: true } });
    if (!room) throw notFound('Room not found');
    if (input.bed > room.beds) throw badRequest(`Room ${room.number} has ${room.beds} beds`);
    if (await db.hostelAllotment.findFirst({ where: { roomId: room.id, bed: input.bed, status: 'active' } })) throw badRequest('That bed is taken');
    const year = await currentYear();
    if (!year) throw badRequest('No current session');
    const cur = await db.hostelAllotment.findFirst({ where: { studentId: input.studentId, status: 'active' } });
    if (cur) {
        const end = isoOf(new Date(dayDate(input.fromDate).getTime() - DAY));
        await db.hostelAllotment.update({ where: { id: cur.id }, data: { status: 'vacated', toDate: dayDate(end < isoOf(cur.fromDate) ? isoOf(cur.fromDate) : end), note: [cur.note, 'Moved'].filter(Boolean).join(' · ') } });
    }
    const a = await db.hostelAllotment.create({ data: { tenantId: getTenantId()!, studentId: input.studentId, academicYearId: year.id, hostelId: room.hostelId, roomId: room.id, bed: input.bed, fromDate: dayDate(input.fromDate), note: input.note || null, createdBy: userId, isDemo: !!opts.isDemo } });
    await recordAudit({ action: cur ? 'hostel_moved' : 'hostel_allotted', entity: 'student', entityId: input.studentId, changes: { room: room.number, bed: input.bed, from: input.fromDate } });
    return { id: a.id, moved: !!cur };
};

export const vacate = async (allotmentId: string, date: string, note: string | null, userId: string) => {
    const a = await db.hostelAllotment.findFirst({ where: { id: allotmentId, status: 'active' } });
    if (!a) throw badRequest('Not an active allotment');
    await db.hostelAllotment.update({ where: { id: a.id }, data: { status: 'vacated', toDate: dayDate(date < isoOf(a.fromDate) ? isoOf(a.fromDate) : date), note: [a.note, note].filter(Boolean).join(' · ') || null } });
    await recordAudit({ action: 'hostel_vacated', entity: 'student', entityId: a.studentId, changes: { on: date, by: userId } });
    return { ok: true };
};

// ─── Boarders and the roll call ──────────────────────────────────────────────

const boardersOf = async (hostelId: string) => {
    const year = await currentYear();
    const allots = await db.hostelAllotment.findMany({ where: { hostelId, status: 'active' } });
    const [students, enrol, rooms] = await Promise.all([
        db.student.findMany({ where: { id: { in: allots.map((a) => a.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, photoFileId: true } }),
        year ? db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: allots.map((a) => a.studentId) } }, select: { studentId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } }) : [],
        db.hostelRoom.findMany({ where: { id: { in: allots.map((a) => a.roomId) } }, select: { id: true, number: true, block: true, floor: true } }),
    ]);
    return allots
        .map((a) => {
            const s = students.find((x) => x.id === a.studentId);
            const r = rooms.find((x) => x.id === a.roomId);
            const e = enrol.find((x) => x.studentId === a.studentId);
            return { studentId: a.studentId, name: s ? fullName(s) : '', admissionNo: s?.admissionNo ?? '', photo: s?.photoFileId ? `students/${a.studentId}/photo?v=${s.photoFileId}` : null, section: e ? sectionLabel(e.section) : '', roomId: a.roomId, room: r?.number ?? '', block: r?.block ?? '', floor: r?.floor ?? 0, bed: a.bed };
        })
        .sort((x, y) => x.room.localeCompare(y.room, 'en', { numeric: true }) || x.bed - y.bed);
};

/** Leave that has a boarder away on a day (approved and covering it, or out at the gate). */
const awayOn = async (studentIds: string[], date: string) => {
    const start = new Date(`${date}T00:00:00+05:30`);
    const end = new Date(start.getTime() + DAY);
    const rows = await db.hostelLeave.findMany({ where: { studentId: { in: studentIds }, status: { in: ['approved', 'out'] }, fromAt: { lt: end }, toAt: { gt: start } }, select: { studentId: true } });
    return new Set(rows.map((r) => r.studentId));
};

export const rollCall = async (hostelId: string, date: string, userId: string) => {
    await assertHostel(userId, hostelId);
    const [boarders, rc] = await Promise.all([boardersOf(hostelId), db.hostelRollCall.findFirst({ where: { hostelId, date: dayDate(date) } })]);
    const away = await awayOn(boarders.map((b) => b.studentId), date);
    const marks = (rc?.marks ?? {}) as Record<string, string>;
    return { taken: !!rc, takenAt: rc?.takenAt ?? null, boarders: boarders.map((b) => ({ ...b, onLeave: away.has(b.studentId), mark: marks[b.studentId] ?? (away.has(b.studentId) ? 'leave' : 'present') })) };
};

export const rollSchema = z.strictObject({ date: D, marks: z.record(z.uuid(), z.enum(['present', 'absent', 'leave'])) });
export const saveRollCall = async (hostelId: string, input: z.infer<typeof rollSchema>, userId: string, opts: { isDemo?: boolean; quiet?: boolean } = {}) => {
    await assertHostel(userId, hostelId);
    const before = await db.hostelRollCall.findFirst({ where: { hostelId, date: dayDate(input.date) } });
    await db.hostelRollCall.upsert({ where: { hostelId_date: { hostelId, date: dayDate(input.date) } }, create: { tenantId: getTenantId()!, hostelId, date: dayDate(input.date), marks: input.marks, takenBy: userId, isDemo: !!opts.isDemo }, update: { marks: input.marks, takenBy: userId, takenAt: new Date() } });
    const absent = Object.entries(input.marks).filter(([, m]) => m === 'absent').map(([id]) => id);
    const was = new Set(Object.entries((before?.marks ?? {}) as Record<string, string>).filter(([, m]) => m === 'absent').map(([id]) => id));
    const newly = absent.filter((id) => !was.has(id));
    if (newly.length && !opts.quiet) {
        const [h, students] = await Promise.all([db.hostel.findFirst({ where: { id: hostelId }, select: { name: true, wardenId: true } }), db.student.findMany({ where: { id: { in: newly } }, select: { id: true, firstName: true, middleName: true, lastName: true } })]);
        raiseLater('hostel_absent', { parent: () => parentsOf(newly), warden: () => (h?.wardenId ? staffOf([h.wardenId]) : Promise.resolve([])), principal: () => holdersOf('hostel.setup') }, { hostel: h?.name ?? '', date: input.date, students: students.map((s) => fullName(s)).join(', ') }, { dedupe: `hostel-absent:${hostelId}:${input.date}:${newly.join(',')}` });
    }
    return { saved: true, absent: absent.length };
};

// ─── Leave and passes ────────────────────────────────────────────────────────

const code = () => randomBytes(4).toString('hex').toUpperCase();
export const leaveSchema = z.strictObject({ studentId: z.uuid(), fromAt: z.iso.datetime({ offset: true }), toAt: z.iso.datetime({ offset: true }), reason: z.string().trim().min(3).max(300), escort: z.string().trim().max(100).nullable().optional(), destination: z.string().trim().max(100).nullable().optional() });

const mineIds = async (userId: string) => (await db.student.findMany({ where: { OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, select: { id: true } })).map((s) => s.id);

/** A leave request (by a parent for their child, or by the warden; the warden's own is approved at once). */
export const askLeave = async (input: z.infer<typeof leaveSchema>, userId: string, asParent: boolean, opts: { isDemo?: boolean; status?: string } = {}) => {
    const from = new Date(input.fromAt);
    const to = new Date(input.toAt);
    if (to <= from) throw badRequest('The return is before the leaving time');
    const a = await db.hostelAllotment.findFirst({ where: { studentId: input.studentId, status: 'active' } });
    if (!a) throw badRequest('Not a boarder');
    if (asParent) {
        const s = await getSettings({ on: HOSTEL.parentLeave });
        if (!s.on) throw forbidden('Ask the warden for leave');
        if (!(await mineIds(userId)).includes(input.studentId)) throw forbidden();
    } else await assertHostel(userId, a.hostelId);
    const days = (to.getTime() - from.getTime()) / DAY;
    const { principalDays } = await getSettings({ principalDays: HOSTEL.principalDays });
    const autoOk = !asParent && (principalDays === 0 || days <= principalDays || (await hostelScope(userId)) === 'all');
    const l = await db.hostelLeave.create({ data: { tenantId: getTenantId()!, studentId: input.studentId, hostelId: a.hostelId, fromAt: from, toAt: to, reason: input.reason, escort: input.escort || null, destination: input.destination || null, status: opts.status ?? (autoOk ? 'approved' : 'pending'), passCode: code(), requestedBy: userId, answeredBy: autoOk ? userId : null, answeredAt: autoOk ? new Date() : null, isDemo: !!opts.isDemo } });
    if (l.status === 'pending' && !opts.isDemo) {
        const [h, st] = await Promise.all([db.hostel.findFirst({ where: { id: a.hostelId }, select: { wardenId: true } }), db.student.findFirst({ where: { id: input.studentId }, select: { firstName: true, middleName: true, lastName: true } })]);
        raiseLater('hostel_leave_request', { warden: () => (h?.wardenId ? staffOf([h.wardenId]) : holdersOf('hostel.warden')) }, { student: st ? fullName(st) : '', from: from.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), to: to.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), reason: input.reason }, { dedupe: `hostel-leave:${l.id}` });
    }
    return { id: l.id, status: l.status, passCode: l.passCode };
};

const leaveRows = async (where: object) => {
    const rows = await db.hostelLeave.findMany({ where, orderBy: { fromAt: 'desc' }, take: 300 });
    const [students, hostels, users] = await Promise.all([db.student.findMany({ where: { id: { in: rows.map((r) => r.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, photoFileId: true } }), db.hostel.findMany({ where: { id: { in: rows.map((r) => r.hostelId) } }, select: { id: true, name: true } }), db.user.findMany({ where: { id: { in: rows.flatMap((r) => [r.requestedBy, r.answeredBy]).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } })]);
    const un = (id: string | null) => (id ? (users.find((u) => u.id === id)?.displayName ?? '') : '');
    return rows.map((r) => {
        const s = students.find((x) => x.id === r.studentId);
        return { id: r.id, studentId: r.studentId, student: s ? fullName(s) : '', admissionNo: s?.admissionNo ?? '', photo: s?.photoFileId ? `students/${r.studentId}/photo?v=${s.photoFileId}` : null, hostel: hostels.find((h) => h.id === r.hostelId)?.name ?? '', fromAt: r.fromAt, toAt: r.toAt, reason: r.reason, escort: r.escort, destination: r.destination, status: r.status, passCode: r.status === 'approved' || r.status === 'out' ? r.passCode : null, requestedBy: un(r.requestedBy), answeredBy: un(r.answeredBy), answer: r.answer, outAt: r.outAt, inAt: r.inAt, late: r.late };
    });
};

export const leavesQuery = z.object({ show: z.enum(['open', 'out', 'done', 'all']).default('open') });
export const listLeaves = async (q: z.infer<typeof leavesQuery>, userId: string) => {
    const scope = await hostelScope(userId);
    const status = q.show === 'open' ? { status: { in: ['pending', 'approved'] } } : q.show === 'out' ? { status: 'out' } : q.show === 'done' ? { status: { in: ['returned', 'rejected', 'cancelled'] } } : {};
    return leaveRows({ ...status, ...(scope === 'all' ? {} : { hostelId: { in: scope } }) });
};

export const answerLeave = async (id: string, approve: boolean, answer: string | null, userId: string) => {
    const l = await db.hostelLeave.findFirst({ where: { id } });
    if (!l || l.status !== 'pending') throw badRequest('Nothing to answer');
    await assertHostel(userId, l.hostelId);
    const { principalDays } = await getSettings({ principalDays: HOSTEL.principalDays });
    const days = (l.toAt.getTime() - l.fromAt.getTime()) / DAY;
    if (approve && principalDays > 0 && days > principalDays && (await hostelScope(userId)) !== 'all') throw forbidden(`Leave longer than ${principalDays} days needs the principal`);
    await db.hostelLeave.update({ where: { id }, data: { status: approve ? 'approved' : 'rejected', answer, answeredBy: userId, answeredAt: new Date() } });
    const st = await db.student.findFirst({ where: { id: l.studentId }, select: { firstName: true, middleName: true, lastName: true } });
    raiseLater('hostel_leave_answer', { parent: () => parentsOf([l.studentId]) }, { student: st ? fullName(st) : '', result: approve ? `approved: pass code ${l.passCode}` : 'not approved', answer: answer ?? '' }, { dedupe: `hostel-leave-ans:${id}` });
    return { id };
};

export const cancelLeave = async (id: string, userId: string) => {
    const l = await db.hostelLeave.findFirst({ where: { id } });
    if (!l || !['pending', 'approved'].includes(l.status)) throw badRequest('Cannot be cancelled now');
    if (!(await mineIds(userId)).includes(l.studentId)) await assertHostel(userId, l.hostelId);
    await db.hostelLeave.update({ where: { id }, data: { status: 'cancelled' } });
    return { id };
};

/** The gate: an approved pass goes out, an "out" one comes back (late is flagged). */
export const scanPass = async (passCode: string, userId: string) => {
    const l = await db.hostelLeave.findFirst({ where: { passCode: passCode.trim().toUpperCase() } });
    if (!l) throw notFound('No pass with that code');
    const [row] = await leaveRows({ id: l.id });
    if (l.status === 'approved') {
        if (l.fromAt.getTime() - Date.now() > 6 * 3_600_000) throw badRequest(`This pass starts at ${l.fromAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
        await db.hostelLeave.update({ where: { id: l.id }, data: { status: 'out', outAt: new Date() } });
        raiseLater('hostel_movement', { parent: () => parentsOf([l.studentId]) }, { student: row.student, movement: 'left the hostel', at: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) }, { dedupe: `hostel-out:${l.id}` });
        return { action: 'out' as const, leave: { ...row, status: 'out' } };
    }
    if (l.status === 'out') {
        const { grace } = await getSettings({ grace: HOSTEL.lateMinutes });
        const late = Date.now() > l.toAt.getTime() + grace * 60_000;
        await db.hostelLeave.update({ where: { id: l.id }, data: { status: 'returned', inAt: new Date(), late } });
        raiseLater('hostel_movement', { parent: () => parentsOf([l.studentId]) }, { student: row.student, movement: late ? 'came back late' : 'came back', at: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) }, { dedupe: `hostel-in:${l.id}` });
        await recordAudit({ action: 'hostel_pass_in', entity: 'student', entityId: l.studentId, changes: { late, by: userId } });
        return { action: 'in' as const, leave: { ...row, status: 'returned', late } };
    }
    throw badRequest(l.status === 'pending' ? 'This leave is not approved yet' : l.status === 'returned' ? 'Already came back on this pass' : `This pass is ${l.status}`);
};

// ─── Visitors, sick bay, inspections ─────────────────────────────────────────

export const visitorSchema = z.strictObject({ studentId: z.uuid(), name: z.string().trim().min(2).max(80), relation: z.string().trim().max(40).nullable().optional(), phone: z.string().trim().max(20).nullable().optional() });
export const addVisitor = async (input: z.infer<typeof visitorSchema>, userId: string, opts: { isDemo?: boolean } = {}) => {
    const a = await db.hostelAllotment.findFirst({ where: { studentId: input.studentId, status: 'active' } });
    if (!a) throw badRequest('Not a boarder');
    if (!(await mineIds(userId)).includes(input.studentId)) await assertHostel(userId, a.hostelId);
    await db.hostelVisitorAllow.create({ data: { ...input, relation: input.relation || null, phone: input.phone || null, tenantId: getTenantId()!, addedBy: userId, isDemo: !!opts.isDemo } });
    return visitors(input.studentId);
};
export const visitors = (studentId: string) => db.hostelVisitorAllow.findMany({ where: { studentId }, orderBy: { name: 'asc' } });
export const removeVisitor = async (id: string, userId: string) => {
    const v = await db.hostelVisitorAllow.findFirst({ where: { id } });
    if (!v) throw notFound('Not found');
    const a = await db.hostelAllotment.findFirst({ where: { studentId: v.studentId, status: 'active' } });
    if (!(await mineIds(userId)).includes(v.studentId) && a) await assertHostel(userId, a.hostelId);
    await db.hostelVisitorAllow.delete({ where: { id } });
    return visitors(v.studentId);
};

export const medicalSchema = z.strictObject({ studentId: z.uuid(), complaint: z.string().trim().min(2).max(300), treatment: z.string().trim().max(300).nullable().optional(), medicine: z.string().trim().max(200).nullable().optional(), referred: z.boolean().default(false), tellParent: z.boolean().default(true) });
export const addMedical = async (input: z.infer<typeof medicalSchema>, userId: string, opts: { isDemo?: boolean; at?: Date } = {}) => {
    const a = await db.hostelAllotment.findFirst({ where: { studentId: input.studentId, status: 'active' } });
    if (a) await assertHostel(userId, a.hostelId);
    await db.hostelMedical.create({ data: { tenantId: getTenantId()!, studentId: input.studentId, hostelId: a?.hostelId ?? null, complaint: input.complaint, treatment: input.treatment || null, medicine: input.medicine || null, referred: input.referred, parentTold: input.tellParent, recordedBy: userId, isDemo: !!opts.isDemo, ...(opts.at ? { at: opts.at } : {}) } });
    if (input.tellParent && !opts.isDemo) {
        const st = await db.student.findFirst({ where: { id: input.studentId }, select: { firstName: true, middleName: true, lastName: true } });
        raiseLater('hostel_medical', { parent: () => parentsOf([input.studentId]) }, { student: st ? fullName(st) : '', complaint: input.complaint, treatment: [input.treatment, input.medicine].filter(Boolean).join(' · ') || '—', referred: input.referred ? 'Taken to the doctor / hospital.' : '' }, { dedupe: `hostel-med:${input.studentId}:${Date.now()}` });
    }
    return { ok: true };
};

export const listMedical = async (userId: string, studentId?: string) => {
    const scope = await hostelScope(userId);
    const rows = await db.hostelMedical.findMany({ where: { ...(studentId ? { studentId } : {}), ...(scope === 'all' ? {} : { hostelId: { in: scope } }) }, orderBy: { at: 'desc' }, take: 200 });
    const students = await db.student.findMany({ where: { id: { in: rows.map((r) => r.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } });
    return rows.map((r) => ({ ...r, student: fullName(students.find((s) => s.id === r.studentId) ?? { firstName: '' }) }));
};

export const noteSchema = z.strictObject({ hostelId: z.uuid(), roomId: z.uuid().nullable().optional(), studentId: z.uuid().nullable().optional(), kind: z.enum(['inspection', 'fine']), note: z.string().trim().min(2).max(500), fine: z.number().int().min(0).max(100_000).nullable().optional() });
export const addNote = async (input: z.infer<typeof noteSchema>, userId: string, opts: { isDemo?: boolean; at?: Date } = {}) => {
    await assertHostel(userId, input.hostelId);
    if (input.kind === 'fine' && (!input.studentId || !input.fine)) throw badRequest('A fine needs the student and the amount');
    const year = await currentYear();
    await db.hostelNote.create({ data: { tenantId: getTenantId()!, hostelId: input.hostelId, roomId: input.roomId ?? null, studentId: input.studentId ?? null, academicYearId: year?.id ?? null, kind: input.kind, note: input.note, fine: input.kind === 'fine' ? (input.fine ?? null) : null, recordedBy: userId, isDemo: !!opts.isDemo, ...(opts.at ? { at: opts.at } : {}) } });
    return listNotes(input.hostelId, userId);
};
export const listNotes = async (hostelId: string, userId: string) => {
    await assertHostel(userId, hostelId);
    const rows = await db.hostelNote.findMany({ where: { hostelId }, orderBy: { at: 'desc' }, take: 200 });
    const [students, rooms] = await Promise.all([db.student.findMany({ where: { id: { in: rows.map((r) => r.studentId!).filter(Boolean) } }, select: { id: true, firstName: true, middleName: true, lastName: true } }), db.hostelRoom.findMany({ where: { id: { in: rows.map((r) => r.roomId!).filter(Boolean) } }, select: { id: true, number: true } })]);
    return rows.map((r) => ({ ...r, student: r.studentId ? fullName(students.find((s) => s.id === r.studentId) ?? { firstName: '' }) : null, room: r.roomId ? (rooms.find((x) => x.id === r.roomId)?.number ?? null) : null }));
};

// ─── Parents and students ────────────────────────────────────────────────────

export const myHostel = async (userId: string) => {
    const ids = await mineIds(userId);
    const allots = await db.hostelAllotment.findMany({ where: { studentId: { in: ids }, status: 'active' } });
    const s = await getSettings({ parentLeave: HOSTEL.parentLeave });
    const out = [];
    for (const a of allots) {
        const [st, room, hostel, mates, leaves, medical, vis, rolls] = await Promise.all([
            db.student.findFirst({ where: { id: a.studentId }, select: { firstName: true, middleName: true, lastName: true } }),
            db.hostelRoom.findFirst({ where: { id: a.roomId } }),
            db.hostel.findFirst({ where: { id: a.hostelId } }),
            db.hostelAllotment.findMany({ where: { roomId: a.roomId, status: 'active', studentId: { not: a.studentId } } }),
            leaveRows({ studentId: a.studentId }),
            db.hostelMedical.findMany({ where: { studentId: a.studentId }, orderBy: { at: 'desc' }, take: 10 }),
            visitors(a.studentId),
            db.hostelRollCall.findMany({ where: { hostelId: a.hostelId, date: { gte: dayDate(isoOf(new Date(Date.now() - 14 * DAY))) } }, orderBy: { date: 'desc' } }),
        ]);
        const mateNames = await db.student.findMany({ where: { id: { in: mates.map((m) => m.studentId) } }, select: { firstName: true, middleName: true, lastName: true } });
        const warden = hostel?.wardenId ? await db.staff.findFirst({ where: { id: hostel.wardenId }, select: { firstName: true, middleName: true, lastName: true, mobile: true } }) : null;
        out.push({
            studentId: a.studentId,
            name: st ? fullName(st) : '',
            hostel: hostel?.name ?? '',
            hostelPhone: hostel?.phone ?? null,
            warden: warden ? { name: staffName(warden), phone: warden.mobile } : null,
            room: room?.number ?? '',
            bed: a.bed,
            since: isoOf(a.fromDate),
            roommates: mateNames.map((m) => fullName(m)),
            leaves,
            medical,
            visitors: vis,
            nights: rolls.map((r) => ({ date: isoOf(r.date), mark: ((r.marks ?? {}) as Record<string, string>)[a.studentId] ?? null })).filter((x) => x.mark),
        });
    }
    return { parentLeave: s.parentLeave, children: out };
};

// ─── Fees ────────────────────────────────────────────────────────────────────

// The room type's fee in each instalment due while the student has a bed; fines into the next instalment.
registerFeeSource(async (yearId, students, instalments) => {
    const out = new Map<string, { feeHeadId: string; instalmentId: string; amount: number }[]>();
    if (!students.length || !instalments.length) return out;
    const [allots, fines] = await Promise.all([db.hostelAllotment.findMany({ where: { academicYearId: yearId, studentId: { in: students.map((s) => s.id) } } }), db.hostelNote.findMany({ where: { academicYearId: yearId, kind: 'fine', fine: { gt: 0 }, studentId: { in: students.map((s) => s.id) } }, select: { studentId: true, fine: true, at: true } })]);
    if (!allots.length && !fines.length) return out;
    const { code: c } = await getSettings({ code: HOSTEL.feeHeadCode });
    const head = await db.masterValue.findFirst({ where: { master: 'fee_head', code: { equals: c, mode: 'insensitive' } }, select: { id: true } });
    if (!head) return out;
    const rooms = await db.hostelRoom.findMany({ where: { id: { in: allots.map((a) => a.roomId) } }, select: { id: true, roomTypeId: true } });
    const types = await db.masterValue.findMany({ where: { master: 'hostel_room_type' }, select: { id: true, extra: true } });
    const feeOf = (roomId: string) => Number(((types.find((t) => t.id === rooms.find((r) => r.id === roomId)?.roomTypeId)?.extra ?? {}) as { fee?: number }).fee ?? 0);
    const add = (studentId: string, instalmentId: string, amount: number) => {
        const lines = out.get(studentId) ?? [];
        const same = lines.find((l) => l.instalmentId === instalmentId);
        if (same) same.amount += amount;
        else lines.push({ feeHeadId: head.id, instalmentId, amount });
        out.set(studentId, lines);
    };
    for (const inst of instalments)
        for (const a of allots) {
            const due = isoOf(inst.dueDate);
            // The bed's period covers the instalment's due date (or started within 15 days after it).
            const from = isoOf(new Date(a.fromDate.getTime() - 15 * DAY));
            if (due >= from && (!a.toDate || due <= isoOf(a.toDate))) add(a.studentId, inst.id, feeOf(a.roomId));
        }
    const sorted = [...instalments].sort((x, y) => x.dueDate.getTime() - y.dueDate.getTime());
    for (const f of fines) {
        const inst = sorted.find((i) => i.dueDate >= f.at) ?? sorted[sorted.length - 1];
        add(f.studentId!, inst.id, f.fine!);
    }
    return out;
});

// ─── Daily: roll call not taken, boarders not back ───────────────────────────

defineDailyJob({
    key: 'hostel_checks',
    at: async () => {
        const { t } = await getSettings({ t: HOSTEL.rollCallTime });
        const [h, m] = t.split(':').map(Number);
        const mins = Math.min(23 * 60 + 59, h * 60 + m + 45);
        return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    },
    run: async () => {
        const today = todayIST();
        const hostels = await db.hostel.findMany({ where: { isActive: true } });
        let missing = 0;
        for (const h of hostels) {
            if (!(await db.hostelAllotment.count({ where: { hostelId: h.id, status: 'active' } }))) continue;
            if (await db.hostelRollCall.findFirst({ where: { hostelId: h.id, date: dayDate(today) } })) continue;
            missing++;
            raiseLater('hostel_roll_missing', { warden: () => (h.wardenId ? staffOf([h.wardenId]) : holdersOf('hostel.warden')) }, { hostel: h.name, date: today }, { dedupe: `hostel-roll:${h.id}:${today}` });
        }
        const { grace } = await getSettings({ grace: HOSTEL.lateMinutes });
        const overdue = await db.hostelLeave.findMany({ where: { status: 'out', toAt: { lt: new Date(Date.now() - grace * 60_000) } } });
        if (overdue.length) {
            const students = await db.student.findMany({ where: { id: { in: overdue.map((o) => o.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true } });
            raiseLater('hostel_not_back', { wardens: () => holdersOf('hostel.warden') }, { count: String(overdue.length), list: overdue.map((o) => `- ${fullName(students.find((s) => s.id === o.studentId) ?? { firstName: '' })} (due ${o.toAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })})`).join('\n') }, { dedupe: `hostel-late:${today}` });
        }
        return `${missing} roll calls missing, ${overdue.length} not back`;
    },
});
