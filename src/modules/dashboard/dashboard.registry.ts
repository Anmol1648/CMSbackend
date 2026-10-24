/**
 * Dashboard widgets. Each module declares its widgets in code: what they show, who may see them (any
 * one of their permissions), where clicking them goes, and how their data is loaded, already limited
 * to what the person may see (their sections, their children…). No widget runs SQL typed in by a user.
 */

export type WidgetSize = 'sm' | 'md' | 'lg';
export type WidgetType = 'stat' | 'chart' | 'donut' | 'list';

/** A number with what it means (and small numbers under it). */
export interface StatData {
    value: string | number;
    caption?: string;
    tone?: 'good' | 'warn' | 'bad' | 'neutral';
    /** A bar under the number (e.g. 82 of 100 collected). */
    progress?: { value: number; max: number; label?: string };
    sub?: { label: string; value: string | number; tone?: 'good' | 'warn' | 'bad' }[];
    action?: { label: string; href: string };
}
export interface ChartData {
    kind: 'bar' | 'line';
    points: { label: string; value: number; hint?: string }[];
    /** Values are rupees. */
    money?: boolean;
    caption?: string;
}
export interface DonutData {
    slices: { label: string; value: number }[];
    money?: boolean;
    centerLabel?: string;
}
export interface ListData {
    items: { title: string; sub?: string; meta?: string; href?: string; tone?: 'good' | 'warn' | 'bad' | 'neutral'; badge?: string | number }[];
    empty: string;
    /** "+12 more" link. */
    more?: { label: string; href: string };
}
export type WidgetData = (StatData | ChartData | DonutData | ListData) & {
    /** Nothing to show for this person (e.g. not a class teacher): the widget is left out. */
    hidden?: boolean;
    /** A line under the title, e.g. "Today · 23 Oct". */
    note?: string;
    /** A choice on the widget (period, section, hostel…): the one used, and the others. */
    filter?: { value: string; options: { value: string; label: string }[] };
};

export interface WidgetContext {
    userId: string;
    permissions: Record<string, string>;
    /** The person's choice on the widget's filter (empty = its default). */
    filter?: string;
}

export interface WidgetDef {
    key: string;
    label: string;
    description: string;
    /** Heading in the setup screen ("Today", "Fees"…). */
    category: string;
    type: WidgetType;
    size: WidgetSize;
    /** Any one of these lets a person see it; empty = everyone signed in. */
    permissions: string[];
    /** Where clicking the title goes. */
    href?: string;
    /** How long its numbers are kept before being worked out again (seconds). */
    cacheSeconds?: number;
    load(ctx: WidgetContext): Promise<WidgetData>;
}

const widgets = new Map<string, WidgetDef>();
const categoryOrder = new Map<string, number>();

export const defineWidget = (def: WidgetDef) => {
    if (widgets.has(def.key)) throw new Error(`Widget "${def.key}" is defined twice`);
    widgets.set(def.key, def);
    return def;
};
export const registerWidgetCategory = (name: string, order: number) => categoryOrder.set(name, order);
export const widgetCategoryRank = (name: string) => categoryOrder.get(name) ?? 999;
export const findWidget = (key: string) => widgets.get(key);
export const listWidgets = () => [...widgets.values()];
export const mayUse = (w: WidgetDef, permissions: Record<string, string>) => !w.permissions.length || w.permissions.some((p) => permissions[p]);

/** The layout a role starts with (until the school sets its own), by role slug. */
export type LayoutItem = { key: string; size: WidgetSize; filter?: string };
const defaults = new Map<string, (string | LayoutItem)[]>();
const extras = new Map<string, { items: string[]; after?: string }[]>();
export const defineDefaultLayout = (roleSlug: string, items: (string | LayoutItem)[]) => defaults.set(roleSlug, items);
/** Adds widgets to a role's built-in layout (after one of its widgets, or at the end), whichever module defines the layout. */
export const extendDefaultLayout = (roleSlug: string, items: string[], after?: string) => extras.set(roleSlug, [...(extras.get(roleSlug) ?? []), { items, after }]);
const dropped = new Set<string>();
/** Leaves a widget out of every built-in layout (it can still be added by hand). */
export const dropFromDefaultLayouts = (key: string) => dropped.add(key);
export const defaultLayoutOf = (roleSlug: string): LayoutItem[] | null => {
    const base = defaults.get(roleSlug);
    if (!base) return null;
    const keys = base.map((i) => (typeof i === 'string' ? i : i.key)).filter((k) => !dropped.has(k));
    for (const e of extras.get(roleSlug) ?? []) {
        const add = e.items.filter((k) => !keys.includes(k));
        const at = e.after ? keys.indexOf(e.after) : -1;
        keys.splice(at >= 0 ? at + 1 : keys.length, 0, ...add);
    }
    return keys.map((k) => {
        const given = base.find((i) => typeof i !== 'string' && i.key === k) as LayoutItem | undefined;
        return given ?? { key: k, size: widgets.get(k)?.size ?? 'sm' };
    });
};

// ─── The action centre: what is waiting for the person ───────────────────────

export interface ActionDef {
    key: string;
    /** What is waiting, e.g. "Staff leave to approve". */
    label: string;
    icon: string;
    href: string;
    /** Any one of these lets a person see it. */
    permissions: string[];
    /** How many are waiting for this person (0 = not shown), or a number with its own text. */
    count(ctx: WidgetContext): Promise<number | { count: number; label?: string; value?: string }>;
    /** bad = late / overdue. */
    tone?: 'warn' | 'bad';
    order?: number;
}
const actions = new Map<string, ActionDef>();
export const defineAction = (def: ActionDef) => {
    if (actions.has(def.key)) throw new Error(`Action "${def.key}" is defined twice`);
    actions.set(def.key, def);
};
export const listActions = () => [...actions.values()].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
