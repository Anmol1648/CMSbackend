import type { DataScope } from '@prisma/client';
import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { getUserAccess } from '../rbac/access.service';
import { scopeWhere as studentScope, fullName } from '../students/students.service';
import { defineReport } from '../reports/reports.registry';
import { classSummary, collectionReport, duesReport } from './fee-reports.service';
import { modeNames } from './payment-modes';
import type { Viewer } from './receipts.service';

/** Fee reports in the Report Center. */

/** Whose fees the person may see (fee.view's scope; people who only collect or see reports: everyone). */
export const feeViewer = async (userId: string): Promise<Viewer> => {
    const access = await getUserAccess(userId);
    const scope = (access.permissions['fee.view'] ?? (access.permissions['fee.collect'] || access.permissions['fee.reports'] ? 'all' : 'own')) as DataScope;
    return { userId, scope };
};

const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const period = (f: Record<string, string>) => {
    if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
    return f.from === f.to ? day(f.from) : `${day(f.from)} – ${day(f.to)}`;
};
const className = async (id?: string) => (id ? ((await db.schoolClass.findUnique({ where: { id }, select: { name: true } }))?.name ?? null) : null);
const sectionName = async (id?: string) => {
    if (!id) return null;
    const s = await db.section.findUnique({ where: { id }, select: { name: true, schoolClass: { select: { name: true } } } });
    return s ? `${s.schoolClass.name} – ${s.name}` : null;
};
const yearName = async (id?: string) => (id ? ((await db.academicYear.findUnique({ where: { id }, select: { name: true } }))?.name ?? null) : null);
const words = (parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ');


// ─── Collection register ─────────────────────────────────────────────────────

defineReport({
    key: 'fee_collection_register',
    category: 'Fees',
    label: 'Fee collection register',
    description: 'Every receipt in a period: student, class, mode and who took it, with subtotals by day, class, mode or collector and the grand total.',
    permissions: ['fee.reports'],
    orientation: 'landscape',
    jasper: 'fee-collection-register.jrxml',
    filters: [
        { key: 'from', label: 'From', type: 'date', required: true, default: 'monthStart' },
        { key: 'to', label: 'To', type: 'date', required: true, default: 'today' },
        {
            key: 'groupBy',
            label: 'Subtotals by',
            type: 'select',
            default: 'date',
            options: [
                { value: 'date', label: 'Day' },
                { value: 'class', label: 'Class' },
                { value: 'mode', label: 'Payment mode' },
                { value: 'collector', label: 'Collected by' },
                { value: 'none', label: 'No subtotals' },
            ],
        },
        { key: 'mode', label: 'Payment mode', type: 'master', master: 'payment_mode' },
        { key: 'class', label: 'Class', type: 'class' },
    ],
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 0.9 },
        { key: 'receiptNo', label: 'Receipt no.', type: 'text', width: 1.2 },
        { key: 'student', label: 'Student', type: 'text', width: 2 },
        { key: 'admissionNo', label: 'Adm. no.', type: 'text', width: 0.9 },
        { key: 'className', label: 'Class', type: 'text', width: 0.8 },
        { key: 'mode', label: 'Mode', type: 'text', width: 1 },
        { key: 'reference', label: 'Reference', type: 'text', width: 1.2 },
        { key: 'collectedBy', label: 'Collected by', type: 'text', width: 1.3 },
        { key: 'amount', label: 'Amount', type: 'money', width: 1, total: true },
    ],
    async run(f, ctx) {
        const subtitle = period(f);
        const viewer = await feeViewer(ctx.userId);
        const scope = await studentScope({ userId: viewer.userId, scope: viewer.scope, sensitive: false });
        const receipts = await db.feeReceipt.findMany({
            where: { status: 'active', date: { gte: new Date(`${f.from}T00:00:00Z`), lte: new Date(`${f.to}T00:00:00Z`) }, student: scope, ...(f.mode ? { mode: f.mode.toLowerCase() } : {}) },
            select: {
                receiptNo: true,
                date: true,
                mode: true,
                reference: true,
                amount: true,
                createdBy: true,
                onlinePaymentId: true,
                academicYearId: true,
                student: { select: { id: true, admissionNo: true, firstName: true, middleName: true, lastName: true } },
            },
            orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
        });
        const enrolments = receipts.length
            ? await db.enrolment.findMany({
                  where: { studentId: { in: [...new Set(receipts.map((r) => r.student.id))] }, academicYearId: { in: [...new Set(receipts.map((r) => r.academicYearId))] } },
                  select: { studentId: true, academicYearId: true, section: { select: { name: true, sortOrder: true, schoolClass: { select: { id: true, name: true, shortName: true, sortOrder: true } } } } },
              })
            : [];
        const enrolOf = new Map(enrolments.map((e) => [`${e.studentId}|${e.academicYearId}`, e.section]));
        const users = new Map((await db.user.findMany({ where: { id: { in: [...new Set(receipts.map((r) => r.createdBy).filter((x): x is string => !!x))] } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
        const modeName = await modeNames();
        const rows = receipts
            .map((r) => {
                const sec = enrolOf.get(`${r.student.id}|${r.academicYearId}`);
                const collectedBy = r.onlinePaymentId ? 'Online payment' : ((r.createdBy && users.get(r.createdBy)) ?? '—');
                const date = r.date.toISOString().slice(0, 10);
                const mode = modeName(r.mode);
                const cls = sec ? `${sec.schoolClass.shortName ?? sec.schoolClass.name}-${sec.name}` : '—';
                const group =
                    f.groupBy === 'date' ? { groupKey: date, groupLabel: day(date) }
                    : f.groupBy === 'class' ? { groupKey: sec ? String(sec.schoolClass.sortOrder).padStart(4, '0') : '9999', groupLabel: sec ? sec.schoolClass.name : 'No class' }
                    : f.groupBy === 'mode' ? { groupKey: mode, groupLabel: mode }
                    : f.groupBy === 'collector' ? { groupKey: collectedBy, groupLabel: collectedBy }
                    : { groupKey: '', groupLabel: null };
                return { date, receiptNo: r.receiptNo, student: fullName(r.student), admissionNo: r.student.admissionNo, className: cls, mode, reference: r.reference ?? '', collectedBy, amount: r.amount, classId: sec?.schoolClass.id ?? null, ...group };
            })
            .filter((r) => !f.class || r.classId === f.class)
            .sort((a, b) => a.groupKey.localeCompare(b.groupKey) || a.date.localeCompare(b.date) || a.receiptNo.localeCompare(b.receiptNo))
            .map(({ classId: _c, ...r }) => r);
        const grouped = { date: 'Day', class: 'Class', mode: 'Payment mode', collector: 'Collected by' }[f.groupBy as 'date'] ?? null;
        return { rows, subtitle: words([subtitle, f.mode && modeName(f.mode), await className(f.class)]), groupedBy: grouped };
    },
});

// ─── Defaulters ──────────────────────────────────────────────────────────────

defineReport({
    key: 'fee_defaulters',
    category: 'Fees',
    label: 'Fee defaulters',
    description: 'Students with fees overdue (or anything left to pay), section by section, with the parent’s number, what is overdue and since when.',
    permissions: ['fee.view', 'fee.reports'],
    orientation: 'landscape',
    jasper: 'fee-defaulters.jrxml',
    filters: [
        { key: 'year', label: 'Session', type: 'year', required: true, default: 'current' },
        { key: 'class', label: 'Class', type: 'class' },
        { key: 'section', label: 'Section', type: 'section' },
        {
            key: 'show',
            label: 'Show',
            type: 'select',
            default: 'overdue',
            options: [
                { value: 'overdue', label: 'Overdue only (defaulters)' },
                { value: 'all', label: 'Anything left to pay' },
            ],
        },
        { key: 'asOf', label: 'As on', type: 'date', default: 'today' },
    ],
    columns: [
        { key: 'roll', label: 'Roll', type: 'number', width: 0.45 },
        { key: 'student', label: 'Student', type: 'text', width: 1.8 },
        { key: 'admissionNo', label: 'Adm. no.', type: 'text', width: 0.9 },
        { key: 'parent', label: 'Parent', type: 'text', width: 1.5 },
        { key: 'mobile', label: 'Mobile', type: 'text', width: 1 },
        { key: 'overdueInstalments', label: 'Overdue instalments', type: 'text', width: 1.8 },
        { key: 'overdueSince', label: 'Since', type: 'date', width: 0.85 },
        { key: 'overdue', label: 'Overdue', type: 'money', width: 0.9, total: true },
        { key: 'fine', label: 'Late fine', type: 'money', width: 0.8, total: true },
        { key: 'balance', label: 'Balance (year)', type: 'money', width: 1, total: true },
    ],
    async run(f, ctx) {
        const r = await duesReport({ year: f.year, class: f.class, section: f.section, asOf: f.asOf, show: (f.show as 'overdue' | 'all') ?? 'overdue' }, await feeViewer(ctx.userId));
        let order = 0;
        let last = '';
        const rows = r.students.map((s) => {
            if (s.section !== last) {
                order++;
                last = s.section;
            }
            return {
                roll: s.roll,
                student: s.name,
                admissionNo: s.admissionNo,
                parent: s.parent?.name ?? '',
                mobile: s.parent?.mobile ?? '',
                overdueInstalments: s.overdueInstalments.join(', '),
                overdueSince: s.overdueSince,
                overdue: s.overdue,
                fine: s.fine,
                balance: s.balance,
                groupKey: String(order).padStart(4, '0'),
                groupLabel: s.section,
            };
        });
        return {
            rows,
            subtitle: words([await yearName(r.academicYearId), (await sectionName(f.section)) ?? (await className(f.class)), `as on ${day(r.asOf)}`, f.show === 'all' ? 'anything left to pay' : 'overdue only']),
            groupedBy: 'Section',
        };
    },
});

// ─── Class summary ───────────────────────────────────────────────────────────

defineReport({
    key: 'fee_class_summary',
    category: 'Fees',
    label: 'Fee summary by class',
    description: 'For each class: fees for the year, collected, balance, overdue and how many students are defaulters.',
    permissions: ['fee.reports'],
    orientation: 'portrait',
    filters: [{ key: 'year', label: 'Session', type: 'year', required: true, default: 'current' }],
    columns: [
        { key: 'className', label: 'Class', type: 'text', width: 1.2 },
        { key: 'students', label: 'Students', type: 'number', width: 0.8, total: true },
        { key: 'net', label: 'Fees (year)', type: 'money', width: 1.1, total: true },
        { key: 'paid', label: 'Collected', type: 'money', width: 1.1, total: true },
        { key: 'balance', label: 'Balance', type: 'money', width: 1.1, total: true },
        { key: 'overdue', label: 'Overdue', type: 'money', width: 1.1, total: true },
        { key: 'defaulters', label: 'Defaulters', type: 'number', width: 0.8, total: true },
    ],
    async run(f, ctx) {
        const r = await classSummary(f.year, await feeViewer(ctx.userId));
        return {
            rows: r.classes.map((c) => ({ className: c.name, students: c.students, net: c.net, paid: c.paid, balance: c.balance, overdue: c.overdue, defaulters: c.defaulters })),
            subtitle: (await yearName(r.academicYearId)) ?? '',
        };
    },
});

// ─── Collection by fee head and by day ───────────────────────────────────────

defineReport({
    key: 'fee_head_collection',
    category: 'Fees',
    label: 'Collection by fee head',
    description: 'How much of each fee head (tuition, transport, late fine…) was collected in a period.',
    permissions: ['fee.reports'],
    orientation: 'portrait',
    filters: [
        { key: 'from', label: 'From', type: 'date', required: true, default: 'monthStart' },
        { key: 'to', label: 'To', type: 'date', required: true, default: 'today' },
    ],
    columns: [
        { key: 'head', label: 'Fee head', type: 'text', width: 3 },
        { key: 'amount', label: 'Collected', type: 'money', width: 1.2, total: true },
    ],
    async run(f, ctx) {
        const subtitle = period(f);
        const r = await collectionReport({ from: f.from, to: f.to }, await feeViewer(ctx.userId));
        return { rows: r.byHead.map((h) => ({ head: h.name, amount: h.amount })), subtitle };
    },
});

defineReport({
    key: 'fee_daily_collection',
    category: 'Fees',
    label: 'Day-wise collection',
    description: 'Receipts and money collected on each day of a period (the day book).',
    permissions: ['fee.reports'],
    orientation: 'portrait',
    filters: [
        { key: 'from', label: 'From', type: 'date', required: true, default: 'monthStart' },
        { key: 'to', label: 'To', type: 'date', required: true, default: 'today' },
    ],
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 1.5 },
        { key: 'receipts', label: 'Receipts', type: 'number', width: 1, total: true },
        { key: 'amount', label: 'Collected', type: 'money', width: 1.5, total: true },
    ],
    async run(f, ctx) {
        const subtitle = period(f);
        const r = await collectionReport({ from: f.from, to: f.to }, await feeViewer(ctx.userId));
        return { rows: r.byDay.map((d) => ({ date: d.date, receipts: d.count, amount: d.amount })), subtitle };
    },
});
