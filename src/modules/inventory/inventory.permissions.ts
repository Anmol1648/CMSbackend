import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import './inventory.settings';

registerPermissions({ key: 'inventory', label: 'Inventory', order: 60 }, [
    { resource: 'inventory', action: 'manage', label: 'Add and change items' },
    { resource: 'inventory', action: 'store', label: 'Keep the store: receive goods, issue, return, transfer, count' },
    { resource: 'inventory', action: 'purchase', label: 'Make purchase orders to vendors' },
    { resource: 'inventory', action: 'approve', label: 'Approve requests, purchase orders, write-offs and count differences' },
    { resource: 'inventory', action: 'request', label: 'Ask the store for items (My Requests)' },
    { resource: 'inventory', action: 'sell', label: 'Sell items to students (uniform, diary…)' },
    { resource: 'inventory', action: 'view', label: 'See stock and inventory reports' },
]);

registerMenuGroup({ key: 'inventory', label: 'Inventory', order: 26 });
registerMenuItems([
    { key: 'inv-stock', label: 'Stock', icon: 'inventory', href: '/inventory', group: 'inventory', order: 10, anyPermission: ['inventory.view', 'inventory.store', 'inventory.manage'] },
    { key: 'inv-issue', label: 'Issue & Requests', icon: 'outbox', href: '/inventory/issue', group: 'inventory', order: 20, anyPermission: ['inventory.store', 'inventory.approve'] },
    { key: 'inv-purchase', app: false, label: 'Purchase & Receive', icon: 'local_shipping', href: '/inventory/purchase', group: 'inventory', order: 30, anyPermission: ['inventory.purchase', 'inventory.store', 'inventory.approve'] },
    { key: 'inv-sales', app: false, label: 'Student Sales', icon: 'point_of_sale', href: '/inventory/sales', group: 'inventory', order: 40, permission: 'inventory.sell' },
    { key: 'inv-count', app: false, label: 'Stock Count & Write-off', icon: 'fact_check', href: '/inventory/count', group: 'inventory', order: 50, anyPermission: ['inventory.store', 'inventory.approve'] },
    { key: 'inv-mine', label: 'My Requests', icon: 'shopping_basket', href: '/my-requests', group: 'main', order: 39, permission: 'inventory.request' },
]);

registerMasterUsage('inv_category', { label: 'items', count: (ids) => db.invItem.count({ where: { categoryId: { in: ids } } }) });
registerMasterUsage('inv_unit', { label: 'items', count: (ids) => db.invItem.count({ where: { unitId: { in: ids } } }) });
registerMasterUsage('inv_store', { label: 'stock entries', count: (ids) => db.invMove.count({ where: { storeId: { in: ids } } }) });
registerMasterUsage('asset_vendor', { label: 'purchase orders', count: (ids) => db.invPurchaseOrder.count({ where: { vendorId: { in: ids } } }) });
