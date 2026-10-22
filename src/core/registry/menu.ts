/**
 * Sidebar registry. Each module declares its pages (`<module>.menu.ts`); a person sees a page only if
 * they hold its permission. Schools can rename / reorder / hide items (menu_customizations).
 */

export interface MenuItemDef {
    key: string;
    label: string;
    icon: string;
    href: string;
    /** Section heading in the sidebar. */
    group: string;
    order: number;
    /** Needed to see the item; omit for "every signed-in user". */
    permission?: string;
    /** Or any one of these (e.g. approvers of their team and approvers of everyone). */
    anyPermission?: string[];
    /** Shown only when this says so for the school (e.g. a feature switched on in System Settings). */
    visible?: () => Promise<boolean>;
}

export interface MenuGroupDef {
    key: string;
    label: string;
    order: number;
}

const items = new Map<string, MenuItemDef>();
const groups = new Map<string, MenuGroupDef>();

export const registerMenuGroup = (group: MenuGroupDef) => groups.set(group.key, group);

export const registerMenuItems = (defs: MenuItemDef[]) => {
    for (const d of defs) {
        if (items.has(d.key)) throw new Error(`Menu item "${d.key}" is registered twice`);
        items.set(d.key, d);
    }
};

export const listMenuItems = () => [...items.values()];
export const listMenuGroups = () => [...groups.values()].sort((a, b) => a.order - b.order);
