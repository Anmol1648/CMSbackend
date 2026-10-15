import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { validationError } from '../../core/errors';
import { db } from '../../core/db';
import { listMenuGroups, listMenuItems } from '../../core/registry/menu';
import { authenticated, can } from '../../middlewares/access';
import * as roles from './role.service';
import { getUserAccess } from './access.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) throw validationError(parsed.error);
    return parsed.data;
};

const roleInput = z.strictObject({
    name: z.string().trim().min(2, 'must be at least 2 characters').max(80),
    description: z.string().trim().max(300).nullable().optional(),
});
const createRoleInput = roleInput.extend({ copyFromRoleId: z.string().uuid().optional() });
const grantsInput = z.strictObject({
    permissions: z.array(z.strictObject({ key: z.string().max(100), scope: z.enum(['all', 'assigned', 'own']) })).max(1000),
});

// ─── Roles ───────────────────────────────────────────────────────────────────

export const roleRoutes = Router();

roleRoutes.get('/', can('role.view'), asyncHandler(async (_req: Request, res: Response) => {
    successResponse(res, await roles.listRoles(), 'Roles');
}));

roleRoutes.get('/permissions', can('role.view'), asyncHandler(async (_req: Request, res: Response) => {
    successResponse(res, roles.permissionCatalogue(), 'Permissions');
}));

roleRoutes.get('/:id', can('role.view'), asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await roles.getRole(req.params.id), 'Role');
}));

roleRoutes.post('/', can('role.manage'), asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await roles.createRole(parse(createRoleInput, req.body)), 'Role created', 201);
}));

roleRoutes.patch('/:id', can('role.manage'), asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await roles.updateRole(req.params.id, parse(roleInput.partial(), req.body)), 'Role saved');
}));

roleRoutes.put('/:id/permissions', can('role.manage'), asyncHandler(async (req: Request, res: Response) => {
    const { permissions } = parse(grantsInput, req.body);
    successResponse(res, await roles.setRolePermissions(req.params.id, permissions, req.user!.userId), 'Permissions saved');
}));

roleRoutes.delete('/:id', can('role.manage'), asyncHandler(async (req: Request, res: Response) => {
    await roles.deleteRole(req.params.id);
    successResponse(res, {}, 'Role deleted');
}));

// ─── Me: what I may do + my sidebar ──────────────────────────────────────────

export const meRoutes = Router();

meRoutes.get('/access', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const access = await getUserAccess(req.user!.userId);
    const custom = new Map((await db.menuCustomization.findMany()).map((c) => [c.menuKey, c]));
    const visible = listMenuItems()
        .filter((i) => !i.permission || access.permissions[i.permission])
        .filter((i) => !custom.get(i.key)?.hidden)
        .map((i) => ({ ...i, label: custom.get(i.key)?.label ?? i.label, order: custom.get(i.key)?.sortOrder ?? i.order }));
    const menu = listMenuGroups()
        .map((g) => ({ key: g.key, label: g.label, items: visible.filter((i) => i.group === g.key).sort((a, b) => a.order - b.order).map(({ key, label, icon, href }) => ({ key, label, icon, href })) }))
        .filter((g) => g.items.length);
    successResponse(res, { isSuperAdmin: access.isSuperAdmin, permissions: access.permissions, menu }, 'Your access');
}));
