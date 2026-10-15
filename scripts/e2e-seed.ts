/**
 * Seeds the TEST database (cms_test) with one school for browser tests:
 *   school "e2e" (domain none), Super Admin "admin" / password "E2e-pass-123", no password change due.
 * Refuses to run against any other database.
 *   DATABASE_URL=<test url> DIRECT_URL=<test direct url> npx tsx scripts/e2e-seed.ts
 */
import { Prisma } from '@prisma/client';
import '../src/config/env';
import { db } from '../src/core/db';
import { cache } from '../src/core/cache';
import { runAsTenant } from '../src/core/context';
import { hashPassword } from '../src/core/password';
import { createTenant } from '../src/modules/tenants';

const main = async () => {
    const [{ name }] = await db.$queryRawUnsafe<{ name: string }[]>('SELECT current_database() AS name');
    if (name !== 'cms_test') throw new Error(`refusing to seed database "${name}"`);
    const tables = Prisma.dmmf.datamodel.models.map((m) => `"${m.dbName ?? m.name}"`).join(', ');
    await db.$executeRawUnsafe(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
    const created = await createTenant({ code: 'e2e', name: 'E2E Public School', admin: { username: 'admin', displayName: 'E2E Admin' } });
    await runAsTenant(created.tenant.id, async () =>
        db.user.update({ where: { id: created.admin.id }, data: { passwordHash: await hashPassword('E2e-pass-123'), mustChangePassword: false } })
    );
    process.stdout.write('seeded school e2e, admin / E2e-pass-123\n');
};

main()
    .catch((e) => {
        process.stderr.write(`${(e as Error).stack}\n`);
        process.exitCode = 1;
    })
    .finally(() => Promise.allSettled([db.$disconnect(), cache.close()]));
