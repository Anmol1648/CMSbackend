import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import './mess.settings';

registerPermissions({ key: 'mess', label: 'Mess', order: 64 }, [
    { resource: 'mess', action: 'setup', label: 'Set up mess plans and the menu' },
    { resource: 'mess', action: 'manage', label: 'Run the mess: members, skipped meals, headcount, guests and kitchen costs' },
    { resource: 'mess', action: 'counter', label: 'Mark meals served at the counter' },
    { resource: 'mess', action: 'view', label: 'See the mess, its members and reports' },
    { resource: 'mess', action: 'mine', label: 'See their (child’s) mess plan and menu; skip meals; rate meals' },
]);

registerMenuGroup({ key: 'mess', label: 'Mess', order: 30 });
registerMenuItems([
    { key: 'mess-today', label: 'Mess Today', icon: 'restaurant', href: '/mess', group: 'mess', order: 10, anyPermission: ['mess.manage', 'mess.view', 'mess.setup', 'mess.counter'] },
    { key: 'mess-counter', label: 'Mess Counter', icon: 'qr_code_scanner', href: '/mess/counter', group: 'mess', order: 20, anyPermission: ['mess.counter', 'mess.manage'] },
    { key: 'mess-members', app: false, label: 'Mess Members', icon: 'groups', href: '/mess/members', group: 'mess', order: 30, anyPermission: ['mess.manage', 'mess.view'] },
    { key: 'mess-menu', app: false, label: 'Menu & Plans', icon: 'menu_book', href: '/mess/menu', group: 'mess', order: 40, anyPermission: ['mess.setup', 'mess.manage', 'mess.view'] },
    { key: 'mess-mine', label: 'My Mess', icon: 'restaurant', href: '/my-mess', group: 'main', order: 42, permission: 'mess.mine' },
]);

registerMasterUsage('mess_meal', { label: 'menu entries', count: (ids) => db.messMenu.count({ where: { mealId: { in: ids } } }) });
