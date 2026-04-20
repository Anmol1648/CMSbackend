import { Request, Response } from 'express';
import { asyncHandler, successResponse, ErrorCode } from '@shared/core';
import { AppError } from '../utils/errors';
import * as roleService from '../services/role.service';
import * as rbacService from '../services/rbac.service';
import { db } from '../models/prisma';

// ─── Internal Handlers (Called by API Gateway) ──────────────────────────────
export const getInternalPermissions = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    const tenantId = req.headers['x-tenant-id'] as string;
    
    if (!userId || !tenantId) {
        throw new AppError('Missing user or tenant context', 400, ErrorCode.VALIDATION_ERROR);
    }
    
    const permissions = await rbacService.getPermissionSet(userId, tenantId);
    return successResponse(res, permissions, 'Permissions retrieved');
});

export const getInternalFieldPermissions = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    const tenantId = req.headers['x-tenant-id'] as string;
    const modelName = req.params.modelName;

    if (!userId || !tenantId) {
        throw new AppError('Missing user or tenant context', 400, ErrorCode.VALIDATION_ERROR);
    }

    const userRoles = await db.userRole.findMany({
        where: { user_id: userId, tenant_id: tenantId },
        select: { role_id: true }
    });
    const roleIds = userRoles.map(ur => ur.role_id);

    const fields = await db.fieldPermission.findMany({
        where: {
            role_id: { in: roleIds },
            model_name: modelName
        }
    });

    return successResponse(res, fields, 'Field permissions retrieved');
});

// ─── My Permissions (Frontend Query) ────────────────────────────────────────
export const getMyPermissions = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const tenantId = (req as any).user.tenantId;

    const permissions = await rbacService.getPermissionSet(userId, tenantId);
    return successResponse(res, permissions, 'Permissions retrieved');
});

// ─── My Menus (Dynamic Sidebar) ─────────────────────────────────────────────
export const getMyMenus = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const tenantId = (req as any).user.tenantId;

    // Get user's role IDs
    const userRoles = await db.userRole.findMany({
        where: { user_id: userId, tenant_id: { in: [tenantId, 'system'] } },
        select: { role_id: true }
    });
    const roleIds = userRoles.map(ur => ur.role_id);

    const menuTree = await rbacService.buildMenuTree(roleIds);
    return successResponse(res, menuTree, 'User menus retrieved');
});

// ─── Permissions CRUD ───────────────────────────────────────────────────────
export const getAllPermissions = asyncHandler(async (req: Request, res: Response) => {
    const permissions = await db.permission.findMany({
        orderBy: [{ resource: 'asc' }, { action: 'asc' }]
    });
    return successResponse(res, permissions, 'All permissions retrieved');
});

export const createPermission = asyncHandler(async (req: Request, res: Response) => {
    const { resource, action, description } = req.body;
    const permission = await db.permission.create({
        data: { resource, action, description }
    });
    return successResponse(res, permission, 'Permission created successfully', 201);
});

export const updatePermission = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { resource, action, description } = req.body;
    const permission = await db.permission.update({
        where: { id },
        data: { resource, action, description }
    });
    return successResponse(res, permission, 'Permission updated successfully');
});

export const deletePermission = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    await db.permission.delete({ where: { id } });
    return successResponse(res, null, 'Permission deleted successfully');
});

// ─── Menus CRUD ─────────────────────────────────────────────────────────────
export const getMenus = asyncHandler(async (req: Request, res: Response) => {
    const menus = await db.menu.findMany({
        orderBy: { sort_order: 'asc' }
    });
    return successResponse(res, menus, 'All menus retrieved');
});

export const createMenu = asyncHandler(async (req: Request, res: Response) => {
    const { parent_id, ...rest } = req.body;
    const menu = await db.menu.create({
        data: {
            ...rest,
            ...(parent_id ? { parent: { connect: { id: parent_id } } } : {})
        }
    });
    return successResponse(res, menu, 'Menu created successfully', 201);
});

export const updateMenu = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { parent_id, ...rest } = req.body;
    const menu = await db.menu.update({
        where: { id },
        data: {
            ...rest,
            ...(parent_id !== undefined
                ? parent_id
                    ? { parent: { connect: { id: parent_id } } }
                    : { parent: { disconnect: true } }
                : {})
        }
    });
    return successResponse(res, menu, 'Menu updated successfully');
});

export const deleteMenu = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    await db.menu.delete({ where: { id } });
    return successResponse(res, null, 'Menu deleted successfully');
});

// ─── Roles CRUD ─────────────────────────────────────────────────────────────
export const getRoles = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = (req as any).user.tenantId;
    const roles = await db.role.findMany({
        where: { 
            OR: [
                { tenant_id: tenantId },
                { tenant_id: 'system' }
            ],
            deleted_at: null 
        },
        include: {
            _count: {
                select: { rolePermissions: true, roleMenus: true, userRoles: true }
            }
        },
        orderBy: { createdAt: 'desc' }
    });
    return successResponse(res, roles, 'Roles retrieved');
});

export const createRole = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = (req as any).user.tenantId;
    const role = await roleService.createRole(tenantId, req.body);
    return successResponse(res, role, 'Role created successfully', 201);
});

export const updateRole = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = (req as any).user.tenantId;
    const role = await roleService.updateRole(tenantId, req.params.id, req.body);
    return successResponse(res, role, 'Role updated successfully');
});

export const deleteRole = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = (req as any).user.tenantId;
    const result = await roleService.deleteRole(tenantId, req.params.id);
    return successResponse(res, result, result.message);
});

export const cloneRole = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = (req as any).user.tenantId;
    const { newSlug, newName } = req.body;
    const role = await roleService.cloneRole(tenantId, req.params.id, newSlug, newName);
    return successResponse(res, role, 'Role cloned successfully', 201);
});

// ─── Role Assignments ───────────────────────────────────────────────────────
export const assignPermissions = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = (req as any).user.tenantId;
    const { assignments } = req.body;
    const result = await roleService.assignPermissions(tenantId, req.params.id, assignments);
    return successResponse(res, result, result.message);
});

export const assignMenus = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = (req as any).user.tenantId;
    const { menus } = req.body;
    
    // Convert array of string menu IDs from frontend into expected object format
    const formattedMenus = Array.isArray(menus) 
        ? menus.map(id => typeof id === 'string' ? { menu_id: id, visible: true } : id)
        : [];
        
    const result = await roleService.assignMenus(tenantId, req.params.id, formattedMenus);
    return successResponse(res, result, result.message);
});

export const getRoleMenus = asyncHandler(async (req: Request, res: Response) => {
    const { id: roleId } = req.params;
    const roleMenus = await db.roleMenu.findMany({
        where: { role_id: roleId },
        include: { menu: true }
    });
    return successResponse(res, roleMenus, 'Role menu mappings retrieved');
});

export const getRolePermissions = asyncHandler(async (req: Request, res: Response) => {
    const { id: roleId } = req.params;
    const rolePermissions = await db.rolePermission.findMany({
        where: { role_id: roleId },
        include: { permission: true }
    });
    return successResponse(res, rolePermissions, 'Role permission mappings retrieved');
});

// ─── Simulation ─────────────────────────────────────────────────────────────
export const simulateRole = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = (req as any).user.tenantId;
    const simulation = await roleService.simulateRole(tenantId, req.params.id);
    return successResponse(res, simulation, 'Role simulation generated');
});

// ─── User Role Management ───────────────────────────────────────────────────
export const assignRoleToUser = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = (req as any).user.tenantId;
    const { userId } = req.params;
    const { roleIds } = req.body; 

    const validRoles = await db.role.findMany({
        where: { id: { in: roleIds }, tenant_id: { in: [tenantId, 'system'] }, deleted_at: null }
    });

    if (validRoles.length !== roleIds.length) {
        throw new AppError('One or more roles invalid or not found', 400, ErrorCode.VALIDATION_ERROR);
    }

    await db.$transaction(async (tx) => {
        await tx.userRole.deleteMany({
            where: { user_id: userId, tenant_id: tenantId }
        });

        if (roleIds.length > 0) {
            await tx.userRole.createMany({
                data: roleIds.map((rId: string) => ({
                    user_id: userId,
                    role_id: rId,
                    tenant_id: tenantId
                }))
            });
        }
    });

    await rbacService.invalidateCache(tenantId, userId);
    return successResponse(res, null, 'User roles updated successfully');
});

export const getUserRoles = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = (req as any).user.tenantId;
    const { userId } = req.params;

    const userRoles = await db.userRole.findMany({
        where: { user_id: userId, tenant_id: tenantId },
        include: { role: true }
    });

    return successResponse(res, userRoles, 'User roles retrieved');
});

export const getUsers = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = (req as any).user.tenantId;
    const { search } = req.query;

    const users = await db.user.findMany({
        where: {
            tenant_id: tenantId,
            ...(search ? {
                OR: [
                    { email: { contains: search as string, mode: 'insensitive' } },
                    { first_name: { contains: search as string, mode: 'insensitive' } },
                    { last_name: { contains: search as string, mode: 'insensitive' } },
                ]
            } : {})
        },
        include: {
            profile: {
                select: { avatar_url: true }
            },
            userRoles: {
                include: { role: true }
            }
        },
        take: 50,
        orderBy: { createdAt: 'desc' }
    });

    return successResponse(res, users, 'Users retrieved');
});

export const toggleUserStatus = asyncHandler(async (req: Request, res: Response) => {
    const tenantId = (req as any).user.tenantId;
    const { userId } = req.params;
    const { is_active } = req.body;

    const user = await db.user.findFirst({
        where: { id: userId, tenant_id: tenantId }
    });

    if (!user) {
        throw new AppError('User not found', 404, ErrorCode.VALIDATION_ERROR);
    }

    const updated = await db.user.update({
        where: { id: userId },
        data: { is_active }
    });

    return successResponse(res, { id: updated.id, is_active: updated.is_active }, 'User status updated');
});
