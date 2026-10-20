/**
 * Demo data for showing the system (students, parents, class teachers), or removing it again.
 *
 *   npm run demo:seed -- --school dps
 *   npm run demo:clear -- --school dps
 */
import { parseArgs } from 'util';
import '../config/env';
import '../modules/registry';
import { db } from '../core/db';
import { cache } from '../core/cache';
import { runAsSystem, runAsTenant } from '../core/context';
import { clearDemoData, createDemoData, DEMO_PASSWORD } from '../modules/students/demo-data';

const out = (line = '') => process.stdout.write(line + '\n');

const main = async () => {
    const { values } = parseArgs({ options: { school: { type: 'string' }, clear: { type: 'boolean' } } });
    if (!values.school) {
        out('Usage: npm run demo:seed -- --school <code>   |   npm run demo:clear -- --school <code>');
        process.exitCode = 1;
        return;
    }
    const tenant = await runAsSystem(() => db.tenant.findUnique({ where: { code: values.school!.toLowerCase() } }));
    if (!tenant) {
        out(`No school with code "${values.school}".`);
        process.exitCode = 1;
        return;
    }
    if (values.clear) {
        const r = await runAsTenant(tenant.id, clearDemoData);
        out(`${tenant.name}: removed ${r.students} demo students, ${r.families} families, ${r.staff} staff and ${r.logins} demo logins.${r.counterReset ? ' Numbers start again from the first.' : ''}`);
        return;
    }
    out(`${tenant.name}: creating demo data (this takes a minute)…`);
    const r = await runAsTenant(tenant.id, () => createDemoData());
    out(`${tenant.name}: ${r.students} students in ${r.sections} sections of ${r.year}, ${r.families} families, ${r.staff.staff} staff (${r.staff.logins} with logins, ${r.staff.assignments} subject-teacher assignments), ${r.studentLogins} student logins.`);
    out('');
    out(`Every demo login uses the password ${DEMO_PASSWORD}`);
    if (r.staff.sampleTeacher) out(`  class teacher: ${r.staff.sampleTeacher}   (sees only their own sections' students)`);
    if (r.studentLogins && r.sampleStudent) out(`  student:       ${r.sampleStudent.replace(/[^A-Za-z0-9]/g, '').toLowerCase()}   (admission no ${r.sampleStudent})`);
    out('Remove it all later with: npm run demo:clear -- --school ' + tenant.code);
};

main()
    .catch((err) => {
        process.stderr.write(`${(err as Error).message ?? err}\n`);
        process.exitCode = 1;
    })
    .finally(() => Promise.allSettled([db.$disconnect(), cache.close()]));
