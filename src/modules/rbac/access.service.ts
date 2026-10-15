import type { DataScope } from '@prisma/client';
import { db } from '../../core/db';
import { cache } from '../../core/cache';
import { getTenantId } from '../../core/context';
import { broader, listPermissionDefs } from '../../core/registry/permissions';

/**
 * What a signed-in person may do: Super Admin (system role) gets every permission with scope "all";
 * everyone else gets the union of their roles' grants, the broadest scope winning (all > assigned > own).
 * Cached for 5 minutes per user; cleared whenever roles, grants or a user's roles change.
 */

export interface UserAccess {
    isSuperAdmin: boolean;
    roles: { id: string; slug: string; name: string }[];
    permissions: Record<string, DataScope>;
}

const TTL_SECONDS = 300;
const cacheKey = (tenantId: string, userId: string) => `access:${tenantId}:${userId}`;

export const getUserAccess = async (userId: string): Promise<UserAccess> => {
    const tenantId = getTenantId();
    if (!tenantId) throw new Error('getUserAccess needs a school in context');
    const hit = await cache.get(cacheKey(tenantId, userId));
    if (hit) return JSON.parse(hit);

    const links = await db.userRole.findMany({
        where: { userId, role: { deletedAt: null } },
        select: { role: { select: { id: true, slug: true, name: true, isSystem: true, permissions: { select: { permissionKey: true, scope: true } } } } },
    });
    const isSuperAdmin = links.some((l) => l.role.isSystem);
    const permissions: Record<string, DataScope> = {};
    if (isSuperAdmin) {
        for (const p of listPermissionDefs()) permissions[p.key] = 'all';
    } else {
        for (const l of links) {
            for (const g of l.role.permissions) permissions[g.permissionKey] = permissions[g.permissionKey] ? broader(permissions[g.permissionKey], g.scope) : g.scope;
        }
    }
    const access: UserAccess = { isSuperAdmin, roles: links.map((l) => ({ id: l.role.id, slug: l.role.slug, name: l.role.name })), permissions };
    await cache.set(cacheKey(tenantId, userId), JSON.stringify(access), TTL_SECONDS);
    return access;
};

/** Forget cached access for one user, or for everyone in the school (after a role's grants change). */
export const invalidateAccess = async (userId?: string) => {
    const tenantId = getTenantId();
    if (!tenantId) return;
    if (userId) await cache.del(cacheKey(tenantId, userId));
    else await cache.delPrefix(`access:${tenantId}:`);
};
