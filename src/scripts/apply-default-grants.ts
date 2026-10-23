/**
 * Adds missing default permissions to a school's default roles (never removes anything).
 * Run after upgrading, when a module brings new defaults.
 *
 *   npm run roles:apply-defaults -- --school dps
 */
import { parseArgs } from 'util';
import '../config/env';
import '../modules/registry';
import { db } from '../core/db';
import { cache } from '../core/cache';
import { runAsSystem, runAsTenant } from '../core/context';
import { syncPermissions } from '../core/registry/permissions';
import { applyDefaultGrants } from '../modules/rbac/default-grants';
import { invalidateAccess } from '../modules/rbac/access.service';
import { DEFAULT_ROLES } from '../modules/tenants/default-roles';

const out = (line = '') => process.stdout.write(line + '\n');

const main = async () => {
    const { values } = parseArgs({ options: { school: { type: 'string' } } });
    if (!values.school) {
        out('Usage: npm run roles:apply-defaults -- --school <school code>');
        process.exitCode = 1;
        return;
    }
    const synced = await syncPermissions();
    const tenant = await runAsSystem(() => db.tenant.findUnique({ where: { code: values.school!.toLowerCase() } }));
    if (!tenant) {
        out(`No school with code "${values.school}".`);
        process.exitCode = 1;
        return;
    }
    const added = await runAsTenant(tenant.id, async () => {
        // Default roles added after the school was created (e.g. Driver / Bus Helper).
        await db.role.createMany({ data: DEFAULT_ROLES.map((r) => ({ tenantId: tenant.id, slug: r.slug, name: r.name, description: r.description, isSystem: r.isSystem ?? false, defaultFor: r.defaultFor ?? null })), skipDuplicates: true });
        const n = await applyDefaultGrants(tenant.id);
        await invalidateAccess();
        return n;
    });
    out(`${synced.total} permissions in the catalogue; ${added} default grant(s) added to ${tenant.name}.`);
};

main()
    .catch((err) => {
        process.stderr.write(`${(err as Error).stack ?? err}\n`);
        process.exitCode = 1;
    })
    .finally(() => Promise.allSettled([db.$disconnect(), cache.close()]));
