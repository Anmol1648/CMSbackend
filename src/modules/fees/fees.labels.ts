import type { MasterSeed } from '../masters/masters.registry';

/** The payment modes a school starts with (Configuration → Masters → Payment modes). */
export const PAYMENT_MODE_SEED: MasterSeed[] = [
    { name: 'Cash', code: 'cash', extra: { needs_reference: false, at_counter: true } },
    { name: 'UPI', code: 'upi', extra: { needs_reference: true, at_counter: true } },
    { name: 'Cheque', code: 'cheque', extra: { needs_reference: true, at_counter: true } },
    { name: 'Demand draft', code: 'dd', extra: { needs_reference: true, at_counter: true } },
    { name: 'Bank transfer', code: 'bank_transfer', extra: { needs_reference: true, at_counter: true } },
    { name: 'Card', code: 'card', extra: { needs_reference: true, at_counter: true } },
    { name: 'Online', code: 'online', extra: { needs_reference: false, at_counter: false } },
];
