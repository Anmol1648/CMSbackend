/**
 * Read-only: a school's recent sign-in sessions and security events, to explain sign-outs.
 *   npx tsx scripts/recent-sessions.ts dps
 */
import '../src/config/env';
import { db } from '../src/core/db';
import { cache } from '../src/core/cache';
import { runAsSystem, runAsTenant } from '../src/core/context';

const out = (l = '') => process.stdout.write(l + '\n');
const t = (d: Date | null) => (d ? d.toISOString().replace('T', ' ').slice(0, 19) : '-');

const main = async () => {
    const code = process.argv[2] ?? 'dps';
    const tenant = await runAsSystem(() => db.tenant.findUnique({ where: { code } }));
    if (!tenant) return out(`no school ${code}`);
    await runAsTenant(tenant.id, async () => {
        const sessions = await db.userSession.findMany({ orderBy: { createdAt: 'desc' }, take: 10, include: { user: { select: { username: true } } } });
        out('SESSIONS (newest first): created | last used | expires | revoked | reason | user');
        for (const s of sessions) out(`  ${t(s.createdAt)} | ${t(s.lastUsedAt)} | ${t(s.expiresAt)} | ${t(s.revokedAt)} | ${s.revokedReason ?? '-'} | ${s.user.username}`);
        const events = await db.auditLog.findMany({ where: { entity: { in: ['user', 'user_session'] } }, orderBy: { at: 'desc' }, take: 15 });
        out('EVENTS (newest first):');
        for (const e of events) out(`  ${t(e.at)} ${e.action} ${JSON.stringify(e.changes ?? {})}`);
    });
};

main().finally(() => Promise.allSettled([db.$disconnect(), cache.close()]));
