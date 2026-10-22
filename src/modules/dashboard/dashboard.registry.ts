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
};

export interface WidgetContext {
    userId: string;
    permissions: Record<string, string>;
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
export type LayoutItem = { key: string; size: WidgetSize };
const defaults = new Map<string, LayoutItem[]>();
export const defineDefaultLayout = (roleSlug: string, items: (string | LayoutItem)[]) =>
    defaults.set(
        roleSlug,
        items.map((i) => (typeof i === 'string' ? { key: i, size: widgets.get(i)?.size ?? 'sm' } : i))
    );
export const defaultLayoutOf = (roleSlug: string) => defaults.get(roleSlug) ?? null;
