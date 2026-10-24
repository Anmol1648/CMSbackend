import { z } from 'zod';
import { defineSetting } from '../../core/settings';

/**
 * System Settings → ID cards: card numbers, validity, the duplicate fee, photos from parents and the
 * digital card. The designs are in ID cards → Designs; who designs, prints or takes photos is in
 * Roles & Permissions (idcard.*).
 */

const G = 'ID cards';
const bool = (key: string, label: string, def: boolean, help?: string) => defineSetting<boolean>({ key, group: G, label, help, type: 'boolean', default: def, schema: z.boolean() });
const num = (key: string, label: string, def: number, min: number, max: number, help?: string) =>
    defineSetting<number>({ key, group: G, label, help, type: 'number', default: def, schema: z.number().int().min(min).max(max) });

export const IDCARDS = {
    prefix: defineSetting<string>({ key: 'idcards.prefix', group: G, label: 'Card numbers start with', help: 'Then a running number, e.g. ID-000123 (in the card’s QR code).', type: 'text', default: 'ID-', schema: z.string().trim().max(10) }),
    digits: num('idcards.digits', 'Digits in the running number', 6, 3, 9),
    validity: defineSetting<string>({
        key: 'idcards.validity',
        group: G,
        label: 'Cards are valid till',
        type: 'select',
        default: 'session',
        schema: z.enum(['session', 'months']),
        options: [
            { value: 'session', label: 'The end of the academic session' },
            { value: 'months', label: 'A number of months from printing' },
        ],
    }),
    months: num('idcards.months', 'Months a card is valid (when not till the session end; staff cards always use this)', 12, 1, 120),
    duplicateFee: num('idcards.duplicate_fee', 'Fee for a duplicate student card (₹, 0 = free)', 0, 0, 10_000, 'Added to the student’s fees (next instalment) when a lost or damaged card is replaced.'),
    feeHeadCode: defineSetting<string>({ key: 'idcards.fee_head_code', group: G, label: 'Fee head the duplicate fee is charged under (its code in Masters → Fee heads)', type: 'text', default: 'IDC', schema: z.string().trim().min(1).max(20) }),
    parentPhotos: bool('idcards.parent_photos', 'Parents and students may send the photo for the card from the app', true),
    photoApproval: bool('idcards.photo_approval', 'Photos from parents need the office’s approval before they are used', true),
    digital: bool('idcards.digital', 'Show the digital ID card on My ID Card', true),
};
