import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { auditModel, db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import './fees.settings';
import './fees.masters';

registerPermissions({ key: 'fees', label: 'Fees', order: 40 }, [
    { resource: 'fee', action: 'setup', label: 'Set up fees: instalments, amounts per class, concessions' },
    { resource: 'fee', action: 'view', label: 'See students’ fees, dues and receipts', description: 'Assigned = students of the sections they teach; own = their own (or their children’s).', scopes: ['all', 'assigned', 'own'] },
    { resource: 'fee', action: 'collect', label: 'Take fees at the counter and print receipts' },
    { resource: 'fee', action: 'cancel', label: 'Cancel receipts', sensitive: true },
    { resource: 'fee', action: 'concession', label: 'Give concessions, waive fines and change a student’s dues' },
    { resource: 'fee', action: 'reports', label: 'See fee reports (collection, dues, class summary)' },
    { resource: 'fee', action: 'pay_online', label: 'Pay their own / their children’s fees online (My Fees)' },
    { resource: 'payment', action: 'configure', label: 'Set up the online payment gateway and see online payments', sensitive: true },
]);

registerMenuGroup({ key: 'fees', label: 'Fees', order: 15 });
registerMenuItems([
    { key: 'fee-collect', label: 'Collect Fees', icon: 'point_of_sale', href: '/fees/collect', group: 'fees', order: 10, permission: 'fee.collect' },
    { key: 'fee-receipts', label: 'Receipts', icon: 'receipt_long', href: '/fees/receipts', group: 'fees', order: 20, permission: 'fee.view' },
    { key: 'fee-dues', label: 'Fee Dues', icon: 'pending_actions', href: '/fees/dues', group: 'fees', order: 30, permission: 'fee.view' },
    { key: 'fee-reports', label: 'Fee Reports', icon: 'monitoring', href: '/fees/reports', group: 'fees', order: 40, permission: 'fee.reports' },
    { key: 'fee-setup', app: false, label: 'Fee Setup', icon: 'tune', href: '/fees/setup', group: 'fees', order: 50, permission: 'fee.setup' },
    { key: 'online-payments', label: 'Online Payments', icon: 'credit_card', href: '/fees/online', group: 'fees', order: 60, permission: 'payment.configure' },
    { key: 'my-fees', label: 'My Fees', icon: 'account_balance_wallet', href: '/my-fees', group: 'main', order: 20, permission: 'fee.pay_online' },
]);

auditModel('FeeInstalment', 'fee_instalment');
auditModel('FeeConcession', 'fee_concession');

registerMasterUsage('fee_head', {
    label: 'fee amounts, concessions or receipts',
    count: async (ids) =>
        (await db.feeStructureLine.count({ where: { feeHeadId: { in: ids } } })) +
        (await db.feeConcessionLine.count({ where: { feeHeadId: { in: ids } } })) +
        (await db.feeReceiptLine.count({ where: { feeHeadId: { in: ids } } })) +
        (await db.feeAdjustment.count({ where: { feeHeadId: { in: ids } } })),
});
for (const [master, column] of [
    ['gender', 'genderIds'],
    ['caste_category', 'casteCategoryIds'],
    ['student_category', 'categoryIds'],
] as const) {
    registerMasterUsage(master, { label: 'fee concessions', count: (ids) => db.feeConcession.count({ where: { [column]: { hasSome: ids } } }) });
}
