import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import './accounts.settings';

registerPermissions({ key: 'accounts', label: 'Accounts', order: 62 }, [
    { resource: 'accounts', action: 'setup', label: 'Set up the chart of accounts, bank accounts and opening balances' },
    { resource: 'accounts', action: 'entry', label: 'Make vouchers (receipts, payments, contra, journal) and post from fees, payroll and the store' },
    { resource: 'accounts', action: 'approve', label: 'Approve payments above the limit, cancel vouchers' },
    { resource: 'accounts', action: 'view', label: 'See the books and financial statements' },
    { resource: 'accounts', action: 'reconcile', label: 'Reconcile bank accounts with the bank statement' },
    { resource: 'accounts', action: 'close', label: 'Close a financial year (carry balances forward)' },
]);

registerMenuGroup({ key: 'accounts', label: 'Accounts', order: 28 });
registerMenuItems([
    { key: 'acc-vouchers', app: false, label: 'Vouchers', icon: 'receipt', href: '/accounts', group: 'accounts', order: 10, anyPermission: ['accounts.entry', 'accounts.approve', 'accounts.view'] },
    { key: 'acc-books', app: false, label: 'Books & Ledgers', icon: 'menu_book', href: '/accounts/books', group: 'accounts', order: 20, permission: 'accounts.view' },
    { key: 'acc-statements', app: false, label: 'Financial Statements', icon: 'account_balance', href: '/accounts/statements', group: 'accounts', order: 30, permission: 'accounts.view' },
    { key: 'acc-bank', app: false, label: 'Bank Reconciliation', icon: 'rule', href: '/accounts/bank', group: 'accounts', order: 40, permission: 'accounts.reconcile' },
    { key: 'acc-setup', app: false, label: 'Chart of Accounts', icon: 'account_tree', href: '/accounts/setup', group: 'accounts', order: 50, anyPermission: ['accounts.setup', 'accounts.close'] },
]);
