/**
 * Adds the starter options of master lists that are still empty for a school (a list a new module
 * brought, or a school created before masters existed). Lists with any options are left alone.
 *
 *   npm run masters:seed -- --school dps
 */
import { parseArgs } from 'util';
import '../config/env';
import '../modules/registry';
import { db } from '../core/db';
import { cache } from '../core/cache';
import { runAsSystem, runAsTenant } from '../core/context';
import { seedMasters } from '../modules/masters/masters.service';

const out = (line = '') => process.stdout.write(line + '\n');

const main = async () => {
    const { values } = parseArgs({ options: { school: { type: 'string' } } });
    if (!values.school) {
        out('Usage: npm run masters:seed -- --school <school code>');
        process.exitCode = 1;
        return;
    }
    const tenant = await runAsSystem(() => db.tenant.findUnique({ where: { code: values.school!.toLowerCase() } }));
    if (!tenant) {
        out(`No school with code "${values.school}".`);
        process.exitCode = 1;
        return;
    }
    const added = await runAsTenant(tenant.id, seedMasters);
    const lists = Object.entries(added);
    if (!lists.length) out(`${tenant.name}: every master list already has options; nothing added.`);
    for (const [list, n] of lists) out(`${tenant.name}: ${list} — ${n} starter option(s) added`);
};

main()
    .catch((err) => {
        process.stderr.write(`${(err as Error).stack ?? err}\n`);
        process.exitCode = 1;
    })
    .finally(() => Promise.allSettled([db.$disconnect(), cache.close()]));
