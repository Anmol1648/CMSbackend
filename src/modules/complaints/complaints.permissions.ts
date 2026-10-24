import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import './complaints.settings';

registerPermissions({ key: 'complaint', label: 'Complaints', order: 50 }, [
    { resource: 'complaint', action: 'raise', label: 'Raise complaints and follow their own (My Complaints)' },
    { resource: 'complaint', action: 'handle', label: 'Work on complaints assigned to them: reply, notes, mark resolved' },
    { resource: 'complaint', action: 'manage', label: 'See every complaint, assign and reassign, escalate, close; take complaints for walk-ins and calls' },
    { resource: 'complaint', action: 'view_anonymous', label: 'See who raised an anonymous complaint', description: 'Give this only if the school’s policy allows it.' },
]);

registerMenuGroup({ key: 'complaints', label: 'Complaints', order: 20 });
registerMenuItems([
    { key: 'complaints-desk', label: 'Complaints', icon: 'support_agent', href: '/complaints', group: 'complaints', order: 10, anyPermission: ['complaint.handle', 'complaint.manage'] },
    { key: 'complaints-mine', label: 'My Complaints', icon: 'feedback', href: '/my-complaints', group: 'main', order: 33, permission: 'complaint.raise' },
]);

registerMasterUsage('complaint_category', { label: 'complaints', count: (ids) => db.complaint.count({ where: { categoryId: { in: ids } } }) });
