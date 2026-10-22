import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { scopeWhere as studentScope, fullName } from '../students/students.service';
import { defineDataSource, isoDay } from '../reports/datasources.registry';
import { duesReport } from './fee-reports.service';
import { feeViewer } from './fee.reports';
import { modeNames } from './payment-modes';

/** Fee data for the Report Builder: each student's dues, and every receipt. */

defineDataSource({
    key: 'fee_dues',
    label: 'Fee dues (per student)',
    description: 'Each student’s fees for the session: total, paid, balance, overdue, late fine and since when.',
    category: 'Fees',
    permissions: ['fee.view', 'fee.reports'],
    params: [
        { key: 'year', label: 'Session', type: 'year', required: true, default: 'current' },
        { key: 'asOf', label: 'Dues as on', type: 'date', default: 'today' },
    ],
    fields: [
        { key: 'admissionNo', label: 'Admission no.', type: 'text' },
        { key: 'student', label: 'Student', type: 'text' },
        { key: 'section', label: 'Class and section', type: 'text' },
        { key: 'roll', label: 'Roll no.', type: 'number' },
        { key: 'status', label: 'Student status', type: 'text' },
        { key: 'parent', label: 'Parent', type: 'text' },
        { key: 'mobile', label: 'Parent’s mobile', type: 'text' },
        { key: 'net', label: 'Fees for the session', type: 'money', group: 'Amounts' },
        { key: 'paid', label: 'Paid', type: 'money', group: 'Amounts' },
        { key: 'balance', label: 'Balance', type: 'money', group: 'Amounts' },
        { key: 'overdue', label: 'Overdue', type: 'money', group: 'Amounts' },
        { key: 'fine', label: 'Late fine', type: 'money', group: 'Amounts' },
        { key: 'overdueSince', label: 'Overdue since', type: 'date', group: 'Amounts' },
        { key: 'overdueInstalments', label: 'Overdue instalments', type: 'text', group: 'Amounts' },
        { key: 'defaulter', label: 'Defaulter (has overdue)', type: 'boolean', group: 'Amounts' },
    ],
    async load(p, ctx) {
        const r = await duesReport({ year: p.year, asOf: p.asOf, show: 'everyone' }, await feeViewer(ctx.userId));
        return r.students.map((s) => ({
            admissionNo: s.admissionNo,
            student: s.name,
            section: s.section,
            roll: s.roll,
            status: s.status.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
            parent: s.parent?.name ?? null,
            mobile: s.parent?.mobile ?? null,
            net: s.net,
            paid: s.paid,
            balance: s.balance,
            overdue: s.overdue,
            fine: s.fine,
            overdueSince: s.overdueSince,
            overdueInstalments: s.overdueInstalments.join(', ') || null,
            defaulter: s.overdue > 0,
        }));
    },
});

defineDataSource({
    key: 'fee_receipts',
    label: 'Fee receipts',
    description: 'Every receipt in a period, active or cancelled: student, class, mode, reference, amount and who took it.',
    category: 'Fees',
    permissions: ['fee.reports'],
    params: [
        { key: 'from', label: 'From', type: 'date', required: true, default: 'monthStart' },
        { key: 'to', label: 'To', type: 'date', required: true, default: 'today' },
    ],
    fields: [
        { key: 'date', label: 'Date', type: 'date' },
        { key: 'receiptNo', label: 'Receipt no.', type: 'text' },
        { key: 'student', label: 'Student', type: 'text' },
        { key: 'admissionNo', label: 'Admission no.', type: 'text' },
        { key: 'className', label: 'Class', type: 'text' },
        { key: 'section', label: 'Class and section', type: 'text' },
        { key: 'session', label: 'Session', type: 'text' },
        { key: 'mode', label: 'Mode', type: 'text', group: 'Payment' },
        { key: 'reference', label: 'Reference (cheque / UPI no.)', type: 'text', group: 'Payment' },
        { key: 'bankName', label: 'Bank', type: 'text', group: 'Payment' },
        { key: 'amount', label: 'Amount', type: 'money', group: 'Payment' },
        { key: 'online', label: 'Paid online', type: 'boolean', group: 'Payment' },
        { key: 'collectedBy', label: 'Collected by', type: 'text', group: 'Payment' },
        { key: 'note', label: 'Note', type: 'text', group: 'Payment' },
        { key: 'status', label: 'Status', type: 'text', group: 'Cancellation' },
        { key: 'cancelledOn', label: 'Cancelled on', type: 'date', group: 'Cancellation' },
        { key: 'cancelReason', label: 'Why cancelled', type: 'text', group: 'Cancellation' },
    ],
    async load(p, ctx) {
        if (p.from > p.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
        const viewer = await feeViewer(ctx.userId);
        const receipts = await db.feeReceipt.findMany({
            where: { date: { gte: new Date(`${p.from}T00:00:00Z`), lte: new Date(`${p.to}T00:00:00Z`) }, student: await studentScope({ userId: viewer.userId, scope: viewer.scope, sensitive: false }) },
            orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
            select: {
                date: true, receiptNo: true, mode: true, reference: true, bankName: true, amount: true, note: true, status: true, cancelledAt: true, cancelReason: true, onlinePaymentId: true, createdBy: true, studentId: true, academicYearId: true,
                student: { select: { admissionNo: true, firstName: true, middleName: true, lastName: true } },
                academicYear: { select: { name: true } },
            },
        });
        const enrolments = receipts.length
            ? await db.enrolment.findMany({
                  where: { studentId: { in: [...new Set(receipts.map((r) => r.studentId))] }, academicYearId: { in: [...new Set(receipts.map((r) => r.academicYearId))] } },
                  select: { studentId: true, academicYearId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } },
              })
            : [];
        const sectionOf = new Map(enrolments.map((e) => [`${e.studentId}|${e.academicYearId}`, e.section]));
        const modeName = await modeNames();
        const users = new Map((await db.user.findMany({ where: { id: { in: [...new Set(receipts.map((r) => r.createdBy).filter((x): x is string => !!x))] } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
        return receipts.map((r) => {
            const sec = sectionOf.get(`${r.studentId}|${r.academicYearId}`);
            return {
                date: isoDay(r.date),
                receiptNo: r.receiptNo,
                student: fullName(r.student),
                admissionNo: r.student.admissionNo,
                className: sec?.schoolClass.name ?? null,
                section: sec ? `${sec.schoolClass.shortName ?? sec.schoolClass.name}-${sec.name}` : null,
                session: r.academicYear.name,
                mode: modeName(r.mode),
                reference: r.reference,
                bankName: r.bankName,
                amount: r.amount,
                online: !!r.onlinePaymentId,
                collectedBy: r.onlinePaymentId ? 'Online payment' : ((r.createdBy && users.get(r.createdBy)) ?? null),
                note: r.note,
                status: r.status === 'active' ? 'Active' : 'Cancelled',
                cancelledOn: isoDay(r.cancelledAt),
                cancelReason: r.cancelReason,
            };
        });
    },
});
