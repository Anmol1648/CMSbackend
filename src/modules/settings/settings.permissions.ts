import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuItems } from '../../core/registry/menu';

registerPermissions({ key: 'settings', label: 'System settings', order: 85 }, [
    { resource: 'settings', action: 'view', label: 'See system settings' },
    { resource: 'settings', action: 'update', label: 'Change system settings (sign-in, security, passwords…)' },
]);

registerMenuItems([
    { key: 'system-settings', label: 'System Settings', icon: 'tune', href: '/settings', group: 'setup', order: 50, permission: 'settings.view' },
    { key: 'email-templates', label: 'Email Templates', icon: 'mail', href: '/email-templates', group: 'setup', order: 55, permission: 'settings.view' },
]);
