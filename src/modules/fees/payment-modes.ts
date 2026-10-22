import { codedLabel, codedList, requireCode } from '../masters/coded-lists';
import { PAYMENT_MODE_SEED } from './fees.labels';

/** The school's payment modes (Masters → Payment modes); receipts keep the code. */

export const paymentModes = () => codedList('payment_mode', PAYMENT_MODE_SEED);

/** code → name, for showing receipts. */
export const modeNames = async () => {
    const list = await paymentModes();
    return (code: string | null | undefined) => codedLabel(list, code) ?? '';
};

/** A mode chosen at the counter (or for the registration fee): active, allowed at the counter, reference if it needs one. */
export const counterMode = async (code: string, reference: string | null | undefined, field = 'mode') => {
    const atCounter = (await paymentModes()).filter((m) => m.code !== 'online' && m.extra.at_counter !== false);
    const mode = requireCode(atCounter, code, 'payment mode', field);
    return { mode, needsReference: mode.extra.needs_reference === true && !reference };
};
