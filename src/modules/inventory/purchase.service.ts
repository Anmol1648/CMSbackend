import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { getUserAccess } from '../rbac/access.service';
import { dayDate, isoOf } from '../attendance/attendance.settings';
import { raiseLater } from '../alerts/deliver';
import { holdersOf, usersOf } from '../alerts/recipients';
import { INVENTORY } from './inventory.settings';
import { applyMove, lookups, nextNumber, qtySchema, r2 } from './inventory.service';

/** Purchase orders to vendors (approval above a value) and goods received into a store. */

const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const STATUS_OPEN = ['draft', 'pending', 'approved', 'partly'];

const lineTotal = (l: { qty: number; rate: number; gstPct: number }) => l.qty * l.rate * (1 + l.gstPct / 100);

export const poSchema = z.strictObject({
    vendorId: z.uuid({ message: 'Choose the vendor' }),
    storeId: z.uuid().nullable().optional(),
    orderDate: D,
    expectedOn: D.nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
    lines: z.array(z.strictObject({ itemId: z.uuid(), qty: qtySchema, rate: z.number().min(0).max(10_000_000), gstPct: z.number().min(0).max(28).default(0) })).min(1).max(100),
});

const school = async () => {
    const p = await db.schoolProfile.findFirst({ include: { tenant: { select: { code: true } } } });
    return p ? { name: p.legalName, address: [p.addressLine1, p.addressLine2, p.city, p.state, p.pincode].filter(Boolean).join(', '), phone: p.phone ?? '', email: p.email ?? '', logoUrl: p.logoFileId ? `public/school/logo?school=${p.tenant.code}&v=${p.logoFileId}` : null } : null;
};

export const poView = async (id: string) => {
    const po = await db.invPurchaseOrder.findFirst({ where: { id }, include: { lines: true } });
    if (!po) throw notFound('Order not found');
    const [l, items, users, receipts, sch] = await Promise.all([
        lookups(),
        db.invItem.findMany({ where: { id: { in: po.lines.map((x) => x.itemId) } }, select: { id: true, name: true, code: true, unitId: true, trackExpiry: true } }),
        db.user.findMany({ where: { id: { in: [po.createdBy, po.approvedBy].filter((x): x is string => !!x) } }, select: { id: true, displayName: true } }),
        db.invReceipt.findMany({ where: { poId: id }, orderBy: { at: 'asc' }, select: { id: true, number: true, at: true, billNo: true, total: true } }),
        school(),
    ]);
    const vendor = l.rows.find((r) => r.id === po.vendorId);
    return {
        ...po,
        orderDate: isoOf(po.orderDate),
        expectedOn: po.expectedOn ? isoOf(po.expectedOn) : null,
        vendor: vendor?.name ?? '',
        vendorInfo: (vendor?.extra ?? {}) as { phone?: string; gstin?: string },
        store: l.name(po.storeId),
        createdByName: users.find((u) => u.id === po.createdBy)?.displayName ?? '',
        approvedByName: users.find((u) => u.id === po.approvedBy)?.displayName ?? '',
        school: sch,
        receipts,
        lines: po.lines.map((x) => {
            const i = items.find((y) => y.id === x.itemId);
            return { ...x, item: i?.name ?? '', code: i?.code ?? '', unit: l.name(i?.unitId), trackExpiry: !!i?.trackExpiry, amount: r2(lineTotal(x)) };
        }),
    };
};

export const posQuery = z.object({ show: z.enum(['open', 'pending', 'received', 'all']).default('open') });
export const listPOs = async (q: z.infer<typeof posQuery>) => {
    const rows = await db.invPurchaseOrder.findMany({ where: q.show === 'open' ? { status: { in: STATUS_OPEN } } : q.show === 'pending' ? { status: 'pending' } : q.show === 'received' ? { status: { in: ['received', 'cancelled', 'rejected'] } } : {}, orderBy: { createdAt: 'desc' }, take: 200, include: { lines: { select: { qty: true, receivedQty: true } } } });
    const [l, users] = await Promise.all([lookups(), db.user.findMany({ where: { id: { in: rows.map((r) => r.createdBy!).filter(Boolean) } }, select: { id: true, displayName: true } })]);
    return rows.map((p) => ({ id: p.id, number: p.number, vendor: l.name(p.vendorId), store: l.name(p.storeId), orderDate: isoOf(p.orderDate), expectedOn: p.expectedOn ? isoOf(p.expectedOn) : null, status: p.status, total: p.total, lines: p.lines.length, received: p.lines.filter((x) => x.receivedQty >= x.qty - 0.0001).length, by: users.find((u) => u.id === p.createdBy)?.displayName ?? '' }));
};

/** Saves a draft order (new, or a draft / refused one being changed). */
export const savePO = async (id: string | null, input: z.infer<typeof poSchema>, userId: string) => {
    const total = r2(input.lines.reduce((a, x) => a + lineTotal(x), 0));
    const data = { vendorId: input.vendorId, storeId: input.storeId ?? null, orderDate: dayDate(input.orderDate), expectedOn: input.expectedOn ? dayDate(input.expectedOn) : null, note: input.note || null, total };
    const tenantId = getTenantId()!;
    if (id) {
        const po = await db.invPurchaseOrder.findFirst({ where: { id } });
        if (!po || !['draft', 'rejected'].includes(po.status)) throw badRequest('Only a draft can be changed');
        await db.invPoLine.deleteMany({ where: { poId: id } });
        await db.invPurchaseOrder.update({ where: { id }, data: { ...data, status: 'draft', lines: { create: input.lines.map((x) => ({ ...x })) } } });
        return poView(id);
    }
    const { p } = await getSettings({ p: INVENTORY.poPrefix });
    const po = await db.invPurchaseOrder.create({ data: { ...data, tenantId, number: await nextNumber('inv_po', p), createdBy: userId, lines: { create: input.lines.map((x) => ({ ...x })) } } });
    return poView(po.id);
};

/** Sends a draft for approval, or approves it at once (small orders, or the person may approve). */
export const submitPO = async (id: string, userId: string) => {
    const po = await db.invPurchaseOrder.findFirst({ where: { id } });
    if (!po || po.status !== 'draft') throw badRequest('Only a draft can be sent');
    const [s, a] = await Promise.all([getSettings({ limit: INVENTORY.poApproval }), getUserAccess(userId)]);
    const ok = (s.limit > 0 && po.total <= s.limit) || !!a.permissions['inventory.approve'];
    await db.invPurchaseOrder.update({ where: { id }, data: ok ? { status: 'approved', approvedBy: userId, approvedAt: new Date() } : { status: 'pending' } });
    if (!ok) {
        const l = await lookups();
        raiseLater('inv_po_approval', { approvers: () => holdersOf('inventory.approve') }, { number: po.number, vendor: l.name(po.vendorId), total: String(po.total) }, { dedupe: `inv-po:${id}` });
    }
    return poView(id);
};

export const answerPO = async (id: string, approve: boolean, userId: string) => {
    const po = await db.invPurchaseOrder.findFirst({ where: { id } });
    if (!po || po.status !== 'pending') throw badRequest('Nothing to approve');
    await db.invPurchaseOrder.update({ where: { id }, data: { status: approve ? 'approved' : 'rejected', approvedBy: userId, approvedAt: new Date() } });
    if (po.createdBy) raiseLater('inv_po_answer', { creator: () => usersOf([po.createdBy!]) }, { number: po.number, result: approve ? 'approved' : 'not approved' }, { dedupe: `inv-po-ans:${id}` });
    await recordAudit({ action: approve ? 'inv_po_approved' : 'inv_po_refused', entity: 'inv_po', entityId: id, changes: { number: po.number, total: po.total } });
    return poView(id);
};

export const cancelPO = async (id: string) => {
    const po = await db.invPurchaseOrder.findFirst({ where: { id } });
    if (!po || !['draft', 'pending', 'approved', 'rejected'].includes(po.status)) throw badRequest('A part-received order cannot be cancelled');
    await db.invPurchaseOrder.update({ where: { id }, data: { status: 'cancelled' } });
    return poView(id);
};

// ─── Goods received ──────────────────────────────────────────────────────────

export const receiveSchema = z.strictObject({
    source: z.enum(['po', 'direct', 'donation']),
    poId: z.uuid().nullable().optional(),
    vendorId: z.uuid().nullable().optional(),
    storeId: z.uuid(),
    billNo: z.string().trim().max(60).nullable().optional(),
    billDate: D.nullable().optional(),
    billFileId: z.uuid().nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
    lines: z.array(z.strictObject({ itemId: z.uuid(), qty: qtySchema, rate: z.number().min(0).max(10_000_000), gstPct: z.number().min(0).max(28).default(0), batchNo: z.string().trim().max(40).nullable().optional(), expiryOn: D.nullable().optional() })).min(1).max(100),
});

export const receive = async (input: z.infer<typeof receiveSchema>, userId: string, opts: { at?: Date; isDemo?: boolean } = {}) => {
    const po = input.source === 'po' ? await db.invPurchaseOrder.findFirst({ where: { id: input.poId ?? undefined }, include: { lines: true } }) : null;
    if (input.source === 'po' && (!po || !['approved', 'partly'].includes(po.status))) throw badRequest(po?.status === 'pending' ? 'The order is waiting for approval' : 'Choose an approved order');
    const items = await db.invItem.findMany({ where: { id: { in: input.lines.map((x) => x.itemId) } }, select: { id: true, name: true, trackExpiry: true } });
    for (const x of input.lines) if (items.find((i) => i.id === x.itemId)?.trackExpiry && !x.expiryOn) throw badRequest(`Give the expiry date of ${items.find((i) => i.id === x.itemId)?.name}`);
    const donation = input.source === 'donation';
    const total = r2(input.lines.reduce((a, x) => a + (donation ? 0 : lineTotal(x)), 0));
    const { p } = await getSettings({ p: INVENTORY.grnPrefix });
    const number = await nextNumber('inv_grn', p);
    const tenantId = getTenantId()!;
    const r = await withTransaction(async (tx) => {
        const rec = await tx.invReceipt.create({ data: { tenantId, number, source: input.source, poId: po?.id ?? null, vendorId: input.vendorId ?? po?.vendorId ?? null, storeId: input.storeId, billNo: input.billNo || null, billDate: input.billDate ? dayDate(input.billDate) : null, billFileId: input.billFileId ?? null, total, note: input.note || null, receivedBy: userId, at: opts.at ?? new Date(), isDemo: opts.isDemo ?? false, lines: { create: input.lines.map((x) => ({ itemId: x.itemId, qty: x.qty, rate: donation ? 0 : x.rate, gstPct: donation ? 0 : x.gstPct, batchNo: x.batchNo || null, expiryOn: x.expiryOn ? dayDate(x.expiryOn) : null })) } } });
        for (const x of input.lines) {
            // Landed cost of one unit includes GST (a school does not claim it back).
            await applyMove(tx, { itemId: x.itemId, storeId: input.storeId, kind: 'receive', qty: x.qty, rate: donation ? 0 : r2(x.rate * (1 + x.gstPct / 100)), batchNo: x.batchNo || null, expiryOn: x.expiryOn || null, refType: 'grn', refId: rec.id, refNo: number, note: donation ? 'Donation' : null, userId, at: opts.at, isDemo: opts.isDemo });
        }
        if (po) {
            for (const x of input.lines) {
                const line = po.lines.find((y) => y.itemId === x.itemId);
                if (line) await tx.invPoLine.update({ where: { id: line.id }, data: { receivedQty: line.receivedQty + x.qty } });
            }
            const lines = await tx.invPoLine.findMany({ where: { poId: po.id } });
            await tx.invPurchaseOrder.update({ where: { id: po.id }, data: { status: lines.every((y) => y.receivedQty >= y.qty - 0.0001) ? 'received' : 'partly' } });
        }
        return rec;
    }, { timeout: 90_000 });
    return { id: r.id, number, total };
};

export const receiptsQuery = z.object({ from: D.optional(), to: D.optional() });
export const listReceipts = async (q: z.infer<typeof receiptsQuery>) => {
    const rows = await db.invReceipt.findMany({ where: q.from && q.to ? { at: { gte: dayDate(q.from), lt: new Date(dayDate(q.to).getTime() + 86_400_000) } } : {}, orderBy: { at: 'desc' }, take: 200, include: { lines: { select: { id: true } } } });
    const [l, pos, users] = await Promise.all([lookups(), db.invPurchaseOrder.findMany({ where: { id: { in: rows.map((r) => r.poId!).filter(Boolean) } }, select: { id: true, number: true } }), db.user.findMany({ where: { id: { in: rows.map((r) => r.receivedBy!).filter(Boolean) } }, select: { id: true, displayName: true } })]);
    return rows.map((r) => ({ id: r.id, number: r.number, source: r.source, po: pos.find((p) => p.id === r.poId)?.number ?? null, vendor: l.name(r.vendorId), store: l.name(r.storeId), billNo: r.billNo, billDate: r.billDate ? isoOf(r.billDate) : null, billFileId: r.billFileId, total: r.total, lines: r.lines.length, by: users.find((u) => u.id === r.receivedBy)?.displayName ?? '', at: r.at }));
};

export const receiptView = async (id: string) => {
    const r = await db.invReceipt.findFirst({ where: { id }, include: { lines: true } });
    if (!r) throw notFound('Receipt not found');
    const [l, items] = await Promise.all([lookups(), db.invItem.findMany({ where: { id: { in: r.lines.map((x) => x.itemId) } }, select: { id: true, name: true, code: true, unitId: true } })]);
    return { ...r, vendor: l.name(r.vendorId), store: l.name(r.storeId), billDate: r.billDate ? isoOf(r.billDate) : null, lines: r.lines.map((x) => ({ ...x, item: items.find((i) => i.id === x.itemId)?.name ?? '', unit: l.name(items.find((i) => i.id === x.itemId)?.unitId), expiryOn: x.expiryOn ? isoOf(x.expiryOn) : null, amount: r2(lineTotal(x)) })) };
};

export const vendorReturnSchema = z.strictObject({ storeId: z.uuid(), vendorId: z.uuid(), note: z.string().trim().max(300).nullable().optional(), lines: z.array(z.strictObject({ itemId: z.uuid(), qty: qtySchema })).min(1).max(100) });
export const vendorReturn = async (input: z.infer<typeof vendorReturnSchema>, userId: string) => {
    const ref = await nextNumber('inv_vreturn', 'VR-');
    const l = await lookups();
    await withTransaction(async (tx) => {
        for (const x of input.lines) await applyMove(tx, { itemId: x.itemId, storeId: input.storeId, kind: 'vendor_return', qty: -x.qty, refType: 'vendor_return', refNo: ref, note: [`To ${l.name(input.vendorId)}`, input.note].filter(Boolean).join(': '), userId });
    }, { timeout: 60_000 });
    return { refNo: ref };
};

