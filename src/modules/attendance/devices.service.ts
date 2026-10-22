import crypto from 'crypto';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { logger } from '../../core/logger';
import { fullName } from '../students/students.service';
import { ATTENDANCE, dayDate, isoOf, minutesIST, toMinutes } from './attendance.settings';
import { statuses } from './student-attendance.service';

/**
 * A school's own attendance machines and systems, connected by configuration:
 *   - essl_adms  eSSL / ZKTeco (and other "ADMS push") machines call /iclock/cdata with their serial number
 *   - webhook    any system posts punches to /api/public/attendance-devices/<token>/punches
 *   - import     a file exported from a machine (user number, date and time on each line)
 * Punches are matched to staff by their machine number (Staff → device user id); the first punch of a
 * day is the check-in, the last the check-out.
 */

const KINDS = ['essl_adms', 'webhook', 'import'] as const;
const IST_OFFSET = '+05:30';
const newToken = () => crypto.randomBytes(18).toString('hex');

// ─── Devices ─────────────────────────────────────────────────────────────────

export const deviceSchema = z.strictObject({
    name: z.string().trim().min(2).max(80),
    kind: z.enum(KINDS),
    /** ADMS machines: the serial number (on the machine: Menu → System info). */
    serialNo: z.string().trim().max(60).optional(),
    isActive: z.boolean().default(true),
});

export const listDevices = async () => {
    const devices = await db.attendanceDevice.findMany({ orderBy: { createdAt: 'asc' }, include: { _count: { select: { punches: true } } } });
    return devices.map((d) => ({ id: d.id, name: d.name, kind: d.kind, serialNo: d.serialNo, token: d.token, isActive: d.isActive, lastSeenAt: d.lastSeenAt, lastPunchAt: d.lastPunchAt, punches: d._count.punches }));
};

export const saveDevice = async (id: string | null, input: z.infer<typeof deviceSchema>) => {
    const serialNo = input.kind === 'essl_adms' ? input.serialNo?.toUpperCase() || null : null;
    if (input.kind === 'essl_adms' && !serialNo) throw badRequest('Give the machine’s serial number', [{ field: 'serialNo', message: 'is required for this machine' }]);
    if (serialNo) {
        const other = await db.attendanceDevice.findFirst({ where: { serialNo, ...(id ? { NOT: { id } } : {}) }, select: { id: true } });
        if (other) throw conflict('A machine with this serial number is already added');
    }
    const data = { name: input.name, kind: input.kind, serialNo, isActive: input.isActive };
    try {
        if (id) {
            if (!z.uuid().safeParse(id).success || !(await db.attendanceDevice.findFirst({ where: { id } }))) throw notFound('Device not found');
            await db.attendanceDevice.update({ where: { id }, data });
        } else await db.attendanceDevice.create({ data: { tenantId: getTenantId()!, token: newToken(), ...data } });
    } catch (err) {
        // The serial number is unique across schools.
        if ((err as { code?: string }).code === 'P2002') throw conflict('This serial number is already used by another machine');
        throw err;
    }
    await recordAudit({ action: 'attendance_device_saved', entity: 'attendance_device', changes: { name: input.name, kind: input.kind } });
    return listDevices();
};

export const newDeviceToken = async (id: string) => {
    if (!z.uuid().safeParse(id).success || !(await db.attendanceDevice.findFirst({ where: { id } }))) throw notFound('Device not found');
    await db.attendanceDevice.update({ where: { id }, data: { token: newToken() } });
    await recordAudit({ action: 'attendance_device_token', entity: 'attendance_device', entityId: id });
    return listDevices();
};

export const deleteDevice = async (id: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Device not found');
    await db.attendanceDevice.deleteMany({ where: { id } });
    return listDevices();
};

// ─── Staff machine numbers ───────────────────────────────────────────────────

export const staffNumbers = async () => {
    const [staff, unmatched] = await Promise.all([
        db.staff.findMany({ where: { status: 'working' }, select: { id: true, employeeCode: true, firstName: true, middleName: true, lastName: true, deviceUserId: true }, orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }] }),
        db.attendancePunch.groupBy({ by: ['deviceUserId'], where: { staffId: null }, _count: { _all: true }, _max: { punchedAt: true } }),
    ]);
    return {
        staff: staff.map((s) => ({ id: s.id, name: fullName(s), employeeCode: s.employeeCode, deviceUserId: s.deviceUserId })),
        unmatched: unmatched.map((u) => ({ deviceUserId: u.deviceUserId, punches: u._count._all, lastAt: u._max.punchedAt })).sort((a, b) => a.deviceUserId.localeCompare(b.deviceUserId, 'en', { numeric: true })),
    };
};

export const numberSchema = z.strictObject({ deviceUserId: z.string().trim().max(40).nullable() });

/** Sets a person's machine number; punches already received under it become theirs. */
export const setStaffNumber = async (staffId: string, input: z.infer<typeof numberSchema>) => {
    if (!z.uuid().safeParse(staffId).success || !(await db.staff.findFirst({ where: { id: staffId } }))) throw notFound('Staff not found');
    const value = input.deviceUserId || null;
    if (value && (await db.staff.findFirst({ where: { deviceUserId: value, NOT: { id: staffId } }, select: { id: true } }))) throw conflict(`Number ${value} is already someone else’s`);
    await db.staff.update({ where: { id: staffId }, data: { deviceUserId: value } });
    if (value) {
        const waiting = await db.attendancePunch.findMany({ where: { deviceUserId: value, staffId: null }, select: { punchedAt: true } });
        if (waiting.length) {
            await db.attendancePunch.updateMany({ where: { deviceUserId: value, staffId: null }, data: { staffId } });
            for (const day of new Set(waiting.map((p) => istDay(p.punchedAt)))) await applyDay(staffId, day);
        }
    }
    return staffNumbers();
};

// ─── Punches ─────────────────────────────────────────────────────────────────

/** The India date of a moment. */
const istDay = (d: Date) => isoOf(new Date(d.getTime() + 5.5 * 3600_000));

/** "2026-10-22 08:05:30", "22-10-2026 08:05", "22/10/2026 8:05 AM", ISO with a zone. Without a zone: India time. */
export const parseWhen = (raw: string): Date | null => {
    const s = raw.trim();
    if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))) return new Date(s);
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
    let y: string, mo: string, d: string;
    if (m) [y, mo, d] = [m[1], m[2], m[3]];
    else {
        m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
        if (!m) return null;
        [d, mo, y] = [m[1], m[2], m[3]];
    }
    let h = Number(m[4]);
    if (m[7]) h = (h % 12) + (m[7].toLowerCase() === 'pm' ? 12 : 0);
    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${String(h).padStart(2, '0')}:${m[5]}:${(m[6] ?? '00').padStart(2, '0')}${IST_OFFSET}`;
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? null : at;
};

/** Stores punches (duplicates skipped), matches them to staff and updates their days. */
export const ingest = async (deviceId: string | null, punches: { userId: string; at: Date }[]) => {
    const tenantId = getTenantId()!;
    const clean = punches.filter((p) => p.userId && !Number.isNaN(p.at.getTime()) && p.at.getTime() < Date.now() + 10 * 60_000).slice(0, 5000);
    if (!clean.length) return { received: punches.length, added: 0, unmatched: 0 };
    const ids = [...new Set(clean.map((p) => p.userId))];
    const owners = new Map((await db.staff.findMany({ where: { deviceUserId: { in: ids } }, select: { id: true, deviceUserId: true } })).map((s) => [s.deviceUserId!, s.id]));
    const added = await db.attendancePunch.createMany({
        data: clean.map((p) => ({ tenantId, deviceId, deviceUserId: p.userId, staffId: owners.get(p.userId) ?? null, punchedAt: p.at })),
        skipDuplicates: true,
    });
    if (deviceId) await db.attendanceDevice.update({ where: { id: deviceId }, data: { lastPunchAt: new Date(), lastSeenAt: new Date() } }).catch(() => undefined);
    // Each person's affected days.
    const days = new Set<string>();
    for (const p of clean) {
        const staffId = owners.get(p.userId);
        if (staffId) days.add(`${staffId}|${istDay(p.at)}`);
    }
    for (const key of days) {
        const [staffId, day] = key.split('|');
        await applyDay(staffId, day);
    }
    return { received: punches.length, added: added.count, unmatched: clean.filter((p) => !owners.has(p.userId)).length };
};

/** A person's day from their punches: first = check-in, last = check-out (a day the office corrected is left alone). */
const applyDay = async (staffId: string, day: string) => {
    const from = new Date(`${day}T00:00:00${IST_OFFSET}`);
    const to = new Date(from.getTime() + 86_400_000);
    const punches = await db.attendancePunch.findMany({ where: { staffId, punchedAt: { gte: from, lt: to } }, orderBy: { punchedAt: 'asc' }, select: { punchedAt: true } });
    if (!punches.length) return;
    const existing = await db.staffAttendance.findFirst({ where: { staffId, date: dayDate(day) } });
    if (existing?.source === 'admin') return;
    const s = await getSettings({ start: ATTENDANCE.staffStart, end: ATTENDANCE.staffEnd, grace: ATTENDANCE.staffGrace, halfDay: ATTENDANCE.staffHalfDay });
    // The earliest of the machine and a button check-in, the latest check-out.
    const first = existing?.checkIn && existing.checkIn < punches[0].punchedAt ? existing.checkIn : punches[0].punchedAt;
    const lastPunch = punches[punches.length - 1].punchedAt;
    // One punch only (or all within 5 minutes) = no check-out yet.
    const last = lastPunch.getTime() - first.getTime() >= 5 * 60_000 ? lastPunch : (existing?.checkOut ?? null);
    const late = minutesIST(first) - toMinutes(s.start);
    const list = (await statuses()).filter((x) => x.isActive);
    const code = s.halfDay && late >= s.halfDay ? 'HD' : late > s.grace ? 'LT' : 'P';
    const statusId = (list.find((x) => x.code === code) ?? list.find((x) => x.code === 'P'))?.id ?? null;
    const data = { checkIn: first, checkOut: last, statusId, late: late > s.grace, earlyOut: last ? minutesIST(last) < toMinutes(s.end) : false, source: existing?.source === 'button' ? 'button' : 'device' };
    if (existing) await db.staffAttendance.update({ where: { id: existing.id }, data });
    else await db.staffAttendance.create({ data: { tenantId: getTenantId()!, staffId, date: dayDate(day), ...data } });
};

export const recentPunches = async () => {
    const rows = await db.attendancePunch.findMany({ orderBy: { punchedAt: 'desc' }, take: 100, include: { staff: { select: { firstName: true, middleName: true, lastName: true } }, device: { select: { name: true } } } });
    return rows.map((r) => ({ id: r.id, at: r.punchedAt, deviceUserId: r.deviceUserId, staff: r.staff ? fullName(r.staff) : null, device: r.device?.name ?? 'Import' }));
};

// ─── The three ways in ───────────────────────────────────────────────────────

export const webhookSchema = z.object({
    punches: z.array(z.object({ userId: z.union([z.string(), z.number()]), time: z.string().max(40) })).max(5000),
});

/** A system posts punches (JSON) to its device's address. */
export const fromWebhook = async (deviceId: string, input: z.infer<typeof webhookSchema>) => {
    const parsed = input.punches.map((p) => ({ userId: String(p.userId).trim(), at: parseWhen(p.time) }));
    const bad = parsed.filter((p) => !p.at).length;
    const r = await ingest(deviceId, parsed.filter((p): p is { userId: string; at: Date } => !!p.at));
    return { ...r, unreadable: bad };
};

/** ADMS "ATTLOG" lines: user number, "YYYY-MM-DD HH:MM:SS", status… separated by tabs. */
export const fromAdms = async (deviceId: string, body: string) => {
    const punches = body
        .split(/\r?\n/)
        .map((l) => l.split('\t'))
        .filter((c) => c.length >= 2 && c[0].trim() && c[1].trim())
        .map((c) => ({ userId: c[0].trim(), at: parseWhen(c[1]) }))
        .filter((p): p is { userId: string; at: Date } => !!p.at);
    const r = await ingest(deviceId, punches);
    return r.added;
};

export const importSchema = z.strictObject({ deviceId: z.uuid().optional(), text: z.string().min(3).max(2_000_000) });

/** A file from a machine: each line "user number, date time" (comma, semicolon or tab); a header line is skipped. */
export const fromImport = async (input: z.infer<typeof importSchema>) => {
    if (input.deviceId && !(await db.attendanceDevice.findFirst({ where: { id: input.deviceId } }))) throw notFound('Device not found');
    const lines = input.text.split(/\r?\n/).filter((l) => l.trim());
    const parsed = lines.map((l) => {
        const cells = l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
        // "user, date, time" or "user, date time"
        const when = cells.length >= 3 && /^\d{1,2}:\d{2}/.test(cells[2]) ? `${cells[1]} ${cells[2]}` : cells[1] ?? '';
        return { userId: cells[0], at: parseWhen(when) };
    });
    const ok = parsed.filter((p): p is { userId: string; at: Date } => !!p.at && !!p.userId);
    if (!ok.length) throw badRequest('No punches could be read. Each line needs the person’s number and the date and time, e.g. 105, 2026-10-22 08:05');
    const r = await ingest(input.deviceId ?? null, ok);
    logger.info('Punches imported', { lines: lines.length, added: r.added });
    return { ...r, lines: lines.length, unreadable: lines.length - ok.length };
};
