import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import './attendance.settings';

registerPermissions({ key: 'attendance', label: 'Attendance', order: 35 }, [
    {
        resource: 'attendance',
        action: 'view',
        label: 'See student attendance: the day’s registers and attendance reports',
        description: 'Assigned = the sections they are class or subject teacher of.',
        scopes: ['all', 'assigned'],
    },
    { resource: 'attendance', action: 'mark', label: 'Mark the attendance of the sections they are class teacher of' },
    { resource: 'attendance', action: 'mark_any', label: 'Mark or change any section’s attendance, on any day (office, principal)' },
    { resource: 'attendance', action: 'holidays', label: 'Keep the holiday list' },
    { resource: 'attendance', action: 'mine', label: 'See their own attendance (students) or their children’s (parents)' },
    { resource: 'attendance', action: 'checkin', label: 'Check in and check out themselves (staff)' },
    { resource: 'attendance', action: 'staff', label: 'See and correct staff attendance' },
]);

registerMenuGroup({ key: 'attendance', label: 'Attendance', order: 12 });
registerMenuItems([
    { key: 'attendance-mark', label: 'Mark Attendance', icon: 'how_to_reg', href: '/attendance/mark', group: 'attendance', order: 10, permission: 'attendance.mark' },
    { key: 'attendance-today', label: 'Attendance Today', icon: 'fact_check', href: '/attendance', group: 'attendance', order: 20, permission: 'attendance.view' },
    { key: 'attendance-leave', label: 'Leave Requests', icon: 'event_available', href: '/attendance/leave', group: 'attendance', order: 25, permission: 'attendance.mark' },
    { key: 'attendance-staff', label: 'Staff Attendance', icon: 'badge', href: '/attendance/staff', group: 'attendance', order: 30, permission: 'attendance.staff' },
    { key: 'attendance-holidays', label: 'Holidays', icon: 'event_busy', href: '/attendance/holidays', group: 'attendance', order: 40, permission: 'attendance.holidays' },
    { key: 'my-attendance', label: 'My Attendance', icon: 'calendar_month', href: '/my-attendance', group: 'main', order: 25, permission: 'attendance.mine' },
    { key: 'my-check-in', label: 'Check In', icon: 'login', href: '/my-check-in', group: 'main', order: 5, permission: 'attendance.checkin' },
]);

registerMasterUsage('attendance_status', {
    label: 'attendance marks',
    count: async (ids) => (await db.attendanceMark.count({ where: { statusId: { in: ids } } })) + (await db.staffAttendance.count({ where: { statusId: { in: ids } } })),
});
