import { defineMaster, defineMasterGroup } from '../masters/masters.registry';
import { PAYMENT_MODE_SEED } from './fees.labels';

/** Fee lists in the master engine (Configuration → Masters → Fees). */

defineMasterGroup({ key: 'fees', label: 'Fees', order: 9 });

defineMaster({
    key: 'fee_head',
    label: 'Fee head',
    plural: 'Fee heads',
    description: 'What fees are charged for. Amounts per class and instalment are set in Fees → Fee Setup. The order here is the order on receipts and in which part payments are used.',
    group: 'fees',
    order: 10,
    code: 'optional',
    ordering: 'manual',
    fields: [
        { key: 'one_time', label: 'Only for new admissions', type: 'boolean', help: 'Charged only to students admitted this year (e.g. admission fee).' },
        { key: 'refundable', label: 'Refundable', type: 'boolean', help: 'Shown on receipts (e.g. caution money).' },
    ],
    seed: [
        { name: 'Admission fee', code: 'ADM', extra: { one_time: true, refundable: false } },
        { name: 'Caution money', code: 'CAU', extra: { one_time: true, refundable: true } },
        { name: 'Tuition fee', code: 'TUI', extra: { one_time: false, refundable: false } },
        { name: 'Vidyalaya Vikas Nidhi (VVN)', code: 'VVN', extra: { one_time: false, refundable: false } },
        { name: 'Computer fund', code: 'CF', extra: { one_time: false, refundable: false } },
        { name: 'Examination fee', code: 'EXM', extra: { one_time: false, refundable: false } },
        { name: 'Transport fee', code: 'TRN', extra: { one_time: false, refundable: false } },
    ],
});

/**
 * How fees are paid. Receipts keep the CODE ("cash", "upi"…): don't change a code once receipts use it
 * (rename the option instead). "online" is the payment gateway and "upi" the UPI QR; keep those codes.
 */
defineMaster({
    key: 'payment_mode',
    label: 'Payment mode',
    plural: 'Payment modes',
    description: 'How fees and the registration fee are paid. Receipts keep the code: rename an option freely, but don’t change its code once used. “online” (gateway) and “upi” (QR) are used by online payments.',
    group: 'fees',
    order: 20,
    code: 'required',
    ordering: 'manual',
    fields: [
        { key: 'needs_reference', label: 'Ask for a reference number (cheque / DD / transaction no.)', type: 'boolean' },
        { key: 'at_counter', label: 'Can be chosen at the fee counter', type: 'boolean', help: 'Off for modes only the online gateway uses.' },
    ],
    seed: PAYMENT_MODE_SEED,
});
