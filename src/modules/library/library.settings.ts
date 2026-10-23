import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/**
 * System Settings → Library (lending rules, fines, numbering), and its lists (Masters → Library).
 * Who runs the counter, manages books or waives fines is in Roles & Permissions (library.*).
 * How many books each member type may take, and for how long, is Masters → Library member types.
 */

const G = 'Library';
const bool = (key: string, label: string, def: boolean, help?: string) => defineSetting<boolean>({ key, group: G, label, help, type: 'boolean', default: def, schema: z.boolean() });
const num = (key: string, label: string, def: number, min: number, max: number, help?: string) =>
    defineSetting<number>({ key, group: G, label, help, type: 'number', default: def, schema: z.number().int().min(min).max(max) });

export const LIBRARY = {
    accessionPrefix: defineSetting<string>({ key: 'library.accession_prefix', group: G, label: 'Accession numbers start with', help: 'Then a running number, e.g. LIB-00123. Printed on the label as a barcode.', type: 'text', default: 'LIB-', schema: z.string().trim().max(10) }),
    accessionDigits: num('library.accession_digits', 'Digits in the running number', 5, 3, 8),
    finePerDay: num('library.fine_per_day', 'Late fine per day (₹)', 2, 0, 1000),
    fineGraceDays: num('library.fine_grace_days', 'Days after the due date with no fine', 0, 0, 60),
    fineMax: num('library.fine_max', 'Most a late fine can be, per book (₹, 0 = no limit)', 100, 0, 100_000),
    fineHolidays: bool('library.fine_on_holidays', 'Count holidays and weekly offs in the late days', false, 'Off: only school days count, so a book due before a vacation isn’t fined for it.'),
    finesTo: defineSetting<string>({
        key: 'library.fines_to',
        group: G,
        label: 'Students’ fines are paid',
        help: 'With the fees: added to the next instalment, paid at the fee counter or online. Staff always pay at the library.',
        type: 'select',
        default: 'fees',
        schema: z.enum(['fees', 'counter']),
        options: [
            { value: 'fees', label: 'With the fees (added to the next instalment)' },
            { value: 'counter', label: 'At the library counter' },
        ],
    }),
    feeHeadCode: defineSetting<string>({ key: 'library.fee_head_code', group: G, label: 'Fee head the fines are charged under (its code in Masters → Fee heads)', type: 'text', default: 'LIB', schema: z.string().trim().min(1).max(20) }),
    lostCharge: defineSetting<string>({
        key: 'library.lost_charge',
        group: G,
        label: 'A lost book is charged',
        type: 'select',
        default: 'price',
        schema: z.enum(['price', 'fixed', 'price_plus']),
        options: [
            { value: 'price', label: 'Its price' },
            { value: 'price_plus', label: 'Its price plus the fixed amount below (processing)' },
            { value: 'fixed', label: 'The fixed amount below' },
        ],
    }),
    lostFixed: num('library.lost_fixed', 'Fixed amount for a lost book (₹)', 50, 0, 100_000),
    holdDays: num('library.hold_days', 'A reserved book is kept for the member this many days after it comes back', 3, 1, 30),
    maxReservations: num('library.max_reservations', 'Reservations one member can have at a time', 3, 0, 20, '0: members can’t reserve books themselves.'),
    blockOverdue: bool('library.block_overdue', 'No new book while the member has an overdue book', true),
    blockFineAbove: num('library.block_fine_above', 'No new book while unpaid fines are above (₹, 0 = don’t check)', 0, 0, 100_000),
    referenceIssue: bool('library.reference_issue', 'Reference books can be taken home', false),
    overdueEvery: num('library.overdue_every_days', 'Remind about an overdue book every this many days', 3, 1, 30),
    renewOnline: bool('library.renew_online', 'Members can renew their own books on My Library', true),
    newArrivalsDays: num('library.new_arrivals_days', 'Books added in the last this many days show as new arrivals', 30, 1, 365),
};

defineMasterGroup({ key: 'library', label: 'Library', order: 18 });

defineMaster({
    key: 'library_member_type',
    label: 'Library member type',
    plural: 'Library member types',
    description: 'How many books each kind of member may take and for how long. A student gets the first type that lists their class (or the one with no classes).',
    group: 'library',
    order: 10,
    code: 'none',
    ordering: 'manual',
    fields: [
        { key: 'for', label: 'For', type: 'select', required: true, options: [{ value: 'student', label: 'Students' }, { value: 'staff', label: 'Staff' }] },
        { key: 'classes', label: 'Classes (short names, comma-separated; empty = all others)', type: 'text', max: 300 },
        { key: 'books', label: 'Books at a time', type: 'number', required: true },
        { key: 'days', label: 'Days a book is lent for', type: 'number', required: true },
        { key: 'renewals', label: 'Times a book can be renewed', type: 'number', required: true },
    ],
    seed: [
        { name: 'Junior (Bal Vatika–V)', extra: { for: 'student', classes: 'BV1, BV2, BV3, I, II, III, IV, V', books: 1, days: 7, renewals: 1 } },
        { name: 'Middle and senior (VI–XII)', extra: { for: 'student', classes: '', books: 2, days: 14, renewals: 2 } },
        { name: 'Staff', extra: { for: 'staff', classes: '', books: 5, days: 30, renewals: 3 } },
    ],
});

defineMaster({
    key: 'library_category',
    label: 'Book category',
    plural: 'Book categories',
    group: 'library',
    order: 20,
    code: 'none',
    ordering: 'name',
    seed: ['Fiction', 'Non-fiction', 'Textbook', 'Reference', 'Biography', 'Science', 'Mathematics', 'History', 'Geography', 'Language & grammar', 'General knowledge', 'Children’s stories', 'Comics', 'Poetry', 'Computer science', 'Competitive exams', 'Magazines', 'Religion & culture', 'Arts & crafts', 'Sports'].map((name) => ({ name })),
});

defineMaster({
    key: 'library_language',
    label: 'Book language',
    plural: 'Book languages',
    group: 'library',
    order: 30,
    code: 'none',
    ordering: 'manual',
    seed: ['English', 'Hindi', 'Sanskrit', 'Garhwali', 'Kumaoni', 'Urdu', 'Bilingual'].map((name) => ({ name })),
});

defineMaster({
    key: 'library_location',
    label: 'Shelf location',
    plural: 'Shelf locations',
    description: 'Where books are kept (rack and shelf), printed on the label.',
    group: 'library',
    order: 40,
    code: 'none',
    ordering: 'manual',
    seed: ['Rack A1', 'Rack A2', 'Rack B1', 'Rack B2', 'Rack C1', 'Reference section', 'Junior corner', 'Magazine stand'].map((name) => ({ name })),
});

defineMaster({
    key: 'book_condition',
    label: 'Book condition',
    plural: 'Book conditions',
    group: 'library',
    order: 50,
    code: 'none',
    ordering: 'manual',
    fields: [{ key: 'charge', label: 'Charge on return (% of the price; damaged books)', type: 'number' }],
    seed: [
        { name: 'New', extra: { charge: 0 } },
        { name: 'Good', extra: { charge: 0 } },
        { name: 'Worn', extra: { charge: 0 } },
        { name: 'Damaged', extra: { charge: 25 } },
        { name: 'Badly damaged', extra: { charge: 75 } },
    ],
});

export const KINDS = ['book', 'reference', 'magazine', 'newspaper', 'cd', 'ebook'] as const;
export const KIND_LABEL: Record<(typeof KINDS)[number], string> = { book: 'Book', reference: 'Reference', magazine: 'Magazine', newspaper: 'Newspaper', cd: 'CD / DVD', ebook: 'E-book' };
