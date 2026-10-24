import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { fullName } from '../students/students.service';
import { dayDate, isoOf } from '../attendance/attendance.settings';
import { defineReport, registerReportCategory } from '../reports/reports.registry';
import { defineDefaultLayout, defineWidget } from '../dashboard/dashboard.registry';
import { expiring, lookups, lowStock, r2 } from './inventory.service';

/** Inventory reports (Report Center) and a dashboard widget. */

registerReportCategory('Inventory', 60);

const range = [
    { key: 'from', label: 'From', type: 'date' as const, required: true, default: 'monthStart' },
    { key: 'to', label: 'To', type: 'date' as const, required: true, default: 'today' },
];
const between = (f: Record<string, string>) => {
    if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
    return { gte: dayDate(f.from), lt: new Date(dayDate(f.to).getTime() + 86_400_000) };
};
const KIND: Record<string, string> = { opening: 'Opening', receive: 'Received', issue: 'Issued', return: 'Returned', transfer_in: 'Transfer in', transfer_out: 'Transfer out', vendor_return: 'Back to vendor', writeoff: 'Written off', adjust: 'Count adjustment', sale: 'Sold', sale_cancel: 'Sale cancelled' };

defineReport({
    key: 'inv_stock',
    category: 'Inventory',
    label: 'Stock in hand',
    description: 'Every item with its stock, average cost and value, grouped by category.',
    permissions: ['inventory.view', 'inventory.store'],
    orientation: 'landscape',
    filters: [{ key: 'store', label: 'Store', type: 'text', help: 'Leave empty for all stores' }],
    columns: [
        { key: 'code', label: 'Code', type: 'text', width: 0.7 },
        { key: 'name', label: 'Item', type: 'text', width: 2 },
        { key: 'unit', label: 'Unit', type: 'text', width: 0.6 },
        { key: 'qty', label: 'Stock', type: 'number', width: 0.6 },
        { key: 'reorder', label: 'Reorder at', type: 'number', width: 0.6 },
        { key: 'rate', label: 'Avg cost', type: 'money', width: 0.7 },
        { key: 'value', label: 'Value', type: 'money', width: 0.8, total: true },
    ],
    async run(f) {
        const [items, l] = await Promise.all([db.invItem.findMany({ where: { isActive: true }, include: { stock: true }, orderBy: { name: 'asc' } }), lookups()]);
        const store = f.store ? l.of('inv_store').find((s) => s.name.toLowerCase().includes(f.store.toLowerCase())) : null;
        return {
            subtitle: store ? store.name : 'All stores',
            groupedBy: 'Category',
            rows: items
                .map((i) => {
                    const qty = i.stock.filter((s) => !store || s.storeId === store.id).reduce((a, s) => a + s.qty, 0);
                    return { groupKey: i.categoryId ?? '-', groupLabel: l.name(i.categoryId) || 'No category', code: i.code, name: i.name, unit: l.name(i.unitId), qty: r2(qty), reorder: i.reorderLevel, rate: i.avgCost, value: r2(qty * i.avgCost) };
                })
                .sort((a, b) => a.groupLabel.localeCompare(b.groupLabel) || a.name.localeCompare(b.name)),
        };
    },
});

defineReport({
    key: 'inv_ledger',
    category: 'Inventory',
    label: 'Stock ledger of an item',
    description: 'Every movement of one item (or all) in a period with the balance after each.',
    permissions: ['inventory.view', 'inventory.store'],
    orientation: 'landscape',
    filters: [...range, { key: 'item', label: 'Item code or name', type: 'text' }],
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 0.7 },
        { key: 'item', label: 'Item', type: 'text', width: 1.6 },
        { key: 'store', label: 'Store', type: 'text', width: 0.9 },
        { key: 'kind', label: 'Movement', type: 'text', width: 0.9 },
        { key: 'ref', label: 'Ref / to', type: 'text', width: 1.3 },
        { key: 'in', label: 'In', type: 'number', width: 0.5, total: true },
        { key: 'out', label: 'Out', type: 'number', width: 0.5, total: true },
        { key: 'balance', label: 'Balance', type: 'number', width: 0.6 },
    ],
    async run(f) {
        const t = (f.item ?? '').trim();
        const moves = await db.invMove.findMany({ where: { at: between(f), ...(t ? { item: { OR: [{ code: { equals: t, mode: 'insensitive' } }, { name: { contains: t, mode: 'insensitive' } }] } } : {}) }, orderBy: [{ at: 'asc' }], take: 5000, include: { item: { select: { name: true } } } });
        const l = await lookups();
        return { subtitle: `${f.from} – ${f.to}${t ? ` · ${t}` : ''}`, rows: moves.map((m) => ({ date: isoOf(m.at), item: m.item.name, store: l.name(m.storeId), kind: KIND[m.kind] ?? m.kind, ref: [m.refNo, l.name(m.departmentId)].filter(Boolean).join(' · '), in: m.qty > 0 ? m.qty : 0, out: m.qty < 0 ? -m.qty : 0, balance: m.balance })) };
    },
});

defineReport({
    key: 'inv_low',
    category: 'Inventory',
    label: 'Low stock (to reorder)',
    description: 'Items at or below their reorder level, with the suggested quantity to order.',
    permissions: ['inventory.view', 'inventory.store', 'inventory.purchase'],
    orientation: 'portrait',
    filters: [],
    columns: [
        { key: 'name', label: 'Item', type: 'text', width: 1.8 },
        { key: 'category', label: 'Category', type: 'text', width: 1 },
        { key: 'qty', label: 'Stock', type: 'number', width: 0.6 },
        { key: 'reorderLevel', label: 'Reorder at', type: 'number', width: 0.6 },
        { key: 'suggest', label: 'Order', type: 'number', width: 0.6 },
        { key: 'cost', label: 'Approx. cost', type: 'money', width: 0.8, total: true },
    ],
    async run() {
        return { rows: (await lowStock()).map((i) => ({ ...i, name: `${i.name} (${i.unit})`, cost: r2(i.suggest * i.avgCost) })) };
    },
});

defineReport({
    key: 'inv_issues',
    category: 'Inventory',
    label: 'Items issued by department / staff',
    description: 'What each department (and staff member) took from the store in a period, with the value.',
    permissions: ['inventory.view', 'inventory.store', 'inventory.approve'],
    orientation: 'landscape',
    filters: range,
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 0.7 },
        { key: 'item', label: 'Item', type: 'text', width: 1.8 },
        { key: 'to', label: 'Staff', type: 'text', width: 1.2 },
        { key: 'qty', label: 'Qty', type: 'number', width: 0.5 },
        { key: 'value', label: 'Value', type: 'money', width: 0.7, total: true },
        { key: 'ref', label: 'Ref', type: 'text', width: 0.8 },
    ],
    async run(f) {
        const moves = await db.invMove.findMany({ where: { kind: { in: ['issue', 'return'] }, at: between(f) }, orderBy: { at: 'asc' }, include: { item: { select: { name: true, unitId: true } } } });
        const [l, staff] = await Promise.all([lookups(), db.staff.findMany({ where: { id: { in: moves.map((m) => m.staffId!).filter(Boolean) } }, select: { id: true, firstName: true, middleName: true, lastName: true, departmentId: true } })]);
        return {
            subtitle: `${f.from} – ${f.to}`,
            groupedBy: 'Department',
            rows: moves
                .map((m) => {
                    const s = staff.find((x) => x.id === m.staffId);
                    const dept = m.departmentId ?? s?.departmentId ?? null;
                    return { groupKey: dept ?? '-', groupLabel: l.name(dept) || 'No department', date: isoOf(m.at), item: `${m.item.name}${m.qty > 0 ? ' (returned)' : ''}`, to: s ? fullName(s) : '', qty: -m.qty, value: r2(-m.qty * m.rate), ref: m.refNo ?? '' };
                })
                .sort((a, b) => a.groupLabel.localeCompare(b.groupLabel) || a.date.localeCompare(b.date)),
        };
    },
});

defineReport({
    key: 'inv_purchases',
    category: 'Inventory',
    label: 'Purchases by vendor',
    description: 'Goods received in a period, by vendor, with bill numbers and amounts.',
    permissions: ['inventory.view', 'inventory.purchase', 'inventory.approve'],
    orientation: 'landscape',
    filters: range,
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 0.7 },
        { key: 'number', label: 'GRN', type: 'text', width: 0.8 },
        { key: 'po', label: 'Order', type: 'text', width: 0.8 },
        { key: 'bill', label: 'Bill no.', type: 'text', width: 0.9 },
        { key: 'store', label: 'Store', type: 'text', width: 1 },
        { key: 'total', label: 'Amount', type: 'money', width: 0.9, total: true },
    ],
    async run(f) {
        const rows = await db.invReceipt.findMany({ where: { at: between(f) }, orderBy: { at: 'asc' } });
        const [l, pos] = await Promise.all([lookups(), db.invPurchaseOrder.findMany({ where: { id: { in: rows.map((r) => r.poId!).filter(Boolean) } }, select: { id: true, number: true } })]);
        return { subtitle: `${f.from} – ${f.to}`, groupedBy: 'Vendor', rows: rows.map((r) => ({ groupKey: r.vendorId ?? r.source, groupLabel: l.name(r.vendorId) || (r.source === 'donation' ? 'Donations' : 'No vendor'), date: isoOf(r.at), number: r.number, po: pos.find((p) => p.id === r.poId)?.number ?? '', bill: r.billNo ?? '', store: l.name(r.storeId), total: r.total })).sort((a, b) => a.groupLabel.localeCompare(b.groupLabel)) };
    },
});

defineReport({
    key: 'inv_consumption',
    category: 'Inventory',
    label: 'Consumption by item',
    description: 'How much of each item went out (issued, sold, written off) in a period, and its value.',
    permissions: ['inventory.view', 'inventory.store'],
    orientation: 'portrait',
    filters: range,
    columns: [
        { key: 'name', label: 'Item', type: 'text', width: 1.8 },
        { key: 'issued', label: 'Issued', type: 'number', width: 0.6 },
        { key: 'sold', label: 'Sold', type: 'number', width: 0.6 },
        { key: 'lost', label: 'Written off', type: 'number', width: 0.6 },
        { key: 'value', label: 'Value', type: 'money', width: 0.8, total: true },
    ],
    async run(f) {
        const moves = await db.invMove.findMany({ where: { kind: { in: ['issue', 'return', 'sale', 'sale_cancel', 'writeoff'] }, at: between(f) }, include: { item: { select: { name: true, unitId: true } } } });
        const l = await lookups();
        const by = new Map<string, { name: string; issued: number; sold: number; lost: number; value: number }>();
        for (const m of moves) {
            const r = by.get(m.itemId) ?? { name: `${m.item.name} (${l.name(m.item.unitId)})`, issued: 0, sold: 0, lost: 0, value: 0 };
            if (m.kind === 'issue' || m.kind === 'return') r.issued -= m.qty;
            else if (m.kind === 'writeoff') r.lost -= m.qty;
            else r.sold -= m.qty;
            r.value -= m.qty * m.rate;
            by.set(m.itemId, r);
        }
        return { subtitle: `${f.from} – ${f.to}`, rows: Array.from(by.values()).map((r) => ({ ...r, value: r2(r.value) })).sort((a, b) => b.value - a.value) };
    },
});

defineReport({
    key: 'inv_expiring',
    category: 'Inventory',
    label: 'Expiring and expired stock',
    description: 'Batches expiring within a number of days (or already expired).',
    permissions: ['inventory.view', 'inventory.store'],
    orientation: 'portrait',
    filters: [{ key: 'days', label: 'Within', type: 'select', default: '60', options: [{ value: '30', label: '30 days' }, { value: '60', label: '60 days' }, { value: '90', label: '90 days' }, { value: '365', label: 'A year' }] }],
    columns: [
        { key: 'item', label: 'Item', type: 'text', width: 1.6 },
        { key: 'store', label: 'Store', type: 'text', width: 1 },
        { key: 'batchNo', label: 'Batch', type: 'text', width: 0.7 },
        { key: 'expiryOn', label: 'Expires', type: 'date', width: 0.7 },
        { key: 'qty', label: 'Qty', type: 'number', width: 0.5 },
    ],
    async run(f) {
        return { rows: (await expiring(Number(f.days || 60))).map((b) => ({ ...b, item: `${b.item}${b.expired ? ' (EXPIRED)' : ''}`, batchNo: b.batchNo ?? '' })) };
    },
});

defineReport({
    key: 'inv_adjustments',
    category: 'Inventory',
    label: 'Write-offs and count differences',
    description: 'Stock written off (damaged, expired, lost) and count adjustments in a period.',
    permissions: ['inventory.view', 'inventory.approve'],
    orientation: 'landscape',
    filters: range,
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 0.7 },
        { key: 'item', label: 'Item', type: 'text', width: 1.6 },
        { key: 'store', label: 'Store', type: 'text', width: 0.9 },
        { key: 'reason', label: 'Reason', type: 'text', width: 0.8 },
        { key: 'qty', label: 'Qty', type: 'number', width: 0.5 },
        { key: 'value', label: 'Value', type: 'money', width: 0.7, total: true },
        { key: 'status', label: 'Status', type: 'text', width: 0.7 },
    ],
    async run(f) {
        const rows = await db.invAdjustment.findMany({ where: { createdAt: between(f) }, orderBy: { createdAt: 'asc' } });
        const [l, items] = await Promise.all([lookups(), db.invItem.findMany({ where: { id: { in: rows.map((r) => r.itemId) } }, select: { id: true, name: true, avgCost: true } })]);
        const S: Record<string, string> = { pending: 'Waiting', approved: 'Approved', rejected: 'Refused' };
        return { subtitle: `${f.from} – ${f.to}`, rows: rows.map((r) => { const i = items.find((x) => x.id === r.itemId); return { date: isoOf(r.createdAt), item: i?.name ?? '', store: l.name(r.storeId), reason: r.reason === 'count' ? 'Count' : r.reason, qty: r.qty, value: r2(r.qty * (i?.avgCost ?? 0)), status: S[r.status] ?? r.status }; }) };
    },
});

defineReport({
    key: 'inv_sales',
    category: 'Inventory',
    label: 'Sales to students',
    description: 'Uniforms, diaries… sold in a period, paid at the counter or added to the fees.',
    permissions: ['inventory.view', 'inventory.sell'],
    orientation: 'landscape',
    about: 'student',
    filters: [...range, { key: 'pay', label: 'Paid', type: 'select', default: '', options: [{ value: '', label: 'All' }, { value: 'fees', label: 'With the fees' }, { value: 'counter', label: 'At the counter' }] }],
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 0.7 },
        { key: 'number', label: 'Sale no.', type: 'text', width: 0.7 },
        { key: 'student', label: 'Student', type: 'text', width: 1.5 },
        { key: 'admissionNo', label: 'Adm. no.', type: 'text', width: 0.8 },
        { key: 'items', label: 'Items', type: 'text', width: 2 },
        { key: 'pay', label: 'Paid', type: 'text', width: 0.7 },
        { key: 'total', label: 'Amount', type: 'money', width: 0.7, total: true },
    ],
    async run(f) {
        const sales = await db.invSale.findMany({ where: { at: between(f), status: 'active', ...(f.pay ? { payAt: f.pay } : {}) }, orderBy: { at: 'asc' }, include: { lines: true } });
        const [st, items] = await Promise.all([db.student.findMany({ where: { id: { in: sales.map((s) => s.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } }), db.invItem.findMany({ where: { id: { in: sales.flatMap((s) => s.lines.map((x) => x.itemId)) } }, select: { id: true, name: true } })]);
        return { subtitle: `${f.from} – ${f.to}`, rows: sales.map((s) => { const x = st.find((y) => y.id === s.studentId); return { studentId: s.studentId, date: isoOf(s.at), number: s.number, student: x ? fullName(x) : '', admissionNo: x?.admissionNo ?? '', items: s.lines.map((l) => `${items.find((i) => i.id === l.itemId)?.name ?? ''} × ${l.qty}`).join(', '), pay: s.payAt === 'fees' ? 'Fees' : `Counter${s.mode ? ` (${s.mode})` : ''}`, total: s.total }; }) };
    },
});

defineWidget({
    key: 'inventory_status',
    label: 'Store',
    description: 'Items low in stock, requests to issue, and things waiting for approval.',
    category: 'Today',
    type: 'stat',
    size: 'sm',
    href: '/inventory/issue',
    permissions: ['inventory.store', 'inventory.approve'],
    cacheSeconds: 300,
    async load({ permissions }) {
        const [low, toIssue, pending, adj, pos] = await Promise.all([lowStock(), db.invRequest.count({ where: { status: { in: ['approved', 'partly'] } } }), db.invRequest.count({ where: { status: 'pending' } }), db.invAdjustment.count({ where: { status: 'pending' } }), db.invPurchaseOrder.count({ where: { status: 'pending' } })]);
        const waiting = pending + adj + pos;
        return { value: toIssue, caption: 'requests to issue', tone: low.length || (permissions['inventory.approve'] && waiting) ? 'warn' : 'neutral', sub: [{ label: 'Low in stock', value: low.length, tone: low.length ? 'warn' : undefined }, ...(permissions['inventory.approve'] ? [{ label: 'Waiting for your approval', value: waiting, tone: waiting ? ('warn' as const) : undefined }] : [])] };
    },
});


defineDefaultLayout('storekeeper', ['inventory_status', 'my_checkin', 'approvals', 'my_leave', 'notices_latest', 'upcoming_events']);
