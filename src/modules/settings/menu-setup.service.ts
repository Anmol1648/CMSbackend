import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { listMenuGroups, listMenuItems } from '../../core/registry/menu';
import { listPermissionDefs } from '../../core/registry/permissions';
import { buildMenu } from '../rbac/my-access';
import { getUserAccess } from '../rbac/access.service';

/**
 * Menu Setup: a school's own names, order, icons and groups for the sidebar, and items or groups it
 * hides. Who may open a page still comes from role permissions.
 */

/** Every group and item with the built-in values and the school's own (for the setup screen). */
export const menuSetup = async () => {
    const [custom, groupCustom] = await Promise.all([db.menuCustomization.findMany(), db.menuGroupCustomization.findMany()]);
    const c = new Map(custom.map((x) => [x.menuKey, x]));
    const gc = new Map(groupCustom.map((x) => [x.groupKey, x]));
    const perm = new Map(listPermissionDefs().map((p) => [p.key, p.label]));
    return {
        groups: listMenuGroups().map((g) => ({ key: g.key, defaultLabel: g.label, defaultOrder: g.order, label: gc.get(g.key)?.label ?? null, sortOrder: gc.get(g.key)?.sortOrder ?? null, hidden: gc.get(g.key)?.hidden ?? false })),
        items: listMenuItems().map((i) => ({
            key: i.key,
            href: i.href,
            defaultLabel: i.label,
            defaultIcon: i.icon,
            defaultGroup: i.group,
            defaultOrder: i.order,
            label: c.get(i.key)?.label ?? null,
            icon: c.get(i.key)?.icon ?? null,
            groupKey: c.get(i.key)?.groupKey ?? null,
            sortOrder: c.get(i.key)?.sortOrder ?? null,
            hidden: c.get(i.key)?.hidden ?? false,
            needs: i.anyPermission ? i.anyPermission.map((k) => perm.get(k) ?? k).join(' or ') : i.permission ? (perm.get(i.permission) ?? i.permission) : 'everyone',
        })),
        roles: await db.role.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    };
};

const text = (max: number) => z.string().trim().max(max).nullable().optional();
export const menuSaveSchema = z.strictObject({
    groups: z.array(z.strictObject({ key: z.string().max(60), label: text(40), sortOrder: z.number().int().min(-999).max(9999).nullable().optional(), hidden: z.boolean().default(false) })).max(200),
    items: z.array(z.strictObject({ key: z.string().max(60), label: text(60), icon: z.string().trim().regex(/^[a-z0-9_]{2,40}$/, 'must be an icon name like bed or restaurant').nullable().optional(), groupKey: z.string().max(60).nullable().optional(), sortOrder: z.number().int().min(-999).max(9999).nullable().optional(), hidden: z.boolean().default(false) })).max(1000),
});
export type MenuSave = z.infer<typeof menuSaveSchema>;

/** Saves the school's whole menu set-up (only what differs from the built-in is kept). */
export const saveMenu = async (input: MenuSave, userId: string | null) => {
    const groups = new Map(listMenuGroups().map((g) => [g.key, g]));
    const items = new Map(listMenuItems().map((i) => [i.key, i]));
    for (const g of input.groups) if (!groups.has(g.key)) throw badRequest(`There is no menu group “${g.key}”`);
    for (const i of input.items) {
        if (!items.has(i.key)) throw badRequest(`There is no menu item “${i.key}”`);
        if (i.groupKey && !groups.has(i.groupKey)) throw badRequest(`There is no menu group “${i.groupKey}”`);
    }
    const tenantId = getTenantId()!;
    const g2 = input.groups
        .map((g) => {
            const d = groups.get(g.key)!;
            return { tenantId, groupKey: g.key, label: g.label && g.label !== d.label ? g.label : null, sortOrder: g.sortOrder ?? null, hidden: g.hidden, updatedBy: userId };
        })
        .filter((g) => g.label || g.sortOrder !== null || g.hidden);
    const i2 = input.items
        .map((i) => {
            const d = items.get(i.key)!;
            return { tenantId, menuKey: i.key, label: i.label && i.label !== d.label ? i.label : null, icon: i.icon && i.icon !== d.icon ? i.icon : null, groupKey: i.groupKey && i.groupKey !== d.group ? i.groupKey : null, sortOrder: i.sortOrder ?? null, hidden: i.hidden, updatedBy: userId };
        })
        .filter((i) => i.label || i.icon || i.groupKey || i.sortOrder !== null || i.hidden);
    await withTransaction(async (tx) => {
        await tx.menuGroupCustomization.deleteMany({});
        await tx.menuCustomization.deleteMany({});
        if (g2.length) await tx.menuGroupCustomization.createMany({ data: g2 });
        if (i2.length) await tx.menuCustomization.createMany({ data: i2 });
    });
    await recordAudit({ action: 'menu_saved', entity: 'menu', changes: { groups: g2.length, items: i2.length } });
    return menuSetup();
};

/** Back to the built-in menu. */
export const resetMenu = async () => {
    await withTransaction(async (tx) => {
        await tx.menuGroupCustomization.deleteMany({});
        await tx.menuCustomization.deleteMany({});
    });
    await recordAudit({ action: 'menu_reset', entity: 'menu' });
    return menuSetup();
};

/** The sidebar a role would see with the saved set-up (Super Admin: everything). */
export const previewAs = async (roleId: string) => {
    if (!z.uuid().safeParse(roleId).success) throw notFound('Role not found');
    const role = await db.role.findFirst({ where: { id: roleId }, select: { isSystem: true, permissions: { select: { permissionKey: true } } } });
    if (!role) throw notFound('Role not found');
    const permissions: Record<string, string> = {};
    if (role.isSystem) for (const p of listPermissionDefs()) permissions[p.key] = 'all';
    else for (const p of role.permissions) permissions[p.permissionKey] = 'all';
    return buildMenu(permissions);
};

/** For the person saving: their own menu after the change. */
export const myMenuNow = async (userId: string) => buildMenu((await getUserAccess(userId)).permissions);

/** The school's set-up as a template (Platform console), and a template applied to the school. */
export const exportMenu = async () => {
    const [items, groups] = await Promise.all([db.menuCustomization.findMany(), db.menuGroupCustomization.findMany()]);
    return { items: items.map(({ menuKey, label, icon, groupKey, sortOrder, hidden }) => ({ key: menuKey, label, icon, groupKey, sortOrder, hidden })), groups: groups.map(({ groupKey, label, sortOrder, hidden }) => ({ key: groupKey, label, sortOrder, hidden })) };
};
