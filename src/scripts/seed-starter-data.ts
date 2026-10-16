/**
 * Adds a school's starter data where it is still missing: options of empty master lists (a list a
 * new module brought, or a school created before masters existed) and the academic set-up (only
 * while the school has no classes). Nothing the school changed is touched.
 *
 *   npm run starter:seed -- --school dps
 */
import { parseArgs } from 'util';
import '../config/env';
import '../modules/registry';
import { db } from '../core/db';
import { cache } from '../core/cache';
import { runAsSystem, runAsTenant } from '../core/context';
import { seedStarterData } from '../modules/tenants/starter-data';

const out = (line = '') => process.stdout.write(line + '\n');

const main = async () => {
    const { values } = parseArgs({ options: { school: { type: 'string' } } });
    if (!values.school) {
        out('Usage: npm run starter:seed -- --school <school code>');
        process.exitCode = 1;
        return;
    }
    const tenant = await runAsSystem(() => db.tenant.findUnique({ where: { code: values.school!.toLowerCase() } }));
    if (!tenant) {
        out(`No school with code "${values.school}".`);
        process.exitCode = 1;
        return;
    }
    const { masters, academic } = await runAsTenant(tenant.id, seedStarterData);
    const lists = Object.entries(masters);
    for (const [list, n] of lists) out(`${tenant.name}: ${list} — ${n} starter option(s) added`);
    if (!lists.length) out(`${tenant.name}: every master list already has options.`);
    if ('classes' in academic) {
        out(`${tenant.name}: academic set-up added — year ${academic.year}, ${academic.classes} classes, ${academic.sections} sections, ${academic.subjects} subjects, ${academic.classSubjects} class subjects`);
    } else {
        out(`${tenant.name}: the school already has classes; academic set-up left as it is.`);
    }
};

main()
    .catch((err) => {
        process.stderr.write(`${(err as Error).stack ?? err}\n`);
        process.exitCode = 1;
    })
    .finally(() => Promise.allSettled([db.$disconnect(), cache.close()]));
