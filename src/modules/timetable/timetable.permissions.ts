import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import './timetable.settings';

registerPermissions({ key: 'timetable', label: 'Timetable', order: 45 }, [
    { resource: 'timetable', action: 'view', label: 'See every class’s and teacher’s timetable, and free teachers' },
    { resource: 'timetable', action: 'manage', label: 'Set up, generate, edit and publish timetables' },
    { resource: 'timetable', action: 'substitute', label: 'Arrange substitutions for absent teachers' },
    { resource: 'timetable', action: 'mine', label: 'See their own timetable (My Timetable)' },
]);

registerMenuGroup({ key: 'timetable', label: 'Timetable', order: 17 });
registerMenuItems([
    { key: 'timetable', label: 'Timetable', icon: 'calendar_view_week', href: '/timetable', group: 'timetable', order: 10, permission: 'timetable.view' },
    { key: 'substitutions', label: 'Substitutions', icon: 'swap_horiz', href: '/timetable/substitutions', group: 'timetable', order: 20, permission: 'timetable.substitute' },
    { key: 'timetable-setup', label: 'Timetable Setup', icon: 'schedule', href: '/timetable/setup', group: 'timetable', order: 30, permission: 'timetable.manage' },
    { key: 'my-timetable', label: 'My Timetable', icon: 'event_note', href: '/my-timetable', group: 'main', order: 15, permission: 'timetable.mine' },
]);

registerMasterUsage('room', {
    label: 'subjects or timetable periods',
    count: async (ids) => (await db.ttLoad.count({ where: { roomId: { in: ids } } })) + (await db.ttEntry.count({ where: { roomId: { in: ids } } })),
});
registerMasterUsage('stream', { label: 'timetable periods', count: (ids) => db.ttLoad.count({ where: { streamId: { in: ids } } }) });
