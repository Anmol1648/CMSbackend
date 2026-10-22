import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { staffName } from '../staff/staff.service';
import { defineReport, registerReportCategory } from '../reports/reports.registry';
import { defineDataSource, isoDay } from '../reports/datasources.registry';
import { dayDate, isoOf } from '../attendance/attendance.settings';
import { balancesOf, leaveYearOf } from './balances.service';

/** Staff leave reports (Report Center) and a data source (Report Builder). */

registerReportCategory('Staff Leave', 45);

const STATUS: Record<string, string> = { pending: 'Waiting', approved: 'Approved', rejected: 'Not approved', cancelled: 'Cancelled' };
const showDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const range = (f: Record<string, string>) => {
    if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
    return { gte: dayDate(f.from), lte: dayDate(f.to) };
};
const staffBits = { select: { id: true, employeeCode: true, firstName: true, middleName: true, lastName: true, joiningDate: true, staffTypeId: true, employmentTypeId: true, genderId: true, designation: { select: { name: true } }, department: { select: { name: true } } } } as const;

defineReport({
    key: 'leave_balances',
    category: 'Staff Leave',
    label: 'Leave balances',
    description: 'Each staff member’s leave of every type for the leave year: given, carried, adjusted, taken, waiting and left.',
    permissions: ['leave.view'],
    orientation: 'landscape',
    filters: [{ key: 'asOf', label: 'Balances as on', type: 'date', required: true, default: 'today' }],
    columns: [
        { key: 'type', label: 'Leave', type: 'text', width: 1.6 },
        { key: 'credited', label: 'Given', type: 'number', width: 0.7 },
        { key: 'carried', label: 'Carried', type: 'number', width: 0.7 },
        { key: 'adjusted', label: 'Adjusted', type: 'number', width: 0.7 },
        { key: 'earned', label: 'Comp-off earned', type: 'number', width: 0.8 },
        { key: 'taken', label: 'Taken', type: 'number', width: 0.7, total: true },
        { key: 'pending', label: 'Waiting', type: 'number', width: 0.7 },
        { key: 'balance', label: 'Left', type: 'number', width: 0.7 },
    ],
    async run(f) {
        const year = await leaveYearOf(f.asOf);
        const staff = await db.staff.findMany({ where: { status: 'working' }, ...staffBits, orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }] });
        const b = await balancesOf(staff, year, f.asOf);
        const rows = staff.flatMap((s) =>
            (b.get(s.id) ?? []).map((x) => ({
                groupKey: `${staffName(s)}|${s.id}`,
                groupLabel: `${staffName(s)}${s.employeeCode ? ` (${s.employeeCode})` : ''}${s.designation ? ` · ${s.designation.name}` : ''}`,
                type: x.name,
                credited: x.unlimited ? null : x.credited,
                carried: x.carried || null,
                adjusted: x.adjusted || null,
                earned: x.isCompOff ? x.earned : null,
                taken: x.taken,
                pending: x.pending || null,
                balance: x.unlimited ? null : x.balance,
            }))
        );
        return { rows, subtitle: `Leave year ${year.name} · as on ${showDay(f.asOf)}`, groupedBy: 'Staff member' };
    },
});

defineReport({
    key: 'leave_register',
    category: 'Staff Leave',
    label: 'Leave register',
    description: 'Every leave in a period: who, which leave, the dates, days, without-pay days, status and who approved it.',
    permissions: ['leave.view'],
    orientation: 'landscape',
    filters: [
        { key: 'from', label: 'From', type: 'date', required: true, default: 'monthStart' },
        { key: 'to', label: 'To', type: 'date', required: true, default: 'today' },
        {
            key: 'status',
            label: 'Status',
            type: 'select',
            default: 'approved',
            options: [
                { value: '', label: 'All' },
                { value: 'approved', label: 'Approved' },
                { value: 'pending', label: 'Waiting' },
                { value: 'rejected', label: 'Not approved' },
                { value: 'cancelled', label: 'Cancelled' },
            ],
        },
    ],
    columns: [
        { key: 'staff', label: 'Staff member', type: 'text', width: 1.8 },
        { key: 'code', label: 'Code', type: 'text', width: 0.7 },
        { key: 'department', label: 'Department', type: 'text', width: 1.1 },
        { key: 'type', label: 'Leave', type: 'text', width: 1.3 },
        { key: 'from', label: 'From', type: 'date', width: 0.9 },
        { key: 'to', label: 'To', type: 'date', width: 0.9 },
        { key: 'days', label: 'Days', type: 'number', width: 0.5, total: true },
        { key: 'lwp', label: 'Without pay', type: 'number', width: 0.6, total: true },
        { key: 'status', label: 'Status', type: 'text', width: 0.8 },
        { key: 'reason', label: 'Reason', type: 'text', width: 1.8 },
    ],
    async run(f) {
        range(f);
        const rows = await db.staffLeave.findMany({
            where: { fromDate: { lte: dayDate(f.to) }, toDate: { gte: dayDate(f.from) }, ...(f.status ? { status: f.status } : {}) },
            select: { fromDate: true, toDate: true, days: true, lwpDays: true, status: true, reason: true, half: true, leaveType: { select: { name: true, paid: true } }, staff: staffBits },
            orderBy: [{ fromDate: 'asc' }],
        });
        return {
            rows: rows.map((r) => ({
                staff: staffName(r.staff),
                code: r.staff.employeeCode,
                department: r.staff.department?.name ?? null,
                type: `${r.leaveType.name}${r.half ? ` (${r.half} half)` : ''}`,
                from: isoOf(r.fromDate),
                to: isoOf(r.toDate),
                days: r.days,
                lwp: r.leaveType.paid ? r.lwpDays || null : r.days,
                status: STATUS[r.status] ?? r.status,
                reason: r.reason,
            })),
            subtitle: `${showDay(f.from)} – ${showDay(f.to)}${f.status ? ` · ${STATUS[f.status]}` : ''}`,
        };
    },
});

defineReport({
    key: 'leave_without_pay',
    category: 'Staff Leave',
    label: 'Leave without pay (for salary)',
    description: 'Unpaid days per staff member in a period: leave without pay, and days beyond the balance. For the salary sheet.',
    permissions: ['leave.view'],
    orientation: 'portrait',
    filters: [
        { key: 'from', label: 'From', type: 'date', required: true, default: 'monthStart' },
        { key: 'to', label: 'To', type: 'date', required: true, default: 'today' },
    ],
    columns: [
        { key: 'staff', label: 'Staff member', type: 'text', width: 2 },
        { key: 'code', label: 'Code', type: 'text', width: 0.8 },
        { key: 'designation', label: 'Designation', type: 'text', width: 1.3 },
        { key: 'requests', label: 'Leaves', type: 'number', width: 0.6 },
        { key: 'days', label: 'Days without pay', type: 'number', width: 0.9, total: true },
    ],
    async run(f) {
        const rows = await db.staffLeave.findMany({
            where: { status: 'approved', fromDate: range(f), OR: [{ lwpDays: { gt: 0 } }, { leaveType: { paid: false } }] },
            select: { days: true, lwpDays: true, leaveType: { select: { paid: true } }, staff: staffBits },
        });
        const by = new Map<string, { staff: string; code: string | null; designation: string | null; requests: number; days: number }>();
        for (const r of rows) {
            const x = by.get(r.staff.id) ?? { staff: staffName(r.staff), code: r.staff.employeeCode, designation: r.staff.designation?.name ?? null, requests: 0, days: 0 };
            x.requests += 1;
            x.days += r.leaveType.paid ? r.lwpDays : r.days;
            by.set(r.staff.id, x);
        }
        return { rows: [...by.values()].sort((a, b) => a.staff.localeCompare(b.staff)), subtitle: `${showDay(f.from)} – ${showDay(f.to)} (by the leave’s first day)` };
    },
});

defineReport({
    key: 'leave_away',
    category: 'Staff Leave',
    label: 'Staff on leave on a day',
    description: 'Who is on approved leave on a day (and who has asked), with the leave and its dates.',
    permissions: ['leave.view'],
    orientation: 'portrait',
    filters: [{ key: 'date', label: 'Date', type: 'date', required: true, default: 'today' }],
    columns: [
        { key: 'staff', label: 'Staff member', type: 'text', width: 2 },
        { key: 'designation', label: 'Designation', type: 'text', width: 1.3 },
        { key: 'type', label: 'Leave', type: 'text', width: 1.3 },
        { key: 'from', label: 'From', type: 'date', width: 0.9 },
        { key: 'to', label: 'To', type: 'date', width: 0.9 },
        { key: 'status', label: 'Status', type: 'text', width: 0.8 },
    ],
    async run(f) {
        const rows = await db.staffLeave.findMany({
            where: { status: { in: ['approved', 'pending'] }, fromDate: { lte: dayDate(f.date) }, toDate: { gte: dayDate(f.date) } },
            select: { fromDate: true, toDate: true, status: true, half: true, leaveType: { select: { name: true } }, staff: staffBits },
            orderBy: { staff: { firstName: 'asc' } },
        });
        return {
            rows: rows.map((r) => ({ staff: staffName(r.staff), designation: r.staff.designation?.name ?? null, type: `${r.leaveType.name}${r.half ? ` (${r.half} half)` : ''}`, from: isoOf(r.fromDate), to: isoOf(r.toDate), status: STATUS[r.status] })),
            subtitle: showDay(f.date),
        };
    },
});

defineDataSource({
    key: 'staff_leaves',
    label: 'Staff leave',
    description: 'Every staff leave in a period: who, the leave, dates, days, without pay, status, who asked and approved.',
    category: 'Staff Leave',
    permissions: ['leave.view'],
    params: [
        { key: 'from', label: 'Leave from', type: 'date', required: true, default: 'yearStart' },
        { key: 'to', label: 'To', type: 'date', required: true, default: 'today' },
    ],
    fields: [
        { key: 'staff', label: 'Staff member', type: 'text' },
        { key: 'employeeCode', label: 'Employee code', type: 'text' },
        { key: 'designation', label: 'Designation', type: 'text' },
        { key: 'department', label: 'Department', type: 'text' },
        { key: 'type', label: 'Leave', type: 'text', group: 'Leave' },
        { key: 'typeCode', label: 'Leave code', type: 'text', group: 'Leave' },
        { key: 'from', label: 'From', type: 'date', group: 'Leave' },
        { key: 'to', label: 'To', type: 'date', group: 'Leave' },
        { key: 'halfDay', label: 'Half day', type: 'boolean', group: 'Leave' },
        { key: 'days', label: 'Days', type: 'number', group: 'Leave' },
        { key: 'lwpDays', label: 'Days without pay', type: 'number', group: 'Leave' },
        { key: 'paid', label: 'Paid leave', type: 'boolean', group: 'Leave' },
        { key: 'reason', label: 'Reason', type: 'text', group: 'Leave' },
        { key: 'status', label: 'Status', type: 'text', group: 'Approval' },
        { key: 'askedOn', label: 'Asked on', type: 'date', group: 'Approval' },
        { key: 'decidedOn', label: 'Decided on', type: 'date', group: 'Approval' },
        { key: 'decisionNote', label: 'Approver’s note', type: 'text', group: 'Approval' },
    ],
    async load(p) {
        range(p);
        const rows = await db.staffLeave.findMany({
            where: { fromDate: { lte: dayDate(p.to) }, toDate: { gte: dayDate(p.from) } },
            select: { fromDate: true, toDate: true, half: true, days: true, lwpDays: true, reason: true, status: true, createdAt: true, decidedAt: true, decisionNote: true, leaveType: { select: { name: true, code: true, paid: true } }, staff: staffBits },
            orderBy: { fromDate: 'asc' },
        });
        return rows.map((r) => ({
            staff: staffName(r.staff),
            employeeCode: r.staff.employeeCode,
            designation: r.staff.designation?.name ?? null,
            department: r.staff.department?.name ?? null,
            type: r.leaveType.name,
            typeCode: r.leaveType.code,
            from: isoOf(r.fromDate),
            to: isoOf(r.toDate),
            halfDay: !!r.half,
            days: r.days,
            lwpDays: r.leaveType.paid ? r.lwpDays : r.days,
            paid: r.leaveType.paid,
            reason: r.reason,
            status: STATUS[r.status] ?? r.status,
            askedOn: isoDay(r.createdAt),
            decidedOn: isoDay(r.decidedAt),
            decisionNote: r.decisionNote,
        }));
    },
});
