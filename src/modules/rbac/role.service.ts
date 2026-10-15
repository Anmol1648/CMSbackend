import type { DataScope } from '@prisma/client';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { findPermissionDef, listModules, listPermissionDefs, SCOPE_RANK } from '../../core/registry/permissions';
import { getUserAccess, invalidateAccess } from './access.service';

/** Roles of the current school and the permissions they grant. */

const toSlug = (name: string) =>
    name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'role';

const uniqueSlug = async (name: string) => {
    const base = toSlug(name);
    const taken = new Set((await db.role.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })).map((r) => r.slug));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
};

const findRole = async (id: string) => {
    const role = await db.role.findUnique({ where: { id } });
    if (!role) throw notFound('Role not found');
    return role;
};

/** The permission catalogue, grouped by module, for the Roles screen. */
export const permissionCatalogue = () =>
    listModules().map((m) => ({
        module: m.key,
        label: m.label,
        permissions: listPermissionDefs()
            .filter((p) => p.module === m.key)
            .map((p) => ({ key: p.key, label: p.label, description: p.description ?? null, sensitive: p.sensitive ?? false, scopes: p.scopes })),
    }));

export const listRoles = async () => {
    const roles = await db.role.findMany({
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
        include: { _count: { select: { users: true, permissions: true } } },
    });
    const total = listPermissionDefs().length;
    return roles.map(({ _count, ...r }) => ({ ...r, userCount: _count.users, permissionCount: r.isSystem ? total : _count.permissions }));
};

export const getRole = async (id: string) => {
    const role = await db.role.findUnique({ where: { id }, include: { permissions: { select: { permissionKey: true, scope: true } }, _count: { select: { users: true } } } });
    if (!role) throw notFound('Role not found');
    const { permissions, _count, ...rest } = role;
    const grants = role.isSystem
        ? listPermissionDefs().map((p) => ({ key: p.key, scope: 'all' as DataScope }))
        : permissions.map((p) => ({ key: p.permissionKey, scope: p.scope }));
    return { ...rest, userCount: _count.users, permissions: grants };
};

export const createRole = async (input: { name: string; description?: string | null; copyFromRoleId?: string }) => {
    const name = input.name.trim();
    if (await db.role.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } })) throw conflict(`A role called "${name}" already exists`);
    const source = input.copyFromRoleId ? await getRole(input.copyFromRoleId) : null;
    const tenantId = getTenantId()!;

    const role = await withTransaction(async (tx) => {
        const created = await tx.role.create({ data: { tenantId, name, slug: await uniqueSlug(name), description: input.description?.trim() || null } });
        if (source?.permissions.length) {
            await tx.rolePermission.createMany({ data: source.permissions.map((g) => ({ tenantId, roleId: created.id, permissionKey: g.key, scope: g.scope })) });
        }
        return created;
    });
    await recordAudit({ action: 'create', entity: 'role', entityId: role.id, changes: { name, copiedFrom: source?.name ?? null } });
    return getRole(role.id);
};

export const updateRole = async (id: string, input: { name?: string; description?: string | null }) => {
    const role = await findRole(id);
    const data: { name?: string; description?: string | null } = {};
    if (input.name !== undefined && input.name.trim() !== role.name) {
        const name = input.name.trim();
        if (await db.role.findFirst({ where: { id: { not: id }, name: { equals: name, mode: 'insensitive' } } })) throw conflict(`A role called "${name}" already exists`);
        data.name = name;
    }
    if (input.description !== undefined) data.description = input.description?.trim() || null;
    if (!Object.keys(data).length) return getRole(id);
    await db.role.update({ where: { id }, data });
    await recordAudit({ action: 'update', entity: 'role', entityId: id, changes: { name: data.name !== undefined ? [role.name, data.name] : undefined, description: data.description !== undefined ? [role.description, data.description] : undefined } });
    await invalidateAccess();
    return getRole(id);
};

/**
 * Replaces a role's permissions. Someone who isn't Super Admin can only grant what they hold
 * themselves, at no broader scope (no promoting yourself through a role).
 */
export const setRolePermissions = async (id: string, grants: { key: string; scope: DataScope }[], actorUserId: string) => {
    const role = await findRole(id);
    if (role.isSystem) throw badRequest('Super Admin always has every permission; it can’t be changed');

    const issues: { field: string; message: string }[] = [];
    const seen = new Set<string>();
    for (const g of grants) {
        const def = findPermissionDef(g.key);
        if (!def) issues.push({ field: g.key, message: 'is not a known permission' });
        else if (!def.scopes.includes(g.scope)) issues.push({ field: g.key, message: `can only be given with scope ${def.scopes.join(' / ')}` });
        if (seen.has(g.key)) issues.push({ field: g.key, message: 'is listed twice' });
        seen.add(g.key);
    }
    if (issues.length) throw badRequest('Some permissions are not valid', issues);

    const actor = await getUserAccess(actorUserId);
    const before = await db.rolePermission.findMany({ where: { roleId: id }, select: { permissionKey: true, scope: true } });
    const beforeMap = new Map(before.map((b) => [b.permissionKey, b.scope]));
    if (!actor.isSuperAdmin) {
        const tooMuch = grants.filter((g) => {
            const unchanged = beforeMap.get(g.key) === g.scope;
            const held = actor.permissions[g.key];
            return !unchanged && (!held || SCOPE_RANK[held] < SCOPE_RANK[g.scope]);
        });
        if (tooMuch.length) {
            throw forbidden(`You can only give permissions you have yourself: ${tooMuch.map((g) => findPermissionDef(g.key)?.label ?? g.key).join('; ')}`);
        }
    }

    const tenantId = getTenantId()!;
    await withTransaction(async (tx) => {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        if (grants.length) await tx.rolePermission.createMany({ data: grants.map((g) => ({ tenantId, roleId: id, permissionKey: g.key, scope: g.scope })) });
    });

    const afterMap = new Map(grants.map((g) => [g.key, g.scope]));
    const added = grants.filter((g) => !beforeMap.has(g.key)).map((g) => `${g.key}:${g.scope}`);
    const removed = before.filter((b) => !afterMap.has(b.permissionKey)).map((b) => b.permissionKey);
    const rescoped = grants.filter((g) => beforeMap.has(g.key) && beforeMap.get(g.key) !== g.scope).map((g) => `${g.key}:${beforeMap.get(g.key)}→${g.scope}`);
    await recordAudit({ action: 'permission_change', entity: 'role', entityId: id, changes: { role: role.name, added, removed, rescoped } });
    await invalidateAccess();
    return getRole(id);
};

export const deleteRole = async (id: string) => {
    const role = await findRole(id);
    if (role.isSystem) throw badRequest('Super Admin can’t be deleted');
    const users = await db.userRole.count({ where: { roleId: id } });
    if (users) throw conflict(`${users} user${users === 1 ? ' has' : 's have'} this role. Give them another role first.`);
    await db.role.delete({ where: { id } });
    await recordAudit({ action: 'delete', entity: 'role', entityId: id, changes: { name: role.name } });
};
