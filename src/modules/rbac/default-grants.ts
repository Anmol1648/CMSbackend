import type { DataScope } from '@prisma/client';
import { db, Tx } from '../../core/db';
import { findPermissionDef } from '../../core/registry/permissions';

/**
 * Starting permissions of the default roles (least privilege). Schools edit them freely afterwards.
 * Modules add their own entries here as they are built (e.g. Teacher → attendance.mark, scope assigned).
 * Super Admin isn't listed: it always has everything.
 */
export const DEFAULT_GRANTS: Record<string, { key: string; scope?: DataScope }[]> = {
    'school-admin': [
        { key: 'school_profile.update' },
        { key: 'user.view' },
        { key: 'user.create' },
        { key: 'user.update' },
        { key: 'user.reset_password' },
        { key: 'role.view' },
        { key: 'masters.view' },
        { key: 'masters.manage' },
        { key: 'academic.view' },
        { key: 'academic.manage' },
        { key: 'student.view' },
        { key: 'student.create' },
        { key: 'student.update' },
        { key: 'student.import' },
        { key: 'student.view_sensitive' },
        { key: 'staff.view' },
        { key: 'staff.create' },
        { key: 'staff.update' },
        { key: 'staff.import' },
        { key: 'staff.view_sensitive' },
        { key: 'teaching.assign' },
        { key: 'enquiry.view' },
        { key: 'enquiry.manage' },
        { key: 'enquiry.convert' },
        { key: 'enquiry.reports' },
        { key: 'fee.setup' },
        { key: 'fee.view' },
        { key: 'fee.collect' },
        { key: 'fee.cancel' },
        { key: 'fee.concession' },
        { key: 'fee.reports' },
        { key: 'payment.configure' },
        { key: 'timetable.view' },
        { key: 'timetable.manage' },
        { key: 'timetable.substitute' },
        { key: 'timetable.mine' },
        { key: 'documents.manage' },
        { key: 'report.view' },
        { key: 'report.build' },
        { key: 'attendance.view' },
        { key: 'attendance.mark' },
        { key: 'attendance.mark_any' },
        { key: 'attendance.holidays' },
        { key: 'attendance.staff' },
        { key: 'attendance.checkin' },
        { key: 'leave.apply' },
        { key: 'leave.approve' },
        { key: 'leave.approve_all' },
        { key: 'leave.view' },
        { key: 'leave.manage' },
        { key: 'leave.setup' },
        { key: 'notice.create' },
        { key: 'notice.publish' },
        { key: 'notice.reports' },
        { key: 'event.manage' },
        { key: 'dashboard.setup' },
        { key: 'promotion.manage' },
        { key: 'tc.manage' },
        { key: 'tc.clear' },
        { key: 'certificate.issue' },
        { key: 'exam.setup' },
        { key: 'exam.marks' },
        { key: 'exam.marks_any' },
        { key: 'exam.moderate' },
        { key: 'exam.publish' },
        { key: 'exam.view' },
        { key: 'message.send' },
        { key: 'message.send_groups' },
        { key: 'message.attach_documents' },
        { key: 'message.schedule' },
        { key: 'message.sms_whatsapp' },
        { key: 'message.view_sent' },
        { key: 'alert.setup' },
        { key: 'alert.custom' },
        { key: 'alert.log' },
        { key: 'alert.templates' },
    ],
    principal: [{ key: 'user.view' }, { key: 'role.view' }, { key: 'masters.view' }, { key: 'academic.view' }, { key: 'academic.manage' }, { key: 'student.view' }, { key: 'student.view_sensitive' }, { key: 'staff.view' }, { key: 'staff.view_sensitive' }, { key: 'teaching.assign' }, { key: 'enquiry.view' }, { key: 'enquiry.reports' }, { key: 'fee.view' }, { key: 'fee.reports' }, { key: 'fee.concession' }, { key: 'timetable.view' }, { key: 'timetable.manage' }, { key: 'timetable.substitute' }, { key: 'timetable.mine' }, { key: 'report.view' }, { key: 'attendance.view' }, { key: 'attendance.mark' }, { key: 'attendance.mark_any' }, { key: 'attendance.holidays' }, { key: 'attendance.staff' }, { key: 'attendance.checkin' }, { key: 'leave.apply' }, { key: 'leave.approve' }, { key: 'leave.approve_all' }, { key: 'leave.view' }, { key: 'notice.create' }, { key: 'notice.publish' }, { key: 'notice.reports' }, { key: 'event.manage' }, { key: 'promotion.manage' }, { key: 'certificate.issue' }, { key: 'exam.setup' }, { key: 'exam.moderate' }, { key: 'exam.publish' }, { key: 'exam.view' }, { key: 'exam.marks_any' }, { key: 'message.send' }, { key: 'message.send_groups' }, { key: 'message.attach_documents' }, { key: 'message.schedule' }, { key: 'message.sms_whatsapp' }, { key: 'message.view_sent' }, { key: 'alert.setup' }, { key: 'alert.custom' }, { key: 'alert.log' }, { key: 'alert.templates' }],
    // Teachers see the students of the sections they teach, and their own staff record.
    teacher: [{ key: 'student.view', scope: 'assigned' }, { key: 'staff.view', scope: 'own' }, { key: 'fee.view', scope: 'assigned' }, { key: 'timetable.mine' }, { key: 'attendance.view', scope: 'assigned' }, { key: 'attendance.mark' }, { key: 'attendance.checkin' }, { key: 'leave.apply' }, { key: 'leave.approve' }, { key: 'exam.marks' }, { key: 'exam.view', scope: 'assigned' }, { key: 'message.send', scope: 'assigned' }, { key: 'message.view_sent', scope: 'own' }],
    // Class teachers see the students of their own sections.
    'class-teacher': [{ key: 'student.view', scope: 'assigned' }, { key: 'staff.view', scope: 'own' }, { key: 'fee.view', scope: 'assigned' }, { key: 'timetable.mine' }, { key: 'attendance.view', scope: 'assigned' }, { key: 'attendance.mark' }, { key: 'attendance.checkin' }, { key: 'leave.apply' }, { key: 'leave.approve' }, { key: 'exam.marks' }, { key: 'exam.view', scope: 'assigned' }, { key: 'message.send', scope: 'assigned' }, { key: 'message.view_sent', scope: 'own' }],
    'office-staff': [{ key: 'masters.view' }, { key: 'academic.view' }, { key: 'student.view' }, { key: 'student.create' }, { key: 'student.update' }, { key: 'student.import' }, { key: 'staff.view' }, { key: 'staff.create' }, { key: 'staff.update' }, { key: 'enquiry.view' }, { key: 'enquiry.manage' }, { key: 'enquiry.convert' }, { key: 'enquiry.reports' }, { key: 'fee.view' }, { key: 'fee.collect' }, { key: 'timetable.view' }, { key: 'timetable.substitute' }, { key: 'report.view' }, { key: 'attendance.view' }, { key: 'attendance.mark' }, { key: 'attendance.mark_any' }, { key: 'attendance.holidays' }, { key: 'attendance.staff' }, { key: 'attendance.checkin' }, { key: 'leave.apply' }, { key: 'leave.approve' }, { key: 'leave.view' }, { key: 'leave.manage' }, { key: 'notice.create' }, { key: 'notice.reports' }, { key: 'event.manage' }, { key: 'tc.manage' }, { key: 'tc.clear' }, { key: 'certificate.issue' }, { key: 'exam.setup' }, { key: 'exam.marks_any' }, { key: 'exam.view' }, { key: 'message.send' }, { key: 'message.send_groups' }, { key: 'message.attach_documents' }, { key: 'message.schedule' }, { key: 'message.view_sent' }, { key: 'alert.log' }, { key: 'alert.templates' }],
    // The accountant runs fees: set-up, counter, concessions and reports (cancelling stays with the admin).
    accountant: [{ key: 'masters.view' }, { key: 'academic.view' }, { key: 'fee.setup' }, { key: 'fee.view' }, { key: 'fee.collect' }, { key: 'fee.concession' }, { key: 'fee.reports' }, { key: 'report.view' }, { key: 'attendance.checkin' }, { key: 'leave.apply' }, { key: 'leave.approve' }, { key: 'message.send' }, { key: 'message.view_sent', scope: 'own' }],
    // A student sees their own record; a parent sees their children.
    // My Fees shows their own fees and receipts (fee.view is the office's list of everyone's).
    student: [{ key: 'student.view', scope: 'own' }, { key: 'fee.pay_online' }, { key: 'timetable.mine' }, { key: 'attendance.mine' }, { key: 'exam.mine' }],
    guardian: [{ key: 'student.view', scope: 'own' }, { key: 'fee.pay_online' }, { key: 'timetable.mine' }, { key: 'attendance.mine' }, { key: 'exam.mine' }],
};

/**
 * Adds the default grants that are missing for the current school's default roles. Never removes
 * anything, so it is safe to run again after a module adds new defaults.
 */
export const applyDefaultGrants = async (tenantId: string, client: typeof db | Tx = db) => {
    // tenantId explicitly: this also runs inside runAsSystem (creating a school), where scoping is off.
    const roles = await client.role.findMany({ where: { tenantId, slug: { in: Object.keys(DEFAULT_GRANTS) } }, select: { id: true, slug: true } });
    // One statement for every role (creating a school runs this inside a time-limited transaction).
    const data = roles.flatMap((role) =>
        (DEFAULT_GRANTS[role.slug] ?? []).filter((g) => findPermissionDef(g.key)).map((g) => ({ tenantId, roleId: role.id, permissionKey: g.key, scope: g.scope ?? ('all' as const) }))
    );
    if (!data.length) return 0;
    return (await client.rolePermission.createMany({ data, skipDuplicates: true })).count;
};
