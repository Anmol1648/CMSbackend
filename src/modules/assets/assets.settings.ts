import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/**
 * System Settings → Assets (codes, depreciation, reminders, disposal approval), and its lists
 * (Masters → Assets): categories (with depreciation and maintenance interval), conditions, vendors.
 * Locations are Masters → Rooms & labs. Who manages, repairs or approves is in Roles & Permissions (asset.*).
 */

const G = 'Assets';
const bool = (key: string, label: string, def: boolean, help?: string) => defineSetting<boolean>({ key, group: G, label, help, type: 'boolean', default: def, schema: z.boolean() });
const num = (key: string, label: string, def: number, min: number, max: number, help?: string) =>
    defineSetting<number>({ key, group: G, label, help, type: 'number', default: def, schema: z.number().int().min(min).max(max) });

export const ASSETS = {
    codePrefix: defineSetting<string>({ key: 'assets.code_prefix', group: G, label: 'Asset codes start with', help: 'Then a running number, e.g. AST-00042 (printed on the QR label).', type: 'text', default: 'AST-', schema: z.string().trim().max(10) }),
    codeDigits: num('assets.code_digits', 'Digits in the running number', 5, 3, 8),
    depreciation: bool('assets.depreciation', 'Work out the present value (straight-line depreciation, % per year on each category)', true),
    warrantyDays: num('assets.warranty_days', 'Remind about warranties / AMCs ending within this many days', 30, 1, 180),
    maintenanceDays: num('assets.maintenance_days', 'Remind about maintenance due within this many days', 7, 0, 90),
    disposalApproval: bool('assets.disposal_approval', 'Writing an asset off needs approval', true),
};

defineMasterGroup({ key: 'assets', label: 'Assets', order: 24 });

defineMaster({
    key: 'asset_category',
    label: 'Asset category',
    plural: 'Asset categories',
    group: 'assets',
    order: 10,
    code: 'none',
    ordering: 'manual',
    fields: [
        { key: 'depreciation', label: 'Depreciation % per year', type: 'number' },
        { key: 'maintain_every', label: 'Maintenance every (months, 0 = none)', type: 'number' },
    ],
    seed: [
        { name: 'Furniture', extra: { depreciation: 10, maintain_every: 0 } },
        { name: 'Computers & IT', extra: { depreciation: 40, maintain_every: 12 } },
        { name: 'Projectors & AV', extra: { depreciation: 20, maintain_every: 12 } },
        { name: 'Lab equipment', extra: { depreciation: 15, maintain_every: 12 } },
        { name: 'Electrical (AC, fans, inverter)', extra: { depreciation: 15, maintain_every: 12 } },
        { name: 'Fire safety', extra: { depreciation: 10, maintain_every: 6 } },
        { name: 'Sports equipment', extra: { depreciation: 20, maintain_every: 0 } },
        { name: 'Musical instruments', extra: { depreciation: 15, maintain_every: 0 } },
        { name: 'Office equipment', extra: { depreciation: 20, maintain_every: 12 } },
        { name: 'Other', extra: { depreciation: 10, maintain_every: 0 } },
    ],
});

defineMaster({
    key: 'asset_condition',
    label: 'Asset condition',
    plural: 'Asset conditions',
    group: 'assets',
    order: 20,
    code: 'none',
    ordering: 'manual',
    seed: ['New', 'Good', 'Fair', 'Needs repair', 'Damaged', 'Out of use'].map((name) => ({ name })),
});

defineMaster({
    key: 'asset_vendor',
    label: 'Vendor',
    plural: 'Vendors',
    description: 'Suppliers and repair vendors.',
    group: 'assets',
    order: 30,
    code: 'none',
    ordering: 'name',
    fields: [
        { key: 'phone', label: 'Phone', type: 'text', max: 20 },
        { key: 'gstin', label: 'GSTIN', type: 'text', max: 20 },
    ],
    seed: [],
});
