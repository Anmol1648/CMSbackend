import { db } from '../../core/db';
import { getSettings } from '../../core/settings';
import { currentYear } from '../academic/years.service';
import { dayDate, todayIST } from '../attendance/attendance.settings';
import { overview } from '../attendance/student-attendance.service';
import { leaveRequests } from '../attendance/leave.service';
import { enquirySummary } from '../admissions/enquiries.service';
import { enquiryViewer } from '../admissions/admissions.routes';
import { myFees } from '../fees/my-fees.service';
import { hostelScope } from '../hostel/hostel.service';
import { HOSTEL } from '../hostel/hostel.settings';
import { defineAction } from './dashboard.registry';

/**
 * The action centre ("Waiting for you"): one card for each kind of thing waiting on the person,
 * with how many, opening the screen where it is done. Each is counted only for those whose
 * permissions let them act on it, and only what is theirs (their staff, sections, hostels, children).
 */

const nowHHMM = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(11, 16);
const myStaffId = async (userId: string) => (await db.staff.findFirst({ where: { userId }, select: { id: true } }))?.id ?? null;
const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

// ─── Approvals ───────────────────────────────────────────────────────────────

defineAction({
    key: 'staff_leave',
    label: 'Staff leave to approve',
    icon: 'event_busy',
    href: '/leave/approvals',
    permissions: ['leave.approve', 'leave.approve_all'],
    order: 10,
    count: ({ userId, permissions: p }) => (p['leave.approve_all'] ? db.staffLeave.count({ where: { status: 'pending', staff: { userId: { not: userId } } } }) : db.staffLeave.count({ where: { status: 'pending', stage: 1, staff: { reportsTo: { userId } } } })),
});
defineAction({ key: 'checkins', label: 'Check-ins to approve', icon: 'how_to_reg', href: '/attendance/staff', permissions: ['attendance.staff'], order: 11, count: () => db.staffAttendance.count({ where: { approval: 'pending' } }) });
defineAction({ key: 'att_corrections', label: 'Attendance corrections asked', icon: 'edit_calendar', href: '/attendance/staff', permissions: ['attendance.staff'], order: 12, count: () => db.staffAttendanceRequest.count({ where: { status: 'pending' } }) });
defineAction({ key: 'student_leave', label: 'Student leave to approve', icon: 'sick', href: '/attendance/leave', permissions: ['attendance.mark', 'attendance.mark_any'], order: 13, count: async ({ userId }) => (await leaveRequests({ status: 'pending' }, userId)).length });
defineAction({ key: 'notices', label: 'Notices to approve', icon: 'campaign', href: '/notices/manage', permissions: ['notice.publish'], order: 14, count: () => db.notice.count({ where: { status: 'pending' } }) });
defineAction({ key: 'vouchers', label: 'Vouchers to approve', icon: 'receipt_long', href: '/accounts', permissions: ['accounts.approve'], order: 15, count: () => db.accVoucher.count({ where: { status: 'pending' } }) });
defineAction({ key: 'payroll', label: 'Payroll to approve', icon: 'payments', href: '/payroll', permissions: ['payroll.approve'], order: 16, count: () => db.payrollRun.count({ where: { status: 'prepared' } }) });
defineAction({
    key: 'store_approvals',
    label: 'Store requests, orders and write-offs to approve',
    icon: 'inventory',
    href: '/inventory/issue',
    permissions: ['inventory.approve'],
    order: 17,
    count: async () => (await Promise.all([db.invRequest.count({ where: { status: 'pending' } }), db.invPurchaseOrder.count({ where: { status: 'pending' } }), db.invAdjustment.count({ where: { status: 'pending' } })])).reduce((a, b) => a + b, 0),
});
defineAction({ key: 'rechecks', label: 'Re-check requests', icon: 'fact_check', href: '/exams/after', permissions: ['exam.recheck'], order: 18, count: () => db.examRecheck.count({ where: { status: { in: ['pending', 'reviewed'] } } }) });

// ─── Work to do ──────────────────────────────────────────────────────────────

defineAction({
    key: 'my_attendance',
    label: 'My class: attendance not marked',
    icon: 'checklist',
    href: '/attendance/mark',
    permissions: ['attendance.mark'],
    tone: 'bad',
    order: 20,
    count: async ({ userId }) => {
        const staffId = await myStaffId(userId);
        const year = await currentYear();
        if (!staffId || !year) return 0;
        const own = await db.section.findMany({ where: { academicYearId: year.id, classTeacherId: staffId, isActive: true }, select: { id: true } });
        if (!own.length) return 0;
        const o = await overview({}, userId);
        if (o.dayOff) return 0;
        const ids = new Set(own.map((s) => s.id));
        return o.sections.filter((s) => ids.has(s.id) && !s.slots.every((x) => x.marked)).length;
    },
});
defineAction({
    key: 'marks_due',
    label: 'Marks sheets to submit',
    icon: 'grading',
    href: '/exams/marks',
    permissions: ['exam.marks'],
    order: 21,
    count: async ({ userId }) => {
        const staffId = await myStaffId(userId);
        const year = await currentYear();
        if (!staffId || !year) return 0;
        const exams = await db.exam.findMany({ where: { academicYearId: year.id, status: 'open' }, select: { id: true } });
        if (!exams.length) return 0;
        const mine = await db.teachingAssignment.findMany({ where: { academicYearId: year.id, staffId }, select: { sectionId: true, subjectId: true, section: { select: { classId: true } } } });
        if (!mine.length) return 0;
        const subjects = await db.examSubject.findMany({ where: { examId: { in: exams.map((e) => e.id) }, subjectId: { in: mine.map((m) => m.subjectId) } }, select: { id: true, classId: true, subjectId: true } });
        const sheets = mine.flatMap((m) => subjects.filter((s) => s.classId === m.section.classId && s.subjectId === m.subjectId).map((s) => ({ examSubjectId: s.id, sectionId: m.sectionId })));
        if (!sheets.length) return 0;
        const locks = await db.examSheetLock.findMany({ where: { examSubjectId: { in: sheets.map((s) => s.examSubjectId) } }, select: { examSubjectId: true, sectionId: true } });
        return sheets.filter((s) => !locks.some((l) => l.examSubjectId === s.examSubjectId && l.sectionId === s.sectionId)).length;
    },
});
defineAction({
    key: 'enquiries_overdue',
    label: 'Enquiry follow-ups',
    icon: 'support_agent',
    href: '/admissions',
    permissions: ['enquiry.view'],
    order: 22,
    count: async ({ userId }) => {
        const year = await currentYear();
        const s = await enquirySummary(year?.id, await enquiryViewer(userId));
        const n = s.overdue + s.dueToday;
        return { count: n, label: s.overdue ? `Enquiry follow-ups (${s.overdue} overdue)` : 'Enquiry follow-ups due today' };
    },
});
defineAction({ key: 'complaints_mine', label: 'Complaints assigned to me', icon: 'report', href: '/complaints', permissions: ['complaint.handle'], order: 23, count: ({ userId }) => db.complaint.count({ where: { assignedTo: userId, status: { in: ['new', 'assigned', 'in_progress', 'reopened'] } } }) });
defineAction({ key: 'complaints_new', label: 'New complaints to assign', icon: 'report', href: '/complaints', permissions: ['complaint.manage'], order: 24, count: () => db.complaint.count({ where: { status: 'new', assignedTo: null } }) });
defineAction({ key: 'store_issue', label: 'Store requests to issue', icon: 'local_shipping', href: '/inventory/issue', permissions: ['inventory.store'], order: 25, count: () => db.invRequest.count({ where: { status: { in: ['approved', 'partly'] } } }) });
defineAction({ key: 'repairs', label: 'Asset problems open', icon: 'build', href: '/assets/repairs', permissions: ['asset.repair'], order: 26, count: () => db.assetIssue.count({ where: { status: { in: ['open', 'in_repair'] } } }) });
defineAction({ key: 'library_overdue', label: 'Library books overdue', icon: 'menu_book', href: '/library', permissions: ['library.issue'], tone: 'bad', order: 27, count: () => db.libraryLoan.count({ where: { status: 'out', dueOn: { lt: dayDate(todayIST()) } } }) });

// ─── Hostel ──────────────────────────────────────────────────────────────────

defineAction({
    key: 'hostel_leave',
    label: 'Hostel leave to answer',
    icon: 'directions_walk',
    href: '/hostel/leave',
    permissions: ['hostel.warden'],
    order: 30,
    count: async ({ userId }) => {
        const scope = await hostelScope(userId);
        return db.hostelLeave.count({ where: { status: 'pending', ...(scope === 'all' ? {} : { hostelId: { in: scope } }) } });
    },
});
defineAction({
    key: 'hostel_late',
    label: 'Boarders overdue back',
    icon: 'running_with_errors',
    href: '/hostel/leave',
    permissions: ['hostel.warden', 'hostel.gate'],
    tone: 'bad',
    order: 31,
    count: async ({ userId }) => {
        const scope = await hostelScope(userId);
        return db.hostelLeave.count({ where: { status: 'out', toAt: { lt: new Date() }, ...(scope === 'all' ? {} : { hostelId: { in: scope } }) } });
    },
});
defineAction({
    key: 'roll_call',
    label: 'Night roll call not taken',
    icon: 'how_to_reg',
    href: '/hostel/roll-call',
    permissions: ['hostel.warden'],
    tone: 'bad',
    order: 32,
    count: async ({ userId }) => {
        const { t } = await getSettings({ t: HOSTEL.rollCallTime });
        if (nowHHMM() < t) return 0;
        const scope = await hostelScope(userId);
        const hostels = await db.hostel.findMany({ where: { isActive: true, ...(scope === 'all' ? {} : { id: { in: scope } }) }, select: { id: true } });
        let n = 0;
        for (const h of hostels) if ((await db.hostelAllotment.count({ where: { hostelId: h.id, status: 'active' } })) && !(await db.hostelRollCall.count({ where: { hostelId: h.id, date: dayDate(todayIST()) } }))) n++;
        return n;
    },
});

// ─── Parents and students ────────────────────────────────────────────────────

defineAction({
    key: 'fees_overdue',
    label: 'Fees overdue',
    icon: 'payments',
    href: '/my-fees',
    permissions: ['fee.pay_online'],
    tone: 'bad',
    order: 40,
    count: async ({ userId }) => {
        const f = await myFees(userId);
        const overdue = f.children.reduce((a, c) => a + c.dues.totals.overdue, 0);
        return overdue > 0 ? { count: 1, value: rupees(overdue), label: 'Fees overdue' } : 0;
    },
});
