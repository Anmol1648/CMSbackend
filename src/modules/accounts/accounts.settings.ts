import { z } from 'zod';
import { defineSetting } from '../../core/settings';

/**
 * System Settings → Accounting: the financial year, voucher numbers, approval of payments, which
 * modules post their entries by themselves, and the cash-in-hand warning. The chart of accounts has
 * its own screen; who enters, approves or closes is in Roles & Permissions (accounts.*).
 */

const G = 'Accounting';
const bool = (key: string, label: string, def: boolean, help?: string) => defineSetting<boolean>({ key, group: G, label, help, type: 'boolean', default: def, schema: z.boolean() });
const num = (key: string, label: string, def: number, min: number, max: number, help?: string) =>
    defineSetting<number>({ key, group: G, label, help, type: 'number', default: def, schema: z.number().int().min(min).max(max) });

export const ACCOUNTS = {
    yearStartMonth: num('accounts.year_start_month', 'The financial year starts in month (4 = April)', 4, 1, 12),
    receiptPrefix: defineSetting<string>({ key: 'accounts.prefix_receipt', group: G, label: 'Receipt voucher numbers start with', type: 'text', default: 'RV', schema: z.string().trim().min(1).max(6) }),
    paymentPrefix: defineSetting<string>({ key: 'accounts.prefix_payment', group: G, label: 'Payment voucher numbers start with', type: 'text', default: 'PV', schema: z.string().trim().min(1).max(6) }),
    contraPrefix: defineSetting<string>({ key: 'accounts.prefix_contra', group: G, label: 'Contra voucher numbers start with', type: 'text', default: 'CV', schema: z.string().trim().min(1).max(6) }),
    journalPrefix: defineSetting<string>({ key: 'accounts.prefix_journal', group: G, label: 'Journal voucher numbers start with', type: 'text', default: 'JV', schema: z.string().trim().min(1).max(6) }),
    approvalAbove: num('accounts.approval_above', 'Payments above this need approval (₹, 0 = every payment)', 25000, 0, 100_000_000),
    postFees: bool('accounts.post_fees', 'Post fee collections by themselves (one receipt voucher a day)', true, 'Also library fines and store sales paid at the counter.'),
    postPayroll: bool('accounts.post_payroll', 'Post a finalised month’s payroll by itself', true),
    postStore: bool('accounts.post_store', 'Post goods received in the store as purchases (payable to the vendor)', true),
    postLoans: bool('accounts.post_loans', 'Post loans and advances given to staff', true),
    cashLimit: num('accounts.cash_limit', 'Warn when cash in hand is more than (₹, 0 = never)', 50000, 0, 100_000_000),
};
