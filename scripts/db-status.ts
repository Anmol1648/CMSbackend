/**
 * Read-only health view of the database the backend points at:
 *   npx tsx scripts/db-status.ts
 * Shows applied migrations, schools, their users, and whether DEFAULT_TENANT_CODE matches a school.
 */
import { env } from '../src/config/env';
import { Prisma } from '@prisma/client';
import { db, systemSql } from '../src/core/db';
import { runAsSystem } from '../src/core/context';

const out = (line = '') => process.stdout.write(line + '\n');

const main = async () => {
    const url = new URL(env.DATABASE_URL);
    out(`database: ${url.pathname.slice(1)} on ${url.hostname}`);

    const tables = await systemSql<{ name: string }>(Prisma.sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`);
    out(`tables: ${tables.map((t) => t.name).join(', ') || '(none)'}`);
    if (!tables.some((t) => t.name === 'tenants') || !tables.some((t) => t.name === 'school_profiles')) {
        out('-> The new schema is not applied. Run: npx prisma migrate reset --force --skip-seed');
        return;
    }
    const migrations = await systemSql<{ name: string }>(Prisma.sql`SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY started_at`);
    out(`migrations: ${migrations.map((m) => m.name).join(', ')}`);

    const tenants = await runAsSystem(() =>
        db.tenant.findMany({ select: { id: true, code: true, name: true, domain: true, status: true, _count: { select: { users: true } } } })
    );
    if (!tenants.length) out('-> No school yet. Run: npm run tenant:create -- --code <code> --name "<name>" --admin-username admin');
    for (const t of tenants) {
        const users = await runAsSystem(() =>
            db.user.findMany({ where: { tenantId: t.id }, select: { username: true, kind: true, status: true, mustChangePassword: true, lockedUntil: true } })
        );
        out(`school ${t.code} "${t.name}" (${t.status}${t.domain ? `, domain ${t.domain}` : ''}) — ${t._count.users} users`);
        for (const u of users) {
            const flags = [u.status, u.mustChangePassword ? 'must change password' : '', u.lockedUntil && u.lockedUntil > new Date() ? 'LOCKED' : ''].filter(Boolean);
            out(`   ${u.username} (${u.kind}) ${flags.join(', ')}`);
        }
    }
    const def = env.DEFAULT_TENANT_CODE;
    if (!def) out('DEFAULT_TENANT_CODE: not set -> the sign-in page only finds a school by its domain');
    else out(`DEFAULT_TENANT_CODE: ${def} ${tenants.some((t) => t.code === def) ? '(matches a school)' : '-> NO school has this code'}`);
};

main()
    .catch((e) => out(`error: ${(e as Error).message}`))
    .finally(() => db.$disconnect());
