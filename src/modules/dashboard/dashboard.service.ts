import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { cache } from '../../core/cache';
import { logger } from '../../core/logger';
import { recordAudit } from '../../core/audit';
import { getUserAccess } from '../rbac/access.service';
import { defaultLayoutOf, findWidget, LayoutItem, listWidgets, mayUse, widgetCategoryRank, WidgetData } from './dashboard.registry';
import './widgets';

/**
 * The home dashboard: each role has a layout (set by the school, or the built-in one for the role);
 * a person sees the widgets of all their roles, once each, and only those their permissions allow.
 * Widgets load one by one, and their numbers are kept for a little while.
 */

const SIZES = ['sm', 'md', 'lg'] as const;
const cacheKey = (userId: string, key: string) => `dash:${getTenantId()}:${userId}:${key}`;

const layoutOfRole = async (role: { id: string; slug: string }): Promise<LayoutItem[]> => {
    const saved = await db.dashboardLayout.findFirst({ where: { roleId: role.id }, select: { widgets: true } });
    if (saved) return (saved.widgets as LayoutItem[]).filter((w) => findWidget(w.key));
    return defaultLayoutOf(role.slug) ?? [];
};

/** The person's dashboard: the widgets to show, in order, with their size (no data yet). */
export const myDashboard = async (userId: string) => {
    const access = await getUserAccess(userId);
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
            items.push({ key: w.key, label: w.label, type: w.type, size: item.size, href: w.href ?? null });
        }
    return { widgets: items, canSetUp: access.isSuperAdmin || !!access.permissions['dashboard.setup'] };
};

/** One widget's data, for the person (checked against their permissions; kept a little while). */
export const widgetData = async (key: string, userId: string, fresh = false): Promise<WidgetData & { updatedAt: string }> => {
    const w = findWidget(key);
    if (!w) throw notFound('Widget not found');
    const access = await getUserAccess(userId);
    if (!mayUse(w, access.permissions)) throw forbidden();
    const ck = cacheKey(userId, key);
    if (!fresh) {
        const hit = await cache.get(ck).catch(() => null);
        if (hit) return JSON.parse(hit);
    }
    let data: WidgetData;
    try {
        data = await w.load({ userId, permissions: access.permissions });
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
