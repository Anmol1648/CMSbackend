import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';

registerPermissions({ key: 'access', label: 'Users & roles', order: 90 }, [
    { resource: 'user', action: 'view', label: 'See users and their roles' },
    { resource: 'user', action: 'create', label: 'Create users' },
    { resource: 'user', action: 'update', label: 'Edit users, their roles and disable them' },
    { resource: 'user', action: 'reset_password', label: "Reset other users' passwords, unlock them, reset two-step sign-in" },
    { resource: 'role', action: 'view', label: 'See roles and what they allow' },
    { resource: 'role', action: 'manage', label: 'Create, edit and delete roles and their permissions' },
]);

registerMenuGroup({ key: 'main', label: '', order: 0 });
registerMenuGroup({ key: 'setup', label: 'Setup', order: 80 });

registerMenuItems([
    { key: 'home', label: 'Home', icon: 'home', href: '/', group: 'main', order: 0 },
    { key: 'users', app: false, label: 'Users', icon: 'group', href: '/users', group: 'setup', order: 30, permission: 'user.view' },
    { key: 'roles', app: false, label: 'Roles & Permissions', icon: 'admin_panel_settings', href: '/roles', group: 'setup', order: 40, permission: 'role.view' },
]);
