import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { currentYear } from '../academic/years.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { registerFeeSource } from '../fees/dues.service';
import { isoOf } from '../attendance/attendance.settings';
import { INVENTORY } from './inventory.settings';
import { applyMove, lookups, nextNumber, qtySchema, r2 } from './inventory.service';

/** Selling items to students (uniform, diary…): paid at the counter, or added to the fees. */

export const findStudents = async (q: string) => {
    const t = q.trim();
    if (t.length < 2) return [];
    const year = await currentYear();
    const rows = await db.student.findMany({ where: { status: 'active', OR: [{ firstName: { contains: t, mode: 'insensitive' } }, { lastName: { contains: t, mode: 'insensitive' } }, { admissionNo: { contains: t, mode: 'insensitive' } }] }, take: 15, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } });
    const enrol = year ? await db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: rows.map((r) => r.id) } }, select: { studentId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } }) : [];
    return rows.map((r) => {
        const e = enrol.find((x) => x.studentId === r.id);
        return { id: r.id, name: fullName(r), admissionNo: r.admissionNo, section: e ? sectionLabel(e.section) : '' };
    });
};

export const saleSchema = z.strictObject({
    studentId: z.uuid(),
    storeId: z.uuid(),
    payAt: z.enum(['fees', 'counter']).optional(),
    mode: z.string().trim().max(30).nullable().optional(),
    lines: z.array(z.strictObject({ itemId: z.uuid(), qty: qtySchema })).min(1).max(50),
});

export const sell = async (input: z.infer<typeof saleSchema>, userId: string, opts: { at?: Date; isDemo?: boolean } = {}) => {
    const s = await getSettings({ on: INVENTORY.sales, to: INVENTORY.salesTo, p: INVENTORY.salePrefix });
    if (!s.on) throw forbidden('Student sales are off (System Settings → Inventory)');
    const items = await db.invItem.findMany({ where: { id: { in: input.lines.map((x) => x.itemId) }, sellable: true } });
    for (const x of input.lines) if (!items.find((i) => i.id === x.itemId)?.sellPrice) throw badRequest('One of the items is not for sale');
    const year = await currentYear();
    const total = r2(input.lines.reduce((a, x) => a + x.qty * (items.find((i) => i.id === x.itemId)!.sellPrice ?? 0), 0));
    const number = await nextNumber('inv_sale', s.p);
    const tenantId = getTenantId()!;
    const sale = await withTransaction(async (tx) => {
        const sl = await tx.invSale.create({ data: { tenantId, number, studentId: input.studentId, academicYearId: year?.id ?? null, storeId: input.storeId, payAt: input.payAt ?? s.to, mode: input.mode || null, total, soldBy: userId, at: opts.at ?? new Date(), isDemo: opts.isDemo ?? false, lines: { create: input.lines.map((x) => ({ itemId: x.itemId, qty: x.qty, rate: items.find((i) => i.id === x.itemId)!.sellPrice! })) } } });
        for (const x of input.lines) await applyMove(tx, { itemId: x.itemId, storeId: input.storeId, kind: 'sale', qty: -x.qty, studentId: input.studentId, refType: 'sale', refId: sl.id, refNo: number, userId, at: opts.at, isDemo: opts.isDemo });
        return sl;
    }, { timeout: 60_000 });
    return saleView(sale.id);
};

export const saleView = async (id: string) => {
    const s = await db.invSale.findFirst({ where: { id }, include: { lines: true } });
    if (!s) throw notFound('Sale not found');
    const [items, st, l, user, school] = await Promise.all([db.invItem.findMany({ where: { id: { in: s.lines.map((x) => x.itemId) } }, select: { id: true, name: true, unitId: true } }), db.student.findFirst({ where: { id: s.studentId }, select: { firstName: true, middleName: true, lastName: true, admissionNo: true } }), lookups(), db.user.findFirst({ where: { id: s.soldBy ?? undefined }, select: { displayName: true } }), db.schoolProfile.findFirst({ select: { legalName: true, addressLine1: true, city: true, phone: true } })]);
    return { ...s, student: st ? fullName(st) : '', admissionNo: st?.admissionNo ?? '', store: l.name(s.storeId), soldByName: user?.displayName ?? '', school, lines: s.lines.map((x) => ({ ...x, item: items.find((i) => i.id === x.itemId)?.name ?? '', unit: l.name(items.find((i) => i.id === x.itemId)?.unitId), amount: r2(x.qty * x.rate) })) };
};

export const salesQuery = z.object({ studentId: z.uuid().optional(), page: z.coerce.number().int().min(1).default(1) });
export const listSales = async (q: z.infer<typeof salesQuery>) => {
    const where = q.studentId ? { studentId: q.studentId } : {};
    const [total, rows] = await Promise.all([db.invSale.count({ where }), db.invSale.findMany({ where, orderBy: { at: 'desc' }, skip: (q.page - 1) * 30, take: 30, include: { lines: { select: { qty: true } } } })]);
    const st = await db.student.findMany({ where: { id: { in: rows.map((r) => r.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } });
    return { total, page: q.page, pageSize: 30, rows: rows.map((r) => ({ id: r.id, number: r.number, student: fullName(st.find((x) => x.id === r.studentId) ?? { firstName: '' }), admissionNo: st.find((x) => x.id === r.studentId)?.admissionNo ?? '', payAt: r.payAt, mode: r.mode, total: r.total, items: r.lines.reduce((a, x) => a + x.qty, 0), status: r.status, at: r.at })) };
};

export const cancelSale = async (id: string, userId: string) => {
    const s = await db.invSale.findFirst({ where: { id }, include: { lines: true } });
    if (!s || s.status !== 'active') throw badRequest('Already cancelled');
    await withTransaction(async (tx) => {
        await tx.invSale.update({ where: { id }, data: { status: 'cancelled' } });
        for (const x of s.lines) await applyMove(tx, { itemId: x.itemId, storeId: s.storeId, kind: 'sale_cancel', qty: x.qty, studentId: s.studentId, refType: 'sale', refId: s.id, refNo: s.number, note: 'Sale cancelled, items back', userId });
    }, { timeout: 60_000 });
    await recordAudit({ action: 'inv_sale_cancelled', entity: 'inv_sale', entityId: id, changes: { number: s.number, total: s.total } });
    return saleView(id);
};

// Student purchases "with the fees": into the first instalment due on or after the sale (else the last).
registerFeeSource(async (yearId, students, instalments) => {
    const out = new Map<string, { feeHeadId: string; instalmentId: string; amount: number }[]>();
    if (!students.length || !instalments.length) return out;
    const sales = await db.invSale.findMany({ where: { academicYearId: yearId, payAt: 'fees', status: 'active', studentId: { in: students.map((s) => s.id) } }, select: { studentId: true, total: true, at: true } });
    if (!sales.length) return out;
    const { code } = await getSettings({ code: INVENTORY.feeHeadCode });
    const head = await db.masterValue.findFirst({ where: { master: 'fee_head', code: { equals: code, mode: 'insensitive' } }, select: { id: true } });
    if (!head) return out;
    const sorted = [...instalments].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
    for (const s of sales) {
        const day = isoOf(s.at);
        const inst = sorted.find((i) => isoOf(i.dueDate) >= day) ?? sorted[sorted.length - 1];
        const lines = out.get(s.studentId) ?? [];
        const same = lines.find((l) => l.instalmentId === inst.id);
        if (same) same.amount += Math.round(s.total);
        else lines.push({ feeHeadId: head.id, instalmentId: inst.id, amount: Math.round(s.total) });
        out.set(s.studentId, lines);
    }
    return out;
});
