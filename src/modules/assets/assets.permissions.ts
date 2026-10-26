import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import './assets.settings';

registerPermissions({ key: 'asset', label: 'Assets', order: 58 }, [
    { resource: 'asset', action: 'manage', label: 'Add and change assets, move and assign them, verification, ask to write off' },
    { resource: 'asset', action: 'view', label: 'See the asset register and reports' },
    { resource: 'asset', action: 'repair', label: 'Work on reported problems (repairs) and record maintenance' },
    { resource: 'asset', action: 'report', label: 'Report a problem with an asset (broken projector…)' },
    { resource: 'asset', action: 'mine', label: 'See the assets given to them' },
    { resource: 'asset', action: 'approve_disposal', label: 'Approve or refuse writing an asset off' },
]);

registerMenuGroup({ key: 'assets', label: 'Assets', order: 24 });
registerMenuItems([
    { key: 'assets-register', app: false, label: 'Asset Register', icon: 'inventory_2', href: '/assets', group: 'assets', order: 10, anyPermission: ['asset.manage', 'asset.view'] },
    { key: 'assets-repairs', app: false, label: 'Repairs & Maintenance', icon: 'build', href: '/assets/repairs', group: 'assets', order: 20, anyPermission: ['asset.repair', 'asset.manage', 'asset.approve_disposal'] },
    { key: 'assets-verify', label: 'Asset Verification', icon: 'fact_check', href: '/assets/verify', group: 'assets', order: 30, permission: 'asset.manage' },
    { key: 'assets-mine', label: 'My Assets', icon: 'devices', href: '/my-assets', group: 'main', order: 37, anyPermission: ['asset.mine', 'asset.report'] },
]);

registerMasterUsage('asset_category', { label: 'assets', count: (ids) => db.asset.count({ where: { categoryId: { in: ids } } }) });
registerMasterUsage('asset_condition', { label: 'assets', count: (ids) => db.asset.count({ where: { conditionId: { in: ids } } }) });
registerMasterUsage('asset_vendor', { label: 'assets or repairs', count: async (ids) => (await db.asset.count({ where: { vendorId: { in: ids } } })) + (await db.assetIssue.count({ where: { vendorId: { in: ids } } })) });
registerMasterUsage('room', { label: 'assets', count: (ids) => db.asset.count({ where: { roomId: { in: ids } } }) });
