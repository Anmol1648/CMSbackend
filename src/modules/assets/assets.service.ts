import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { takeNumbers } from '../../core/numbering';
import { getUserAccess } from '../rbac/access.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { raiseLater } from '../alerts/deliver';
import { holdersOf, usersOf } from '../alerts/recipients';
import { defineDailyJob } from '../alerts/jobs';
import { ASSETS } from './assets.settings';

/**
 * Assets: the register (one item, or a group with a quantity) in rooms (Masters → Rooms & labs)
 * or with a staff member; its history (moved, given, maintained…); problems reported by staff and
 * their repair; scheduled maintenance and warranty reminders; verification room by room;
 * depreciation and writing off (with approval).
 */

const DAY = 86_400_000;
const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const staffName = (s: { firstName: string; middleName?: string | null; lastName?: string | null }) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');
const plusMonths = (iso: string, m: number) => {
    const d = dayDate(iso);
    d.setUTCMonth(d.getUTCMonth() + m);
    return isoOf(d);
};

/** Present value: cost less a yearly % (straight line, per category), never below zero. */
export const bookValue = (cost: number | null, purchasedOn: Date | null, pct: number) => {
    if (!cost) return null;
    if (!purchasedOn || !pct) return cost;
    const years = Math.max(0, (Date.now() - purchasedOn.getTime()) / (365.25 * DAY));
    return Math.max(0, Math.round(cost * (1 - (pct / 100) * years)));
};

/** Names of the lists an asset points at, and each category's depreciation %. */
const lookups = async () => {
    const rows = await db.masterValue.findMany({ where: { master: { in: ['asset_category', 'asset_condition', 'asset_vendor', 'room'] } }, select: { id: true, name: true, master: true, extra: true, isActive: true } });
    const name = (id: string | null) => (id ? (rows.find((r) => r.id === id)?.name ?? null) : null);
    const pct = (id: string | null) => Number(((rows.find((r) => r.id === id)?.extra ?? {}) as { depreciation?: number }).depreciation ?? 0);
    const every = (id: string | null) => Number(((rows.find((r) => r.id === id)?.extra ?? {}) as { maintain_every?: number }).maintain_every ?? 0);
    return { rows, name, pct, every };
};

/** What the forms need: lists and staff. */
export const options = async () => {
    const [l, staff, s] = await Promise.all([lookups(), db.staff.findMany({ where: { status: 'working' }, orderBy: { firstName: 'asc' }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true } }), getSettings({ dep: ASSETS.depreciation })]);
    const of = (m: string) => l.rows.filter((r) => r.master === m && r.isActive).map((r) => ({ id: r.id, name: r.name, extra: r.extra }));
    return { categories: of('asset_category'), conditions: of('asset_condition'), vendors: of('asset_vendor'), rooms: of('room'), staff: staff.map((x) => ({ id: x.id, name: `${staffName(x)} (${x.employeeCode})` })), depreciation: s.dep };
};

const newCode = async () => {
    const s = await getSettings({ prefix: ASSETS.codePrefix, digits: ASSETS.codeDigits });
    for (;;) {
        const code = `${s.prefix}${String(await takeNumbers('asset', 1)).padStart(s.digits, '0')}`;
        if (!(await db.asset.findFirst({ where: { code }, select: { id: true } }))) return code;
    }
};

const event = (assetId: string, kind: string, data: Partial<Prisma.AssetEventUncheckedCreateInput>, userId: string | null) => db.assetEvent.create({ data: { tenantId: getTenantId()!, assetId, kind, userId, ...data } });

// ─── The register ────────────────────────────────────────────────────────────

export const listQuery = z.object({
    search: z.string().trim().max(60).optional(),
    category: z.uuid().optional(),
    room: z.uuid().optional(),
    condition: z.uuid().optional(),
    staff: z.uuid().optional(),
    status: z.enum(['in_use', 'in_repair', 'disposed', 'lost', 'active', 'all']).default('active'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(5).max(200).default(25),
});

export const listAssets = async (q: z.infer<typeof listQuery>) => {
    const where: Prisma.AssetWhereInput = {
        ...(q.status === 'active' ? { status: { in: ['in_use', 'in_repair'] } } : q.status === 'all' ? {} : { status: q.status }),
        ...(q.category ? { categoryId: q.category } : {}),
        ...(q.room ? { roomId: q.room } : {}),
        ...(q.condition ? { conditionId: q.condition } : {}),
        ...(q.staff ? { staffId: q.staff } : {}),
        ...(q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { code: { contains: q.search, mode: 'insensitive' } }, { serialNo: { contains: q.search, mode: 'insensitive' } }, { make: { contains: q.search, mode: 'insensitive' } }, { model: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows, sums, l, s] = await Promise.all([db.asset.count({ where }), db.asset.findMany({ where, orderBy: [{ code: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }), db.asset.aggregate({ where, _sum: { cost: true, quantity: true } }), lookups(), getSettings({ dep: ASSETS.depreciation })]);
    const staff = await db.staff.findMany({ where: { id: { in: rows.map((r) => r.staffId!).filter(Boolean) } }, select: { id: true, firstName: true, middleName: true, lastName: true } });
    const open = await db.assetIssue.groupBy({ by: ['assetId'], where: { assetId: { in: rows.map((r) => r.id) }, status: { in: ['open', 'in_repair'] } }, _count: { _all: true } });
    const today = todayIST();
    return {
        total,
        page: q.page,
        pageSize: q.pageSize,
        totals: { cost: sums._sum.cost ?? 0, items: sums._sum.quantity ?? 0 },
        rows: rows.map((a) => ({ id: a.id, code: a.code, name: a.name, category: l.name(a.categoryId), room: l.name(a.roomId), staff: a.staffId ? staffName(staff.find((x) => x.id === a.staffId) ?? { firstName: '' }) : null, condition: l.name(a.conditionId), quantity: a.quantity, cost: a.cost, value: s.dep ? bookValue(a.cost, a.purchasedOn, l.pct(a.categoryId)) : a.cost, status: a.status, warrantyUntil: a.warrantyUntil ? isoOf(a.warrantyUntil) : null, maintenanceDue: !!a.nextMaintenanceOn && isoOf(a.nextMaintenanceOn) <= today, openIssues: open.find((o) => o.assetId === a.id)?._count._all ?? 0 })),
    };
};

export const assetView = async (id: string) => {
    const a = await db.asset.findFirst({ where: { id }, include: { history: { orderBy: { at: 'desc' }, take: 50 }, issues: { orderBy: { createdAt: 'desc' } }, disposals: { orderBy: { createdAt: 'desc' } } } });
    if (!a) throw notFound('Asset not found');
    const [l, s] = await Promise.all([lookups(), getSettings({ dep: ASSETS.depreciation })]);
    const staffIds = [a.staffId, ...a.history.flatMap((h) => [h.fromStaffId, h.toStaffId])].filter((x): x is string => !!x);
    const userIds = [...a.history.map((h) => h.userId), ...a.issues.flatMap((i) => [i.reportedBy, i.assignedTo]), ...a.disposals.flatMap((d) => [d.askedBy, d.answeredBy])].filter((x): x is string => !!x);
    const [staff, users] = await Promise.all([db.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, firstName: true, middleName: true, lastName: true } }), db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } })]);
    const sn = (x: string | null) => (x ? staffName(staff.find((y) => y.id === x) ?? { firstName: '' }) : null);
    const un = (x: string | null) => (x ? (users.find((y) => y.id === x)?.displayName ?? null) : null);
    return {
        ...a,
        purchasedOn: a.purchasedOn ? isoOf(a.purchasedOn) : null,
        warrantyUntil: a.warrantyUntil ? isoOf(a.warrantyUntil) : null,
        amcUntil: a.amcUntil ? isoOf(a.amcUntil) : null,
        nextMaintenanceOn: a.nextMaintenanceOn ? isoOf(a.nextMaintenanceOn) : null,
        disposedOn: a.disposedOn ? isoOf(a.disposedOn) : null,
        category: l.name(a.categoryId),
        condition: l.name(a.conditionId),
        vendor: l.name(a.vendorId),
        room: l.name(a.roomId),
        staff: sn(a.staffId),
        value: s.dep ? bookValue(a.cost, a.purchasedOn, l.pct(a.categoryId)) : a.cost,
        depreciation: l.pct(a.categoryId),
        history: a.history.map((h) => ({ id: h.id, kind: h.kind, from: l.name(h.fromRoomId) ?? sn(h.fromStaffId), to: l.name(h.toRoomId) ?? sn(h.toStaffId), cost: h.cost, note: h.note, by: un(h.userId), at: h.at })),
        issues: a.issues.map((i) => ({ id: i.id, title: i.title, details: i.details, status: i.status, reportedBy: un(i.reportedBy), assignedTo: un(i.assignedTo), cost: i.cost, resolution: i.resolution, createdAt: i.createdAt, fixedAt: i.fixedAt })),
        disposals: a.disposals.map((d) => ({ id: d.id, reason: d.reason, note: d.note, amount: d.amount, status: d.status, askedBy: un(d.askedBy), answeredBy: un(d.answeredBy), createdAt: d.createdAt })),
    };
};

export const assetSchema = z.strictObject({
    name: z.string().trim().min(2, 'is required').max(150),
    categoryId: z.uuid().nullable().optional(),
    conditionId: z.uuid().nullable().optional(),
    vendorId: z.uuid().nullable().optional(),
    roomId: z.uuid().nullable().optional(),
    staffId: z.uuid().nullable().optional(),
    make: z.string().trim().max(80).nullable().optional(),
    model: z.string().trim().max(80).nullable().optional(),
    serialNo: z.string().trim().max(80).nullable().optional(),
    quantity: z.number().int().min(1).max(100_000).default(1),
    purchasedOn: D.nullable().optional(),
    billNo: z.string().trim().max(60).nullable().optional(),
    cost: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
    warrantyUntil: D.nullable().optional(),
    amcUntil: D.nullable().optional(),
    maintainEvery: z.number().int().min(0).max(120).nullable().optional(),
    nextMaintenanceOn: D.nullable().optional(),
    photoFileId: z.uuid().nullable().optional(),
    billFileId: z.uuid().nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
});

export const saveAsset = async (id: string | null, input: z.infer<typeof assetSchema>, userId: string) => {
    const l = await lookups();
    const every = input.maintainEvery ?? (input.categoryId ? l.every(input.categoryId) : 0);
    const next = input.nextMaintenanceOn ?? (every ? plusMonths(input.purchasedOn && input.purchasedOn > isoOf(new Date(Date.now() - every * 30 * DAY)) ? input.purchasedOn : todayIST(), every) : null);
    const data = {
        name: input.name,
        categoryId: input.categoryId ?? null,
        conditionId: input.conditionId ?? null,
        vendorId: input.vendorId ?? null,
        roomId: input.roomId ?? null,
        staffId: input.staffId ?? null,
        make: input.make || null,
        model: input.model || null,
        serialNo: input.serialNo || null,
        quantity: input.quantity,
        purchasedOn: input.purchasedOn ? dayDate(input.purchasedOn) : null,
        billNo: input.billNo || null,
        cost: input.cost ?? null,
        warrantyUntil: input.warrantyUntil ? dayDate(input.warrantyUntil) : null,
        amcUntil: input.amcUntil ? dayDate(input.amcUntil) : null,
        maintainEvery: every || null,
        nextMaintenanceOn: next ? dayDate(next) : null,
        photoFileId: input.photoFileId ?? null,
        billFileId: input.billFileId ?? null,
        notes: input.notes || null,
    };
    if (id) {
        const cur = await db.asset.findFirst({ where: { id } });
        if (!cur) throw notFound('Asset not found');
        await db.asset.update({ where: { id }, data });
        if (cur.roomId !== data.roomId) await event(id, 'moved', { fromRoomId: cur.roomId, toRoomId: data.roomId }, userId);
        if (cur.staffId !== data.staffId) await event(id, data.staffId ? 'assigned' : 'returned', { fromStaffId: cur.staffId, toStaffId: data.staffId }, userId);
        if (cur.conditionId !== data.conditionId) await event(id, 'condition', { note: `${l.name(cur.conditionId) ?? '—'} → ${l.name(data.conditionId) ?? '—'}` }, userId);
        return assetView(id);
    }
    const a = await db.asset.create({ data: { ...data, tenantId: getTenantId()!, code: await newCode(), createdBy: userId } });
    await event(a.id, 'added', { toRoomId: a.roomId, toStaffId: a.staffId }, userId);
    await recordAudit({ action: 'asset_added', entity: 'asset', entityId: a.id, changes: { code: a.code, name: a.name } });
    return assetView(a.id);
};

export const moveSchema = z.strictObject({ roomId: z.uuid().nullable().optional(), staffId: z.uuid().nullable().optional(), note: z.string().trim().max(300).nullable().optional() });
/** Moves an asset to a room and / or gives it to (or takes it back from) a staff member. */
export const moveAsset = async (id: string, input: z.infer<typeof moveSchema>, userId: string) => {
    const a = await db.asset.findFirst({ where: { id } });
    if (!a) throw notFound('Asset not found');
    if (a.status === 'disposed') throw badRequest('This asset is written off');
    const roomId = input.roomId === undefined ? a.roomId : input.roomId;
    const staffId = input.staffId === undefined ? a.staffId : input.staffId;
    await db.asset.update({ where: { id }, data: { roomId, staffId } });
    if (roomId !== a.roomId) await event(id, 'moved', { fromRoomId: a.roomId, toRoomId: roomId, note: input.note || null }, userId);
    if (staffId !== a.staffId) await event(id, staffId ? 'assigned' : 'returned', { fromStaffId: a.staffId, toStaffId: staffId, note: input.note || null }, userId);
    return assetView(id);
};

/** An asset by its code (the QR label), for scanning. */
export const byCode = async (code: string) => {
    const a = await db.asset.findFirst({ where: { code: { equals: code.trim(), mode: 'insensitive' } }, select: { id: true } });
    if (!a) throw notFound(`No asset with the code ${code.trim()}`);
    return assetView(a.id);
};

/** QR labels: chosen assets, or all in a room. */
export const labelsQuery = z.object({ ids: z.string().max(8000).optional(), room: z.uuid().optional() });
export const labels = async (q: z.infer<typeof labelsQuery>) => {
    const where: Prisma.AssetWhereInput = q.ids ? { id: { in: q.ids.split(',').filter((x) => /^[0-9a-f-]{36}$/.test(x)) } } : q.room ? { roomId: q.room, status: { not: 'disposed' } } : { id: '00000000-0000-0000-0000-000000000000' };
    const [rows, l, school] = await Promise.all([db.asset.findMany({ where, orderBy: { code: 'asc' }, take: 500 }), lookups(), db.schoolProfile.findFirst({ select: { shortName: true, legalName: true } })]);
    return { school: school?.shortName ?? school?.legalName ?? '', labels: rows.map((a) => ({ id: a.id, code: a.code, name: a.name, room: l.name(a.roomId), quantity: a.quantity })) };
};

/** A staff member's assets. */
export const myAssets = async (userId: string) => {
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    const [rows, l, issues] = await Promise.all([staff ? db.asset.findMany({ where: { staffId: staff.id, status: { not: 'disposed' } }, orderBy: { name: 'asc' } }) : [], lookups(), db.assetIssue.findMany({ where: { reportedBy: userId }, orderBy: { createdAt: 'desc' }, take: 20, include: { asset: { select: { code: true, name: true } } } })]);
    return {
        assets: rows.map((a) => ({ id: a.id, code: a.code, name: a.name, category: l.name(a.categoryId), condition: l.name(a.conditionId), serialNo: a.serialNo, room: l.name(a.roomId), quantity: a.quantity })),
        reported: issues.map((i) => ({ id: i.id, asset: `${i.asset.name} (${i.asset.code})`, title: i.title, status: i.status, resolution: i.resolution, createdAt: i.createdAt })),
    };
};

/** Assets to pick when reporting a problem (search by name / code / room). */
export const pickAssets = async (q: string) => {
    const t = q.trim();
    if (t.length < 2) return [];
    const rooms = await db.masterValue.findMany({ where: { master: 'room', name: { contains: t, mode: 'insensitive' } }, select: { id: true } });
    const rows = await db.asset.findMany({ where: { status: { not: 'disposed' }, OR: [{ name: { contains: t, mode: 'insensitive' } }, { code: { contains: t, mode: 'insensitive' } }, { roomId: { in: rooms.map((r) => r.id) } }] }, take: 20, orderBy: { name: 'asc' } });
    const l = await lookups();
    return rows.map((a) => ({ id: a.id, code: a.code, name: a.name, room: l.name(a.roomId) }));
};

// ─── Problems and repairs ────────────────────────────────────────────────────

export const issueSchema = z.strictObject({ assetId: z.uuid(), title: z.string().trim().min(3, 'say what is wrong').max(150), details: z.string().trim().max(1000).nullable().optional(), photoFileId: z.uuid().nullable().optional() });
export const reportIssue = async (input: z.infer<typeof issueSchema>, userId: string) => {
    const a = await db.asset.findFirst({ where: { id: input.assetId } });
    if (!a || a.status === 'disposed') throw notFound('Asset not found');
    if (await db.assetIssue.findFirst({ where: { assetId: a.id, status: { in: ['open', 'in_repair'] }, title: { equals: input.title, mode: 'insensitive' } } })) throw badRequest('This problem is already reported');
    const i = await db.assetIssue.create({ data: { tenantId: getTenantId()!, assetId: a.id, title: input.title, details: input.details || null, photoFileId: input.photoFileId ?? null, reportedBy: userId } });
    const l = await lookups();
    const by = (await db.user.findFirst({ where: { id: userId }, select: { displayName: true } }))?.displayName ?? '';
    raiseLater('asset_issue', { repairers: () => holdersOf('asset.repair') }, { asset: `${a.name} (${a.code})`, room: l.name(a.roomId) ?? '—', problem: input.title, by }, { dedupe: `asset-issue:${i.id}` });
    return { id: i.id };
};

export const issuesQuery = z.object({ show: z.enum(['open', 'fixed', 'all']).default('open') });
export const listIssues = async (q: z.infer<typeof issuesQuery>) => {
    const rows = await db.assetIssue.findMany({ where: q.show === 'open' ? { status: { in: ['open', 'in_repair'] } } : q.show === 'fixed' ? { status: { in: ['fixed', 'written_off'] } } : {}, orderBy: { createdAt: 'desc' }, take: 200, include: { asset: { select: { id: true, code: true, name: true, roomId: true } } } });
    const [l, users] = await Promise.all([lookups(), db.user.findMany({ where: { id: { in: rows.flatMap((r) => [r.reportedBy, r.assignedTo]).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } })]);
    const un = (x: string | null) => (x ? (users.find((u) => u.id === x)?.displayName ?? null) : null);
    return rows.map((r) => ({ id: r.id, assetId: r.asset.id, asset: `${r.asset.name} (${r.asset.code})`, room: l.name(r.asset.roomId), title: r.title, details: r.details, photoFileId: r.photoFileId, status: r.status, reportedBy: un(r.reportedBy), assignedTo: un(r.assignedTo), assignedToId: r.assignedTo, vendor: l.name(r.vendorId), vendorId: r.vendorId, cost: r.cost, resolution: r.resolution, createdAt: r.createdAt, fixedAt: r.fixedAt }));
};

export const updateIssueSchema = z.strictObject({ status: z.enum(['open', 'in_repair', 'fixed', 'written_off']), assignedTo: z.uuid().nullable().optional(), vendorId: z.uuid().nullable().optional(), cost: z.number().int().min(0).max(100_000_000).nullable().optional(), resolution: z.string().trim().max(1000).nullable().optional() });
export const updateIssue = async (id: string, input: z.infer<typeof updateIssueSchema>, userId: string) => {
    const i = await db.assetIssue.findFirst({ where: { id }, include: { asset: true } });
    if (!i) throw notFound('Not found');
    if ((input.status === 'fixed' || input.status === 'written_off') && !input.resolution) throw badRequest('Say what was done', [{ field: 'resolution', message: 'is required' }]);
    await db.assetIssue.update({ where: { id }, data: { status: input.status, assignedTo: input.assignedTo ?? i.assignedTo ?? userId, vendorId: input.vendorId ?? null, cost: input.cost ?? null, resolution: input.resolution || null, fixedAt: input.status === 'fixed' || input.status === 'written_off' ? new Date() : null } });
    const others = await db.assetIssue.count({ where: { assetId: i.assetId, id: { not: id }, status: 'in_repair' } });
    if (input.status === 'in_repair') await db.asset.update({ where: { id: i.assetId }, data: { status: 'in_repair' } });
    if (input.status === 'fixed') {
        if (!others && i.asset.status === 'in_repair') await db.asset.update({ where: { id: i.assetId }, data: { status: 'in_use' } });
        await event(i.assetId, 'repaired', { cost: input.cost ?? null, note: `${i.title}: ${input.resolution}` }, userId);
        if (i.reportedBy) raiseLater('asset_fixed', { reporter: () => usersOf([i.reportedBy!]) }, { asset: `${i.asset.name} (${i.asset.code})`, problem: i.title, resolution: input.resolution ?? '' }, { dedupe: `asset-fixed:${id}` });
    }
    return { id };
};

// ─── Maintenance ─────────────────────────────────────────────────────────────

/** Assets whose maintenance is due (or overdue) within the reminder days, and warranties / AMCs ending. */
export const careDue = async () => {
    const s = await getSettings({ m: ASSETS.maintenanceDays, w: ASSETS.warrantyDays });
    const today = todayIST();
    const [maint, warranty, l] = await Promise.all([
        db.asset.findMany({ where: { status: { in: ['in_use', 'in_repair'] }, nextMaintenanceOn: { lte: dayDate(isoOf(new Date(dayDate(today).getTime() + s.m * DAY))) } }, orderBy: { nextMaintenanceOn: 'asc' } }),
        db.asset.findMany({ where: { status: { in: ['in_use', 'in_repair'] }, OR: [{ warrantyUntil: { gte: dayDate(today), lte: dayDate(isoOf(new Date(dayDate(today).getTime() + s.w * DAY))) } }, { amcUntil: { gte: dayDate(today), lte: dayDate(isoOf(new Date(dayDate(today).getTime() + s.w * DAY))) } }] }, orderBy: { warrantyUntil: 'asc' } }),
        lookups(),
    ]);
    return {
        maintenance: maint.map((a) => ({ id: a.id, code: a.code, name: a.name, room: l.name(a.roomId), due: isoOf(a.nextMaintenanceOn!), overdue: isoOf(a.nextMaintenanceOn!) < today, every: a.maintainEvery })),
        warranty: warranty.map((a) => ({ id: a.id, code: a.code, name: a.name, room: l.name(a.roomId), warrantyUntil: a.warrantyUntil ? isoOf(a.warrantyUntil) : null, amcUntil: a.amcUntil ? isoOf(a.amcUntil) : null })),
    };
};

export const maintainSchema = z.strictObject({ doneOn: D, cost: z.number().int().min(0).max(100_000_000).nullable().optional(), note: z.string().trim().max(500).nullable().optional() });
export const recordMaintenance = async (id: string, input: z.infer<typeof maintainSchema>, userId: string) => {
    const a = await db.asset.findFirst({ where: { id } });
    if (!a) throw notFound('Asset not found');
    await db.asset.update({ where: { id }, data: { nextMaintenanceOn: a.maintainEvery ? dayDate(plusMonths(input.doneOn, a.maintainEvery)) : null } });
    await event(id, 'maintained', { cost: input.cost ?? null, note: input.note || null, at: new Date(`${input.doneOn}T06:00:00Z`) }, userId);
    return assetView(id);
};

// ─── Writing off ─────────────────────────────────────────────────────────────

export const disposalSchema = z.strictObject({ reason: z.enum(['sold', 'scrapped', 'lost', 'donated']), note: z.string().trim().max(500).nullable().optional(), amount: z.number().int().min(0).max(100_000_000).nullable().optional() });
const finishDisposal = async (d: { id: string; assetId: string; reason: string; amount: number | null; note: string | null }, userId: string) => {
    await db.asset.update({ where: { id: d.assetId }, data: { status: d.reason === 'lost' ? 'lost' : 'disposed', disposedOn: dayDate(todayIST()), staffId: null } });
    await event(d.assetId, 'disposed', { note: `${d.reason}${d.amount ? ` for ₹${d.amount}` : ''}${d.note ? `: ${d.note}` : ''}` }, userId);
};
export const requestDisposal = async (id: string, input: z.infer<typeof disposalSchema>, userId: string) => {
    const a = await db.asset.findFirst({ where: { id } });
    if (!a || a.status === 'disposed') throw badRequest('Asset not found or already written off');
    if (await db.assetDisposal.findFirst({ where: { assetId: id, status: 'pending' } })) throw badRequest('Already waiting for approval');
    const { approval } = await getSettings({ approval: ASSETS.disposalApproval });
    const canApprove = !!(await getUserAccess(userId)).permissions['asset.approve_disposal'];
    const pending = approval && !canApprove;
    const d = await db.assetDisposal.create({ data: { tenantId: getTenantId()!, assetId: id, reason: input.reason, note: input.note || null, amount: input.amount ?? null, status: pending ? 'pending' : 'approved', askedBy: userId, answeredBy: pending ? null : userId, answeredAt: pending ? null : new Date() } });
    if (pending) raiseLater('asset_disposal', { approvers: () => holdersOf('asset.approve_disposal') }, { asset: `${a.name} (${a.code})`, reason: input.reason, by: (await db.user.findFirst({ where: { id: userId }, select: { displayName: true } }))?.displayName ?? '' }, { dedupe: `asset-disposal:${d.id}` });
    else await finishDisposal(d, userId);
    return assetView(id);
};

export const answerDisposal = async (id: string, approve: boolean, userId: string) => {
    const d = await db.assetDisposal.findFirst({ where: { id } });
    if (!d || d.status !== 'pending') throw badRequest('Nothing to answer');
    await db.assetDisposal.update({ where: { id }, data: { status: approve ? 'approved' : 'rejected', answeredBy: userId, answeredAt: new Date() } });
    if (approve) await finishDisposal(d, userId);
    await recordAudit({ action: approve ? 'asset_disposal_approved' : 'asset_disposal_refused', entity: 'asset', entityId: d.assetId, changes: { reason: d.reason } });
    return assetView(d.assetId);
};

export const pendingDisposals = async () => {
    const rows = await db.assetDisposal.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, include: { asset: { select: { id: true, code: true, name: true, cost: true } } } });
    const users = await db.user.findMany({ where: { id: { in: rows.map((r) => r.askedBy!).filter(Boolean) } }, select: { id: true, displayName: true } });
    return rows.map((r) => ({ id: r.id, assetId: r.asset.id, asset: `${r.asset.name} (${r.asset.code})`, cost: r.asset.cost, reason: r.reason, note: r.note, amount: r.amount, by: users.find((u) => u.id === r.askedBy)?.displayName ?? '', at: r.createdAt }));
};

// ─── Verification ────────────────────────────────────────────────────────────

export const listVerifications = async () => (await db.assetVerification.findMany({ orderBy: { startedAt: 'desc' }, take: 20, include: { _count: { select: { found: true } } } })).map((v) => ({ id: v.id, name: v.name, status: v.status, startedAt: v.startedAt, closedAt: v.closedAt, found: v._count.found }));

export const startVerification = async (name: string, userId: string) => {
    if (await db.assetVerification.findFirst({ where: { status: 'open' } })) throw badRequest('A verification is open already; close it first');
    const v = await db.assetVerification.create({ data: { tenantId: getTenantId()!, name: name || `Asset verification ${todayIST()}`, createdBy: userId } });
    return verification(v.id);
};

/** A verification: by room, what was expected, found, missing, and found in another room. */
export const verification = async (id: string) => {
    const v = await db.assetVerification.findFirst({ where: { id }, include: { found: true } });
    if (!v) throw notFound('Verification not found');
    const [assets, l] = await Promise.all([db.asset.findMany({ where: { status: { in: ['in_use', 'in_repair'] } }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, roomId: true, quantity: true } }), lookups()]);
    const found = new Map(v.found.map((f) => [f.assetId, f]));
    const rooms = [...new Set(assets.map((a) => a.roomId))];
    return {
        id: v.id,
        name: v.name,
        status: v.status,
        startedAt: v.startedAt,
        expected: assets.length,
        foundCount: v.found.length,
        rooms: rooms.map((r) => ({ roomId: r, room: l.name(r) ?? 'No room', assets: assets.filter((a) => a.roomId === r).map((a) => ({ id: a.id, code: a.code, name: a.name, quantity: a.quantity, found: found.has(a.id), foundIn: found.get(a.id)?.roomId && found.get(a.id)!.roomId !== a.roomId ? l.name(found.get(a.id)!.roomId) : null })) })).sort((a, b) => a.room.localeCompare(b.room)),
    };
};

export const verifySchema = z.strictObject({ assetId: z.uuid().optional(), code: z.string().trim().max(40).optional(), roomId: z.uuid().nullable().optional(), found: z.boolean().default(true) });
export const markFound = async (id: string, input: z.infer<typeof verifySchema>) => {
    const v = await db.assetVerification.findFirst({ where: { id } });
    if (!v || v.status !== 'open') throw badRequest('This verification is closed');
    const a = input.assetId ? await db.asset.findFirst({ where: { id: input.assetId } }) : input.code ? await db.asset.findFirst({ where: { code: { equals: input.code, mode: 'insensitive' } } }) : null;
    if (!a) throw notFound('No such asset');
    if (input.found) await db.assetFound.upsert({ where: { verificationId_assetId: { verificationId: id, assetId: a.id } }, create: { tenantId: getTenantId()!, verificationId: id, assetId: a.id, roomId: input.roomId ?? a.roomId }, update: { roomId: input.roomId ?? a.roomId, at: new Date() } });
    else await db.assetFound.deleteMany({ where: { verificationId: id, assetId: a.id } });
    return { code: a.code, name: a.name, misplaced: !!input.roomId && input.roomId !== a.roomId };
};

/** Closes a verification; assets found in another room can be moved there in the register. */
export const closeVerification = async (id: string, moveMisplaced: boolean, userId: string) => {
    const v = await db.assetVerification.findFirst({ where: { id }, include: { found: true } });
    if (!v || v.status !== 'open') throw badRequest('Already closed');
    if (moveMisplaced) {
        for (const f of v.found) {
            const a = await db.asset.findFirst({ where: { id: f.assetId }, select: { roomId: true } });
            if (a && f.roomId && a.roomId !== f.roomId) {
                await db.asset.update({ where: { id: f.assetId }, data: { roomId: f.roomId } });
                await event(f.assetId, 'moved', { fromRoomId: a.roomId, toRoomId: f.roomId, note: `Found here in ${v.name}` }, userId);
            }
        }
    }
    await db.assetVerification.update({ where: { id }, data: { status: 'closed', closedAt: new Date() } });
    return verification(id);
};

// ─── Daily reminders ─────────────────────────────────────────────────────────

defineDailyJob({
    key: 'assets_care',
    run: async () => {
        const due = await careDue();
        const today = todayIST();
        if (due.maintenance.length) raiseLater('asset_maintenance', { repairers: () => holdersOf('asset.repair') }, { count: String(due.maintenance.length), list: due.maintenance.slice(0, 20).map((m) => `- ${m.name} (${m.code}${m.room ? `, ${m.room}` : ''}): ${m.overdue ? 'overdue since' : 'due'} ${m.due}`).join('\n') }, { dedupe: `asset-maint:${today}` });
        if (due.warranty.length) raiseLater('asset_warranty', { managers: () => holdersOf('asset.manage') }, { count: String(due.warranty.length), list: due.warranty.slice(0, 20).map((w) => `- ${w.name} (${w.code}): ${w.warrantyUntil ? `warranty till ${w.warrantyUntil}` : ''}${w.amcUntil ? ` AMC till ${w.amcUntil}` : ''}`).join('\n') }, { dedupe: `asset-warranty:${today}` });
        return `${due.maintenance.length} maintenance, ${due.warranty.length} warranties`;
    },
});

