import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/**
 * System Settings → Inventory (numbers, approvals, GST, student sales, expiry, negative stock) and its
 * lists (Masters → Inventory): item categories, units and stores. Vendors are the shared list in
 * Masters → Assets → Vendors. Who keeps the store, buys or approves is in Roles & Permissions (inventory.*).
 */

const G = 'Inventory';
const bool = (key: string, label: string, def: boolean, help?: string) => defineSetting<boolean>({ key, group: G, label, help, type: 'boolean', default: def, schema: z.boolean() });
const num = (key: string, label: string, def: number, min: number, max: number, help?: string) =>
    defineSetting<number>({ key, group: G, label, help, type: 'number', default: def, schema: z.number().int().min(min).max(max) });
const text = (key: string, label: string, def: string) => defineSetting<string>({ key, group: G, label, type: 'text', default: def, schema: z.string().trim().max(10) });

export const INVENTORY = {
    itemPrefix: text('inventory.item_prefix', 'Item codes start with', 'ITM-'),
    poPrefix: text('inventory.po_prefix', 'Purchase order numbers start with', 'PO-'),
    grnPrefix: text('inventory.grn_prefix', 'Goods receipt numbers start with', 'GRN-'),
    requestPrefix: text('inventory.request_prefix', 'Request numbers start with', 'REQ-'),
    salePrefix: text('inventory.sale_prefix', 'Sale numbers start with', 'SL-'),
    requestApproval: num('inventory.request_approval', 'Staff requests worth more than this need approval (₹, 0 = every request)', 2000, 0, 10_000_000),
    poApproval: num('inventory.po_approval', 'Purchase orders worth more than this need approval (₹, 0 = every order)', 10_000, 0, 100_000_000),
    gst: bool('inventory.gst', 'Record GST on purchases', true),
    negative: bool('inventory.negative', 'Allow issuing more than the stock shows (stock goes below zero)', false),
    expiryDays: num('inventory.expiry_days', 'Remind about batches expiring within this many days', 30, 1, 365),
    sales: bool('inventory.sales', 'Sell items to students (uniform, diary, notebooks…)', true),
    salesTo: defineSetting<string>({
        key: 'inventory.sales_to',
        group: G,
        label: 'Student purchases are paid',
        type: 'select',
        default: 'fees',
        schema: z.enum(['fees', 'counter']),
        options: [
            { value: 'fees', label: 'With the fees (added to the next instalment)' },
            { value: 'counter', label: 'At the store counter (receipt)' },
        ],
    }),
    feeHeadCode: defineSetting<string>({ key: 'inventory.fee_head_code', group: G, label: 'Fee head student purchases are charged under (its code in Masters → Fee heads)', type: 'text', default: 'STORE', schema: z.string().trim().min(1).max(20) }),
};

defineMasterGroup({ key: 'inventory', label: 'Inventory', order: 25 });

defineMaster({
    key: 'inv_category',
    label: 'Item category',
    plural: 'Item categories',
    group: 'inventory',
    order: 10,
    code: 'none',
    ordering: 'manual',
    fields: [{ key: 'expiry', label: 'Items have an expiry date (kept in batches)', type: 'boolean' }],
    seed: [
        { name: 'Stationery', extra: { expiry: false } },
        { name: 'Cleaning & housekeeping', extra: { expiry: false } },
        { name: 'Lab consumables', extra: { expiry: true } },
        { name: 'Sports', extra: { expiry: false } },
        { name: 'Electrical', extra: { expiry: false } },
        { name: 'Printing & toner', extra: { expiry: false } },
        { name: 'Uniform', extra: { expiry: false } },
        { name: 'Books & diaries', extra: { expiry: false } },
        { name: 'Medical (first aid)', extra: { expiry: true } },
        { name: 'Other', extra: { expiry: false } },
    ],
});

defineMaster({
    key: 'inv_unit',
    label: 'Unit',
    plural: 'Units',
    group: 'inventory',
    order: 20,
    code: 'none',
    ordering: 'manual',
    seed: ['Piece', 'Box', 'Packet', 'Ream', 'Dozen', 'Set', 'Pair', 'Bottle', 'Litre', 'Kg', 'Roll', 'Metre'].map((name) => ({ name })),
});

defineMaster({
    key: 'inv_store',
    label: 'Store',
    plural: 'Stores',
    description: 'Places where stock is kept (each keeps its own stock).',
    group: 'inventory',
    order: 30,
    code: 'none',
    ordering: 'manual',
    seed: [{ name: 'Main store' }, { name: 'Science lab store' }, { name: 'Sports room' }],
});
