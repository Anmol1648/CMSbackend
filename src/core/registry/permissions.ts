import { DataScope, Prisma } from '@prisma/client';
import { db } from '../db';
import { runAsSystem } from '../context';
import { logger } from '../logger';

/**
 * Permission registry. Each module declares what can be done in it (`<module>.permissions.ts`);
 * at startup the list is synced into the `permissions` table and appears on the Roles screen.
 * Keys are `resource.action`, e.g. `user.create`.
 */

export interface PermissionDef {
    key: string;
    module: string;
    resource: string;
    action: string;
    label: string;
    description?: string;
    /** e.g. viewing Aadhaar / income — shown with a warning on the Roles screen. */
    sensitive?: boolean;
    /** Which data scopes make sense. Default: only "all". */
    scopes: DataScope[];
}

export interface ModuleInfo {
    key: string;
    label: string;
    order: number;
}

const permissions = new Map<string, PermissionDef>();
const modules = new Map<string, ModuleInfo>();

/** Declares a module's permissions: registerPermissions({ key: 'users', label: 'Users', order: 20 }, [...]) */
export const registerPermissions = (
    module: ModuleInfo,
    defs: { resource: string; action: string; label: string; description?: string; sensitive?: boolean; scopes?: DataScope[] }[]
) => {
    modules.set(module.key, module);
    for (const d of defs) {
        const key = `${d.resource}.${d.action}`;
        if (permissions.has(key)) throw new Error(`Permission "${key}" is registered twice`);
        if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(key)) throw new Error(`Permission key "${key}" must look like resource.action`);
        permissions.set(key, { key, module: module.key, resource: d.resource, action: d.action, label: d.label, description: d.description, sensitive: d.sensitive, scopes: d.scopes ?? ['all'] });
    }
};

export const listPermissionDefs = () => [...permissions.values()];
export const findPermissionDef = (key: string) => permissions.get(key);
export const listModules = () => [...modules.values()].sort((a, b) => a.order - b.order);

/**
 * Writes the registry into the permissions table. Keys no longer in code are kept (and logged): an
 * older server on the same database (a deploy still rolling out, a PC running last week's code)
 * would otherwise delete newer permissions and every role's grant of them. PRUNE_PERMISSIONS=true
 * removes them, once every server runs the same code.
 */
export const syncPermissions = () =>
    runAsSystem(async () => {
        const defs = listPermissionDefs();
        const existing = await db.permission.findMany({ select: { key: true } });
        const stale = existing.map((p) => p.key).filter((k) => !permissions.has(k));
        const prune = process.env.PRUNE_PERMISSIONS === 'true';
        await db.$transaction([
            ...defs.map((d) =>
                db.permission.upsert({
                    where: { key: d.key },
                    create: { key: d.key, module: d.module, resource: d.resource, action: d.action, label: d.label, description: d.description, isSensitive: d.sensitive ?? false, scopes: d.scopes },
                    update: { module: d.module, resource: d.resource, action: d.action, label: d.label, description: d.description ?? null, isSensitive: d.sensitive ?? false, scopes: d.scopes },
                })
            ),
            ...(stale.length && prune ? [db.permission.deleteMany({ where: { key: { in: stale } } })] : []),
        ] as Prisma.PrismaPromise<unknown>[]);
        if (stale.length) logger.warn(prune ? `Removed permissions no longer in code: ${stale.join(', ')}` : `Permissions not in this server's code (kept; set PRUNE_PERMISSIONS=true to remove): ${stale.join(', ')}`);
        return { total: defs.length, removed: prune ? stale.length : 0 };
    });

/** Broadest first: all > assigned > own. */
export const SCOPE_RANK: Record<DataScope, number> = { all: 3, assigned: 2, own: 1 };
export const broader = (a: DataScope, b: DataScope): DataScope => (SCOPE_RANK[a] >= SCOPE_RANK[b] ? a : b);
