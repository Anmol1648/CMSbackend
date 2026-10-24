import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/**
 * System Settings → Hostel (roll call time, leave approval, late return, fee heads) and the room types
 * (Masters → Hostel: each with its fee per instalment). Hostels and rooms have their own screen; who
 * allots, runs the hostel or checks passes is in Roles & Permissions (hostel.*).
 */

const G = 'Hostel';
const num = (key: string, label: string, def: number, min: number, max: number, help?: string) =>
    defineSetting<number>({ key, group: G, label, help, type: 'number', default: def, schema: z.number().int().min(min).max(max) });

export const HOSTEL = {
    rollCallTime: defineSetting<string>({ key: 'hostel.roll_call_time', group: G, label: 'Night roll call time (24-hour)', help: 'Wardens are reminded if it is not taken by then.', type: 'text', default: '21:00', schema: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }),
    principalDays: num('hostel.principal_days', 'Leave longer than this many days also needs the principal (0 = warden only)', 7, 0, 60),
    lateMinutes: num('hostel.late_minutes', 'A boarder back more than this many minutes after the pass ends is late', 30, 0, 600),
    feeHeadCode: defineSetting<string>({ key: 'hostel.fee_head_code', group: G, label: 'Fee head the hostel fee and fines are charged under (its code in Masters → Fee heads)', type: 'text', default: 'HOSTEL', schema: z.string().trim().min(1).max(20) }),
    parentLeave: defineSetting<boolean>({ key: 'hostel.parent_leave', group: G, label: 'Parents can ask for leave from the app', type: 'boolean', default: true, schema: z.boolean() }),
};

defineMasterGroup({ key: 'hostel', label: 'Hostel', order: 27 });
defineMaster({
    key: 'hostel_room_type',
    label: 'Hostel room type',
    plural: 'Hostel room types',
    description: 'Kinds of rooms and their fee for each fee instalment (added to the boarder’s fees).',
    group: 'hostel',
    order: 10,
    code: 'none',
    ordering: 'manual',
    fields: [{ key: 'fee', label: 'Fee per instalment (₹)', type: 'number', required: true, example: '18000' }],
    seed: [
        { name: 'Dormitory (6–8 beds)', extra: { fee: 15000 } },
        { name: 'Four-seater', extra: { fee: 18000 } },
        { name: 'Two-seater', extra: { fee: 22000 } },
        { name: 'Two-seater with AC', extra: { fee: 28000 } },
    ],
});
