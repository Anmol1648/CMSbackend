import { z } from 'zod';
import { badRequest } from './errors';

/**
 * Lists the school orders by hand: an item moves one place (the ↑ ↓ buttons) or next to another
 * item (drag and drop: "put it before / after that one"). Placing next to an item rather than at a
 * number keeps it right even when the screen shows only part of the list.
 */
export const moveSchema = z.union([
    z.strictObject({ direction: z.enum(['up', 'down']) }),
    z.strictObject({ before: z.uuid() }),
    z.strictObject({ after: z.uuid() }),
]);
export type Move = z.infer<typeof moveSchema>;

/** The rows in their new order, or null when nothing changes. */
export const applyMove = <T extends { id: string }>(rows: T[], id: string, move: Move): T[] | null => {
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return null;
    const out = [...rows];
    const [item] = out.splice(i, 1);
    let at: number;
    if ('direction' in move) {
        at = move.direction === 'up' ? i - 1 : i + 1;
        if (at < 0 || at > out.length) return null;
    } else {
        const other = 'before' in move ? move.before : move.after;
        const t = out.findIndex((r) => r.id === other);
        if (t < 0) throw badRequest('Both items must be in the same list');
        at = 'before' in move ? t : t + 1;
    }
    out.splice(at, 0, item);
    return out.some((r, k) => r.id !== rows[k].id) ? out : null;
};

/** Numbers the rows 1×step, 2×step… and writes only the ones whose number changed. */
export const renumber = async <T extends { id: string; sortOrder: number }>(rows: T[], save: (id: string, sortOrder: number) => Promise<unknown>, step = 10) => {
    for (const [n, r] of rows.entries()) if (r.sortOrder !== (n + 1) * step) await save(r.id, (n + 1) * step);
};
