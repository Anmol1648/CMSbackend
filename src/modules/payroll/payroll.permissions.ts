import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import './payroll.settings';

registerPermissions({ key: 'payroll', label: 'Payroll', order: 61 }, [
    { resource: 'payroll', action: 'setup', label: 'Set up payroll: pay heads, salary structures' },
    { resource: 'payroll', action: 'salary', label: 'See and change staff salaries, give increments' },
    { resource: 'payroll', action: 'run', label: 'Prepare the month’s payroll (and its additions / deductions)' },
    { resource: 'payroll', action: 'approve', label: 'Approve and finalise a month’s payroll, reopen it' },
    { resource: 'payroll', action: 'view', label: 'See payroll reports, payslips, bank sheets and statutory sheets' },
    { resource: 'payroll', action: 'loans', label: 'Give loans and salary advances' },
    { resource: 'payroll', action: 'mine', label: 'See their own payslips and loans' },
]);

registerMenuGroup({ key: 'payroll', label: 'Payroll', order: 27 });
registerMenuItems([
    { key: 'payroll-run', app: false, label: 'Monthly Payroll', icon: 'payments', href: '/payroll', group: 'payroll', order: 10, anyPermission: ['payroll.run', 'payroll.approve', 'payroll.view'] },
    { key: 'payroll-salaries', app: false, label: 'Staff Salaries', icon: 'account_balance_wallet', href: '/payroll/salaries', group: 'payroll', order: 20, permission: 'payroll.salary' },
    { key: 'payroll-loans', app: false, label: 'Loans & Advances', icon: 'savings', href: '/payroll/loans', group: 'payroll', order: 30, anyPermission: ['payroll.loans', 'payroll.view'] },
    { key: 'payroll-setup', app: false, label: 'Salary Structures', icon: 'tune', href: '/payroll/setup', group: 'payroll', order: 40, permission: 'payroll.setup' },
    { key: 'payroll-mine', label: 'My Payslips', icon: 'receipt_long', href: '/my-payslips', group: 'main', order: 40, permission: 'payroll.mine' },
]);

registerMasterUsage('pay_head', { label: 'salary structures', count: async (ids) => (await db.salaryStructure.findMany({ select: { lines: true } })).filter((s) => (s.lines as { headId: string }[]).some((l) => ids.includes(l.headId))).length });
