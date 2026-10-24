import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { dayDate, isoOf } from '../attendance/attendance.settings';
import { defineReport, registerReportCategory } from '../reports/reports.registry';
import { defineWidget } from '../dashboard/dashboard.registry';
import { bookValue, careDue, pendingDisposals } from './assets.service';
import { ASSETS } from './assets.settings';

/** Asset reports (Report Center) and dashboard widgets. */

registerReportCategory('Assets', 58);

const names = async () => {
    const rows = await db.masterValue.findMany({ where: { master: { in: ['asset_category', 'asset_condition', 'asset_vendor', 'room'] } }, select: { id: true, name: true, extra: true } });
    return { name: (id: string | null) => (id ? (rows.find((r) => r.id === id)?.name ?? '') : ''), pct: (id: string | null) => Number(((rows.find((r) => r.id === id)?.extra ?? {}) as { depreciation?: number }).depreciation ?? 0) };
};
const STATUS: Record<string, string> = { in_use: 'In use', in_repair: 'In repair', disposed: 'Written off', lost: 'Lost' };
const range = [
    { key: 'from', label: 'From', type: 'date' as const, required: true, default: 'sessionStart' },
    { key: 'to', label: 'To', type: 'date' as const, required: true, default: 'today' },
];
const between = (f: Record<string, string>) => {
    if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
    return { gte: dayDate(f.from), lt: new Date(dayDate(f.to).getTime() + 86_400_000) };
};

defineReport({
    key: 'asset_register',
    category: 'Assets',
    label: 'Asset register',
    description: 'Every asset in use, grouped by room or category, with cost and present value.',
    permissions: ['asset.view', 'asset.manage'],
    orientation: 'landscape',
    filters: [
        { key: 'by', label: 'Group by', type: 'select', default: 'room', options: [{ value: 'room', label: 'Room' }, { value: 'category', label: 'Category' }] },
    ],
    columns: [
        { key: 'code', label: 'Code', type: 'text', width: 0.8 },
        { key: 'name', label: 'Asset', type: 'text', width: 1.8 },
        { key: 'other', label: 'Category / room', type: 'text', width: 1.1 },
        { key: 'serial', label: 'Make / serial', type: 'text', width: 1.2 },
        { key: 'quantity', label: 'Qty', type: 'number', width: 0.5, total: true },
        { key: 'condition', label: 'Condition', type: 'text', width: 0.8 },
        { key: 'purchased', label: 'Bought', type: 'date', width: 0.7 },
        { key: 'cost', label: 'Cost', type: 'money', width: 0.8, total: true },
        { key: 'value', label: 'Present value', type: 'money', width: 0.8, total: true },
    ],
    async run(f) {
        const [l, s, rows] = await Promise.all([names(), getSettings({ dep: ASSETS.depreciation }), db.asset.findMany({ where: { status: { in: ['in_use', 'in_repair'] } }, orderBy: { code: 'asc' } })]);
        const byRoom = f.by !== 'category';
        return {
            groupedBy: byRoom ? 'Room' : 'Category',
            rows: rows
                .map((a) => {
                    const g = byRoom ? a.roomId : a.categoryId;
                    return { groupKey: g ?? '-', groupLabel: l.name(g) || (byRoom ? 'No room' : 'No category'), code: a.code, name: a.name, other: byRoom ? l.name(a.categoryId) : l.name(a.roomId), serial: [a.make, a.model, a.serialNo].filter(Boolean).join(' · '), quantity: a.quantity, condition: l.name(a.conditionId), purchased: a.purchasedOn ? isoOf(a.purchasedOn) : '', cost: a.cost ?? 0, value: (s.dep ? bookValue(a.cost, a.purchasedOn, l.pct(a.categoryId)) : a.cost) ?? 0 };
                })
                .sort((a, b) => a.groupLabel.localeCompare(b.groupLabel) || a.code.localeCompare(b.code)),
        };
    },
});

defineReport({
    key: 'asset_value',
    category: 'Assets',
    label: 'Asset value by category',
    description: 'For each category: items, cost, depreciation so far and present value.',
    permissions: ['asset.view', 'asset.manage'],
    orientation: 'portrait',
    filters: [],
    columns: [
        { key: 'category', label: 'Category', type: 'text', width: 1.6 },
        { key: 'rate', label: '% / year', type: 'number', width: 0.6 },
        { key: 'entries', label: 'Entries', type: 'number', width: 0.6, total: true },
        { key: 'items', label: 'Items', type: 'number', width: 0.6, total: true },
        { key: 'cost', label: 'Cost', type: 'money', width: 0.9, total: true },
        { key: 'dep', label: 'Depreciation', type: 'money', width: 0.9, total: true },
        { key: 'value', label: 'Present value', type: 'money', width: 0.9, total: true },
    ],
    async run() {
        const [l, rows] = await Promise.all([names(), db.asset.findMany({ where: { status: { in: ['in_use', 'in_repair'] } } })]);
        const by = new Map<string, typeof rows>();
        for (const a of rows) by.set(a.categoryId ?? '-', [...(by.get(a.categoryId ?? '-') ?? []), a]);
        return {
            rows: Array.from(by.entries())
                .map(([cat, list]) => {
                    const id = cat === '-' ? null : cat;
                    const cost = list.reduce((s, a) => s + (a.cost ?? 0), 0);
                    const value = list.reduce((s, a) => s + (bookValue(a.cost, a.purchasedOn, l.pct(id)) ?? 0), 0);
                    return { category: l.name(id) || 'No category', rate: l.pct(id), entries: list.length, items: list.reduce((s, a) => s + a.quantity, 0), cost, dep: cost - value, value };
                })
                .sort((a, b) => b.cost - a.cost),
        };
    },
});

defineReport({
    key: 'asset_repairs',
    category: 'Assets',
    label: 'Repairs and maintenance cost',
    description: 'Problems reported and fixed, and maintenance done in a period, with the cost.',
    permissions: ['asset.view', 'asset.manage', 'asset.repair'],
    orientation: 'landscape',
    filters: range,
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 0.7 },
        { key: 'kind', label: 'Kind', type: 'text', width: 0.8 },
        { key: 'asset', label: 'Asset', type: 'text', width: 1.6 },
        { key: 'room', label: 'Room', type: 'text', width: 0.9 },
        { key: 'what', label: 'What', type: 'text', width: 2 },
        { key: 'status', label: 'Status', type: 'text', width: 0.7 },
        { key: 'cost', label: 'Cost', type: 'money', width: 0.7, total: true },
    ],
    async run(f) {
        const when = between(f);
        const [l, issues, maint] = await Promise.all([names(), db.assetIssue.findMany({ where: { createdAt: when }, include: { asset: { select: { code: true, name: true, roomId: true } } } }), db.assetEvent.findMany({ where: { kind: 'maintained', at: when }, include: { asset: { select: { code: true, name: true, roomId: true } } } })]);
        const IS: Record<string, string> = { open: 'Open', in_repair: 'In repair', fixed: 'Fixed', written_off: 'Written off' };
        return {
            subtitle: `${f.from} – ${f.to}`,
            rows: [
                ...issues.map((i) => ({ at: i.createdAt, date: isoOf(i.createdAt), kind: 'Repair', asset: `${i.asset.name} (${i.asset.code})`, room: l.name(i.asset.roomId), what: i.resolution ? `${i.title}: ${i.resolution}` : i.title, status: IS[i.status] ?? i.status, cost: i.cost ?? 0 })),
                ...maint.map((m) => ({ at: m.at, date: isoOf(m.at), kind: 'Maintenance', asset: `${m.asset.name} (${m.asset.code})`, room: l.name(m.asset.roomId), what: m.note ?? '', status: 'Done', cost: m.cost ?? 0 })),
            ]
                .sort((a, b) => a.at.getTime() - b.at.getTime())
                .map(({ at: _at, ...r }) => r),
        };
    },
});

defineReport({
    key: 'asset_staff',
    category: 'Assets',
    label: 'Assets with staff',
    description: 'Laptops, tablets… given to staff members, by person.',
    permissions: ['asset.view', 'asset.manage'],
    orientation: 'portrait',
    filters: [],
    columns: [
        { key: 'code', label: 'Code', type: 'text', width: 0.8 },
        { key: 'name', label: 'Asset', type: 'text', width: 1.8 },
        { key: 'serial', label: 'Serial no.', type: 'text', width: 1 },
        { key: 'condition', label: 'Condition', type: 'text', width: 0.8 },
        { key: 'cost', label: 'Cost', type: 'money', width: 0.8, total: true },
    ],
    async run() {
        const rows = await db.asset.findMany({ where: { staffId: { not: null }, status: { in: ['in_use', 'in_repair'] } }, orderBy: { code: 'asc' } });
        const [l, staff] = await Promise.all([names(), db.staff.findMany({ where: { id: { in: rows.map((r) => r.staffId!) } }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true } })]);
        const label = (id: string) => {
            const s = staff.find((x) => x.id === id);
            return s ? `${[s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ')} (${s.employeeCode})` : '';
        };
        return { groupedBy: 'Staff member', rows: rows.map((a) => ({ groupKey: a.staffId, groupLabel: label(a.staffId!), code: a.code, name: a.name, serial: a.serialNo ?? '', condition: l.name(a.conditionId), cost: a.cost ?? 0 })).sort((a, b) => a.groupLabel.localeCompare(b.groupLabel)) };
    },
});

defineReport({
    key: 'asset_disposed',
    category: 'Assets',
    label: 'Assets written off',
    description: 'Assets sold, scrapped, lost or donated in a period, with the amount received.',
    permissions: ['asset.view', 'asset.manage', 'asset.approve_disposal'],
    orientation: 'landscape',
    filters: range,
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 0.7 },
        { key: 'asset', label: 'Asset', type: 'text', width: 1.8 },
        { key: 'reason', label: 'Reason', type: 'text', width: 0.8 },
        { key: 'note', label: 'Note', type: 'text', width: 1.6 },
        { key: 'cost', label: 'Cost', type: 'money', width: 0.8, total: true },
        { key: 'amount', label: 'Received', type: 'money', width: 0.8, total: true },
    ],
    async run(f) {
        const rows = await db.assetDisposal.findMany({ where: { status: 'approved', answeredAt: between(f) }, orderBy: { answeredAt: 'asc' }, include: { asset: { select: { code: true, name: true, cost: true } } } });
        const R: Record<string, string> = { sold: 'Sold', scrapped: 'Scrapped', lost: 'Lost', donated: 'Donated' };
        return { subtitle: `${f.from} – ${f.to}`, rows: rows.map((d) => ({ date: isoOf(d.answeredAt ?? d.createdAt), asset: `${d.asset.name} (${d.asset.code})`, reason: R[d.reason] ?? d.reason, note: d.note ?? '', cost: d.asset.cost ?? 0, amount: d.amount ?? 0 })) };
    },
});

defineReport({
    key: 'asset_status',
    category: 'Assets',
    label: 'Assets by status and condition',
    description: 'Every asset with its status (in use, in repair, written off, lost) and condition.',
    permissions: ['asset.view', 'asset.manage'],
    orientation: 'landscape',
    filters: [{ key: 'status', label: 'Status', type: 'select', default: '', options: [{ value: '', label: 'All' }, ...Object.entries(STATUS).map(([value, label]) => ({ value, label }))] }],
    columns: [
        { key: 'code', label: 'Code', type: 'text', width: 0.8 },
        { key: 'name', label: 'Asset', type: 'text', width: 1.8 },
        { key: 'category', label: 'Category', type: 'text', width: 1 },
        { key: 'room', label: 'Room', type: 'text', width: 1 },
        { key: 'condition', label: 'Condition', type: 'text', width: 0.8 },
        { key: 'status', label: 'Status', type: 'text', width: 0.8 },
    ],
    async run(f) {
        const [l, rows] = await Promise.all([names(), db.asset.findMany({ where: f.status ? { status: f.status } : {}, orderBy: { code: 'asc' } })]);
        return { rows: rows.map((a) => ({ code: a.code, name: a.name, category: l.name(a.categoryId), room: l.name(a.roomId), condition: l.name(a.conditionId), status: STATUS[a.status] ?? a.status })) };
    },
});

defineWidget({
    key: 'assets_attention',
    label: 'Assets needing attention',
    description: 'Open problems, maintenance due, warranties ending and write-offs waiting for approval.',
    category: 'Today',
    type: 'stat',
    size: 'sm',
    href: '/assets/repairs',
    permissions: ['asset.manage', 'asset.repair', 'asset.approve_disposal'],
    cacheSeconds: 300,
    async load({ permissions }) {
        const [open, care, waiting] = await Promise.all([db.assetIssue.count({ where: { status: { in: ['open', 'in_repair'] } } }), careDue(), permissions['asset.approve_disposal'] ? pendingDisposals().then((p) => p.length) : Promise.resolve(0)]);
        const due = care.maintenance.length;
        return {
            value: open,
            caption: 'open asset problems',
            tone: open || waiting ? 'warn' : 'neutral',
            sub: [
                { label: 'Maintenance due', value: due, tone: care.maintenance.some((m) => m.overdue) ? 'bad' : undefined },
                { label: 'Warranty / AMC ending', value: care.warranty.length },
                ...(permissions['asset.approve_disposal'] ? [{ label: 'Write-offs to approve', value: waiting, tone: waiting ? ('warn' as const) : undefined }] : []),
            ],
        };
    },
});
