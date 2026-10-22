import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { fullName } from '../students/students.service';
import { ATTENDANCE, atIST, dayDate, isoOf, minutesIST, todayIST, toMinutes } from './attendance.settings';
import { dayOff, daysOff } from './calendar.service';
import { statuses } from './student-attendance.service';
import { CheckInInput, REASON_TEXT, Reason, runChecks } from './checkin-checks.service';
import { deleteFile } from '../../core/files';
import { approvedLeaveOn } from '../leave/staff-leave.service';
import { currentYear } from '../academic/years.service';

/**
 * Staff attendance: people check in and out themselves (later a biometric device does it), the
 * office sees the day and corrects it. On time, late or half day comes from the shift settings.
 */

const ISO = z.iso.date();
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time like 08:05');
const timeIST = (d: Date | null) => (d ? new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(11, 16) : null);

const shift = () =>
    getSettings({ enabled: ATTENDANCE.staffCheckIn, start: ATTENDANCE.staffStart, end: ATTENDANCE.staffEnd, grace: ATTENDANCE.staffGrace, halfDay: ATTENDANCE.staffHalfDay, networks: ATTENDANCE.staffNetworks });

/** Present / Late / Half day for a check-in time (by the codes P, LT, HD of the status list). */
const statusForCheckIn = async (at: Date) => {
    const s = await shift();
    const list = (await statuses()).filter((x) => x.isActive);
    const minutesLate = minutesIST(at) - toMinutes(s.start);
    const code = s.halfDay && minutesLate >= s.halfDay ? 'HD' : minutesLate > s.grace ? 'LT' : 'P';
    const st = list.find((x) => x.code === code) ?? list.find((x) => x.code === 'P') ?? list.find((x) => x.present === 1);
    return { statusId: st?.id ?? null, late: minutesLate > s.grace };
};

/** Whether the request comes from an allowed network (exact address, or a range ending with a dot). */
const fromAllowedNetwork = (networks: string, ip: string | undefined) => {
    const list = networks.split(',').map((x) => x.trim()).filter(Boolean);
    if (!list.length) return true;
    const addr = (ip ?? '').replace(/^::ffff:/, '');
    return list.some((n) => (n.endsWith('.') || n.endsWith('*') ? addr.startsWith(n.replace(/\*$/, '')) : addr === n));
};

const myStaff = async (userId: string) => {
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true, status: true } });
    if (!staff) throw badRequest('Your login is not linked to a staff record, so there is nothing to check in to. Ask the office.');
    return staff;
};

type Row = {
    id?: string;
    checkIn: Date | null;
    checkOut: Date | null;
    late: boolean;
    earlyOut: boolean;
    source: string;
    note: string | null;
    statusId: string | null;
    approval?: string | null;
    approvalReasons?: string[];
    checkInPhotoId?: string | null;
    checkOutPhotoId?: string | null;
    checkInDistance?: number | null;
    faceDistance?: number | null;
};
const present = (r: Row | null, names: Map<string, { name: string; code: string }>) =>
    r
        ? {
              id: r.id ?? null,
              checkIn: timeIST(r.checkIn),
              checkOut: timeIST(r.checkOut),
              late: r.late,
              earlyOut: r.earlyOut,
              source: r.source,
              note: r.note,
              status: r.statusId ? (names.get(r.statusId) ?? null) : null,
              approval: r.approval ?? null,
              reasons: (r.approvalReasons ?? []).map((x) => REASON_TEXT[x as Reason] ?? x),
              photoIn: r.checkInPhotoId ?? null,
              photoOut: r.checkOutPhotoId ?? null,
              distance: r.checkInDistance ?? null,
              faceDistance: r.faceDistance ?? null,
          }
        : null;

const statusNames = async () => new Map((await statuses()).map((s) => [s.id, { name: s.name, code: s.code }]));

// ─── The person themself ─────────────────────────────────────────────────────

/** Today (can they check in or out, and why not) and their month so far. */
export const myDay = async (userId: string, ip?: string) => {
    const staff = await myStaff(userId);
    const s = await shift();
    const today = todayIST();
    const [row, off, names] = await Promise.all([db.staffAttendance.findFirst({ where: { staffId: staff.id, date: dayDate(today) } }), dayOff(today, 'staff'), statusNames()]);
    const leave = await approvedLeaveOn(staff.id, today);
    const away = leave && !leave.leaveType.countsPresent ? `You are on ${leave.leaveType.name} today.` : null;
    const why = !s.enabled ? 'Check-in by staff is switched off (System Settings → Attendance).' : off ? `Not a working day: ${off}.` : away ? away : !fromAllowedNetwork(s.networks, ip) ? 'You can check in only from the school’s network.' : null;
    const monthStart = `${today.slice(0, 7)}-01`;
    const [rows, offs] = await Promise.all([db.staffAttendance.findMany({ where: { staffId: staff.id, date: { gte: dayDate(monthStart), lte: dayDate(today) } }, orderBy: { date: 'asc' } }), daysOff(monthStart, today, 'staff')]);
    const month = [];
    for (let t = dayDate(monthStart).getTime(); t <= dayDate(today).getTime(); t += 86_400_000) {
        const iso = isoOf(new Date(t));
        const r = rows.find((x) => isoOf(x.date) === iso) ?? null;
        month.push({ date: iso, off: offs.get(iso) ?? null, ...(present(r, names) ?? { checkIn: null, checkOut: null, late: false, earlyOut: false, source: null, note: null, status: null }) });
    }
    const c = await getSettings({ photo: ATTENDANCE.staffPhoto, face: ATTENDANCE.staffFace, liveness: ATTENDANCE.staffLiveness, location: ATTENDANCE.staffLocation, selfEnrol: ATTENDANCE.staffSelfEnrol, phoneLock: ATTENDANCE.staffPhoneLock });
    const face = await db.staffFace.findFirst({ where: { staffId: staff.id }, select: { status: true } });
    return {
        staff: { name: fullName(staff), employeeCode: staff.employeeCode },
        checks: { photo: c.photo || c.face || c.liveness, face: c.face, liveness: c.liveness, location: c.location, phoneLock: c.phoneLock !== 'off', enrolled: face?.status ?? null, canEnrol: c.selfEnrol },
        today,
        shift: { start: s.start, end: s.end, grace: s.grace },
        day: present(row, names),
        canCheckIn: !why && !row?.checkIn,
        canCheckOut: !why && !!row?.checkIn && !row.checkOut,
        reason: why,
        month: month.reverse(),
    };
};

export const checkIn = async (userId: string, ip?: string, input: CheckInInput = {}) => {
    const staff = await myStaff(userId);
    const s = await shift();
    const today = todayIST();
    if (!s.enabled) throw forbidden('Check-in by staff is switched off');
    const off = await dayOff(today, 'staff');
    if (off) throw badRequest(`Not a working day: ${off}`);
    const leave = await approvedLeaveOn(staff.id, today);
    if (leave && !leave.leaveType.countsPresent) throw badRequest(`You are on ${leave.leaveType.name} today. If you have come in, ask the office to cancel the leave.`);
    if (!fromAllowedNetwork(s.networks, ip)) throw forbidden('You can check in only from the school’s network');
    const existing = await db.staffAttendance.findFirst({ where: { staffId: staff.id, date: dayDate(today) } });
    if (existing?.checkIn) throw conflict('You have already checked in today');
    const now = new Date();
    const checks = await runChecks(staff.id, input);
    if (checks.blockMessage) throw forbidden(checks.blockMessage);
    const { statusId, late } = await statusForCheckIn(now);
    const data = {
        checkIn: now,
        statusId,
        late,
        source: 'button',
        checkInIp: ip ?? null,
        checkInPhotoId: checks.photoId,
        checkInLat: checks.lat,
        checkInLng: checks.lng,
        checkInAccuracy: checks.accuracy,
        checkInDistance: checks.distance,
        faceDistance: checks.faceDistance,
        approval: checks.reasons.length ? 'pending' : null,
        approvalReasons: checks.reasons,
    };
    if (existing) await db.staffAttendance.update({ where: { id: existing.id }, data });
    else await db.staffAttendance.create({ data: { tenantId: getTenantId()!, staffId: staff.id, date: dayDate(today), ...data } });
    return myDay(userId, ip);
};

export const checkOut = async (userId: string, ip?: string, input: CheckInInput = {}) => {
    const staff = await myStaff(userId);
    const s = await shift();
    if (!s.enabled) throw forbidden('Check-in by staff is switched off');
    if (!fromAllowedNetwork(s.networks, ip)) throw forbidden('You can check out only from the school’s network');
    const row = await db.staffAttendance.findFirst({ where: { staffId: staff.id, date: dayDate(todayIST()) } });
    if (!row?.checkIn) throw badRequest('Check in first');
    if (row.checkOut) throw conflict('You have already checked out today');
    const now = new Date();
    const checks = await runChecks(staff.id, input);
    if (checks.blockMessage) throw forbidden(checks.blockMessage.replace('Check in when you reach school', 'Check out at school'));
    // Something wrong at check-out sends the day for approval too (unless the office already decided).
    const more = checks.reasons.filter((r) => !row.approvalReasons.includes(r)).map((r) => `${r}_out`);
    await db.staffAttendance.update({
        where: { id: row.id },
        data: {
            checkOut: now,
            earlyOut: minutesIST(now) < toMinutes(s.end),
            checkOutIp: ip ?? null,
            checkOutPhotoId: checks.photoId,
            checkOutLat: checks.lat,
            checkOutLng: checks.lng,
            checkOutAccuracy: checks.accuracy,
            checkOutDistance: checks.distance,
            ...(checks.reasons.length && row.approval !== 'rejected' ? { approval: 'pending', approvalReasons: [...row.approvalReasons, ...more] } : {}),
        },
    });
    return myDay(userId, ip);
};

export const myMonthQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be a month like 2026-10').optional() });

type DaySummary = { days: number; present: number; absent: number; excused: number; percent: number | null };

/**
 * A staff member's own month (calendar / table, like the students' My Attendance): each day's status,
 * times in and out, leave asked or approved; with the month's and the session's totals. A working
 * day gone by with nothing recorded counts as absent.
 */
export const myMonth = async (userId: string, monthQ?: string) => {
    const staff = await myStaff(userId);
    const today = todayIST();
    const month = monthQ ?? today.slice(0, 7);
    const first = `${month}-01`;
    const last = isoOf(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)));
    const year = await currentYear();
    const yearFrom = year ? isoOf(year.startDate) : `${today.slice(0, 4)}-01-01`;
    const from = first < yearFrom ? first : yearFrom;
    const [list, rows, off, leaves, joined] = await Promise.all([
        statuses(),
        db.staffAttendance.findMany({ where: { staffId: staff.id, date: { gte: dayDate(from), lte: dayDate(last) } } }),
        daysOff(from, last, 'staff'),
        db.staffLeave.findMany({
            where: { staffId: staff.id, status: { in: ['pending', 'approved'] }, fromDate: { lte: dayDate(last) }, toDate: { gte: dayDate(first) } },
            select: { fromDate: true, toDate: true, status: true, half: true, reason: true, leaveType: { select: { code: true, name: true } } },
        }),
        db.staff.findUnique({ where: { id: staff.id }, select: { joiningDate: true } }),
    ]);
    const byId = new Map(list.map((x) => [x.id, x]));
    const byDay = new Map(rows.map((r) => [isoOf(r.date), r]));
    const joining = joined ? isoOf(joined.joiningDate) : from;
    const markOf = (iso: string) => {
        const r = byDay.get(iso);
        const st = r?.statusId ? byId.get(r.statusId) : undefined;
        if (!r || !st) return null;
        const times = [timeIST(r.checkIn) && `In ${timeIST(r.checkIn)}`, timeIST(r.checkOut) && `out ${timeIST(r.checkOut)}`, r.approval === 'pending' ? 'waiting for approval' : null, r.source === 'leave' ? null : r.note].filter(Boolean).join(' · ');
        return { slot: 'day', code: st.code, name: st.name, present: st.present, excused: st.excused, note: times || null };
    };
    const summary = (a: string, b: string): DaySummary => {
        const s: DaySummary = { days: 0, present: 0, absent: 0, excused: 0, percent: null };
        for (let t = dayDate(a).getTime(); t <= dayDate(b).getTime(); t += 86_400_000) {
            const iso = isoOf(new Date(t));
            if (iso > today || iso < joining || off.has(iso)) continue;
            const m = markOf(iso);
            // Today with nothing yet is not counted (the day isn't over).
            if (!m && iso === today) continue;
            s.days++;
            if (!m) s.absent++;
            else if (m.excused) s.excused++;
            else {
                s.present += m.present;
                if (m.present === 0) s.absent++;
            }
        }
        const counted = s.days - s.excused;
        s.percent = counted > 0 ? Math.round((s.present / counted) * 1000) / 10 : null;
        return s;
    };
    const days = [];
    for (let t = dayDate(first).getTime(); t <= dayDate(last).getTime(); t += 86_400_000) {
        const iso = isoOf(new Date(t));
        const lv = leaves.find((l) => isoOf(l.fromDate) <= iso && isoOf(l.toDate) >= iso);
        const m = markOf(iso);
        days.push({
            date: iso,
            off: off.get(iso) ?? null,
            future: iso > today,
            leave: lv && !off.has(iso) ? { status: lv.status as 'pending' | 'approved', kind: lv.leaveType.code, kindName: `${lv.leaveType.name}${lv.half ? ` (${lv.half} half)` : ''}`, reason: lv.reason } : null,
            marks: m ? [m] : [],
        });
    }
    const { minPercent } = await getSettings({ minPercent: ATTENDANCE.minPercent });
    return {
        staff: { name: fullName(staff), employeeCode: staff.employeeCode },
        month,
        days,
        statuses: list.filter((x) => x.isActive).map(({ code, name, present, excused }) => ({ code, name, present, excused })),
        monthSummary: summary(first, last),
        yearSummary: { ...summary(yearFrom, today), from: yearFrom, year: year?.name ?? today.slice(0, 4) },
        minPercent,
    };
};

// ─── The office ──────────────────────────────────────────────────────────────

export const dayQuery = z.object({ date: ISO.optional() });

/** Every working staff member on a day: in / out, late, status; absent when nothing is recorded. */
export const staffDay = async (q: z.infer<typeof dayQuery>) => {
    const date = q.date ?? todayIST();
    const d = dayDate(date);
    const [staff, rows, off, names] = await Promise.all([
        db.staff.findMany({
            where: { joiningDate: { lte: d }, OR: [{ status: 'working' }, { statusDate: { gt: d } }] },
            select: { id: true, employeeCode: true, firstName: true, middleName: true, lastName: true, designation: { select: { name: true } }, department: { select: { name: true } } },
            orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
        }),
        db.staffAttendance.findMany({ where: { date: d } }),
        dayOff(date, 'staff'),
        statusNames(),
    ]);
    const byStaff = new Map(rows.map((r) => [r.staffId, r]));
    const list = staff.map((s) => ({ id: s.id, employeeCode: s.employeeCode, name: fullName(s), designation: s.designation?.name ?? null, department: s.department?.name ?? null, record: present(byStaff.get(s.id) ?? null, names) }));
    const has = (f: (r: NonNullable<(typeof list)[number]['record']>) => boolean) => list.filter((x) => x.record && f(x.record)).length;
    return {
        date,
        dayOff: off,
        isToday: date === todayIST(),
        staff: list,
        totals: {
            staff: list.length,
            in: has((r) => !!r.checkIn),
            late: has((r) => r.late),
            // On a working day that has gone by (or today), nobody recorded = absent.
            notIn: off || date > todayIST() ? 0 : list.filter((x) => !x.record || (!x.record.checkIn && !x.record.status)).length,
        },
    };
};

export const correctionSchema = z.strictObject({
    date: ISO,
    checkIn: HHMM.nullable().optional(),
    checkOut: HHMM.nullable().optional(),
    statusId: z.uuid().nullable().optional(),
    note: z.string().trim().max(200).optional(),
});

/** The office sets a person's day (forgot to check in, on duty outside, leave…). */
export const correct = async (staffId: string, input: z.infer<typeof correctionSchema>) => {
    if (!z.uuid().safeParse(staffId).success) throw notFound('Staff not found');
    const staff = await db.staff.findFirst({ where: { id: staffId }, select: { id: true, firstName: true, middleName: true, lastName: true } });
    if (!staff) throw notFound('Staff not found');
    if (input.date > todayIST()) throw badRequest('That day hasn’t come yet', [{ field: 'date', message: 'is in the future' }]);
    if (input.checkIn && input.checkOut && input.checkOut <= input.checkIn) throw badRequest('Check-out is before check-in', [{ field: 'checkOut', message: 'is before check-in' }]);
    const list = await statuses();
    if (input.statusId && !list.some((s) => s.id === input.statusId && s.isActive)) throw badRequest('Choose a status from the list', [{ field: 'statusId', message: 'is not a status' }]);
    const s = await shift();
    const existing = await db.staffAttendance.findFirst({ where: { staffId, date: dayDate(input.date) } });
    const inAt = input.checkIn === undefined ? (existing?.checkIn ?? null) : input.checkIn ? atIST(input.date, input.checkIn) : null;
    const outAt = input.checkOut === undefined ? (existing?.checkOut ?? null) : input.checkOut ? atIST(input.date, input.checkOut) : null;
    // A status chosen by hand wins; otherwise it follows the check-in time.
    const auto = inAt ? await statusForCheckIn(inAt) : { statusId: null, late: false };
    const statusId = input.statusId === undefined ? (existing?.statusId && !input.checkIn ? existing.statusId : auto.statusId) : input.statusId;
    const data = {
        checkIn: inAt,
        checkOut: outAt,
        statusId,
        late: inAt ? auto.late : false,
        earlyOut: outAt ? minutesIST(outAt) < toMinutes(s.end) : false,
        source: 'admin',
        note: input.note ?? existing?.note ?? null,
    };
    if (existing) await db.staffAttendance.update({ where: { id: existing.id }, data });
    else await db.staffAttendance.create({ data: { tenantId: getTenantId()!, staffId, date: dayDate(input.date), ...data } });
    await recordAudit({ action: 'staff_attendance_corrected', entity: 'staff_attendance', entityId: staffId, changes: { staff: fullName(staff), date: input.date, checkIn: input.checkIn, checkOut: input.checkOut, status: list.find((x) => x.id === statusId)?.code ?? null } });
    return staffDay({ date: input.date });
};

// ─── Correction requests ─────────────────────────────────────────────────────

export const requestSchema = z
    .strictObject({ date: ISO, checkIn: HHMM.optional(), checkOut: HHMM.optional(), reason: z.string().trim().min(3, 'is too short').max(300) })
    .refine((x) => x.checkIn || x.checkOut, { message: 'give the time you came in or left', path: ['checkIn'] })
    .refine((x) => !x.checkIn || !x.checkOut || x.checkOut > x.checkIn, { message: 'check-out is before check-in', path: ['checkOut'] });

/** A staff member asks the office to put a day right. */
export const askCorrection = async (userId: string, input: z.infer<typeof requestSchema>) => {
    const staff = await myStaff(userId);
    const { days } = await getSettings({ days: ATTENDANCE.staffRequestDays });
    const today = todayIST();
    const earliest = isoOf(new Date(dayDate(today).getTime() - days * 86_400_000));
    if (input.date > today) throw badRequest('That day hasn’t come yet', [{ field: 'date', message: 'is in the future' }]);
    if (input.date < earliest) throw badRequest(`Corrections can be asked for up to ${days} days back. Speak to the office for older days.`, [{ field: 'date', message: 'is too far back' }]);
    if (await dayOff(input.date, 'staff')) throw badRequest('That was not a working day', [{ field: 'date', message: 'is not a working day' }]);
    if (await db.staffAttendanceRequest.findFirst({ where: { staffId: staff.id, date: dayDate(input.date), status: 'pending' } })) throw conflict('You already have a request waiting for that day');
    const row = await db.staffAttendanceRequest.create({ data: { tenantId: getTenantId()!, staffId: staff.id, date: dayDate(input.date), checkIn: input.checkIn ?? null, checkOut: input.checkOut ?? null, reason: input.reason } });
    await recordAudit({ action: 'staff_attendance_request', entity: 'staff_attendance_request', entityId: row.id, changes: { staff: fullName(staff), date: input.date } });
    return myRequests(userId);
};

const presentRequests = async (rows: Prisma.StaffAttendanceRequestGetPayload<{ include: { staff: { select: { id: true; firstName: true; middleName: true; lastName: true; employeeCode: true } } } }>[]) => {
    const users = new Map((await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.decidedBy).filter((x): x is string => !!x))] } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
    const recorded = rows.length ? await db.staffAttendance.findMany({ where: { OR: rows.map((r) => ({ staffId: r.staffId, date: r.date })) }, select: { staffId: true, date: true, checkIn: true, checkOut: true } }) : [];
    return rows.map((r) => {
        const now = recorded.find((x) => x.staffId === r.staffId && isoOf(x.date) === isoOf(r.date));
        return {
            id: r.id,
            staff: { id: r.staff.id, name: fullName(r.staff), employeeCode: r.staff.employeeCode },
            date: isoOf(r.date),
            checkIn: r.checkIn,
            checkOut: r.checkOut,
            recorded: { checkIn: timeIST(now?.checkIn ?? null), checkOut: timeIST(now?.checkOut ?? null) },
            reason: r.reason,
            status: r.status,
            askedAt: r.createdAt,
            decidedBy: r.decidedBy ? (users.get(r.decidedBy) ?? null) : null,
            decidedAt: r.decidedAt,
            decisionNote: r.decisionNote,
        };
    });
};
const staffSelect = { select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true } } as const;

export const myRequests = async (userId: string) => {
    const staff = await myStaff(userId);
    return presentRequests(await db.staffAttendanceRequest.findMany({ where: { staffId: staff.id }, include: { staff: staffSelect }, orderBy: { createdAt: 'desc' }, take: 30 }));
};

export const requestsQuery = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending') });

export const correctionRequests = async (q: z.infer<typeof requestsQuery>) =>
    presentRequests(await db.staffAttendanceRequest.findMany({ where: q.status === 'all' ? {} : { status: q.status }, include: { staff: staffSelect }, orderBy: q.status === 'pending' ? { date: 'asc' } : { updatedAt: 'desc' }, take: 200 }));

/** The office approves (the day is corrected with the asked times) or turns down a request. */
export const decideCorrection = async (id: string, input: { approve: boolean; note?: string }, userId: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Request not found');
    const r = await db.staffAttendanceRequest.findFirst({ where: { id } });
    if (!r) throw notFound('Request not found');
    if (r.status !== 'pending') throw badRequest('This request has already been decided');
    if (input.approve) await correct(r.staffId, { date: isoOf(r.date), ...(r.checkIn ? { checkIn: r.checkIn } : {}), ...(r.checkOut ? { checkOut: r.checkOut } : {}), note: r.reason });
    await db.staffAttendanceRequest.update({ where: { id }, data: { status: input.approve ? 'approved' : 'rejected', decidedBy: userId, decidedAt: new Date(), decisionNote: input.note || null } });
    await recordAudit({ action: input.approve ? 'staff_attendance_request_approved' : 'staff_attendance_request_rejected', entity: 'staff_attendance_request', entityId: id });
    return correctionRequests({ status: 'pending' });
};

// ─── Check-ins waiting for approval ─────────────────────────────────────────

const REASON_OUT: Record<string, string> = Object.fromEntries(Object.entries(REASON_TEXT).map(([k, v]) => [`${k}_out`, `${v} (at check-out)`]));
const reasonText = (r: string) => REASON_TEXT[r as Reason] ?? REASON_OUT[r] ?? r;

/** Check-ins that wait for the office: photo, enrolled face, distance, face match and why. */
export const pendingCheckIns = async () => {
    const rows = await db.staffAttendance.findMany({
        where: { approval: 'pending' },
        orderBy: [{ date: 'desc' }, { checkIn: 'asc' }],
        take: 200,
        include: { staff: { select: { id: true, employeeCode: true, firstName: true, middleName: true, lastName: true, face: { select: { photoIds: true, status: true } } } } },
    });
    return rows.map((r) => ({
        id: r.id,
        staff: { id: r.staff.id, name: fullName(r.staff), employeeCode: r.staff.employeeCode, facePhotoId: r.staff.face?.status === 'approved' ? (r.staff.face.photoIds[0] ?? null) : null },
        date: isoOf(r.date),
        checkIn: timeIST(r.checkIn),
        checkOut: timeIST(r.checkOut),
        late: r.late,
        photoIn: r.checkInPhotoId,
        photoOut: r.checkOutPhotoId,
        distance: r.checkInDistance,
        accuracy: r.checkInAccuracy,
        location: r.checkInLat !== null && r.checkInLng !== null ? { lat: r.checkInLat, lng: r.checkInLng } : null,
        faceDistance: r.faceDistance,
        reasons: r.approvalReasons.map(reasonText),
    }));
};

export const approvalSchema = z.strictObject({ approve: z.boolean(), note: z.string().trim().max(300).optional() });

/** Approves a check-in (it counts as worked) or rejects it (the day becomes Absent). */
export const decideCheckIn = async (id: string, input: z.infer<typeof approvalSchema>, userId: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Check-in not found');
    const r = await db.staffAttendance.findFirst({ where: { id }, include: { staff: { select: { firstName: true, middleName: true, lastName: true } } } });
    if (!r) throw notFound('Check-in not found');
    if (r.approval !== 'pending') throw badRequest('This check-in is not waiting for approval');
    const absent = (await statuses()).find((x) => x.isActive && x.code === 'A');
    await db.staffAttendance.update({
        where: { id },
        data: { approval: input.approve ? 'approved' : 'rejected', decidedBy: userId, decidedAt: new Date(), decisionNote: input.note || null, ...(input.approve ? {} : { statusId: absent?.id ?? null }) },
    });
    await recordAudit({ action: input.approve ? 'staff_check_in_approved' : 'staff_check_in_rejected', entity: 'staff_attendance', entityId: id, changes: { staff: fullName(r.staff), date: isoOf(r.date), reasons: r.approvalReasons.join(', ') } });
    return pendingCheckIns();
};

/** A check-in / face photo, for the office or the person themself. */
export const photoFor = async (fileId: string, userId: string, mayManage: boolean) => {
    if (!z.uuid().safeParse(fileId).success) throw notFound('Photo not found');
    const [att, face] = await Promise.all([
        db.staffAttendance.findFirst({ where: { OR: [{ checkInPhotoId: fileId }, { checkOutPhotoId: fileId }] }, select: { staff: { select: { userId: true } } } }),
        db.staffFace.findFirst({ where: { photoIds: { has: fileId } }, select: { staff: { select: { userId: true } } } }),
    ]);
    const owner = att?.staff.userId ?? face?.staff.userId;
    if (!att && !face) throw notFound('Photo not found');
    if (!mayManage && owner !== userId) throw forbidden();
    return fileId;
};

/** Deletes check-in selfies older than the school keeps them (daily job, per school). */
export const purgeOldPhotos = async () => {
    const { days } = await getSettings({ days: ATTENDANCE.staffPhotoDays });
    const before = dayDate(isoOf(new Date(Date.now() - days * 86_400_000)));
    const rows = await db.staffAttendance.findMany({ where: { date: { lt: before }, OR: [{ checkInPhotoId: { not: null } }, { checkOutPhotoId: { not: null } }] }, select: { id: true, checkInPhotoId: true, checkOutPhotoId: true }, take: 2000 });
    for (const r of rows) {
        for (const f of [r.checkInPhotoId, r.checkOutPhotoId]) if (f) await deleteFile(f);
        await db.staffAttendance.update({ where: { id: r.id }, data: { checkInPhotoId: null, checkOutPhotoId: null } });
    }
    return rows.length;
};
