import { db } from '../../core/db';
import { listMenuGroups, listMenuItems } from '../../core/registry/menu';
import { getUserAccess } from './access.service';

/** What a person may do plus their sidebar (filtered by permission and the school's customisations). */
export const myAccess = async (userId: string) => {
    const access = await getUserAccess(userId);
    const custom = new Map((await db.menuCustomization.findMany()).map((c) => [c.menuKey, c]));
    const allowed = listMenuItems().filter((i) => (i.anyPermission ? i.anyPermission.some((k) => access.permissions[k]) : !i.permission || access.permissions[i.permission]));
    const switchedOn = await Promise.all(allowed.map((i) => (i.visible ? i.visible().catch(() => true) : Promise.resolve(true))));
    const visible = allowed
        .filter((_, n) => switchedOn[n])
        .filter((i) => !custom.get(i.key)?.hidden)
        .map((i) => ({ ...i, label: custom.get(i.key)?.label ?? i.label, order: custom.get(i.key)?.sortOrder ?? i.order }));
    const menu = listMenuGroups()
        .map((g) => ({
            key: g.key,
            label: g.label,
            items: visible
                .filter((i) => i.group === g.key)
                .sort((a, b) => a.order - b.order)
                .map(({ key, label, icon, href }) => ({ key, label, icon, href })),
        }))
        .filter((g) => g.items.length);
    return { isSuperAdmin: access.isSuperAdmin, permissions: access.permissions, menu };
};
