import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuItems } from '../../core/registry/menu';

registerPermissions({ key: 'dashboard', label: 'Dashboard', order: 5 }, [{ resource: 'dashboard', action: 'setup', label: 'Choose the widgets on each role’s dashboard' }]);

registerMenuItems([{ key: 'dashboard-setup', label: 'Dashboard Setup', icon: 'dashboard_customize', href: '/dashboard/setup', group: 'setup', order: 90, permission: 'dashboard.setup' }]);
