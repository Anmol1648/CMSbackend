import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { dayDate, isoOf } from '../attendance/attendance.settings';
import { defineReport, registerReportCategory } from '../reports/reports.registry';
import { defineWidget } from '../dashboard/dashboard.registry';
import { desk, myComplaints } from './complaints.service';

/** Complaint reports (Report Center) and dashboard widgets. */

registerReportCategory('Complaints', 50);

const range = [
    { key: 'from', label: 'From', type: 'date' as const, required: true, default: 'monthStart' },
    { key: 'to', label: 'To', type: 'date' as const, required: true, default: 'today' },
];
const raised = (f: Record<string, string>) => {
    if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
    return { gte: dayDate(f.from), lt: new Date(dayDate(f.to).getTime() + 86_400_000) };
};
const hours = (a: Date, b: Date) => Math.round(((b.getTime() - a.getTime()) / 3_600_000) * 10) / 10;
const avg = (l: number[]) => (l.length ? Math.round((l.reduce((x, y) => x + y, 0) / l.length) * 10) / 10 : null);
const OPEN = ['new', 'assigned', 'in_progress', 'reopened'];
const STATUS: Record<string, string> = { new: 'New', assigned: 'Assigned', in_progress: 'In progress', reopened: 'Reopened', resolved: 'Resolved', closed: 'Closed' };

defineReport({
    key: 'complaints_by_category',
    category: 'Complaints',
    label: 'Complaints by category',
    description: 'Complaints raised in a period by category: how many, still open, resolved, average reply and resolve time, and rating.',
    permissions: ['complaint.manage'],
    orientation: 'landscape',
    filters: range,
    columns: [
        { key: 'category', label: 'Category', type: 'text', width: 1.6 },
        { key: 'raised', label: 'Raised', type: 'number', width: 0.6, total: true },
        { key: 'open', label: 'Open', type: 'number', width: 0.6, total: true },
        { key: 'done', label: 'Resolved / closed', type: 'number', width: 0.8, total: true },
        { key: 'overdue', label: 'Overdue', type: 'number', width: 0.6, total: true },
        { key: 'reply', label: 'Avg. reply (h)', type: 'number', width: 0.7 },
        { key: 'resolve', label: 'Avg. resolve (h)', type: 'number', width: 0.7 },
        { key: 'rating', label: 'Avg. rating', type: 'number', width: 0.6 },
    ],
    async run(f) {
        const rows = await db.complaint.findMany({ where: { createdAt: raised(f) } });
        const cats = await db.masterValue.findMany({ where: { master: 'complaint_category' }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } });
        const now = Date.now();
        return {
            subtitle: `${f.from} – ${f.to}`,
            rows: cats
                .map((c) => {
                    const mine = rows.filter((r) => r.categoryId === c.id);
                    return {
                        category: c.name,
                        raised: mine.length,
                        open: mine.filter((r) => OPEN.includes(r.status)).length,
                        done: mine.filter((r) => !OPEN.includes(r.status)).length,
                        overdue: mine.filter((r) => OPEN.includes(r.status) && ((!r.firstResponseAt && r.respondBy && r.respondBy.getTime() < now) || (r.resolveBy && r.resolveBy.getTime() < now))).length,
                        reply: avg(mine.filter((r) => r.firstResponseAt).map((r) => hours(r.createdAt, r.firstResponseAt!))),
                        resolve: avg(mine.filter((r) => r.resolvedAt).map((r) => hours(r.createdAt, r.resolvedAt!))),
                        rating: avg(mine.filter((r) => r.rating).map((r) => r.rating!)),
                    };
                })
                .filter((r) => r.raised),
        };
    },
});

defineReport({
    key: 'complaints_by_handler',
    category: 'Complaints',
    label: 'Complaints by handler',
    description: 'For each handler: complaints assigned in a period, resolved, overdue, escalated, average times and rating.',
    permissions: ['complaint.manage'],
    orientation: 'landscape',
    filters: range,
    columns: [
        { key: 'handler', label: 'Handler', type: 'text', width: 1.6 },
        { key: 'assigned', label: 'Assigned', type: 'number', width: 0.7, total: true },
        { key: 'resolved', label: 'Resolved', type: 'number', width: 0.7, total: true },
        { key: 'overdue', label: 'Overdue now', type: 'number', width: 0.7, total: true },
        { key: 'escalated', label: 'Escalated', type: 'number', width: 0.7, total: true },
        { key: 'reply', label: 'Avg. reply (h)', type: 'number', width: 0.7 },
        { key: 'resolve', label: 'Avg. resolve (h)', type: 'number', width: 0.7 },
        { key: 'rating', label: 'Avg. rating', type: 'number', width: 0.6 },
    ],
    async run(f) {
        const rows = await db.complaint.findMany({ where: { createdAt: raised(f), assignedTo: { not: null } } });
        const users = await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.assignedTo!))] } }, select: { id: true, displayName: true } });
        const now = Date.now();
        return {
            subtitle: `${f.from} – ${f.to}`,
            rows: users
                .map((u) => {
                    const mine = rows.filter((r) => r.assignedTo === u.id);
                    return { handler: u.displayName, assigned: mine.length, resolved: mine.filter((r) => r.resolvedAt || r.status === 'closed').length, overdue: mine.filter((r) => OPEN.includes(r.status) && ((!r.firstResponseAt && r.respondBy && r.respondBy.getTime() < now) || (r.resolveBy && r.resolveBy.getTime() < now))).length, escalated: mine.filter((r) => r.escalation > 0).length, reply: avg(mine.filter((r) => r.firstResponseAt).map((r) => hours(r.createdAt, r.firstResponseAt!))), resolve: avg(mine.filter((r) => r.resolvedAt).map((r) => hours(r.createdAt, r.resolvedAt!))), rating: avg(mine.filter((r) => r.rating).map((r) => r.rating!)) };
                })
                .sort((a, b) => b.assigned - a.assigned),
        };
    },
});

defineReport({
    key: 'complaints_register',
    category: 'Complaints',
    label: 'Complaint register',
    description: 'Every complaint raised in a period: ticket, category, priority, status, handler, dates and rating (anonymous complainants stay hidden).',
    permissions: ['complaint.manage'],
    orientation: 'landscape',
    filters: [...range, { key: 'status', label: 'Status', type: 'select', default: '', options: [{ value: '', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'resolved', label: 'Resolved' }, { value: 'closed', label: 'Closed' }, { value: 'overdue', label: 'Overdue' }] }],
    columns: [
        { key: 'ticket', label: 'Ticket', type: 'text', width: 0.9 },
        { key: 'date', label: 'Raised', type: 'date', width: 0.7 },
        { key: 'category', label: 'Category', type: 'text', width: 1.1 },
        { key: 'subject', label: 'Subject', type: 'text', width: 2 },
        { key: 'by', label: 'By', type: 'text', width: 1.1 },
        { key: 'priority', label: 'Priority', type: 'text', width: 0.6 },
        { key: 'status', label: 'Status', type: 'text', width: 0.7 },
        { key: 'handler', label: 'Handler', type: 'text', width: 1 },
        { key: 'rating', label: 'Rating', type: 'number', width: 0.5 },
    ],
    async run(f) {
        const now = new Date();
        const rows = await db.complaint.findMany({ where: { createdAt: raised(f), ...(f.status === 'open' ? { status: { in: OPEN } } : f.status === 'resolved' ? { status: 'resolved' } : f.status === 'closed' ? { status: 'closed' } : f.status === 'overdue' ? { status: { in: OPEN }, OR: [{ firstResponseAt: null, respondBy: { lt: now } }, { resolveBy: { lt: now } }] } : {}) }, orderBy: { createdAt: 'asc' } });
        const [cats, users] = await Promise.all([db.masterValue.findMany({ where: { master: 'complaint_category' }, select: { id: true, name: true } }), db.user.findMany({ where: { id: { in: [...rows.map((r) => r.assignedTo!), ...rows.map((r) => r.raisedBy!)].filter(Boolean) } }, select: { id: true, displayName: true } })]);
        const name = (id: string | null) => users.find((u) => u.id === id)?.displayName ?? '';
        return { subtitle: `${f.from} – ${f.to}`, rows: rows.map((r) => ({ ticket: r.ticketNo, date: isoOf(new Date(r.createdAt.getTime() + 5.5 * 3_600_000)), category: cats.find((c) => c.id === r.categoryId)?.name ?? '', subject: r.subject, by: r.anonymous ? 'Anonymous' : r.raisedAs === 'office' ? `${r.contactName ?? ''} (office)` : name(r.raisedBy), priority: r.priority, status: STATUS[r.status] ?? r.status, handler: name(r.assignedTo), rating: r.rating })) };
    },
});

// ─── Widgets ─────────────────────────────────────────────────────────────────

defineWidget({
    key: 'complaints_desk',
    label: 'Complaints',
    description: 'Open complaints (all, for those who manage; assigned to me, for handlers) and how many are overdue.',
    category: 'Today',
    type: 'stat',
    size: 'sm',
    href: '/complaints',
    permissions: ['complaint.handle', 'complaint.manage'],
    cacheSeconds: 120,
    async load({ userId }) {
        const d = await desk({ show: 'open', page: 1, pageSize: 5 }, userId);
        if (!d.manage && !d.counts.open && !d.counts.resolved) return { hidden: true, value: '' };
        return { value: d.counts.open, caption: d.manage ? 'open complaints' : 'open, assigned to you', tone: d.counts.overdue ? 'bad' : d.counts.open ? 'warn' : 'good', sub: [{ label: 'Overdue', value: d.counts.overdue, tone: d.counts.overdue ? 'bad' : undefined }, { label: 'Resolved, waiting to close', value: d.counts.resolved }] };
    },
});

defineWidget({
    key: 'my_complaints',
    label: 'My complaints',
    description: 'A parent’s, student’s or staff member’s complaints that aren’t closed.',
    category: 'Today',
    type: 'list',
    size: 'md',
    href: '/my-complaints',
    permissions: ['complaint.raise'],
    cacheSeconds: 120,
    async load({ userId }) {
        const rows = (await myComplaints(userId)).filter((r) => r.status !== 'closed');
        if (!rows.length) return { hidden: true, items: [], empty: '' };
        return { items: rows.slice(0, 5).map((r) => ({ title: r.subject, sub: `${r.ticketNo} · ${STATUS[r.status] ?? r.status}`, tone: (r.status === 'resolved' ? 'good' : 'neutral') as 'good' | 'neutral', href: '/my-complaints' })), empty: '' };
    },
});
