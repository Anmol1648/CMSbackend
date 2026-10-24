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
        { key: 'homework.give' },
        { key: 'homework.check' },
        { key: 'homework.view' },
        { key: 'syllabus.manage' },
        { key: 'question.view' },
        { key: 'question.add' },
        { key: 'question.approve' },
        { key: 'ai.generate' },
        { key: 'ai.setup' },
        { key: 'ai.usage' },
        { key: 'test.create' },
        { key: 'test.mark' },
        { key: 'test.view' },
        { key: 'learn.view' },
        { key: 'transport.view' },
        { key: 'transport.manage' },
        { key: 'transport.track_all' },
        { key: 'transport.setup' },
        { key: 'library.view' },
        { key: 'library.manage' },
        { key: 'library.issue' },
        { key: 'library.fines' },
        { key: 'library.mine' },
        { key: 'ptm.manage' },
        { key: 'ptm.desk' },
        { key: 'visitor.gate' },
        { key: 'visitor.view' },
        { key: 'visitor.manage' },
        { key: 'visitor.expect' },
        { key: 'complaint.raise' },
        { key: 'complaint.handle' },
        { key: 'complaint.manage' },
        { key: 'discipline.record' },
        { key: 'discipline.view' },
        { key: 'discipline.action' },
        { key: 'discipline.approve' },
        { key: 'feedback.manage' },
        { key: 'feedback.results' },
        { key: 'upload.manage' },
        { key: 'upload.view' },
        { key: 'upload.reports' },
        { key: 'asset.manage' },
        { key: 'asset.view' },
        { key: 'asset.repair' },
        { key: 'asset.report' },
        { key: 'asset.mine' },
        { key: 'asset.approve_disposal' },
        { key: 'idcard.design' },
        { key: 'idcard.print' },
        { key: 'idcard.view' },
        { key: 'idcard.photos' },
        { key: 'idcard.verify' },
        { key: 'idcard.mine' },
        { key: 'inventory.manage' },
        { key: 'inventory.store' },
        { key: 'inventory.purchase' },
        { key: 'inventory.approve' },
        { key: 'inventory.request' },
        { key: 'inventory.sell' },
        { key: 'inventory.view' },
    ],
    principal: [{ key: 'user.view' }, { key: 'role.view' }, { key: 'masters.view' }, { key: 'academic.view' }, { key: 'academic.manage' }, { key: 'student.view' }, { key: 'student.view_sensitive' }, { key: 'staff.view' }, { key: 'staff.view_sensitive' }, { key: 'teaching.assign' }, { key: 'enquiry.view' }, { key: 'enquiry.reports' }, { key: 'fee.view' }, { key: 'fee.reports' }, { key: 'fee.concession' }, { key: 'timetable.view' }, { key: 'timetable.manage' }, { key: 'timetable.substitute' }, { key: 'timetable.mine' }, { key: 'report.view' }, { key: 'attendance.view' }, { key: 'attendance.mark' }, { key: 'attendance.mark_any' }, { key: 'attendance.holidays' }, { key: 'attendance.staff' }, { key: 'attendance.checkin' }, { key: 'leave.apply' }, { key: 'leave.approve' }, { key: 'leave.approve_all' }, { key: 'leave.view' }, { key: 'notice.create' }, { key: 'notice.publish' }, { key: 'notice.reports' }, { key: 'event.manage' }, { key: 'promotion.manage' }, { key: 'certificate.issue' }, { key: 'exam.setup' }, { key: 'exam.moderate' }, { key: 'exam.publish' }, { key: 'exam.view' }, { key: 'exam.marks_any' }, { key: 'message.send' }, { key: 'message.send_groups' }, { key: 'message.attach_documents' }, { key: 'message.schedule' }, { key: 'message.sms_whatsapp' }, { key: 'message.view_sent' }, { key: 'alert.setup' }, { key: 'alert.custom' }, { key: 'alert.log' }, { key: 'alert.templates' }, { key: 'homework.view' }, { key: 'homework.check' }, { key: 'syllabus.manage' }, { key: 'question.view' }, { key: 'question.approve' }, { key: 'ai.generate' }, { key: 'ai.usage' }, { key: 'test.view' }, { key: 'test.mark' }, { key: 'learn.view' }, { key: 'transport.view' }, { key: 'transport.track_all' }, { key: 'library.view' }, { key: 'library.mine' }, { key: 'ptm.manage' }, { key: 'ptm.desk' }, { key: 'ptm.meet' }, { key: 'visitor.view' }, { key: 'visitor.manage' }, { key: 'visitor.expect' }, { key: 'complaint.raise' }, { key: 'complaint.handle' }, { key: 'complaint.manage' }, { key: 'discipline.record' }, { key: 'discipline.view' }, { key: 'discipline.action' }, { key: 'discipline.approve' }, { key: 'feedback.manage' }, { key: 'feedback.results' }, { key: 'upload.manage' }, { key: 'upload.view' }, { key: 'upload.reports' }, { key: 'asset.view' }, { key: 'asset.approve_disposal' }, { key: 'asset.report' }, { key: 'asset.mine' }, { key: 'idcard.view' }, { key: 'idcard.verify' }, { key: 'idcard.mine' }, { key: 'inventory.approve' }, { key: 'inventory.view' }, { key: 'inventory.request' }],
    // Teachers see the students of the sections they teach, and their own staff record.
    teacher: [{ key: 'student.view', scope: 'assigned' }, { key: 'staff.view', scope: 'own' }, { key: 'fee.view', scope: 'assigned' }, { key: 'timetable.mine' }, { key: 'attendance.view', scope: 'assigned' }, { key: 'attendance.mark' }, { key: 'attendance.checkin' }, { key: 'leave.apply' }, { key: 'leave.approve' }, { key: 'exam.marks' }, { key: 'exam.view', scope: 'assigned' }, { key: 'message.send', scope: 'assigned' }, { key: 'message.view_sent', scope: 'own' }, { key: 'homework.give', scope: 'assigned' }, { key: 'homework.check' }, { key: 'homework.view', scope: 'assigned' }, { key: 'syllabus.manage', scope: 'assigned' }, { key: 'question.view', scope: 'assigned' }, { key: 'question.add', scope: 'assigned' }, { key: 'ai.generate' }, { key: 'test.create', scope: 'assigned' }, { key: 'test.mark' }, { key: 'test.view', scope: 'assigned' }, { key: 'learn.view', scope: 'assigned' }, { key: 'library.mine' }, { key: 'ptm.meet' }, { key: 'visitor.expect' }, { key: 'complaint.raise' }, { key: 'complaint.handle' }, { key: 'discipline.record', scope: 'assigned' }, { key: 'discipline.view', scope: 'assigned' }, { key: 'feedback.own' }, { key: 'upload.add' }, { key: 'upload.view' }, { key: 'asset.report' }, { key: 'asset.mine' }, { key: 'idcard.mine' }, { key: 'inventory.request' }],
    // Class teachers see the students of their own sections.
    'class-teacher': [{ key: 'student.view', scope: 'assigned' }, { key: 'staff.view', scope: 'own' }, { key: 'fee.view', scope: 'assigned' }, { key: 'timetable.mine' }, { key: 'attendance.view', scope: 'assigned' }, { key: 'attendance.mark' }, { key: 'attendance.checkin' }, { key: 'leave.apply' }, { key: 'leave.approve' }, { key: 'exam.marks' }, { key: 'exam.view', scope: 'assigned' }, { key: 'message.send', scope: 'assigned' }, { key: 'message.view_sent', scope: 'own' }, { key: 'homework.give', scope: 'assigned' }, { key: 'homework.check' }, { key: 'homework.view', scope: 'assigned' }, { key: 'syllabus.manage', scope: 'assigned' }, { key: 'question.view', scope: 'assigned' }, { key: 'question.add', scope: 'assigned' }, { key: 'ai.generate' }, { key: 'test.create', scope: 'assigned' }, { key: 'test.mark' }, { key: 'test.view', scope: 'assigned' }, { key: 'learn.view', scope: 'assigned' }, { key: 'library.mine' }, { key: 'ptm.meet' }, { key: 'visitor.expect' }, { key: 'complaint.raise' }, { key: 'complaint.handle' }, { key: 'discipline.record', scope: 'assigned' }, { key: 'discipline.view', scope: 'assigned' }, { key: 'discipline.action' }, { key: 'feedback.own' }, { key: 'upload.add' }, { key: 'upload.view' }, { key: 'asset.report' }, { key: 'asset.mine' }, { key: 'idcard.photos', scope: 'assigned' }, { key: 'idcard.mine' }, { key: 'inventory.request' }],
    'office-staff': [{ key: 'masters.view' }, { key: 'academic.view' }, { key: 'student.view' }, { key: 'student.create' }, { key: 'student.update' }, { key: 'student.import' }, { key: 'staff.view' }, { key: 'staff.create' }, { key: 'staff.update' }, { key: 'enquiry.view' }, { key: 'enquiry.manage' }, { key: 'enquiry.convert' }, { key: 'enquiry.reports' }, { key: 'fee.view' }, { key: 'fee.collect' }, { key: 'timetable.view' }, { key: 'timetable.substitute' }, { key: 'report.view' }, { key: 'attendance.view' }, { key: 'attendance.mark' }, { key: 'attendance.mark_any' }, { key: 'attendance.holidays' }, { key: 'attendance.staff' }, { key: 'attendance.checkin' }, { key: 'leave.apply' }, { key: 'leave.approve' }, { key: 'leave.view' }, { key: 'leave.manage' }, { key: 'notice.create' }, { key: 'notice.reports' }, { key: 'event.manage' }, { key: 'tc.manage' }, { key: 'tc.clear' }, { key: 'certificate.issue' }, { key: 'exam.setup' }, { key: 'exam.marks_any' }, { key: 'exam.view' }, { key: 'message.send' }, { key: 'message.send_groups' }, { key: 'message.attach_documents' }, { key: 'message.schedule' }, { key: 'message.view_sent' }, { key: 'alert.log' }, { key: 'alert.templates' }, { key: 'homework.view' }, { key: 'test.view' }, { key: 'transport.view' }, { key: 'transport.manage' }, { key: 'transport.track_all' }, { key: 'library.view' }, { key: 'library.issue' }, { key: 'ptm.desk' }, { key: 'visitor.gate' }, { key: 'visitor.view' }, { key: 'visitor.expect' }, { key: 'complaint.raise' }, { key: 'complaint.handle' }, { key: 'discipline.record' }, { key: 'discipline.view' }, { key: 'upload.manage' }, { key: 'upload.view' }, { key: 'upload.reports' }, { key: 'asset.manage' }, { key: 'asset.view' }, { key: 'asset.repair' }, { key: 'asset.report' }, { key: 'asset.mine' }, { key: 'idcard.design' }, { key: 'idcard.print' }, { key: 'idcard.view' }, { key: 'idcard.photos' }, { key: 'idcard.verify' }, { key: 'idcard.mine' }, { key: 'inventory.manage' }, { key: 'inventory.store' }, { key: 'inventory.purchase' }, { key: 'inventory.sell' }, { key: 'inventory.view' }, { key: 'inventory.request' }],
    // The accountant runs fees: set-up, counter, concessions and reports (cancelling stays with the admin).
    accountant: [{ key: 'masters.view' }, { key: 'transport.view' }, { key: 'academic.view' }, { key: 'fee.setup' }, { key: 'fee.view' }, { key: 'fee.collect' }, { key: 'fee.concession' }, { key: 'fee.reports' }, { key: 'report.view' }, { key: 'attendance.checkin' }, { key: 'leave.apply' }, { key: 'leave.approve' }, { key: 'message.send' }, { key: 'message.view_sent', scope: 'own' }, { key: 'complaint.raise' }, { key: 'complaint.handle' }, { key: 'upload.view' }, { key: 'asset.view' }, { key: 'asset.report' }, { key: 'asset.mine' }, { key: 'idcard.mine' }, { key: 'inventory.purchase' }, { key: 'inventory.view' }, { key: 'inventory.request' }],
    // A student sees their own record; a parent sees their children.
    // My Fees shows their own fees and receipts (fee.view is the office's list of everyone's).
    student: [{ key: 'student.view', scope: 'own' }, { key: 'fee.pay_online' }, { key: 'timetable.mine' }, { key: 'attendance.mine' }, { key: 'exam.mine' }, { key: 'homework.mine' }, { key: 'test.take' }, { key: 'learn.use' }, { key: 'transport.track_mine' }, { key: 'library.mine' }, { key: 'ptm.mine' }, { key: 'complaint.raise' }, { key: 'discipline.mine' }, { key: 'feedback.give' }, { key: 'upload.view' }, { key: 'idcard.mine' }],
    guardian: [{ key: 'student.view', scope: 'own' }, { key: 'fee.pay_online' }, { key: 'timetable.mine' }, { key: 'attendance.mine' }, { key: 'exam.mine' }, { key: 'homework.mine' }, { key: 'test.take' }, { key: 'learn.view', scope: 'own' }, { key: 'transport.track_mine' }, { key: 'library.mine' }, { key: 'ptm.mine' }, { key: 'visitor.pickup_mine' }, { key: 'complaint.raise' }, { key: 'discipline.mine' }, { key: 'feedback.give' }, { key: 'upload.view' }, { key: 'idcard.mine' }],
    // The guard runs the gate.
    'security-guard': [{ key: 'visitor.gate' }, { key: 'attendance.checkin' }, { key: 'leave.apply' }, { key: 'complaint.raise' }, { key: 'upload.view' }, { key: 'asset.report' }, { key: 'asset.mine' }, { key: 'idcard.verify' }, { key: 'idcard.mine' }, { key: 'inventory.request' }],
    // The librarian runs the library.
    librarian: [{ key: 'library.view' }, { key: 'library.manage' }, { key: 'library.issue' }, { key: 'library.fines' }, { key: 'library.mine' }, { key: 'student.view' }, { key: 'staff.view', scope: 'own' }, { key: 'attendance.checkin' }, { key: 'leave.apply' }, { key: 'report.view' }, { key: 'complaint.raise' }, { key: 'upload.view' }, { key: 'asset.report' }, { key: 'asset.mine' }, { key: 'idcard.verify' }, { key: 'idcard.mine' }, { key: 'inventory.request' }],
    // Drivers and bus helpers run the trips of their own routes.
    driver: [{ key: 'transport.drive' }, { key: 'attendance.checkin' }, { key: 'leave.apply' }, { key: 'complaint.raise' }, { key: 'upload.view' }, { key: 'asset.report' }, { key: 'asset.mine' }, { key: 'idcard.verify' }, { key: 'idcard.mine' }, { key: 'inventory.request' }],
    // The storekeeper keeps the store (items, receiving, issuing, counts, student sales).
    storekeeper: [{ key: 'inventory.manage' }, { key: 'inventory.store' }, { key: 'inventory.view' }, { key: 'inventory.request' }, { key: 'inventory.sell' }, { key: 'attendance.checkin' }, { key: 'leave.apply' }, { key: 'complaint.raise' }, { key: 'upload.view' }, { key: 'asset.report' }, { key: 'asset.mine' }, { key: 'idcard.mine' }],
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
