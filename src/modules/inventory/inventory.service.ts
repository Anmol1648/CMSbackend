import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db, Tx, withTransaction } from '../../core/db';
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
import { INVENTORY } from './inventory.settings';

/**
 * Inventory: consumable items kept in stores. Every change of stock is a movement in the ledger
 * (applyMove), which keeps the store's balance, the batches of items with an expiry date (used
 * earliest-expiry first) and the item's moving average cost. Staff ask for items (approval above a
 * value), the store issues, takes back, transfers, writes off (with approval) and counts.
 */

const DAY = 86_400_000;
export const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const staffName = (s: { firstName: string; middleName?: string | null; lastName?: string | null }) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');
export const qtySchema = z.number().positive().max(1_000_000);
export const lineSchema = z.strictObject({ itemId: z.uuid(), qty: qtySchema });

export const nextNumber = async (key: string, prefix: string) => `${prefix}${String(await takeNumbers(key, 1)).padStart(5, '0')}`;

/** Names of the lists inventory points at. */
export const lookups = async () => {
    const rows = await db.masterValue.findMany({ where: { master: { in: ['inv_category', 'inv_unit', 'inv_store', 'asset_vendor', 'department'] } }, select: { id: true, name: true, master: true, extra: true, isActive: true, sortOrder: true }, orderBy: { sortOrder: 'asc' } });
    const name = (id: string | null | undefined) => (id ? (rows.find((r) => r.id === id)?.name ?? '') : '');
    return { rows, name, of: (m: string) => rows.filter((r) => r.master === m && r.isActive).map((r) => ({ id: r.id, name: r.name, extra: r.extra })) };
};

export interface MoveInput {
    itemId: string;
    storeId: string;
    kind: string;
    /** + in, − out. */
    qty: number;
    /** Cost of one unit coming in (receipts); out movements use the average cost. */
    rate?: number;
    batchNo?: string | null;
    expiryOn?: string | null;
    batchId?: string | null;
    departmentId?: string | null;
    staffId?: string | null;
    studentId?: string | null;
    refType?: string;
    refId?: string | null;
    refNo?: string | null;
    note?: string | null;
    userId?: string | null;
    at?: Date;
    isDemo?: boolean;
}

/** Records one movement: the store's balance, batches, the average cost and the ledger line. */
export const applyMove = async (tx: Tx, m: MoveInput, allowNegative?: boolean) => {
    const item = await tx.invItem.findFirst({ where: { id: m.itemId } });
    if (!item) throw notFound('Item not found');
    const tenantId = getTenantId()!;
    const stock = await tx.invStock.findFirst({ where: { itemId: m.itemId, storeId: m.storeId } });
    const before = stock?.qty ?? 0;
    const after = r3(before + m.qty);
    if (m.qty < 0 && after < -0.0001) {
        const neg = allowNegative ?? (await getSettings({ n: INVENTORY.negative })).n;
        if (!neg) throw badRequest(`Not enough ${item.name} in this store (has ${r3(before)}, needs ${r3(-m.qty)})`);
    }
    if (stock) await tx.invStock.update({ where: { id: stock.id }, data: { qty: after } });
    else await tx.invStock.create({ data: { tenantId, itemId: m.itemId, storeId: m.storeId, qty: after } });

    // Average cost: only receipts (and openings) with a rate change it.
    let rate = item.avgCost;
    if (m.qty > 0 && m.rate !== undefined && ['receive', 'opening'].includes(m.kind)) {
        const all = await tx.invStock.aggregate({ where: { itemId: m.itemId }, _sum: { qty: true } });
        const totalBefore = Math.max(0, (all._sum.qty ?? 0) - m.qty);
        const avg = totalBefore + m.qty > 0 ? (totalBefore * item.avgCost + m.qty * m.rate) / (totalBefore + m.qty) : m.rate;
        await tx.invItem.update({ where: { id: item.id }, data: { avgCost: r2(avg) } });
        rate = m.rate;
    }

    // Batches (items with an expiry date).
    if (item.trackExpiry) {
        if (m.qty > 0) {
            const same = m.batchId ? await tx.invBatch.findFirst({ where: { id: m.batchId } }) : await tx.invBatch.findFirst({ where: { itemId: item.id, storeId: m.storeId, batchNo: m.batchNo ?? null, expiryOn: m.expiryOn ? dayDate(m.expiryOn) : null } });
            if (same) await tx.invBatch.update({ where: { id: same.id }, data: { qty: r3(same.qty + m.qty) } });
            else await tx.invBatch.create({ data: { tenantId, itemId: item.id, storeId: m.storeId, batchNo: m.batchNo ?? null, expiryOn: m.expiryOn ? dayDate(m.expiryOn) : null, qty: m.qty } });
        } else {
            let left = -m.qty;
            const batches = m.batchId ? await tx.invBatch.findMany({ where: { id: m.batchId } }) : await tx.invBatch.findMany({ where: { itemId: item.id, storeId: m.storeId, qty: { gt: 0 } }, orderBy: [{ expiryOn: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }] });
            for (const b of batches) {
                if (left <= 0) break;
                const take = Math.min(b.qty, left);
                await tx.invBatch.update({ where: { id: b.id }, data: { qty: r3(b.qty - take) } });
                left = r3(left - take);
            }
        }
    }
    return tx.invMove.create({ data: { tenantId, itemId: m.itemId, storeId: m.storeId, kind: m.kind, qty: m.qty, rate: r2(rate), balance: after, departmentId: m.departmentId ?? null, staffId: m.staffId ?? null, studentId: m.studentId ?? null, refType: m.refType ?? null, refId: m.refId ?? null, refNo: m.refNo ?? null, note: m.note ?? null, userId: m.userId ?? null, at: m.at ?? new Date(), isDemo: m.isDemo ?? false } });
};

// ─── Options and items ───────────────────────────────────────────────────────

export const options = async (userId: string) => {
    const [l, staff, s, a] = await Promise.all([lookups(), db.staff.findMany({ where: { status: 'working' }, orderBy: { firstName: 'asc' }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true, departmentId: true } }), getSettings({ gst: INVENTORY.gst, sales: INVENTORY.sales, salesTo: INVENTORY.salesTo, negative: INVENTORY.negative }), getUserAccess(userId)]);
    const can = (k: string) => !!a.permissions[`inventory.${k}`];
    return { categories: l.of('inv_category'), units: l.of('inv_unit'), stores: l.of('inv_store'), vendors: l.of('asset_vendor'), departments: l.of('department'), staff: staff.map((x) => ({ id: x.id, name: `${staffName(x)} (${x.employeeCode})`, departmentId: x.departmentId })), settings: s, can: { manage: can('manage'), store: can('store'), purchase: can('purchase'), approve: can('approve'), sell: can('sell'), view: can('view') } };
};

export const itemsQuery = z.object({
    search: z.string().trim().max(60).optional(),
    category: z.uuid().optional(),
    store: z.uuid().optional(),
    show: z.enum(['active', 'low', 'sellable', 'expiry', 'inactive', 'all']).default('active'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(5).max(500).default(50),
});

export const listItems = async (q: z.infer<typeof itemsQuery>) => {
    const where: Prisma.InvItemWhereInput = {
        ...(q.show === 'inactive' ? { isActive: false } : q.show === 'all' ? {} : { isActive: true }),
        ...(q.show === 'sellable' ? { sellable: true } : {}),
        ...(q.show === 'expiry' ? { trackExpiry: true } : {}),
        ...(q.category ? { categoryId: q.category } : {}),
        ...(q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { code: { contains: q.search, mode: 'insensitive' } }, { barcode: { equals: q.search } }] } : {}),
    };
    const [all, l] = await Promise.all([db.invItem.findMany({ where, orderBy: { name: 'asc' }, include: { stock: true } }), lookups()]);
    const qtyOf = (i: (typeof all)[number]) => r3(i.stock.filter((s) => !q.store || s.storeId === q.store).reduce((a, s) => a + s.qty, 0));
    const total = (i: (typeof all)[number]) => r3(i.stock.reduce((a, s) => a + s.qty, 0));
    const rows = all.filter((i) => q.show !== 'low' || total(i) <= i.reorderLevel);
    const page = rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    return {
        total: rows.length,
        page: q.page,
        pageSize: q.pageSize,
        value: r2(rows.reduce((a, i) => a + qtyOf(i) * i.avgCost, 0)),
        low: all.filter((i) => i.isActive && total(i) <= i.reorderLevel).length,
        rows: page.map((i) => ({ id: i.id, code: i.code, name: i.name, category: l.name(i.categoryId), unit: l.name(i.unitId), qty: qtyOf(i), totalQty: total(i), reorderLevel: i.reorderLevel, low: total(i) <= i.reorderLevel, avgCost: i.avgCost, value: r2(qtyOf(i) * i.avgCost), sellable: i.sellable, sellPrice: i.sellPrice, trackExpiry: i.trackExpiry, isActive: i.isActive, stores: i.stock.filter((s) => s.qty !== 0).map((s) => ({ store: l.name(s.storeId), qty: s.qty })) })),
    };
};

export const itemView = async (id: string) => {
    const i = await db.invItem.findFirst({ where: { id }, include: { stock: true, batches: { where: { qty: { gt: 0 } }, orderBy: { expiryOn: 'asc' } }, moves: { orderBy: { at: 'desc' }, take: 100 } } });
    if (!i) throw notFound('Item not found');
    const l = await lookups();
    const [staff, users] = await Promise.all([db.staff.findMany({ where: { id: { in: i.moves.map((m) => m.staffId!).filter(Boolean) } }, select: { id: true, firstName: true, middleName: true, lastName: true } }), db.user.findMany({ where: { id: { in: i.moves.map((m) => m.userId!).filter(Boolean) } }, select: { id: true, displayName: true } })]);
    return {
        ...i,
        category: l.name(i.categoryId),
        unit: l.name(i.unitId),
        totalQty: r3(i.stock.reduce((a, s) => a + s.qty, 0)),
        stock: i.stock.map((s) => ({ storeId: s.storeId, store: l.name(s.storeId), qty: s.qty })),
        batches: i.batches.map((b) => ({ id: b.id, store: l.name(b.storeId), storeId: b.storeId, batchNo: b.batchNo, expiryOn: b.expiryOn ? isoOf(b.expiryOn) : null, qty: b.qty, expired: !!b.expiryOn && isoOf(b.expiryOn) < todayIST() })),
        moves: i.moves.map((m) => ({ id: m.id, kind: m.kind, store: l.name(m.storeId), qty: m.qty, rate: m.rate, balance: m.balance, to: l.name(m.departmentId) || (m.staffId ? staffName(staff.find((s) => s.id === m.staffId) ?? { firstName: '' }) : ''), refNo: m.refNo, note: m.note, by: users.find((u) => u.id === m.userId)?.displayName ?? '', at: m.at })),
    };
};

export const itemSchema = z.strictObject({
    name: z.string().trim().min(2, 'is required').max(150),
    categoryId: z.uuid().nullable().optional(),
    unitId: z.uuid().nullable().optional(),
    reorderLevel: z.number().min(0).max(1_000_000).default(0),
    reorderQty: z.number().min(0).max(1_000_000).default(0),
    barcode: z.string().trim().max(60).nullable().optional(),
    sellable: z.boolean().default(false),
    sellPrice: z.number().min(0).max(1_000_000).nullable().optional(),
    trackExpiry: z.boolean().optional(),
    gstPct: z.number().min(0).max(28).default(0),
    isActive: z.boolean().default(true),
    /** New item only: stock already on the shelf. */
    opening: z.strictObject({ storeId: z.uuid(), qty: qtySchema, rate: z.number().min(0).max(10_000_000) }).nullable().optional(),
});

export const saveItem = async (id: string | null, input: z.infer<typeof itemSchema>, userId: string) => {
    const l = await lookups();
    const catExpiry = !!((l.rows.find((r) => r.id === input.categoryId)?.extra ?? {}) as { expiry?: boolean }).expiry;
    const { opening, ...rest } = input;
    const data = { ...rest, categoryId: input.categoryId ?? null, unitId: input.unitId ?? null, barcode: input.barcode || null, sellPrice: input.sellable ? (input.sellPrice ?? null) : null, trackExpiry: input.trackExpiry ?? catExpiry };
    if (input.sellable && !input.sellPrice) throw badRequest('Give the selling price', [{ field: 'sellPrice', message: 'is required' }]);
    if (id) {
        await db.invItem.update({ where: { id }, data });
        return itemView(id);
    }
    const { prefix } = await getSettings({ prefix: INVENTORY.itemPrefix });
    let code = await nextNumber('inv_item', prefix);
    while (await db.invItem.findFirst({ where: { code }, select: { id: true } })) code = await nextNumber('inv_item', prefix);
    const item = await db.invItem.create({ data: { ...data, tenantId: getTenantId()!, code } });
    if (opening) await withTransaction((tx) => applyMove(tx, { itemId: item.id, storeId: opening.storeId, kind: 'opening', qty: opening.qty, rate: opening.rate, refType: 'opening', note: 'Opening stock', userId }));
    await recordAudit({ action: 'inv_item_added', entity: 'inv_item', entityId: item.id, changes: { code, name: item.name } });
    return itemView(item.id);
};

/** Items to pick in a form (with the stock of a store). */
export const pickItems = async (q: string, storeId?: string, sellable?: boolean) => {
    const t = q.trim();
    const rows = await db.invItem.findMany({ where: { isActive: true, ...(sellable ? { sellable: true } : {}), ...(t ? { OR: [{ name: { contains: t, mode: 'insensitive' } }, { code: { contains: t, mode: 'insensitive' } }, { barcode: t }] } : {}) }, orderBy: { name: 'asc' }, take: t ? 25 : 400, include: { stock: true } });
    const l = await lookups();
    return rows.map((i) => ({ id: i.id, code: i.code, name: i.name, unit: l.name(i.unitId), avgCost: i.avgCost, sellPrice: i.sellPrice, gstPct: i.gstPct, trackExpiry: i.trackExpiry, reorderQty: i.reorderQty, qty: r3(i.stock.filter((s) => !storeId || s.storeId === storeId).reduce((a, s) => a + s.qty, 0)) }));
};

// ─── Requests from staff ─────────────────────────────────────────────────────

export const requestSchema = z.strictObject({ storeId: z.uuid().nullable().optional(), departmentId: z.uuid().nullable().optional(), purpose: z.string().trim().max(300).nullable().optional(), lines: z.array(lineSchema).min(1).max(50) });

export const createRequest = async (input: z.infer<typeof requestSchema>, userId: string) => {
    const items = await db.invItem.findMany({ where: { id: { in: input.lines.map((x) => x.itemId) } }, select: { id: true, avgCost: true, name: true } });
    const value = r2(input.lines.reduce((a, x) => a + x.qty * (items.find((i) => i.id === x.itemId)?.avgCost ?? 0), 0));
    const [s, staff, prefix] = await Promise.all([getSettings({ limit: INVENTORY.requestApproval }), db.staff.findFirst({ where: { userId }, select: { id: true, departmentId: true } }), getSettings({ p: INVENTORY.requestPrefix })]);
    const pending = s.limit === 0 || value > s.limit;
    const r = await db.invRequest.create({ data: { tenantId: getTenantId()!, number: await nextNumber('inv_request', prefix.p), requestedBy: userId, staffId: staff?.id ?? null, departmentId: input.departmentId ?? staff?.departmentId ?? null, storeId: input.storeId ?? null, purpose: input.purpose || null, status: pending ? 'pending' : 'approved', value, lines: { create: input.lines.map((x) => ({ itemId: x.itemId, qty: x.qty })) } } });
    const by = (await db.user.findFirst({ where: { id: userId }, select: { displayName: true } }))?.displayName ?? '';
    const list = input.lines.map((x) => `- ${items.find((i) => i.id === x.itemId)?.name ?? ''}: ${x.qty}`).join('\n');
    if (pending) raiseLater('inv_request_approval', { approvers: () => holdersOf('inventory.approve') }, { number: r.number, by, value: String(value), list }, { dedupe: `inv-req-ap:${r.id}` });
    else raiseLater('inv_request_new', { store: () => holdersOf('inventory.store') }, { number: r.number, by, list }, { dedupe: `inv-req:${r.id}` });
    return { id: r.id, number: r.number, status: r.status };
};

const requestRows = async (where: Prisma.InvRequestWhereInput) => {
    const rows = await db.invRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200, include: { lines: true } });
    const [l, items, users] = await Promise.all([lookups(), db.invItem.findMany({ where: { id: { in: rows.flatMap((r) => r.lines.map((x) => x.itemId)) } }, include: { stock: true } }), db.user.findMany({ where: { id: { in: rows.flatMap((r) => [r.requestedBy, r.answeredBy]).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } })]);
    const un = (id: string | null) => (id ? (users.find((u) => u.id === id)?.displayName ?? '') : '');
    return rows.map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        value: r.value,
        purpose: r.purpose,
        department: l.name(r.departmentId),
        departmentId: r.departmentId,
        staffId: r.staffId,
        storeId: r.storeId,
        by: un(r.requestedBy),
        answeredBy: un(r.answeredBy),
        answer: r.answer,
        createdAt: r.createdAt,
        lines: r.lines.map((x) => {
            const i = items.find((y) => y.id === x.itemId);
            return { id: x.id, itemId: x.itemId, item: i?.name ?? '', code: i?.code ?? '', unit: l.name(i?.unitId), qty: x.qty, issuedQty: x.issuedQty, inStock: r3((i?.stock ?? []).filter((s) => !r.storeId || s.storeId === r.storeId).reduce((a, s) => a + s.qty, 0)) };
        }),
    }));
};

export const myRequests = (userId: string) => requestRows({ requestedBy: userId });
export const requestsQuery = z.object({ show: z.enum(['open', 'pending', 'done', 'all']).default('open') });
export const listRequests = (q: z.infer<typeof requestsQuery>) => requestRows(q.show === 'open' ? { status: { in: ['pending', 'approved', 'partly'] } } : q.show === 'pending' ? { status: 'pending' } : q.show === 'done' ? { status: { in: ['issued', 'rejected', 'cancelled'] } } : {});

export const cancelRequest = async (id: string, userId: string) => {
    const r = await db.invRequest.findFirst({ where: { id } });
    if (!r || r.requestedBy !== userId) throw notFound('Request not found');
    if (!['pending', 'approved'].includes(r.status)) throw badRequest('It is already being issued');
    await db.invRequest.update({ where: { id }, data: { status: 'cancelled' } });
    return { id };
};

export const answerRequest = async (id: string, approve: boolean, answer: string | null, userId: string) => {
    const r = await db.invRequest.findFirst({ where: { id } });
    if (!r || r.status !== 'pending') throw badRequest('Nothing to approve');
    await db.invRequest.update({ where: { id }, data: { status: approve ? 'approved' : 'rejected', answer, answeredBy: userId, answeredAt: new Date() } });
    if (r.requestedBy) raiseLater('inv_request_answer', { requester: () => usersOf([r.requestedBy!]) }, { number: r.number, result: approve ? 'approved: the store will issue it' : 'not approved', answer: answer ?? '' }, { dedupe: `inv-req-ans:${id}` });
    if (approve) raiseLater('inv_request_new', { store: () => holdersOf('inventory.store') }, { number: r.number, by: '', list: '' }, { dedupe: `inv-req:${id}` });
    return { id };
};

// ─── Issue, return, transfer ─────────────────────────────────────────────────

export const issueSchema = z.strictObject({
    storeId: z.uuid(),
    departmentId: z.uuid().nullable().optional(),
    staffId: z.uuid().nullable().optional(),
    requestId: z.uuid().nullable().optional(),
    note: z.string().trim().max(300).nullable().optional(),
    lines: z.array(lineSchema).min(1).max(100),
});

/** Issues items from a store to a department / staff member (against a request, if any). */
export const issue = async (input: z.infer<typeof issueSchema>, userId: string) => {
    if (!input.departmentId && !input.staffId) throw badRequest('Choose the department or staff member it goes to');
    const req = input.requestId ? await db.invRequest.findFirst({ where: { id: input.requestId }, include: { lines: true } }) : null;
    if (req && !['approved', 'partly'].includes(req.status)) throw badRequest(req.status === 'pending' ? 'The request is waiting for approval' : 'The request is closed');
    const ref = req?.number ?? (await nextNumber('inv_issue', 'ISS-'));
    await withTransaction(async (tx) => {
        for (const x of input.lines) await applyMove(tx, { itemId: x.itemId, storeId: input.storeId, kind: 'issue', qty: -x.qty, departmentId: input.departmentId ?? req?.departmentId ?? null, staffId: input.staffId ?? req?.staffId ?? null, refType: req ? 'request' : 'issue', refId: req?.id ?? null, refNo: ref, note: input.note || null, userId });
        if (req) {
            for (const x of input.lines) {
                const line = req.lines.find((y) => y.itemId === x.itemId);
                if (line) await tx.invRequestLine.update({ where: { id: line.id }, data: { issuedQty: r3(line.issuedQty + x.qty) } });
            }
            const lines = await tx.invRequestLine.findMany({ where: { requestId: req.id } });
            await tx.invRequest.update({ where: { id: req.id }, data: { status: lines.every((y) => y.issuedQty >= y.qty - 0.0001) ? 'issued' : 'partly' } });
        }
    }, { timeout: 60_000 });
    if (req?.requestedBy) raiseLater('inv_request_answer', { requester: () => usersOf([req.requestedBy!]) }, { number: req.number, result: 'issued: collect it from the store', answer: '' }, { dedupe: `inv-req-iss:${req.id}:${Date.now()}` });
    return { refNo: ref, lines: input.lines.length };
};

/** Closes what is left of a request (the store cannot give the rest). */
export const closeRequest = async (id: string, userId: string) => {
    const r = await db.invRequest.findFirst({ where: { id } });
    if (!r || !['approved', 'partly'].includes(r.status)) throw badRequest('Nothing to close');
    await db.invRequest.update({ where: { id }, data: { status: r.status === 'partly' ? 'issued' : 'rejected', answer: r.status === 'partly' ? 'Partly given; the rest is not available' : 'Not available in the store', answeredBy: userId, answeredAt: new Date() } });
    return { id };
};

export const returnSchema = z.strictObject({ storeId: z.uuid(), departmentId: z.uuid().nullable().optional(), staffId: z.uuid().nullable().optional(), note: z.string().trim().max(300).nullable().optional(), lines: z.array(lineSchema).min(1).max(100) });
export const takeBack = async (input: z.infer<typeof returnSchema>, userId: string) => {
    const ref = await nextNumber('inv_return', 'RET-');
    await withTransaction(async (tx) => {
        for (const x of input.lines) await applyMove(tx, { itemId: x.itemId, storeId: input.storeId, kind: 'return', qty: x.qty, departmentId: input.departmentId ?? null, staffId: input.staffId ?? null, refType: 'return', refNo: ref, note: input.note || null, userId });
    }, { timeout: 60_000 });
    return { refNo: ref };
};

export const transferSchema = z.strictObject({ fromStoreId: z.uuid(), toStoreId: z.uuid(), note: z.string().trim().max(300).nullable().optional(), lines: z.array(lineSchema).min(1).max(100) });
export const transfer = async (input: z.infer<typeof transferSchema>, userId: string) => {
    if (input.fromStoreId === input.toStoreId) throw badRequest('Choose two different stores');
    const ref = await nextNumber('inv_transfer', 'TRF-');
    await withTransaction(async (tx) => {
        for (const x of input.lines) {
            await applyMove(tx, { itemId: x.itemId, storeId: input.fromStoreId, kind: 'transfer_out', qty: -x.qty, refType: 'transfer', refNo: ref, note: input.note || null, userId });
            await applyMove(tx, { itemId: x.itemId, storeId: input.toStoreId, kind: 'transfer_in', qty: x.qty, refType: 'transfer', refNo: ref, note: input.note || null, userId });
        }
    }, { timeout: 60_000 });
    return { refNo: ref };
};

/** Issues and returns of a department or staff member (what they took). */
export const issuedTo = async (q: { departmentId?: string; staffId?: string; from: string; to: string }) => {
    const moves = await db.invMove.findMany({ where: { kind: { in: ['issue', 'return'] }, at: { gte: dayDate(q.from), lt: new Date(dayDate(q.to).getTime() + DAY) }, ...(q.departmentId ? { departmentId: q.departmentId } : {}), ...(q.staffId ? { staffId: q.staffId } : {}) }, orderBy: { at: 'desc' }, take: 500, include: { item: { select: { name: true, code: true } } } });
    const l = await lookups();
    return moves.map((m) => ({ id: m.id, at: m.at, kind: m.kind, item: m.item.name, code: m.item.code, qty: -m.qty, value: r2(-m.qty * m.rate), store: l.name(m.storeId), refNo: m.refNo }));
};

// ─── Write-offs and counts ───────────────────────────────────────────────────

export const writeoffSchema = z.strictObject({ storeId: z.uuid(), itemId: z.uuid(), batchId: z.uuid().nullable().optional(), qty: qtySchema, reason: z.enum(['damaged', 'expired', 'lost']), note: z.string().trim().max(300).nullable().optional() });

const applyAdjustment = async (a: { id: string; itemId: string; storeId: string; batchId: string | null; qty: number; kind: string; reason: string; note: string | null }, userId: string) =>
    withTransaction((tx) => applyMove(tx, { itemId: a.itemId, storeId: a.storeId, batchId: a.batchId, kind: a.kind === 'count' ? 'adjust' : 'writeoff', qty: a.qty, refType: a.kind, refId: a.id, note: [a.reason, a.note].filter(Boolean).join(': '), userId }, true));

export const requestWriteoff = async (input: z.infer<typeof writeoffSchema>, userId: string) => {
    const canApprove = !!(await getUserAccess(userId)).permissions['inventory.approve'];
    const a = await db.invAdjustment.create({ data: { tenantId: getTenantId()!, kind: 'writeoff', itemId: input.itemId, storeId: input.storeId, batchId: input.batchId ?? null, qty: -input.qty, reason: input.reason, note: input.note || null, status: canApprove ? 'approved' : 'pending', askedBy: userId, answeredBy: canApprove ? userId : null, answeredAt: canApprove ? new Date() : null } });
    if (canApprove) await applyAdjustment(a, userId);
    else {
        const item = await db.invItem.findFirst({ where: { id: input.itemId }, select: { name: true } });
        raiseLater('inv_adjust_approval', { approvers: () => holdersOf('inventory.approve') }, { what: `Write off ${input.qty} × ${item?.name ?? ''} (${input.reason})` }, { dedupe: `inv-adj:${a.id}` });
    }
    return { id: a.id, status: a.status };
};

export const adjustmentsQuery = z.object({ show: z.enum(['pending', 'all']).default('pending') });
export const listAdjustments = async (q: z.infer<typeof adjustmentsQuery>) => {
    const rows = await db.invAdjustment.findMany({ where: q.show === 'pending' ? { status: 'pending' } : {}, orderBy: { createdAt: 'desc' }, take: 200 });
    const [l, items, users] = await Promise.all([lookups(), db.invItem.findMany({ where: { id: { in: rows.map((r) => r.itemId) } }, select: { id: true, name: true, code: true, avgCost: true } }), db.user.findMany({ where: { id: { in: rows.flatMap((r) => [r.askedBy, r.answeredBy]).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } })]);
    return rows.map((r) => {
        const i = items.find((x) => x.id === r.itemId);
        return { id: r.id, kind: r.kind, item: i?.name ?? '', code: i?.code ?? '', store: l.name(r.storeId), qty: r.qty, value: r2(r.qty * (i?.avgCost ?? 0)), reason: r.reason, note: r.note, status: r.status, by: users.find((u) => u.id === r.askedBy)?.displayName ?? '', answeredBy: users.find((u) => u.id === r.answeredBy)?.displayName ?? '', at: r.createdAt };
    });
};

export const answerAdjustment = async (id: string, approve: boolean, userId: string) => {
    const a = await db.invAdjustment.findFirst({ where: { id } });
    if (!a || a.status !== 'pending') throw badRequest('Nothing to answer');
    await db.invAdjustment.update({ where: { id }, data: { status: approve ? 'approved' : 'rejected', answeredBy: userId, answeredAt: new Date() } });
    if (approve) await applyAdjustment(a, userId);
    return { id };
};

export const listCounts = async () => {
    const [rows, l] = await Promise.all([db.invCount.findMany({ orderBy: { startedAt: 'desc' }, take: 30, include: { lines: { select: { counted: true, systemQty: true } } } }), lookups()]);
    return rows.map((c) => ({ id: c.id, name: c.name, store: l.name(c.storeId), status: c.status, startedAt: c.startedAt, closedAt: c.closedAt, items: c.lines.length, counted: c.lines.filter((x) => x.counted !== null).length, differences: c.lines.filter((x) => x.counted !== null && Math.abs(x.counted - x.systemQty) > 0.0001).length }));
};

export const startCount = async (storeId: string, name: string, userId: string) => {
    if (await db.invCount.findFirst({ where: { storeId, status: 'open' } })) throw badRequest('A count of this store is open already');
    const items = await db.invItem.findMany({ where: { OR: [{ isActive: true }, { stock: { some: { storeId, qty: { not: 0 } } } }] }, include: { stock: { where: { storeId } } }, orderBy: { name: 'asc' } });
    const c = await db.invCount.create({ data: { tenantId: getTenantId()!, storeId, name: name || `Stock count ${todayIST()}`, createdBy: userId, lines: { create: items.filter((i) => i.stock.length || i.isActive).map((i) => ({ itemId: i.id, systemQty: i.stock[0]?.qty ?? 0 })) } } });
    return countView(c.id);
};

export const countView = async (id: string) => {
    const c = await db.invCount.findFirst({ where: { id }, include: { lines: true } });
    if (!c) throw notFound('Count not found');
    const [items, l] = await Promise.all([db.invItem.findMany({ where: { id: { in: c.lines.map((x) => x.itemId) } }, select: { id: true, name: true, code: true, unitId: true, categoryId: true, avgCost: true } }), lookups()]);
    return {
        id: c.id,
        name: c.name,
        store: l.name(c.storeId),
        status: c.status,
        lines: c.lines
            .map((x) => {
                const i = items.find((y) => y.id === x.itemId);
                return { itemId: x.itemId, item: i?.name ?? '', code: i?.code ?? '', unit: l.name(i?.unitId), category: l.name(i?.categoryId), systemQty: x.systemQty, counted: x.counted, diff: x.counted === null ? null : r3(x.counted - x.systemQty), value: x.counted === null ? null : r2((x.counted - x.systemQty) * (i?.avgCost ?? 0)) };
            })
            .sort((a, b) => a.category.localeCompare(b.category) || a.item.localeCompare(b.item)),
    };
};

export const countSchema = z.strictObject({ lines: z.array(z.strictObject({ itemId: z.uuid(), counted: z.number().min(0).max(10_000_000).nullable() })).max(2000) });
export const saveCount = async (id: string, input: z.infer<typeof countSchema>) => {
    const c = await db.invCount.findFirst({ where: { id } });
    if (!c || c.status !== 'open') throw badRequest('This count is closed');
    for (const x of input.lines) await db.invCountLine.updateMany({ where: { countId: id, itemId: x.itemId }, data: { counted: x.counted } });
    return countView(id);
};

/** Ends a count: each difference becomes an adjustment (approved at once if the person may approve). */
export const submitCount = async (id: string, userId: string) => {
    const c = await db.invCount.findFirst({ where: { id }, include: { lines: true } });
    if (!c || c.status !== 'open') throw badRequest('This count is closed');
    const canApprove = !!(await getUserAccess(userId)).permissions['inventory.approve'];
    const diffs = c.lines.filter((x) => x.counted !== null && Math.abs(x.counted - x.systemQty) > 0.0001);
    for (const x of diffs) {
        const a = await db.invAdjustment.create({ data: { tenantId: getTenantId()!, kind: 'count', itemId: x.itemId, storeId: c.storeId, qty: r3(x.counted! - x.systemQty), reason: 'count', note: c.name, countId: c.id, status: canApprove ? 'approved' : 'pending', askedBy: userId, answeredBy: canApprove ? userId : null, answeredAt: canApprove ? new Date() : null } });
        if (canApprove) await applyAdjustment(a, userId);
    }
    await db.invCount.update({ where: { id }, data: { status: 'closed', closedAt: new Date() } });
    if (diffs.length && !canApprove) raiseLater('inv_adjust_approval', { approvers: () => holdersOf('inventory.approve') }, { what: `${diffs.length} stock count difference(s) in ${c.name}` }, { dedupe: `inv-count:${id}` });
    return { differences: diffs.length, approved: canApprove };
};

// ─── Low stock and expiry ────────────────────────────────────────────────────

export const lowStock = async () => {
    const [items, l] = await Promise.all([db.invItem.findMany({ where: { isActive: true, reorderLevel: { gt: 0 } }, include: { stock: true }, orderBy: { name: 'asc' } }), lookups()]);
    return items
        .map((i) => ({ id: i.id, code: i.code, name: i.name, unit: l.name(i.unitId), category: l.name(i.categoryId), qty: r3(i.stock.reduce((a, s) => a + s.qty, 0)), reorderLevel: i.reorderLevel, suggest: Math.max(i.reorderQty, i.reorderLevel), avgCost: i.avgCost, gstPct: i.gstPct }))
        .filter((i) => i.qty <= i.reorderLevel);
};

export const expiring = async (days?: number) => {
    const d = days ?? (await getSettings({ d: INVENTORY.expiryDays })).d;
    const limit = dayDate(isoOf(new Date(dayDate(todayIST()).getTime() + d * DAY)));
    const [rows, l] = await Promise.all([db.invBatch.findMany({ where: { qty: { gt: 0 }, expiryOn: { lte: limit } }, orderBy: { expiryOn: 'asc' }, include: { item: { select: { name: true, code: true, unitId: true } } } }), lookups()]);
    const today = todayIST();
    return rows.map((b) => ({ id: b.id, itemId: b.itemId, item: b.item.name, code: b.item.code, unit: l.name(b.item.unitId), store: l.name(b.storeId), storeId: b.storeId, batchNo: b.batchNo, expiryOn: isoOf(b.expiryOn!), expired: isoOf(b.expiryOn!) < today, qty: b.qty }));
};

defineDailyJob({
    key: 'inventory_daily',
    run: async () => {
        const [low, exp] = await Promise.all([lowStock(), expiring()]);
        const today = todayIST();
        if (low.length) raiseLater('inv_low_stock', { store: () => holdersOf('inventory.store') }, { count: String(low.length), list: low.slice(0, 25).map((i) => `- ${i.name}: ${i.qty} ${i.unit} (reorder at ${i.reorderLevel})`).join('\n') }, { dedupe: `inv-low:${today}` });
        if (exp.length) raiseLater('inv_expiry', { store: () => holdersOf('inventory.store') }, { count: String(exp.length), list: exp.slice(0, 25).map((b) => `- ${b.item} (${b.store}${b.batchNo ? `, batch ${b.batchNo}` : ''}): ${b.qty} ${b.unit}, ${b.expired ? 'expired' : 'expires'} ${b.expiryOn}`).join('\n') }, { dedupe: `inv-exp:${today}` });
        return `${low.length} low, ${exp.length} expiring`;
    },
});
