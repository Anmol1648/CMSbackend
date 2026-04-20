import { db } from '../models/prisma';
import { redis } from '../config/redis.config';
import { serviceHandler } from '@shared/core';

export interface RBACCondition {
    own_data?: boolean;
    own_department?: boolean;
    // other conditions can be added here
}

export interface ResolvedPermission {
    resource: string;
    action: string;
    condition: RBACCondition | null;
}

/**
 * Recursively fetches all role IDs in the hierarchy for a given set of role IDs.
 * Includes the initial role IDs themselves.
 */
async function getAllInheritedRoleIds(roleIds: string[]): Promise<string[]> {
    const allIds = new Set<string>();
    const toProcess = [...roleIds];

    while (toProcess.length > 0) {
        const currentId = toProcess.shift()!;
        if (allIds.has(currentId)) continue;
        
        allIds.add(currentId);
        
        const role = await db.role.findUnique({
            where: { id: currentId },
            select: { parent_role_id: true }
        });

        if (role?.parent_role_id) {
            toProcess.push(role.parent_role_id);
        }
    }

    return Array.from(allIds);
}

export const getPermissionSet = serviceHandler(async (userId: string, tenantId: string): Promise<ResolvedPermission[]> => {
    const cacheKey = `rbac:${tenantId}:${userId}`;

    // 1. Try Cache
    const cached = await redis.get(cacheKey);
    if (cached) {
        return JSON.parse(cached);
    }

    // 2. Fetch User's Direct Roles
    const directUserRoles = await db.userRole.findMany({
        where: { 
            user_id: userId, 
            tenant_id: { in: [tenantId, 'system'] } 
        },
        select: { role_id: true }
    });

    const directRoleIds = directUserRoles.map(ur => ur.role_id);
    const allRoleIds = await getAllInheritedRoleIds(directRoleIds);

    // 3. Fetch Full Permission Matrix for all roles in hierarchy
    const rolesWithPerms = await db.role.findMany({
        where: { 
            id: { in: allRoleIds },
            deleted_at: null
        },
        include: {
            rolePermissions: {
                include: {
                    permission: true
                }
            }
        }
    });

    const permissionsMap = new Map<string, ResolvedPermission>();

    rolesWithPerms.forEach(role => {
        role.rolePermissions.forEach(rp => {
            const key = `${rp.permission.resource}:${rp.permission.action}`;
            
            // If already exists without conditions, keep it (most permissive wins)
            if (permissionsMap.has(key)) {
                const existing = permissionsMap.get(key)!;
                if (!existing.condition) return; // Keep existing (no restrictions)
                if (!rp.condition) {
                    // New is unrestricted, overwrite
                    permissionsMap.set(key, { 
                        resource: rp.permission.resource,
                        action: rp.permission.action,
                        condition: null 
                    });
                } else {
                    // Combine conditions
                    permissionsMap.set(key, {
                        ...existing,
                        condition: { ...existing.condition as RBACCondition, ...rp.condition as RBACCondition }
                    });
                }
            } else {
                permissionsMap.set(key, {
                    resource: rp.permission.resource,
                    action: rp.permission.action,
                    condition: rp.condition as RBACCondition | null
                });
            }
        });
    });

    const resolvedPermissions = Array.from(permissionsMap.values());

    // 4. Cache it (300 seconds = 5 minutes)
    await redis.set(cacheKey, JSON.stringify(resolvedPermissions), 'EX', 300);

    return resolvedPermissions;
});

export const buildMenuTree = serviceHandler(async (initialRoleIds: string[]): Promise<any[]> => {
    // 1. Resolve Hierarchy
    const allRoleIds = await getAllInheritedRoleIds(initialRoleIds);

    // 2. Fetch RoleMenus for all roles in hierarchy
    const roleMenus = await db.roleMenu.findMany({
        where: {
            role_id: { in: allRoleIds },
            visible: true,
            role: { deleted_at: null }
        },
        include: {
            menu: true
        }
    });

    // Extract unique menus
    const menuMap = new Map<string, any>();
    roleMenus.forEach(rm => {
        if (!menuMap.has(rm.menu.id)) {
            menuMap.set(rm.menu.id, rm.menu);
        }
    });

    const menus = Array.from(menuMap.values()).sort((a, b) => a.sort_order - b.sort_order);

    // Build Tree
    const tree: any[] = [];
    const lookup: any = {};

    menus.forEach(menu => {
        lookup[menu.id] = { ...menu, children: [] };
    });

    menus.forEach(menu => {
        if (menu.parent_id && lookup[menu.parent_id]) {
            lookup[menu.parent_id].children.push(lookup[menu.id]);
        } else {
            tree.push(lookup[menu.id]);
        }
    });

    return tree;
});

export const evaluateCondition = (condition: RBACCondition | null, userContext: any, recordContext?: any): boolean => {
    if (!condition) return true; // No conditions = unrestricted access

    if (condition.own_data) {
        if (recordContext?.created_by !== userContext.userId) {
            return false;
        }
    }

    if (condition.own_department) {
        if (recordContext?.department_id !== userContext.department_id) {
            return false;
        }
    }

    return true;
};

export const invalidateCache = serviceHandler(async (tenantId: string, userId?: string) => {
    if (userId) {
        await redis.del(`rbac:${tenantId}:${userId}`);
    } else {
        // Find all keys starting with rbac:{tenantId}:
        const stream = redis.scanStream({
            match: `rbac:${tenantId}:*`,
            count: 100
        });

        stream.on('data', async (keys: string[]) => {
            if (keys.length) {
                const pipeline = redis.pipeline();
                keys.forEach(key => pipeline.del(key));
                await pipeline.exec();
            }
        });
        
        await new Promise((resolve) => stream.on('end', resolve));
    }
});
