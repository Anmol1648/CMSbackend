import { db } from '../../core/db';
import { getUserAccess } from '../rbac/access.service';
import { currentYear } from '../academic/years.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { dayDate, todayIST } from '../attendance/attendance.settings';
import { hostelScope } from '../hostel/hostel.service';
import { defineDataSource, isoDay, personName, titleCase } from './datasources.registry';

/**
 * More data for the Report Builder and the Widget Builder: hostel, mess, library, store, complaints,
 * visitors and payslips. Each is limited to what the person may see (a warden's hostels, the
 * complaints assigned to a handler…).
 */

const DAY = 86_400_000;
const range = [
    { key: 'from', label: 'From', type: 'date' as const, required: true, default: 'monthStart' },
    { key: 'to', label: 'To', type: 'date' as const, required: true, default: 'today' },
];
const between = (p: Record<string, string>) => ({ gte: dayDate(p.from ?? todayIST()), lt: new Date(dayDate(p.to ?? todayIST()).getTime() + DAY) });
const istTime = (d: Date | null) => (d ? d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' }) : null);
const sectionsOf = async (studentIds: string[]) => {
    const year = await currentYear();
    if (!year || !studentIds.length) return new Map<string, string>();
    const en = await db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: studentIds } }, select: { studentId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } });
    return new Map(en.map((e) => [e.studentId, sectionLabel(e.section)]));
};
const names = async (ids: string[], master?: string) => new Map((await db.masterValue.findMany({ where: { id: { in: ids.filter(Boolean) }, ...(master ? { master } : {}) }, select: { id: true, name: true } })).map((m) => [m.id, m.name]));

// ─── Hostel ──────────────────────────────────────────────────────────────────

defineDataSource({
    key: 'hostel_boarders',
    label: 'Hostel boarders',
    description: 'Every boarder with a bed now: hostel, room, bed, room type and class.',
    category: 'Hostel',
    permissions: ['hostel.view', 'hostel.warden', 'hostel.allot', 'hostel.setup'],
    params: [],
    fields: [
        { key: 'name', label: 'Student', type: 'text' },
        { key: 'admissionNo', label: 'Admission no.', type: 'text' },
        { key: 'section', label: 'Class', type: 'text' },
        { key: 'gender', label: 'Gender', type: 'text' },
        { key: 'hostel', label: 'Hostel', type: 'text' },
        { key: 'room', label: 'Room', type: 'text' },
        { key: 'floor', label: 'Floor', type: 'number' },
        { key: 'bed', label: 'Bed', type: 'number' },
        { key: 'roomType', label: 'Room type', type: 'text' },
        { key: 'since', label: 'Since', type: 'date' },
    ],
    async load(_p, ctx) {
        const scope = await hostelScope(ctx.userId);
        const allots = await db.hostelAllotment.findMany({ where: { status: 'active', ...(scope === 'all' ? {} : { hostelId: { in: scope } }) } });
        const [st, hostels, rooms, sec] = await Promise.all([
            db.student.findMany({ where: { id: { in: allots.map((a) => a.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, gender: { select: { name: true } } } }),
            db.hostel.findMany({ select: { id: true, name: true } }),
            db.hostelRoom.findMany({ where: { id: { in: allots.map((a) => a.roomId) } }, select: { id: true, number: true, floor: true, roomTypeId: true } }),
            sectionsOf(allots.map((a) => a.studentId)),
        ]);
        const types = await names(rooms.map((r) => r.roomTypeId ?? ''));
        return allots.map((a) => {
            const s = st.find((x) => x.id === a.studentId);
            const r = rooms.find((x) => x.id === a.roomId);
            return { name: personName(s), admissionNo: s?.admissionNo ?? null, section: sec.get(a.studentId) ?? null, gender: s?.gender?.name ?? null, hostel: hostels.find((h) => h.id === a.hostelId)?.name ?? null, room: r?.number ?? null, floor: r?.floor ?? null, bed: a.bed, roomType: r?.roomTypeId ? (types.get(r.roomTypeId) ?? null) : null, since: isoDay(a.fromDate) };
        });
    },
});

defineDataSource({
    key: 'hostel_leave',
    label: 'Hostel leave',
    description: 'Hostel leave starting in a period: who, when, why, going out and coming back, late returns.',
    category: 'Hostel',
    permissions: ['hostel.view', 'hostel.warden', 'hostel.gate'],
    params: range,
    fields: [
        { key: 'name', label: 'Student', type: 'text' },
        { key: 'section', label: 'Class', type: 'text' },
        { key: 'hostel', label: 'Hostel', type: 'text' },
        { key: 'fromDate', label: 'Leaves on', type: 'date' },
        { key: 'toDate', label: 'Back by', type: 'date' },
        { key: 'days', label: 'Days', type: 'number' },
        { key: 'reason', label: 'Reason', type: 'text' },
        { key: 'status', label: 'Status', type: 'text' },
        { key: 'late', label: 'Came back late', type: 'boolean' },
        { key: 'outAt', label: 'Went out', type: 'text' },
        { key: 'inAt', label: 'Came back', type: 'text' },
    ],
    async load(p, ctx) {
        const scope = await hostelScope(ctx.userId);
        const rows = await db.hostelLeave.findMany({ where: { fromAt: between(p), ...(scope === 'all' ? {} : { hostelId: { in: scope } }) }, orderBy: { fromAt: 'asc' } });
        const [st, hostels, sec] = await Promise.all([db.student.findMany({ where: { id: { in: rows.map((r) => r.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true } }), db.hostel.findMany({ select: { id: true, name: true } }), sectionsOf(rows.map((r) => r.studentId))]);
        return rows.map((r) => ({ name: personName(st.find((s) => s.id === r.studentId)), section: sec.get(r.studentId) ?? null, hostel: hostels.find((h) => h.id === r.hostelId)?.name ?? null, fromDate: isoDay(new Date(r.fromAt.getTime() + 5.5 * 3_600_000)), toDate: isoDay(new Date(r.toAt.getTime() + 5.5 * 3_600_000)), days: Math.round(((r.toAt.getTime() - r.fromAt.getTime()) / DAY) * 10) / 10, reason: r.reason, status: titleCase(r.status), late: r.late, outAt: istTime(r.outAt), inAt: istTime(r.inAt) }));
    },
});

// ─── Mess ────────────────────────────────────────────────────────────────────

defineDataSource({
    key: 'mess_meals',
    label: 'Mess meals served',
    description: 'Every meal served at the mess counter in a period: members and guests, with the guest charges.',
    category: 'Mess',
    permissions: ['mess.view', 'mess.manage'],
    params: range,
    fields: [
        { key: 'date', label: 'Date', type: 'date' },
        { key: 'meal', label: 'Meal', type: 'text' },
        { key: 'who', label: 'Member / guest', type: 'text' },
        { key: 'kind', label: 'Student / staff / guest', type: 'text' },
        { key: 'plan', label: 'Plan', type: 'text' },
        { key: 'meals', label: 'Meals (guests count each)', type: 'number' },
        { key: 'amount', label: 'Guest charge', type: 'money' },
        { key: 'paidBy', label: 'Guest paid by', type: 'text' },
    ],
    async load(p) {
        const serves = await db.messServe.findMany({ where: { date: { gte: dayDate(p.from ?? todayIST()), lte: dayDate(p.to ?? todayIST()) } } });
        const subs = await db.messSubscription.findMany({ where: { id: { in: serves.map((s) => s.subscriptionId!).filter(Boolean) } }, select: { id: true, planId: true, studentId: true, staffId: true } });
        const [meals, plans, st, sf] = await Promise.all([
            names(serves.map((s) => s.mealId)),
            db.messPlan.findMany({ select: { id: true, name: true } }),
            db.student.findMany({ where: { id: { in: subs.map((s) => s.studentId!).filter(Boolean) } }, select: { id: true, firstName: true, middleName: true, lastName: true } }),
            db.staff.findMany({ where: { id: { in: subs.map((s) => s.staffId!).filter(Boolean) } }, select: { id: true, firstName: true, middleName: true, lastName: true } }),
        ]);
        return serves.map((s) => {
            const sub = subs.find((x) => x.id === s.subscriptionId);
            const person = sub?.studentId ? st.find((x) => x.id === sub.studentId) : sub?.staffId ? sf.find((x) => x.id === sub.staffId) : null;
            return { date: isoDay(s.date), meal: meals.get(s.mealId) ?? null, who: sub ? personName(person) : s.guestName, kind: !sub ? 'Guest' : sub.studentId ? 'Student' : 'Staff', plan: sub ? (plans.find((x) => x.id === sub.planId)?.name ?? null) : null, meals: sub ? 1 : s.guests, amount: s.amount, paidBy: sub ? null : titleCase(s.payBy) };
        });
    },
});

// ─── Library ─────────────────────────────────────────────────────────────────

defineDataSource({
    key: 'library_loans',
    label: 'Library loans',
    description: 'Books issued in a period: who has them, due dates, returns and days overdue.',
    category: 'Library',
    permissions: ['library.view', 'library.issue'],
    params: range,
    fields: [
        { key: 'title', label: 'Book', type: 'text' },
        { key: 'member', label: 'Member', type: 'text' },
        { key: 'memberKind', label: 'Student / staff', type: 'text' },
        { key: 'section', label: 'Class', type: 'text' },
        { key: 'issuedOn', label: 'Issued on', type: 'date' },
        { key: 'dueOn', label: 'Due on', type: 'date' },
        { key: 'returnedOn', label: 'Returned on', type: 'date' },
        { key: 'status', label: 'Status', type: 'text' },
        { key: 'overdueDays', label: 'Days overdue', type: 'number' },
        { key: 'renewals', label: 'Renewals', type: 'number' },
    ],
    async load(p) {
        const loans = await db.libraryLoan.findMany({ where: { issuedOn: { gte: dayDate(p.from ?? todayIST()), lte: dayDate(p.to ?? todayIST()) } } });
        const [books, st, sf, sec] = await Promise.all([
            db.book.findMany({ where: { id: { in: loans.map((l) => l.bookId) } }, select: { id: true, title: true } }),
            db.student.findMany({ where: { id: { in: loans.map((l) => l.studentId!).filter(Boolean) } }, select: { id: true, firstName: true, middleName: true, lastName: true } }),
            db.staff.findMany({ where: { id: { in: loans.map((l) => l.staffId!).filter(Boolean) } }, select: { id: true, firstName: true, middleName: true, lastName: true } }),
            sectionsOf(loans.map((l) => l.studentId!).filter(Boolean)),
        ]);
        const today = dayDate(todayIST()).getTime();
        return loans.map((l) => {
            const end = l.returnedOn ? l.returnedOn.getTime() : today;
            return { title: books.find((b) => b.id === l.bookId)?.title ?? null, member: personName(l.studentId ? st.find((s) => s.id === l.studentId) : sf.find((s) => s.id === l.staffId)), memberKind: titleCase(l.memberKind), section: l.studentId ? (sec.get(l.studentId) ?? null) : null, issuedOn: isoDay(l.issuedOn), dueOn: isoDay(l.dueOn), returnedOn: isoDay(l.returnedOn), status: l.returnedOn ? 'Returned' : titleCase(l.status), overdueDays: Math.max(0, Math.floor((end - l.dueOn.getTime()) / DAY)), renewals: l.renewals };
        });
    },
});

// ─── Store ───────────────────────────────────────────────────────────────────

defineDataSource({
    key: 'inventory_stock',
    label: 'Store stock',
    description: 'Every store item: category, stock in hand, reorder level, average cost and value.',
    category: 'Inventory',
    permissions: ['inventory.view', 'inventory.store', 'inventory.manage'],
    params: [],
    fields: [
        { key: 'code', label: 'Code', type: 'text' },
        { key: 'name', label: 'Item', type: 'text' },
        { key: 'category', label: 'Category', type: 'text' },
        { key: 'unit', label: 'Unit', type: 'text' },
        { key: 'qty', label: 'In stock', type: 'number' },
        { key: 'reorderLevel', label: 'Reorder level', type: 'number' },
        { key: 'low', label: 'Low in stock', type: 'boolean' },
        { key: 'avgCost', label: 'Average cost', type: 'money' },
        { key: 'value', label: 'Stock value', type: 'money' },
        { key: 'sellable', label: 'Sold to students', type: 'boolean' },
    ],
    async load() {
        const items = await db.invItem.findMany({ where: { isActive: true }, select: { code: true, name: true, categoryId: true, unitId: true, reorderLevel: true, avgCost: true, sellable: true, stock: { select: { qty: true } } } });
        const m = await names(items.flatMap((i) => [i.categoryId ?? '', i.unitId ?? '']));
        return items.map((i) => {
            const qty = Math.round(i.stock.reduce((a, s) => a + s.qty, 0) * 100) / 100;
            return { code: i.code, name: i.name, category: i.categoryId ? (m.get(i.categoryId) ?? null) : null, unit: i.unitId ? (m.get(i.unitId) ?? null) : null, qty, reorderLevel: i.reorderLevel, low: i.reorderLevel > 0 && qty <= i.reorderLevel, avgCost: Math.round(i.avgCost * 100) / 100, value: Math.round(qty * i.avgCost), sellable: i.sellable };
        });
    },
});

// ─── Complaints ──────────────────────────────────────────────────────────────

defineDataSource({
    key: 'complaints',
    label: 'Complaints',
    description: 'Complaints raised in a period: category, priority, status, who handles them, days open, rating.',
    category: 'Complaints',
    permissions: ['complaint.manage', 'complaint.handle'],
    params: range,
    fields: [
        { key: 'ticketNo', label: 'Ticket', type: 'text' },
        { key: 'subject', label: 'Subject', type: 'text' },
        { key: 'category', label: 'Category', type: 'text' },
        { key: 'priority', label: 'Priority', type: 'text' },
        { key: 'status', label: 'Status', type: 'text' },
        { key: 'open', label: 'Still open', type: 'boolean' },
        { key: 'raisedAs', label: 'Raised by (parent / staff…)', type: 'text' },
        { key: 'assignedTo', label: 'Handled by', type: 'text' },
        { key: 'raisedOn', label: 'Raised on', type: 'date' },
        { key: 'resolvedOn', label: 'Resolved on', type: 'date' },
        { key: 'daysOpen', label: 'Days open', type: 'number' },
        { key: 'escalated', label: 'Escalated', type: 'boolean' },
        { key: 'rating', label: 'Rating (1–5)', type: 'number' },
    ],
    async load(p, ctx) {
        const a = await getUserAccess(ctx.userId);
        const rows = await db.complaint.findMany({ where: { createdAt: between(p), ...(a.permissions['complaint.manage'] ? {} : { assignedTo: ctx.userId }) } });
        const [cats, users] = await Promise.all([names(rows.map((r) => r.categoryId ?? '')), db.user.findMany({ where: { id: { in: rows.map((r) => r.assignedTo!).filter(Boolean) } }, select: { id: true, displayName: true } })]);
        const OPEN = ['new', 'assigned', 'in_progress', 'reopened'];
        return rows.map((r) => {
            const end = (r.resolvedAt ?? r.closedAt ?? new Date()).getTime();
            return { ticketNo: r.ticketNo, subject: r.subject, category: r.categoryId ? (cats.get(r.categoryId) ?? null) : null, priority: titleCase(r.priority), status: titleCase(r.status), open: OPEN.includes(r.status), raisedAs: titleCase(r.raisedAs), assignedTo: users.find((u) => u.id === r.assignedTo)?.displayName ?? null, raisedOn: isoDay(r.createdAt), resolvedOn: isoDay(r.resolvedAt), daysOpen: Math.floor((end - r.createdAt.getTime()) / DAY), escalated: r.escalation > 0, rating: r.rating };
        });
    },
});

// ─── Visitors ────────────────────────────────────────────────────────────────

defineDataSource({
    key: 'visits',
    label: 'Visitors',
    description: 'Visits at the gate in a period: who came, to meet whom, purpose, time in and out.',
    category: 'Visitors',
    permissions: ['visitor.view'],
    params: range,
    fields: [
        { key: 'day', label: 'Date', type: 'date' },
        { key: 'visitor', label: 'Visitor', type: 'text' },
        { key: 'purpose', label: 'Purpose', type: 'text' },
        { key: 'meeting', label: 'To meet (staff / student)', type: 'text' },
        { key: 'people', label: 'People', type: 'number' },
        { key: 'status', label: 'Status', type: 'text' },
        { key: 'inAt', label: 'In', type: 'text' },
        { key: 'outAt', label: 'Out', type: 'text' },
        { key: 'minutes', label: 'Minutes inside', type: 'number' },
    ],
    async load(p) {
        const visits = await db.visit.findMany({ where: { day: { gte: dayDate(p.from ?? todayIST()), lte: dayDate(p.to ?? todayIST()) } }, include: { visitor: { select: { name: true } } } });
        const [purposes, st, sf] = await Promise.all([
            names(visits.map((v) => v.purposeId ?? '')),
            db.student.findMany({ where: { id: { in: visits.map((v) => v.studentId!).filter(Boolean) } }, select: { id: true, firstName: true, middleName: true, lastName: true } }),
            db.staff.findMany({ where: { id: { in: visits.map((v) => v.staffId!).filter(Boolean) } }, select: { id: true, firstName: true, middleName: true, lastName: true } }),
        ]);
        return visits.map((v) => ({ day: isoDay(v.day), visitor: v.visitor.name, purpose: v.purposeId ? (purposes.get(v.purposeId) ?? null) : null, meeting: personName(v.studentId ? st.find((s) => s.id === v.studentId) : v.staffId ? sf.find((s) => s.id === v.staffId) : null), people: v.people, status: titleCase(v.status), inAt: istTime(v.inAt), outAt: istTime(v.outAt), minutes: v.inAt && v.outAt ? Math.round((v.outAt.getTime() - v.inAt.getTime()) / 60_000) : null }));
    },
});

// ─── Payslips ────────────────────────────────────────────────────────────────

defineDataSource({
    key: 'payslips',
    label: 'Payslips',
    description: 'Every payslip of the months in a period: staff, paid days, gross, deductions and net pay.',
    category: 'Payroll',
    permissions: ['payroll.view', 'payroll.run'],
    params: [
        { key: 'from', label: 'From month (YYYY-MM)', type: 'text', required: true, default: `${todayIST().slice(0, 4)}-01` },
        { key: 'to', label: 'To month (YYYY-MM)', type: 'text', required: true, default: todayIST().slice(0, 7) },
    ],
    fields: [
        { key: 'month', label: 'Month (YYYY-MM)', type: 'text' },
        { key: 'name', label: 'Staff', type: 'text' },
        { key: 'employeeCode', label: 'Employee code', type: 'text' },
        { key: 'designation', label: 'Designation', type: 'text' },
        { key: 'department', label: 'Department', type: 'text' },
        { key: 'paidDays', label: 'Paid days', type: 'number' },
        { key: 'gross', label: 'Gross', type: 'money' },
        { key: 'deducted', label: 'Deductions', type: 'money' },
        { key: 'net', label: 'Net pay', type: 'money' },
        { key: 'runStatus', label: 'Month status', type: 'text' },
    ],
    async load(p) {
        const slips = await db.payslip.findMany({ where: { run: { month: { gte: p.from ?? '0000-00', lte: p.to ?? '9999-99' } } }, include: { run: { select: { month: true, status: true } } } });
        const staff = await db.staff.findMany({ where: { id: { in: slips.map((s) => s.staffId) } }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true, designationId: true, departmentId: true } });
        const m = await names(staff.flatMap((s) => [s.designationId ?? '', s.departmentId ?? '']));
        return slips.map((s) => {
            const x = staff.find((y) => y.id === s.staffId);
            return { month: s.run.month, name: personName(x), employeeCode: x?.employeeCode ?? null, designation: x?.designationId ? (m.get(x.designationId) ?? null) : null, department: x?.departmentId ? (m.get(x.departmentId) ?? null) : null, paidDays: s.paidDays, gross: Math.round(s.gross), deducted: Math.round(s.deducted), net: Math.round(s.net), runStatus: titleCase(s.run.status) };
        });
    },
});
