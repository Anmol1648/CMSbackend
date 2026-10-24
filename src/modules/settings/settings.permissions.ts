import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuItems } from '../../core/registry/menu';

registerPermissions({ key: 'settings', label: 'System settings', order: 85 }, [
    { resource: 'settings', action: 'view', label: 'See system settings' },
    { resource: 'settings', action: 'update', label: 'Change system settings (sign-in, security, passwords…)' },
    { resource: 'menu', action: 'customize', label: 'Rename, reorder, regroup and hide menu items for the school (Menu Setup)' },
]);

registerMenuItems([
    { key: 'system-settings', label: 'System Settings', icon: 'tune', href: '/settings', group: 'setup', order: 50, permission: 'settings.view' },
    { key: 'menu-setup', label: 'Menu Setup', icon: 'menu_open', href: '/settings/menu', group: 'setup', order: 52, permission: 'menu.customize' },
    { key: 'email-templates', label: 'Email Templates', icon: 'mail', href: '/email-templates', group: 'setup', order: 55, permission: 'settings.view' },
]);
