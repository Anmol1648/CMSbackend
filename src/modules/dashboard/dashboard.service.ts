import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { cache } from '../../core/cache';
import { logger } from '../../core/logger';
import { recordAudit } from '../../core/audit';
import { getUserAccess } from '../rbac/access.service';
import { getSettings } from '../../core/settings';
import { defaultLayoutOf, findWidget, LayoutItem, listActions, listWidgets, mayUse, widgetCategoryRank, WidgetData } from './dashboard.registry';
import { DASHBOARD } from './dashboard.settings';
import './widgets';
import './widgets2';
import './actions';

/**
 * The home dashboard: each role has a layout (set by the school, or the built-in one for the role);
 * a person sees the widgets of all their roles, once each, and only those their permissions allow.
 * Widgets load one by one, and their numbers are kept for a little while.
 */

const SIZES = ['sm', 'md', 'lg'] as const;
const cacheKey = (userId: string, key: string, filter?: string) => `dash:${getTenantId()}:${userId}:${key}${filter ? `:${filter}` : ''}`;

const layoutOfRole = async (role: { id: string; slug: string }): Promise<LayoutItem[]> => {
    const saved = await db.dashboardLayout.findFirst({ where: { roleId: role.id }, select: { widgets: true } });
    if (saved) return (saved.widgets as LayoutItem[]).filter((w) => findWidget(w.key));
    return defaultLayoutOf(role.slug) ?? [];
};

/** The widgets of the person's roles, once each, that they may see. */
const roleItems = async (userId: string, access: Awaited<ReturnType<typeof getUserAccess>>) => {
    const roles = await db.role.findMany({ where: { users: { some: { userId } } }, select: { id: true, slug: true, name: true } });
    // Super Admin without a school role gets the school admin's dashboard.
    const lists = await Promise.all(roles.map(layoutOfRole));
    if (!lists.some((l) => l.length) && access.isSuperAdmin) lists.push(defaultLayoutOf('school-admin') ?? []);
    const seen = new Set<string>();
    const items = [];
    for (const list of lists)
        for (const item of list) {
            const w = findWidget(item.key);
            if (!w || seen.has(w.key) || !mayUse(w, access.permissions)) continue;
            seen.add(w.key);
            items.push(item);
        }
    return items;
};

const view = (items: LayoutItem[], permissions: Record<string, string>) =>
    items
        .map((i) => ({ i, w: findWidget(i.key) }))
        .filter((x) => x.w && mayUse(x.w, permissions))
        .map(({ i, w }) => ({ key: w!.key, label: w!.label, type: w!.type, size: i.size, filter: i.filter ?? null, href: w!.href ?? null }));

/** The person's dashboard: their own arrangement (if they made one and the school allows it) or their roles' widgets. */
export const myDashboard = async (userId: string) => {
    const access = await getUserAccess(userId);
    const [s, own] = await Promise.all([getSettings({ personal: DASHBOARD.personal, actions: DASHBOARD.actions }), db.userDashboard.findFirst({ where: { userId }, select: { widgets: true } })]);
    const personal = s.personal && Array.isArray(own?.widgets);
    const items = personal ? (own!.widgets as LayoutItem[]) : await roleItems(userId, access);
    return { widgets: view(items, access.permissions), personal, canCustomise: s.personal, actionCentre: s.actions, canSetUp: access.isSuperAdmin || !!access.permissions['dashboard.setup'] };
};

/** The widgets the person may add to their own dashboard. */
export const myCatalogue = async (userId: string) => {
    const access = await getUserAccess(userId);
    return catalogue().filter((w) => mayUse(findWidget(w.key)!, access.permissions));
};

const SIZES_Z = z.enum(['sm', 'md', 'lg']);
export const myLayoutSchema = z.strictObject({
    widgets: z
        .array(z.strictObject({ key: z.string().min(1).max(60), size: SIZES_Z, filter: z.string().max(60).nullable().optional() }))
        .max(40)
        .refine((xs) => new Set(xs.map((x) => x.key)).size === xs.length, 'a widget is there twice'),
});
export const saveMine = async (userId: string, input: z.infer<typeof myLayoutSchema>) => {
    const { personal } = await getSettings({ personal: DASHBOARD.personal });
    if (!personal) throw forbidden('Your school has fixed the dashboards');
    const access = await getUserAccess(userId);
    const bad = input.widgets.find((w) => !findWidget(w.key) || !mayUse(findWidget(w.key)!, access.permissions));
    if (bad) throw badRequest(`You can’t add “${bad.key}”`);
    const widgets = input.widgets.map((w) => ({ key: w.key, size: w.size, ...(w.filter ? { filter: w.filter } : {}) }));
    await db.userDashboard.upsert({ where: { tenantId_userId: { tenantId: getTenantId()!, userId } }, create: { tenantId: getTenantId()!, userId, widgets }, update: { widgets } });
    return myDashboard(userId);
};
/** Back to the roles' dashboard (shortcuts are kept). */
export const resetMine = async (userId: string) => {
    await db.userDashboard.updateMany({ where: { userId }, data: { widgets: Prisma.DbNull } });
    return myDashboard(userId);
};

export const linksSchema = z.strictObject({ links: z.array(z.strictObject({ label: z.string().trim().min(1).max(60), href: z.string().trim().regex(/^\/[A-Za-z0-9/_?=&.-]*$/, 'must be a page of the ERP') })).max(12) });
export const saveLinks = async (userId: string, input: z.infer<typeof linksSchema>) => {
    await db.userDashboard.upsert({ where: { tenantId_userId: { tenantId: getTenantId()!, userId } }, create: { tenantId: getTenantId()!, userId, links: input.links }, update: { links: input.links } });
    await cache.del(cacheKey(userId, 'quick_links')).catch(() => undefined);
    return input.links;
};
export const myLinks = async (userId: string) => ((await db.userDashboard.findFirst({ where: { userId }, select: { links: true } }))?.links ?? []) as { label: string; href: string }[];

/** "Waiting for you": each kind of thing waiting on the person, with how many (kept a minute). */
export const myActions = async (userId: string, fresh = false) => {
    const ck = cacheKey(userId, '__actions');
    if (!fresh) {
        const hit = await cache.get(ck).catch(() => null);
        if (hit) return JSON.parse(hit) as unknown[];
    }
    const access = await getUserAccess(userId);
    const defs = listActions().filter((a) => a.permissions.some((p) => access.permissions[p]));
    const rows = await Promise.all(
        defs.map(async (a) => {
            try {
                const r = await a.count({ userId, permissions: access.permissions });
                const x = typeof r === 'number' ? { count: r } : r;
                return x.count > 0 ? { key: a.key, label: x.label ?? a.label, icon: a.icon, href: a.href, count: x.count, value: x.value ?? String(x.count), tone: a.tone ?? 'warn' } : null;
            } catch (err) {
                logger.warn('Dashboard action failed', { action: a.key, error: (err as Error).message });
                return null;
            }
        })
    );
    const out = rows.filter(Boolean);
    await cache.set(ck, JSON.stringify(out), 60).catch(() => undefined);
    return out;
};

/** One widget's data, for the person (checked against their permissions; kept a little while). */
export const widgetData = async (key: string, userId: string, fresh = false, filter?: string): Promise<WidgetData & { updatedAt: string }> => {
    const w = findWidget(key);
    if (!w) throw notFound('Widget not found');
    const access = await getUserAccess(userId);
    if (!mayUse(w, access.permissions)) throw forbidden();
    const ck = cacheKey(userId, key, filter);
    if (!fresh) {
        const hit = await cache.get(ck).catch(() => null);
        if (hit) return JSON.parse(hit);
    }
    let data: WidgetData;
    try {
        data = await w.load({ userId, permissions: access.permissions, filter: filter || undefined });
    } catch (err) {
        // A widget that can't load (no current session yet, nothing set up) says so instead of failing the page.
        logger.warn('Dashboard widget failed', { widget: key, error: (err as Error).message });
        return { items: [], empty: (err as { statusCode?: number }).statusCode && (err as { statusCode: number }).statusCode < 500 ? (err as Error).message : 'Couldn’t load this just now.', updatedAt: new Date().toISOString() };
    }
    const out = { ...data, updatedAt: new Date().toISOString() };
    await cache.set(ck, JSON.stringify(out), w.cacheSeconds ?? 120).catch(() => undefined);
    return out;
};

// ─── Setting up the role layouts ─────────────────────────────────────────────

/** Every widget there is, by category (for the setup screen). */
export const catalogue = () =>
    listWidgets()
        .map((w) => ({ key: w.key, label: w.label, description: w.description, category: w.category, type: w.type, size: w.size, permissions: w.permissions, href: w.href ?? null }))
        .sort((a, b) => widgetCategoryRank(a.category) - widgetCategoryRank(b.category));

/** The roles, with whether each has its own layout. */
export const rolesForSetup = async () => {
    const [roles, saved] = await Promise.all([db.role.findMany({ select: { id: true, name: true, slug: true }, orderBy: { name: 'asc' } }), db.dashboardLayout.findMany({ select: { roleId: true, updatedAt: true } })]);
    return roles.map((r) => ({ ...r, customised: saved.some((s) => s.roleId === r.id), hasDefault: !!defaultLayoutOf(r.slug) }));
};

/** A role's layout, and which of its widgets the role can't see (missing permissions). */
export const roleLayout = async (roleId: string) => {
    if (!z.uuid().safeParse(roleId).success) throw notFound('Role not found');
    const role = await db.role.findFirst({ where: { id: roleId }, select: { id: true, name: true, slug: true, permissions: { select: { permissionKey: true } } } });
    if (!role) throw notFound('Role not found');
    const saved = await db.dashboardLayout.findFirst({ where: { roleId }, select: { widgets: true, updatedAt: true } });
    const items = saved ? (saved.widgets as LayoutItem[]).filter((w) => findWidget(w.key)) : (defaultLayoutOf(role.slug) ?? []);
    const has = new Set(role.permissions.map((p) => p.permissionKey));
    const superAdmin = role.slug === 'super-admin';
    return {
        role: { id: role.id, name: role.name, slug: role.slug },
        customised: !!saved,
        updatedAt: saved?.updatedAt ?? null,
        widgets: items.map((i) => {
            const w = findWidget(i.key)!;
            const allowed = superAdmin || !w.permissions.length || w.permissions.some((p) => has.has(p));
            return { key: i.key, size: i.size, label: w.label, category: w.category, type: w.type, hiddenFor: allowed ? null : `needs one of: ${w.permissions.join(', ')}` };
        }),
    };
};

export const layoutSchema = z.strictObject({
    widgets: z
        .array(z.strictObject({ key: z.string().min(1).max(60), size: z.enum(SIZES) }))
        .max(40)
        .refine((xs) => new Set(xs.map((x) => x.key)).size === xs.length, 'a widget is there twice'),
});

export const saveLayout = async (roleId: string, input: z.infer<typeof layoutSchema>) => {
    const r = await roleLayout(roleId);
    const unknown = input.widgets.find((w) => !findWidget(w.key));
    if (unknown) throw badRequest(`There is no widget “${unknown.key}”`);
    await db.dashboardLayout.upsert({ where: { tenantId_roleId: { tenantId: getTenantId()!, roleId } }, create: { tenantId: getTenantId()!, roleId, widgets: input.widgets }, update: { widgets: input.widgets } });
    await recordAudit({ action: 'dashboard_layout_saved', entity: 'role', entityId: roleId, changes: { role: r.role.name, widgets: input.widgets.map((w) => w.key) } });
    return roleLayout(roleId);
};

/** Back to the built-in layout for the role. */
export const resetLayout = async (roleId: string) => {
    const r = await roleLayout(roleId);
    await db.dashboardLayout.deleteMany({ where: { roleId } });
    await recordAudit({ action: 'dashboard_layout_reset', entity: 'role', entityId: roleId, changes: { role: r.role.name } });
    return roleLayout(roleId);
};
