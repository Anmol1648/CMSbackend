import { db } from '../models/prisma';
import { serviceHandler, ErrorCode } from '@shared/core';
import { invalidateCache, getPermissionSet, buildMenuTree } from './rbac.service';
import { AppError } from '../utils/errors';

export const createRole = serviceHandler(async (tenantId: string, data: any) => {
    // Check slug uniqueness within tenant
    const existing = await db.role.findUnique({
        where: { slug_tenant_id: { slug: data.slug, tenant_id: tenantId } }
    });

    if (existing && !existing.deleted_at) {
        throw new AppError('Role slug already exists in this tenant', 400, ErrorCode.VALIDATION_ERROR);
    }

    if (existing && existing.deleted_at) {
        // Restore soft-deleted
        const updated = await db.role.update({
            where: { id: existing.id },
            data: { ...data, deleted_at: null, tenant_id: tenantId }
        });
        return updated;
    }

    const role = await db.role.create({
        data: {
            ...data,
            tenant_id: tenantId
        }
    });

    return role;
});

export const updateRole = serviceHandler(async (tenantId: string, roleId: string, data: any) => {
    const role = await db.role.findFirst({
        where: { id: roleId, tenant_id: { in: [tenantId, 'system'] }, deleted_at: null }
    });

    if (!role) {
        throw new AppError('Role not found', 404, ErrorCode.RBAC_ROLE_NOT_FOUND);
    }

    const updated = await db.role.update({
        where: { id: roleId },
        data
    });

    await invalidateCache(tenantId);
    return updated;
});

export const deleteRole = serviceHandler(async (tenantId: string, roleId: string) => {
    const role = await db.role.findFirst({
        where: { id: roleId, tenant_id: { in: [tenantId, 'system'] }, deleted_at: null }
    });

    if (!role) {
        throw new AppError('Role not found', 404, ErrorCode.RBAC_ROLE_NOT_FOUND);
    }

    if (role.is_system) {
        throw new AppError('Cannot delete system role', 403, ErrorCode.RBAC_FORBIDDEN);
    }

    await db.role.update({
        where: { id: roleId },
        data: { deleted_at: new Date() }
    });

    await invalidateCache(tenantId);
    return { message: 'Role deleted successfully' };
});

export const cloneRole = serviceHandler(async (tenantId: string, sourceRoleId: string, newSlug: string, newName: string) => {
    const source = await db.role.findFirst({
        where: { id: sourceRoleId, tenant_id: { in: [tenantId, 'system'] }, deleted_at: null },
        include: {
            rolePermissions: true,
            roleMenus: true,
            fieldPermissions: true
        }
    });

    if (!source) {
        throw new AppError('Source role not found', 404, ErrorCode.RBAC_ROLE_NOT_FOUND);
    }

    // Wrap in transaction
    const newRole = await db.$transaction(async (tx) => {
        const role = await tx.role.create({
            data: {
                name: newName,
                slug: newSlug,
                tenant_id: tenantId,
                scope: source.scope,
                parent_role_id: source.parent_role_id,
                is_system: false // Cloned roles are never system roles
            }
        });

        if (source.rolePermissions.length > 0) {
            await tx.rolePermission.createMany({
                data: source.rolePermissions.map(rp => ({
                    role_id: role.id,
                    permission_id: rp.permission_id,
                    condition: rp.condition || undefined
                }))
            });
        }

        if (source.roleMenus.length > 0) {
            await tx.roleMenu.createMany({
                data: source.roleMenus.map(rm => ({
                    role_id: role.id,
                    menu_id: rm.menu_id,
                    visible: rm.visible
                }))
            });
        }

        if (source.fieldPermissions.length > 0) {
            await tx.fieldPermission.createMany({
                data: source.fieldPermissions.map(fp => ({
                    role_id: role.id,
                    model_name: fp.model_name,
                    field_name: fp.field_name,
                    can_read: fp.can_read,
                    can_write: fp.can_write
                }))
            });
        }

        return role;
    });

    return newRole;
});

export const assignPermissions = serviceHandler(async (tenantId: string, roleId: string, assignments: { permission_id: string, condition?: any }[]) => {
    const role = await db.role.findFirst({
        where: { id: roleId, tenant_id: { in: [tenantId, 'system'] }, deleted_at: null }
    });

    if (!role) {
        throw new AppError('Role not found', 404, ErrorCode.RBAC_ROLE_NOT_FOUND);
    }

    await db.$transaction(async (tx) => {
        // Clear existing
        await tx.rolePermission.deleteMany({
            where: { role_id: roleId }
        });

        // Insert new
        if (assignments.length > 0) {
            await tx.rolePermission.createMany({
                data: assignments.map(a => ({
                    role_id: roleId,
                    permission_id: a.permission_id,
                    condition: a.condition || undefined
                }))
            });
        }
    });

    await invalidateCache(tenantId);
    return { message: 'Permissions assigned successfully' };
});

export const assignMenus = serviceHandler(async (tenantId: string, roleId: string, menus: { menu_id: string, visible: boolean }[]) => {
    const role = await db.role.findFirst({
        where: { id: roleId, tenant_id: { in: [tenantId, 'system'] }, deleted_at: null }
    });

    if (!role) {
        throw new AppError('Role not found', 404, ErrorCode.RBAC_ROLE_NOT_FOUND);
    }

    await db.$transaction(async (tx) => {
        // Clear existing
        await tx.roleMenu.deleteMany({
            where: { role_id: roleId }
        });

        // Insert new
        if (menus.length > 0) {
            await tx.roleMenu.createMany({
                data: menus.map(m => ({
                    role_id: roleId,
                    menu_id: m.menu_id,
                    visible: m.visible
                }))
            });
        }
    });

    await invalidateCache(tenantId); // Menus might also be cached in the future
    return { message: 'Menus assigned successfully' };
});

export const simulateRole = serviceHandler(async (tenantId: string, roleId: string) => {
    const role = await db.role.findFirst({
        where: { id: roleId, tenant_id: { in: [tenantId, 'system'] }, deleted_at: null },
        include: {
            rolePermissions: {
                include: { permission: true }
            },
            fieldPermissions: true
        }
    });

    if (!role) {
        throw new AppError('Role not found', 404, ErrorCode.RBAC_ROLE_NOT_FOUND);
    }

    const menuTree = await buildMenuTree([roleId]);

    const formattedPermissions = role.rolePermissions.map(rp => ({
        resource: rp.permission.resource,
        action: rp.permission.action,
        condition: rp.condition
    }));

    return {
        role: { id: role.id, name: role.name, slug: role.slug },
        permissions: formattedPermissions,
        menuTree,
        fieldPermissions: role.fieldPermissions
    };
});
