import { parseArgs } from 'node:util';
import { db } from '../core/db';
import { runAsSystem } from '../core/context';
import { generateTemporaryPassword, hashPassword } from '../core/password';

/**
 * Creates the first platform console owner (Klytos), or gives an existing one a new one-time password.
 *
 *   npm run platform:owner -- --email you@klytos.in --name "Your Name"
 *
 * Prints the one-time password once. At the first sign-in they choose their own password and set up
 * an authenticator app (required).
 */

const out = (line = '') => process.stdout.write(line + '\n');

(async () => {
    const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
    const email = values.email?.trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        out('Usage: npm run platform:owner -- --email you@company.in --name "Your Name"');
        process.exit(1);
    }
    const password = generateTemporaryPassword();
    const passwordHash = await hashPassword(password);
    const existing = await runAsSystem(() => db.platformUser.findUnique({ where: { email } }));
    if (existing) await runAsSystem(() => db.platformUser.update({ where: { email }, data: { passwordHash, mustChangePassword: true, role: 'owner', status: 'active', mfaEnabled: false, mfaSecretEnc: null, failedLogins: 0, lockedUntil: null } }));
    else await runAsSystem(() => db.platformUser.create({ data: { email, name: values.name?.trim() || email, role: 'owner', passwordHash, mustChangePassword: true } }));
    out(existing ? `Owner ${email}: password reset.` : `Owner ${email} created.`);
    out(`One-time password: ${password}`);
    out('Sign in at <frontend>/platform; you will choose a new password and set up an authenticator app.');
    await db.$disconnect();
    process.exit(0);
})().catch(async (err) => {
    out(`Failed: ${(err as Error).message}`);
    await db.$disconnect().catch(() => undefined);
    process.exit(1);
});
