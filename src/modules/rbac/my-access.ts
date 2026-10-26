import { db } from '../../core/db';
import { listMenuGroups, listMenuItems } from '../../core/registry/menu';
import { getUserAccess } from './access.service';

/**
 * The sidebar for a set of permissions, with the school's own names, places, icons and hidden items
 * and groups (Menu Setup). Items are offered by permission; customising never shows a page someone
 * may not open. `app` says whether the mobile app shows the item (the website shows them all).
 */
export const buildMenu = async (permissions: Record<string, unknown>) => {
    const [custom, groupCustom] = await Promise.all([db.menuCustomization.findMany(), db.menuGroupCustomization.findMany()]);
    const c = new Map(custom.map((x) => [x.menuKey, x]));
    const gc = new Map(groupCustom.map((x) => [x.groupKey, x]));
    const allowed = listMenuItems()
        .filter((i) => (i.anyPermission ? i.anyPermission.some((k) => permissions[k]) : !i.permission || permissions[i.permission]))
        .filter((i) => !i.scopes || !i.permission || i.scopes.includes(String(permissions[i.permission])));
    const switchedOn = await Promise.all(allowed.map((i) => (i.visible ? i.visible().catch(() => true) : Promise.resolve(true))));
    const groupKeys = new Set(listMenuGroups().map((g) => g.key));
    const visible = allowed
        .filter((_, n) => switchedOn[n])
        .filter((i) => !c.get(i.key)?.hidden)
        .map((i) => {
            const x = c.get(i.key);
            return { ...i, label: x?.label ?? i.label, icon: x?.icon ?? i.icon, group: x?.groupKey && groupKeys.has(x.groupKey) ? x.groupKey : i.group, order: x?.sortOrder ?? i.order, app: x?.inApp ?? i.app ?? true };
        });
    return listMenuGroups()
        .filter((g) => !gc.get(g.key)?.hidden)
        .map((g) => ({ g, order: gc.get(g.key)?.sortOrder ?? g.order }))
        .sort((a, b) => a.order - b.order)
        .map(({ g }) => ({
            key: g.key,
            label: gc.get(g.key)?.label ?? g.label,
            items: visible
                .filter((i) => i.group === g.key)
                .sort((a, b) => a.order - b.order)
                .map(({ key, label, icon, href, app }) => ({ key, label, icon, href, app })),
        }))
        .filter((g) => g.items.length);
};

/** What a person may do plus their sidebar (filtered by permission and the school's customisations). */
export const myAccess = async (userId: string) => {
    const access = await getUserAccess(userId);
    return { isSuperAdmin: access.isSuperAdmin, permissions: access.permissions, menu: await buildMenu(access.permissions) };
};
