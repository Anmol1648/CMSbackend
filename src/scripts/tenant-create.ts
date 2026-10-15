/**
 * Creates a school with its profile, default roles and first Super Admin.
 *
 *   npm run tenant:create -- --code gvs --name "Green Valley School" --admin-username admin
 *                            [--admin-name "School Admin"] [--admin-email a@b.in] [--domain erp.gvs.in]
 *
 * Prints the admin's one-time password once; they must change it at first sign-in.
 */
import { parseArgs } from 'util';
import '../config/env';
import { db } from '../core/db';
import { AppError } from '../core/errors';
import { createTenant } from '../modules/tenants';

const out = (line = '') => process.stdout.write(line + '\n');

const usage = () => {
    out('Usage: npm run tenant:create -- --code <code> --name "<school name>" --admin-username <username>');
    out('       [--admin-name "<name>"] [--admin-email <email>] [--domain <host>]');
    out('Put names with spaces in quotes.');
    process.exitCode = 1;
};

const readArgs = () => {
    try {
        return parseArgs({
            options: {
                code: { type: 'string' },
                name: { type: 'string' },
                domain: { type: 'string' },
                'admin-username': { type: 'string' },
                'admin-name': { type: 'string' },
                'admin-email': { type: 'string' },
            },
        }).values;
    } catch (err) {
        out(`Could not read the arguments: ${(err as Error).message}`);
        return null;
    }
};

const main = async () => {
    const values = readArgs();
    if (!values || !values.code || !values.name || !values['admin-username']) return usage();

    const created = await createTenant({
        code: values.code,
        name: values.name,
        domain: values.domain,
        admin: {
            username: values['admin-username'],
            displayName: values['admin-name'] ?? 'School Admin',
            email: values['admin-email'],
        },
    });

    out(`School created: ${created.tenant.name} (code: ${created.tenant.code}, id: ${created.tenant.id})`);
    out(`Super Admin username: ${created.admin.username}`);
    out(`One-time password:    ${created.admin.temporaryPassword}`);
    out('Shown once. The admin must change it at first sign-in.');
    if (!created.tenant.domain) out(`Tip: set DEFAULT_TENANT_CODE=${created.tenant.code} in .env so the sign-in page finds this school.`);
};

main()
    .catch((err) => {
        if (err instanceof AppError) {
            out(`Could not create the school: ${err.message}`);
            for (const d of err.details ?? []) out(`  - ${d.field}: ${d.message}`);
        } else {
            process.stderr.write(`${(err as Error).stack ?? err}\n`);
        }
        process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
