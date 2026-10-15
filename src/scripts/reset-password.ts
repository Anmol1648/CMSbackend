/**
 * Gives a user a new one-time password (they must change it at next sign-in), unlocks the account
 * and signs them out everywhere. For when an admin can't sign in at all.
 *
 *   npm run user:reset-password -- --school dps --username admin
 */
import { parseArgs } from 'util';
import '../config/env';
import { db } from '../core/db';
import { cache } from '../core/cache';
import { runAsSystem, runAsTenant } from '../core/context';
import { generateTemporaryPassword, hashPassword } from '../core/password';
import { recordAudit } from '../core/audit';
import { revokeUserSessions } from '../modules/auth';

const out = (line = '') => process.stdout.write(line + '\n');

const main = async () => {
    let values: { school?: string; username?: string };
    try {
        values = parseArgs({ options: { school: { type: 'string' }, username: { type: 'string' } } }).values;
    } catch (err) {
        out(`Could not read the arguments: ${(err as Error).message}`);
        values = {};
    }
    if (!values.school || !values.username) {
        out('Usage: npm run user:reset-password -- --school <school code> --username <username>');
        process.exitCode = 1;
        return;
    }

    const tenant = await runAsSystem(() => db.tenant.findUnique({ where: { code: values.school!.toLowerCase() } }));
    if (!tenant) {
        out(`No school with code "${values.school}".`);
        process.exitCode = 1;
        return;
    }

    await runAsTenant(tenant.id, async () => {
        const user = await db.user.findFirst({ where: { username: values.username!.toLowerCase() } });
        if (!user) {
            out(`No user "${values.username}" in ${tenant.name}.`);
            process.exitCode = 1;
            return;
        }
        const password = generateTemporaryPassword();
        await db.user.update({
            where: { id: user.id },
            data: { passwordHash: await hashPassword(password), mustChangePassword: true, failedLoginCount: 0, lockedUntil: null, status: 'active' },
        });
        await revokeUserSessions(user.id, 'admin');
        await recordAudit({ action: 'password_reset', entity: 'user', entityId: user.id, userId: null, changes: { by: 'command line' } });
        out(`School:             ${tenant.name} (${tenant.code})`);
        out(`Username:           ${user.username}`);
        out(`One-time password:  ${password}`);
        out('They must choose a new password at sign-in. Other sessions were signed out.');
    });
};

main()
    .catch((err) => {
        process.stderr.write(`${(err as Error).stack ?? err}\n`);
        process.exitCode = 1;
    })
    // Close the cache (Redis) too, or its connection keeps the command running.
    .finally(() => Promise.allSettled([db.$disconnect(), cache.close()]));
