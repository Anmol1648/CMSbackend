/**
 * Measures database round-trip time, to tell slow code from a far-away database.
 *   npx tsx scripts/db-latency.ts
 */
import '../src/config/env';
import { Prisma } from '@prisma/client';
import { db, systemSql } from '../src/core/db';
import { runAsSystem } from '../src/core/context';

const time = async (label: string, fn: () => Promise<unknown>, runs = 5) => {
    const ms: number[] = [];
    for (let i = 0; i < runs; i++) {
        const t = performance.now();
        await fn();
        ms.push(performance.now() - t);
    }
    ms.sort((a, b) => a - b);
    process.stdout.write(`${label.padEnd(36)} min ${ms[0].toFixed(0)} ms   median ${ms[Math.floor(runs / 2)].toFixed(0)} ms\n`);
};

const main = async () => {
    const host = new URL(process.env.DATABASE_URL!).hostname;
    process.stdout.write(`database host: ${host}\n`);
    await time('first query (connect)', () => systemSql(Prisma.sql`SELECT 1`), 1);
    await time('SELECT 1', () => systemSql(Prisma.sql`SELECT 1`));
    await time('prisma findFirst (tenant)', () => runAsSystem(() => db.tenant.findFirst()));
    await time('transaction with 2 queries', () => db.$transaction([db.$queryRaw`SELECT 1`, db.$queryRaw`SELECT 2`]));
};

main().finally(() => db.$disconnect());
