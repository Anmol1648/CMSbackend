import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/**
 * System Settings → Visitors (gate rules, passes, pickups), and its lists (Masters → Visitors). Who
 * runs the gate, sees the log, manages the blacklist or adds pickup people is in Roles & Permissions
 * (visitor.*).
 */

const G = 'Visitors';
const bool = (key: string, label: string, def: boolean, help?: string) => defineSetting<boolean>({ key, group: G, label, help, type: 'boolean', default: def, schema: z.boolean() });

export const VISITORS = {
    photoRequired: bool('visitors.photo_required', 'A photo is taken of every visitor', false, 'On: the pass can’t be given without a photo.'),
    idRequired: bool('visitors.id_required', 'Visitors show an ID proof (type and number)', false),
    approval: bool('visitors.approval', 'A visitor meeting a staff member waits for their OK', false, 'The staff member gets a notification with Allow / Not now; the gate sees the answer.'),
    passPrefix: defineSetting<string>({ key: 'visitors.pass_prefix', group: G, label: 'Gate pass numbers start with', help: 'Then the date and a running number, e.g. VP-261024-007.', type: 'text', default: 'VP-', schema: z.string().trim().max(10) }),
    passSize: defineSetting<string>({
        key: 'visitors.pass_size',
        group: G,
        label: 'Gate pass size',
        type: 'select',
        default: 'a6',
        schema: z.enum(['a6', 'thermal']),
        options: [
            { value: 'a6', label: 'A6 (a quarter of A4)' },
            { value: 'thermal', label: 'Thermal receipt printer (80 mm)' },
        ],
    }),
    autoOut: defineSetting<string>({ key: 'visitors.auto_out', group: G, label: 'Visitors still inside are checked out at (school time; empty = never)', type: 'text', default: '19:00', schema: z.union([z.literal(''), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)]) }),
    parentsAddPickup: bool('visitors.parents_add_pickup', 'Parents can add people who may collect their child (My Pickup List)', true),
    pickupAlert: bool('visitors.pickup_alert', 'Tell the parents every time their child is collected early', true),
    unknownNeedsApproval: bool('visitors.unknown_needs_approval', 'Someone not on the pickup list needs the office’s OK to collect a child', true),
};

defineMasterGroup({ key: 'visitors', label: 'Visitors', order: 20 });

defineMaster({
    key: 'visit_purpose',
    label: 'Visit purpose',
    plural: 'Visit purposes',
    group: 'visitors',
    order: 10,
    code: 'none',
    ordering: 'manual',
    fields: [{ key: 'host', label: 'Usually meets', type: 'select', options: [{ value: 'staff', label: 'A staff member' }, { value: 'student', label: 'About a student' }, { value: 'office', label: 'The office' }] }],
    seed: [
        { name: 'Meet a teacher', extra: { host: 'staff' } },
        { name: 'Parent: about my child', extra: { host: 'student' } },
        { name: 'Fees / office work', extra: { host: 'office' } },
        { name: 'Admission enquiry', extra: { host: 'office' } },
        { name: 'Delivery / courier', extra: { host: 'office' } },
        { name: 'Vendor / contractor', extra: { host: 'office' } },
        { name: 'Interview', extra: { host: 'staff' } },
        { name: 'Official visit / inspection', extra: { host: 'office' } },
        { name: 'Other', extra: { host: 'office' } },
    ],
});

defineMaster({
    key: 'visitor_id_type',
    label: 'Visitor ID proof',
    plural: 'Visitor ID proofs',
    group: 'visitors',
    order: 20,
    code: 'none',
    ordering: 'manual',
    seed: ['Aadhaar card', 'Driving licence', 'Voter ID', 'PAN card', 'Passport', 'Company ID card', 'Other'].map((name) => ({ name })),
});

defineMaster({
    key: 'pickup_relation',
    label: 'Pickup relation',
    plural: 'Pickup relations',
    description: 'How someone on a student’s pickup list is related (the parents come from the family record).',
    group: 'visitors',
    order: 30,
    code: 'none',
    ordering: 'manual',
    seed: ['Grandfather', 'Grandmother', 'Uncle', 'Aunt', 'Elder brother', 'Elder sister', 'Neighbour', 'Family driver', 'Other'].map((name) => ({ name })),
});
