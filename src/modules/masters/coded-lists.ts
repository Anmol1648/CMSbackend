import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest } from '../../core/errors';
import type { MasterSeed } from './masters.registry';

/**
 * Masters whose CODE is what records keep (payment modes on receipts, leave types on leave, test
 * results on enquiries): the school renames, adds, orders and switches options off in Masters; records
 * keep the code. The defaults are filled in the first time a list is used, so a school never ends up
 * with an empty dropdown.
 */

export interface CodedOption {
    /** Lower case: what records keep. */
    code: string;
    name: string;
    isActive: boolean;
    extra: Record<string, unknown>;
}

export const codedList = async (key: string, defaults: MasterSeed[]): Promise<CodedOption[]> => {
    const read = () => db.masterValue.findMany({ where: { master: key }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { code: true, name: true, isActive: true, extra: true } });
    let rows = await read();
    if (!rows.length && defaults.length) {
        await db.masterValue.createMany({
            data: defaults.map((d, i) => ({ tenantId: getTenantId()!, master: key, name: d.name, code: d.code ?? null, sortOrder: i + 1, extra: (d.extra ?? {}) as object })),
            skipDuplicates: true,
        });
        rows = await read();
    }
    return rows.filter((r) => r.code).map((r) => ({ code: r.code!.toLowerCase(), name: r.name, isActive: r.isActive, extra: (r.extra ?? {}) as Record<string, unknown> }));
};

/** The name of a code ("bank_transfer" → "Bank transfer" when it isn't in the list any more). */
export const codedLabel = (list: CodedOption[], code: string | null | undefined) => {
    if (!code) return null;
    return list.find((o) => o.code === code.toLowerCase())?.name ?? code.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
};

/** A chosen code must be one of the list's active options. */
export const requireCode = (list: CodedOption[], code: string, what: string, field: string) => {
    const o = list.find((x) => x.code === code.trim().toLowerCase() && x.isActive);
    if (!o) throw badRequest(`Choose a ${what} from the list`, [{ field, message: `is not one of the ${what}s` }]);
    return o;
};
