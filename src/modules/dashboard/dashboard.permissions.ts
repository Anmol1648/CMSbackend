import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuItems } from '../../core/registry/menu';

registerPermissions({ key: 'dashboard', label: 'Dashboard', order: 5 }, [
    { resource: 'dashboard', action: 'setup', label: 'Choose the widgets on each role’s dashboard' },
    { resource: 'dashboard', action: 'build', label: 'Make dashboard widgets (Widget Builder) and share them with roles', description: 'They only use data their other permissions allow; each viewer sees their own data.' },
]);

registerMenuItems([
    { key: 'dashboard-setup', label: 'Dashboard Setup', icon: 'dashboard_customize', href: '/dashboard/setup', group: 'setup', order: 90, permission: 'dashboard.setup' },
    { key: 'widget-builder', label: 'Widget Builder', icon: 'widgets', href: '/dashboard/widgets', group: 'setup', order: 91, permission: 'dashboard.build' },
]);
