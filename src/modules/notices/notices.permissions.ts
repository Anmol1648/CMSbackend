import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import './notices.settings';

registerPermissions({ key: 'communication', label: 'Notices & Events', order: 37 }, [
    { resource: 'notice', action: 'create', label: 'Write notices and circulars (and publish them, unless approval is switched on)' },
    { resource: 'notice', action: 'publish', label: 'Publish and approve notices (principal)' },
    { resource: 'notice', action: 'reports', label: 'See who has read each notice' },
    { resource: 'event', action: 'manage', label: 'Add and change events on the school calendar' },
]);

// Every signed-in person sees the notices and events meant for them.
registerMenuGroup({ key: 'communication', label: 'Notices & Events', order: 11 });
registerMenuItems([
    { key: 'notices', label: 'Notices', icon: 'campaign', href: '/notices', group: 'communication', order: 10 },
    { key: 'school-calendar', label: 'School Calendar', icon: 'event', href: '/events', group: 'communication', order: 20 },
    { key: 'notices-manage', label: 'Manage Notices', icon: 'edit_note', href: '/notices/manage', group: 'communication', order: 30, anyPermission: ['notice.create', 'notice.publish'] },
]);

registerMasterUsage('notice_category', { label: 'notices', count: (ids) => db.notice.count({ where: { categoryId: { in: ids } } }) });
registerMasterUsage('event_type', { label: 'events', count: (ids) => db.schoolEvent.count({ where: { typeId: { in: ids } } }) });
