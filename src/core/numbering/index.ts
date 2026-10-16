import { Prisma } from '@prisma/client';
import { tenantSql } from '../db';

/**
 * Running numbers a school formats itself (admission numbers now, receipts later). Each counter is
 * a row in number_sequences; taking numbers is one atomic statement, so two people admitting at
 * the same moment never get the same number. A number taken for a save that then fails is skipped.
 */

/** Takes `count` numbers from the counter `key`; returns the first. A new counter starts at `start`. */
export const takeNumbers = async (key: string, start: number, count = 1): Promise<number> => {
    const [row] = await tenantSql<{ last_value: number }>((tenantId) => Prisma.sql`
        INSERT INTO number_sequences (tenant_id, key, last_value, updated_at)
        VALUES (${tenantId}::uuid, ${key}, ${start + count - 1}, now())
        ON CONFLICT (tenant_id, key) DO UPDATE SET last_value = number_sequences.last_value + ${count}, updated_at = now()
        RETURNING last_value`);
    return row.last_value - count + 1;
};

/** The number the counter would give next (for showing, not reserving). */
export const peekNumber = async (key: string, start: number): Promise<number> => {
    const [row] = await tenantSql<{ last_value: number }>((tenantId) => Prisma.sql`SELECT last_value FROM number_sequences WHERE tenant_id = ${tenantId}::uuid AND key = ${key}`);
    return row ? row.last_value + 1 : start;
};

export interface NumberParts {
    seq: number;
    date: Date;
    /** Academic year name, e.g. "2026–27" (shown as 2026-27). */
    academicYear?: string;
    /** Class short name, e.g. "VI". */
    className?: string;
}

/** "KVJ/{YYYY}/{SEQ:3}" → "KVJ/2026/007". */
export const formatNumber = (pattern: string, p: NumberParts) =>
    pattern
        .replace(/\{SEQ(?::(\d))?\}/g, (_m, width?: string) => String(p.seq).padStart(Number(width ?? 0), '0'))
        .replace(/\{YYYY\}/g, String(p.date.getUTCFullYear()))
        .replace(/\{YY\}/g, String(p.date.getUTCFullYear()).slice(-2))
        .replace(/\{AY\}/g, (p.academicYear ?? '').replace(/–/g, '-'))
        .replace(/\{CLASS\}/g, (p.className ?? '').replace(/\s+/g, ''));
