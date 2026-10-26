import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import './leave.settings';

registerPermissions({ key: 'leave', label: 'Staff Leave', order: 36 }, [
    { resource: 'leave', action: 'apply', label: 'Ask for their own leave and see their balance (My Leave)' },
    { resource: 'leave', action: 'approve', label: 'Approve the leave of the staff who report to them' },
    { resource: 'leave', action: 'approve_all', label: 'Approve anyone’s leave (principal, HR): the final step' },
    { resource: 'leave', action: 'view', label: 'See everyone’s leave and balances (Leave Register, Balances)' },
    { resource: 'leave', action: 'manage', label: 'Record leave for others, adjust balances, give comp-offs, close the leave year' },
    { resource: 'leave', action: 'setup', label: 'Set up leave types and their rules' },
]);

registerMenuGroup({ key: 'leave', label: 'Staff Leave', order: 13 });
registerMenuItems([
    { key: 'my-leave', label: 'My Leave', icon: 'beach_access', href: '/my-leave', group: 'main', order: 26, permission: 'leave.apply' },
    { key: 'leave-approvals', label: 'Leave Approvals', icon: 'task_alt', href: '/leave/approvals', group: 'leave', order: 10, anyPermission: ['leave.approve', 'leave.approve_all'] },
    { key: 'leave-register', app: false, label: 'Leave Register', icon: 'event_note', href: '/leave', group: 'leave', order: 20, permission: 'leave.view' },
    { key: 'leave-balances', app: false, label: 'Leave Balances', icon: 'account_balance_wallet', href: '/leave/balances', group: 'leave', order: 30, permission: 'leave.view' },
    { key: 'leave-setup', app: false, label: 'Leave Setup', icon: 'tune', href: '/leave/setup', group: 'leave', order: 40, permission: 'leave.setup' },
]);
