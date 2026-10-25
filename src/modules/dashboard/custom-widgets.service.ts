import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { cache } from '../../core/cache';
import { currentYear } from '../academic/years.service';
import { todayIST } from '../attendance/attendance.settings';
import { getUserAccess } from '../rbac/access.service';
import { DataField, DataSourceDef, findDataSource, resolveDataSource, resolveDataSources } from '../reports/datasources.registry';
import { matches, NO_VALUE, OPS, OPS_FOR, showValue } from '../reports/builder.service';
import { resolveFilters } from '../reports/reports.service';
import type { WidgetData, WidgetDef, WidgetSize } from './dashboard.registry';

/**
 * The Widget Builder: dashboard widgets people make themselves, as many as they like. A widget is a
 * Report Builder data source (already limited to what each viewer may see), its inputs and
 * conditions, and how it is shown: one number (count / total / average…), a bar or line chart or a
 * donut grouped by a field, or a list. It is offered to its maker, widget builders, and the roles it
 * is shared with; every viewer sees it worked out on their own data.
 */

export const CUSTOM_WIDGET_PREFIX = 'cw_';
type Access = Awaited<ReturnType<typeof getUserAccess>>;

const field = z.string().trim().min(1).max(60);
export const widgetDefinitionSchema = z.strictObject({
    source: field,
    params: z.record(z.string(), z.string().trim().max(40)).default({}),
    filters: z.array(z.strictObject({ field, op: z.enum(OPS), value: z.string().trim().max(300).default(''), value2: z.string().trim().max(300).default('') })).max(20).default([]),
    display: z.strictObject({
        type: z.enum(['stat', 'bar', 'line', 'donut', 'list']),
        measure: z.strictObject({ fn: z.enum(['count', 'sum', 'avg', 'min', 'max', 'distinct']), field: field.nullable().default(null) }),
        groupBy: field.nullable().default(null),
        /** A date field grouped by day, week or month. */
        bucket: z.enum(['day', 'week', 'month']).nullable().default(null),
        sort: z.enum(['value_desc', 'value_asc', 'label_asc', 'label_desc']).default('value_desc'),
        limit: z.number().int().min(1).max(50).default(10),
        /** A list without grouping: the fields of each line, and its order. */
        list: z.strictObject({ title: field.nullable().default(null), sub: field.nullable().default(null), meta: field.nullable().default(null), sortBy: field.nullable().default(null), dir: z.enum(['asc', 'desc']).default('asc') }).default({ title: null, sub: null, meta: null, sortBy: null, dir: 'asc' }),
        /** A number turns amber / red at these values (above, or below). */
        tones: z.strictObject({ warnAt: z.number().nullable().default(null), badAt: z.number().nullable().default(null), direction: z.enum(['above', 'below']).default('above') }).default({ warnAt: null, badAt: null, direction: 'above' }),
        caption: z.string().trim().max(120).default(''),
    }),
});
export type WidgetDefinition = z.infer<typeof widgetDefinitionSchema>;

export const customWidgetSchema = z.strictObject({
    name: z.string().trim().min(2, 'is too short').max(60),
    description: z.string().trim().max(200).default(''),
    size: z.enum(['sm', 'md', 'lg']).default('sm'),
    roleIds: z.array(z.uuid()).max(50).default([]),
    href: z.string().trim().regex(/^\/[A-Za-z0-9/_?=&.-]*$/, 'must be a page of the ERP').nullable().default(null),
    isActive: z.boolean().default(true),
    definition: widgetDefinitionSchema,
});

// ─── Who may build, use and see ──────────────────────────────────────────────

const mayUseSource = (src: DataSourceDef, access: Access) => access.isSuperAdmin || src.permissions.some((p) => access.permissions[p]);
const isBuilder = (access: Access) => access.isSuperAdmin || !!access.permissions['dashboard.build'];
const needBuild = async (userId: string) => {
    const a = await getUserAccess(userId);
    if (!isBuilder(a)) throw forbidden('You can’t make widgets');
    return a;
};

/** The data sources a person may make widgets from, with the fields they may see and the conditions each allows. */
export const builderSources = async (userId: string) => {
    const a = await needBuild(userId);
    return (await resolveDataSources(userId))
        .filter((s) => mayUseSource(s, a))
        .map((s) => {
            const sensitive = a.isSuperAdmin || !!(s.sensitivePermission && a.permissions[s.sensitivePermission]);
            return { key: s.key, label: s.label, description: s.description, category: s.category, params: s.params, fields: s.fields.filter((f) => !f.sensitive || sensitive).map((f) => ({ key: f.key, label: f.label, type: f.type, group: f.group ?? null, sensitive: !!f.sensitive, ops: f.sensitive ? [] : OPS_FOR[f.type] })) };
        });
};
export const builderRoles = async (userId: string) => {
    await needBuild(userId);
    return db.role.findMany({ where: { isSystem: false }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
};

/** Checks a definition against its source and what its maker may see. */
const check = (d: WidgetDefinition, access: Access) => {
    const src = findDataSource(d.source);
    if (!src) throw badRequest('Choose the data', [{ field: 'definition.source', message: 'is not a data source' }]);
    if (!mayUseSource(src, access)) throw forbidden('You can’t use this data');
    const sensitive = access.isSuperAdmin || !!(src.sensitivePermission && access.permissions[src.sensitivePermission]);
    const byKey = new Map(src.fields.map((f) => [f.key, f]));
    const get = (key: string | null, where: string, plain = true) => {
        if (!key) return null;
        const f = byKey.get(key);
        if (!f) throw badRequest(`“${key}” is not a field of ${src.label}`, [{ field: where, message: 'is not a field of this data' }]);
        if (f.sensitive && (plain || !sensitive)) throw badRequest(`${f.label} can’t be used in a widget`, [{ field: where, message: 'is private' }]);
        return f;
    };
    d.filters.forEach((x, i) => {
        const f = get(x.field, `definition.filters.${i}`)!;
        if (!OPS_FOR[f.type].includes(x.op)) throw badRequest(`${f.label}: that condition doesn’t fit this field`, [{ field: `definition.filters.${i}.op`, message: 'does not fit this field' }]);
        if (!NO_VALUE.includes(x.op) && !x.value && !x.value2) throw badRequest(`${f.label}: give a value`, [{ field: `definition.filters.${i}.value`, message: 'is required' }]);
    });
    const ds = d.display;
    const m = get(ds.measure.field, 'definition.display.measure.field');
    if (ds.measure.fn !== 'count' && !m) throw badRequest('Choose the field to add up', [{ field: 'definition.display.measure.field', message: 'is required' }]);
    if (['sum', 'avg'].includes(ds.measure.fn) && m && m.type !== 'number' && m.type !== 'money') throw badRequest(`${m.label} is not a number`, [{ field: 'definition.display.measure.field', message: 'is not a number' }]);
    const g = get(ds.groupBy, 'definition.display.groupBy');
    if ((ds.type === 'bar' || ds.type === 'line' || ds.type === 'donut') && !g) throw badRequest('Choose what to group by', [{ field: 'definition.display.groupBy', message: 'is required for a chart' }]);
    if (ds.bucket && g?.type !== 'date') throw badRequest('Day / week / month only works with a date field', [{ field: 'definition.display.bucket', message: 'needs a date field' }]);
    if (ds.type === 'list' && !g && !ds.list.title) throw badRequest('Choose the field each line shows', [{ field: 'definition.display.list.title', message: 'is required' }]);
    get(ds.list.title, 'definition.display.list.title', false);
    get(ds.list.sub, 'definition.display.list.sub', false);
    get(ds.list.meta, 'definition.display.list.meta', false);
    get(ds.list.sortBy, 'definition.display.list.sortBy');
    for (const k of Object.keys(d.params)) if (!src.params.some((p) => p.key === k)) throw badRequest(`“${k}” is not an input of ${src.label}`);
    return src;
};

// ─── Working a widget out ────────────────────────────────────────────────────

const DAY = 86_400_000;
const shift = (iso: string, days: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
/** Dates in conditions may be relative: today, yesterday, monthStart, lastMonthStart, yearStart, sessionStart, -7d, +30d. */
const relativeDate = async (v: string) => {
    const t = todayIST();
    if (v === 'today') return t;
    if (v === 'yesterday') return shift(t, -1);
    if (v === 'monthStart') return `${t.slice(0, 8)}01`;
    if (v === 'lastMonthStart') {
        const d = new Date(`${t.slice(0, 8)}01T00:00:00Z`);
        d.setUTCMonth(d.getUTCMonth() - 1);
        return d.toISOString().slice(0, 10);
    }
    if (v === 'yearStart') return `${t.slice(0, 5)}01-01`;
    if (v === 'sessionStart') return (await currentYear())?.startDate.toISOString().slice(0, 10) ?? t;
    const m = /^([+-]\d{1,4})d$/.exec(v);
    return m ? shift(t, Number(m[1])) : v;
};

const num = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const aggregate = (rows: Record<string, unknown>[], fn: WidgetDefinition['display']['measure']['fn'], key: string | null) => {
    if (fn === 'count') return rows.length;
    if (fn === 'distinct') return new Set(rows.map((r) => String(r[key!] ?? '')).filter(Boolean)).size;
    const vals = rows.map((r) => num(r[key!])).filter((x): x is number => x !== null);
    if (!vals.length) return 0;
    if (fn === 'sum') return vals.reduce((a, b) => a + b, 0);
    if (fn === 'avg') return vals.reduce((a, b) => a + b, 0) / vals.length;
    if (fn === 'min') return Math.min(...vals);
    return Math.max(...vals);
};
const round = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number, money: boolean) => (money ? `₹${Math.round(n).toLocaleString('en-IN')}` : round(n).toLocaleString('en-IN'));
const bucketOf = (iso: string, b: 'day' | 'week' | 'month') => {
    if (b === 'month') return iso.slice(0, 7);
    if (b === 'week') {
        const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
        return d.toISOString().slice(0, 10);
    }
    return iso.slice(0, 10);
};
const bucketLabel = (k: string, b: 'day' | 'week' | 'month' | null) => {
    if (!b) return k;
    if (b === 'month') return new Date(`${k}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
    const s = new Date(`${k}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    return b === 'week' ? `wk ${s}` : s;
};

/** The viewer's rows of a source, with the source's inputs and the conditions applied (null: no such data / not allowed). */
const loadRows = async (source: string, given0: Record<string, string>, filters: WidgetDefinition['filters'], userId: string) => {
    const src = await resolveDataSource(source, userId);
    if (!src) return null;
    const access = await getUserAccess(userId);
    if (!mayUseSource(src, access)) return null;
    const sensitive = access.isSuperAdmin || !!(src.sensitivePermission && access.permissions[src.sensitivePermission]);
    const byKey = new Map(src.fields.map((f) => [f.key, f]));
    const given: Record<string, string> = {};
    for (const p of src.params) if (given0[p.key]) given[p.key] = p.type === 'date' ? await relativeDate(given0[p.key]) : given0[p.key];
    const params = await resolveFilters({ filters: src.params }, given);
    let rows = await src.load(params, { userId, sensitive });
    for (const x of filters) {
        const f = byKey.get(x.field);
        if (!f || (f.sensitive && !sensitive)) continue;
        const [a, b] = f.type === 'date' ? [await relativeDate(x.value), await relativeDate(x.value2)] : [x.value, x.value2];
        rows = rows.filter((r) => matches(r[f.key], f, x.op, a, b));
    }
    return { src, byKey, sensitive, rows, params };
};

/** A widget's data, worked out on the viewer's own data. */
export const computeWidget = async (d: WidgetDefinition, userId: string): Promise<WidgetData> => {
    if (!findDataSource(d.source)) return { items: [], empty: 'The data this widget was made from is no longer available.' };
    const loaded = await loadRows(d.source, d.params, d.filters, userId);
    if (!loaded) return { hidden: true, items: [], empty: '' };
    const { byKey, sensitive } = loaded;
    let rows = loaded.rows;
    const ds = d.display;
    const mf = ds.measure.field ? byKey.get(ds.measure.field) : undefined;
    const money = ds.measure.fn !== 'count' && ds.measure.fn !== 'distinct' && mf?.type === 'money';
    const caption = ds.caption || undefined;
    const g = ds.groupBy ? byKey.get(ds.groupBy) : undefined;

    // Groups (for charts, donuts, grouped lists, and the top three under a number).
    const groups = () => {
        const m = new Map<string, Record<string, unknown>[]>();
        for (const r of rows) {
            const raw = r[g!.key];
            const k = raw === null || raw === undefined || raw === '' ? '—' : g!.type === 'date' && ds.bucket ? bucketOf(String(raw), ds.bucket) : g!.type === 'date' ? String(raw).slice(0, 10) : showValue(g!, raw);
            m.set(k, [...(m.get(k) ?? []), r]);
        }
        const out = [...m.entries()].map(([k, rs]) => ({ key: k, label: g!.type === 'date' && k !== '—' ? bucketLabel(k, ds.bucket ?? 'day') : k, value: round(aggregate(rs, ds.measure.fn, ds.measure.field)) }));
        const byLabel = g!.type === 'date' ? (a: (typeof out)[0], b: (typeof out)[0]) => a.key.localeCompare(b.key) : (a: (typeof out)[0], b: (typeof out)[0]) => a.label.localeCompare(b.label, 'en-IN', { numeric: true });
        out.sort(ds.sort === 'value_desc' ? (a, b) => b.value - a.value : ds.sort === 'value_asc' ? (a, b) => a.value - b.value : ds.sort === 'label_desc' ? (a, b) => byLabel(b, a) : byLabel);
        return out;
    };

    if (ds.type === 'stat') {
        const v = aggregate(rows, ds.measure.fn, ds.measure.field);
        const t = ds.tones;
        const hit = (at: number | null) => at !== null && (t.direction === 'above' ? v >= at : v <= at);
        const tone = hit(t.badAt) ? 'bad' : hit(t.warnAt) ? 'warn' : t.warnAt !== null || t.badAt !== null ? 'good' : 'neutral';
        const sub = g ? groups().slice(0, 3).map((x) => ({ label: x.label, value: fmt(x.value, money) })) : undefined;
        return { value: fmt(v, money), caption: caption ?? `${ds.measure.fn === 'count' ? 'records' : `${ds.measure.fn} of ${mf?.label ?? ''}`}`, tone, sub };
    }
    if (ds.type === 'bar' || ds.type === 'line') {
        let gs = groups();
        if (g?.type === 'date') gs = gs.slice(-ds.limit);
        else gs = gs.slice(0, ds.limit);
        return { kind: ds.type, points: gs.map((x) => ({ label: x.label, value: x.value, hint: `${x.label}: ${fmt(x.value, money)}` })), money, caption: caption ?? `${fmt(aggregate(rows, ds.measure.fn, ds.measure.field), money)} in all` };
    }
    if (ds.type === 'donut') {
        const gs = groups().sort((a, b) => b.value - a.value);
        const top = gs.slice(0, ds.limit);
        const rest = gs.slice(ds.limit).reduce((a, x) => a + x.value, 0);
        return { slices: [...top.map((x) => ({ label: x.label, value: x.value })), ...(rest > 0 ? [{ label: 'Others', value: round(rest) }] : [])], money, centerLabel: fmt(aggregate(rows, ds.measure.fn, ds.measure.field), money) };
    }
    // A list: groups with their value, or the rows themselves.
    if (g) {
        const gs = groups();
        return { items: gs.slice(0, ds.limit).map((x) => ({ title: x.label, badge: fmt(x.value, money) })), empty: 'Nothing to show.', more: gs.length > ds.limit ? { label: `+${gs.length - ds.limit} more`, href: '/reports' } : undefined, note: caption };
    }
    const sortF = ds.list.sortBy ? byKey.get(ds.list.sortBy) : undefined;
    if (sortF) {
        const dir = ds.list.dir === 'desc' ? -1 : 1;
        rows = [...rows].sort((x, y) => {
            const a = x[sortF.key];
            const b = y[sortF.key];
            if (a === b) return 0;
            if (a === null || a === undefined || a === '') return 1;
            if (b === null || b === undefined || b === '') return -1;
            return (sortF.type === 'number' || sortF.type === 'money' ? Number(a) - Number(b) : String(a).localeCompare(String(b), 'en-IN', { numeric: true })) * dir;
        });
    }
    const show = (k: string | null, r: Record<string, unknown>) => {
        const f = k ? byKey.get(k) : undefined;
        if (!f || (f.sensitive && !sensitive)) return undefined;
        return showValue(f as DataField, r[f.key]);
    };
    return { items: rows.slice(0, ds.limit).map((r) => ({ title: show(ds.list.title, r) ?? '—', sub: show(ds.list.sub, r), meta: show(ds.list.meta, r) })), empty: 'Nothing to show.', more: rows.length > ds.limit ? { label: `${rows.length} in all`, href: '/reports' } : undefined, note: caption };
};

// ─── Looking data up for the AI assistant ────────────────────────────────────

const flt = z.strictObject({ field, op: z.enum(OPS), value: z.coerce.string().trim().max(300).default(''), value2: z.coerce.string().trim().max(300).default('') });
export const querySchema = z.object({
    source: field,
    params: z.record(z.string(), z.coerce.string().trim().max(40)).default({}),
    filters: z.array(flt).max(10).default([]),
    /** total: one number; groups: a number per value of groupBy; rows: the records themselves. */
    mode: z.enum(['total', 'groups', 'rows']).default('total'),
    fn: z.enum(['count', 'sum', 'avg', 'min', 'max', 'distinct']).default('count'),
    field: field.nullable().optional(),
    groupBy: field.nullable().optional(),
    bucket: z.enum(['day', 'week', 'month']).nullable().optional(),
    fields: z.array(field).max(8).default([]),
    sortBy: field.nullable().optional(),
    dir: z.enum(['asc', 'desc']).default('desc'),
    limit: z.number().int().min(1).max(30).default(10),
});

/** One lookup over the person's own data. Throws a message the assistant can act on when the question doesn't fit the data. */
export const runQuery = async (q: z.infer<typeof querySchema>, userId: string) => {
    const src = await resolveDataSource(q.source, userId);
    if (!src) throw badRequest(`There is no data source “${q.source}”`);
    const loaded = await loadRows(q.source, q.params, q.filters, userId);
    if (!loaded) throw forbidden(`This person may not see ${src.label}`);
    const { byKey, sensitive, rows } = loaded;
    const get = (k: string | null | undefined, what: string) => {
        if (!k) return undefined;
        const f = byKey.get(k);
        if (!f) throw badRequest(`“${k}” is not a field of ${src.label} (${what})`);
        if (f.sensitive && !sensitive) throw forbidden(`${f.label} is private for this person`);
        return f;
    };
    for (const x of q.filters) get(x.field, 'condition');
    const mf = get(q.field, 'what to add up');
    if (q.fn !== 'count' && !mf) throw badRequest(`Give the field to ${q.fn}`);
    const money = mf?.type === 'money' && q.fn !== 'count' && q.fn !== 'distinct';
    const total = round(aggregate(rows, q.fn, q.field ?? null));
    const what = q.fn === 'count' ? 'records' : `${q.fn} of ${mf!.label}${money ? ' (₹)' : ''}`;
    if (q.mode === 'total') return { data: src.label, matched: rows.length, measure: what, value: total };
    if (q.mode === 'groups') {
        const g = get(q.groupBy, 'group by');
        if (!g) throw badRequest('Give groupBy for groups');
        const m = new Map<string, Record<string, unknown>[]>();
        for (const r of rows) {
            const raw = r[g.key];
            const k = raw === null || raw === undefined || raw === '' ? '—' : g.type === 'date' ? (q.bucket ? bucketOf(String(raw), q.bucket) : String(raw).slice(0, 10)) : showValue(g, raw);
            m.set(k, [...(m.get(k) ?? []), r]);
        }
        const groups = [...m.entries()].map(([k, rs]) => ({ [g.label]: g.type === 'date' && q.bucket && k !== '—' ? bucketLabel(k, q.bucket) : k, value: round(aggregate(rs, q.fn, q.field ?? null)), records: rs.length }));
        groups.sort((a, b) => (q.dir === 'asc' ? a.value - b.value : b.value - a.value));
        return { data: src.label, matched: rows.length, measure: what, total, groups: groups.slice(0, q.limit), moreGroups: Math.max(0, groups.length - q.limit) };
    }
    const fields = (q.fields.length ? q.fields : src.fields.filter((f) => !f.sensitive).slice(0, 5).map((f) => f.key)).map((k) => get(k, 'fields')!).filter((f) => !f.sensitive || sensitive);
    const sf = get(q.sortBy, 'sort');
    let list = rows;
    if (sf) {
        const dir = q.dir === 'asc' ? 1 : -1;
        list = [...rows].sort((x, y) => {
            const a = x[sf.key];
            const b = y[sf.key];
            if (a === b) return 0;
            if (a === null || a === undefined || a === '') return 1;
            if (b === null || b === undefined || b === '') return -1;
            return (sf.type === 'number' || sf.type === 'money' ? Number(a) - Number(b) : String(a).localeCompare(String(b), 'en-IN', { numeric: true })) * dir;
        });
    }
    return { data: src.label, matched: rows.length, rows: list.slice(0, q.limit).map((r) => Object.fromEntries(fields.map((f) => [f.label, showValue(f as DataField, r[f.key])]))), moreRows: Math.max(0, rows.length - q.limit) };
};

/** The data sources a person may ask about, in a few words each (for the assistant's instructions). */
export const sourcesFor = async (userId: string) => {
    const a = await getUserAccess(userId);
    return (await resolveDataSources(userId))
        .filter((s) => mayUseSource(s, a))
        .map((s) => {
            const sensitive = a.isSuperAdmin || !!(s.sensitivePermission && a.permissions[s.sensitivePermission]);
            return { key: s.key, label: s.label, description: s.description, params: s.params.map((p) => ({ key: p.key, label: p.label, type: p.type, default: p.default ?? null })), fields: s.fields.filter((f) => !f.sensitive || sensitive).map((f) => ({ key: f.key, label: f.label, type: f.type })) };
        });
};

// ─── As dashboard widgets ────────────────────────────────────────────────────

const TYPE: Record<WidgetDefinition['display']['type'], WidgetDef['type']> = { stat: 'stat', bar: 'chart', line: 'chart', donut: 'donut', list: 'list' };

export interface CustomEntry {
    def: WidgetDef;
    canSee: (access: Access, userId: string) => boolean;
    roleIds: string[];
}

/** Every active custom widget of the school, as dashboard widgets with who may see them. */
export const customWidgetEntries = async (): Promise<Map<string, CustomEntry>> => {
    const rows = await db.customWidget.findMany({ where: { isActive: true } });
    const out = new Map<string, CustomEntry>();
    for (const r of rows) {
        const parsed = widgetDefinitionSchema.safeParse(r.definition);
        if (!parsed.success) continue;
        const d = parsed.data;
        const src = findDataSource(d.source);
        const key = `${CUSTOM_WIDGET_PREFIX}${r.id}`;
        out.set(key, {
            roleIds: r.roleIds,
            def: { key, label: r.name, description: r.description || `Made in the Widget Builder from ${src?.label ?? 'data'}.`, category: 'Made here', type: TYPE[d.display.type], size: r.size as WidgetSize, permissions: src ? src.permissions : ['__none__'], href: r.href ?? undefined, cacheSeconds: 300, load: ({ userId }) => computeWidget(d, userId) },
            canSee: (access, userId) => isBuilder(access) || r.createdBy === userId || access.roles.some((x) => r.roleIds.includes(x.id)),
        });
    }
    return out;
};

// ─── Making and keeping them ─────────────────────────────────────────────────

const out = (r: { id: string; name: string; description: string; size: string; roleIds: string[]; href: string | null; isActive: boolean; definition: unknown; createdBy: string | null; updatedAt: Date }) => ({ id: r.id, key: `${CUSTOM_WIDGET_PREFIX}${r.id}`, name: r.name, description: r.description, size: r.size, roleIds: r.roleIds, href: r.href, isActive: r.isActive, definition: r.definition as WidgetDefinition, createdBy: r.createdBy, updatedAt: r.updatedAt });

export const listCustomWidgets = async (userId: string) => {
    await needBuild(userId);
    const rows = await db.customWidget.findMany({ orderBy: { name: 'asc' } });
    const users = await db.user.findMany({ where: { id: { in: rows.map((r) => r.createdBy!).filter(Boolean) } }, select: { id: true, displayName: true } });
    return rows.map((r) => ({ ...out(r), source: findDataSource((r.definition as { source?: string }).source ?? '')?.label ?? '—', maker: users.find((u) => u.id === r.createdBy)?.displayName ?? '' }));
};
export const getCustomWidget = async (id: string, userId: string) => {
    await needBuild(userId);
    if (!z.uuid().safeParse(id).success) throw notFound('No such widget');
    const r = await db.customWidget.findFirst({ where: { id } });
    if (!r) throw notFound('No such widget');
    return out(r);
};
const checkRoles = async (ids: string[]) => {
    if (ids.length && (await db.role.count({ where: { id: { in: ids }, isSystem: false } })) !== new Set(ids).size) throw badRequest('One of the roles was not found', [{ field: 'roleIds', message: 'has a role that does not exist' }]);
};
export const createCustomWidget = async (input: z.infer<typeof customWidgetSchema>, userId: string) => {
    const a = await needBuild(userId);
    check(input.definition, a);
    await checkRoles(input.roleIds);
    const r = await db.customWidget.create({ data: { tenantId: getTenantId()!, ...input, createdBy: userId } });
    await recordAudit({ action: 'custom_widget_created', entity: 'custom_widget', entityId: r.id, changes: { name: r.name, source: input.definition.source } });
    return out(r);
};
export const updateCustomWidget = async (id: string, input: z.infer<typeof customWidgetSchema>, userId: string) => {
    const a = await needBuild(userId);
    await getCustomWidget(id, userId);
    check(input.definition, a);
    await checkRoles(input.roleIds);
    const r = await db.customWidget.update({ where: { id }, data: input });
    await cache.delPrefix(`dash:${getTenantId()}:`).catch(() => undefined);
    await recordAudit({ action: 'custom_widget_updated', entity: 'custom_widget', entityId: id, changes: { name: input.name } });
    return out(r);
};
export const deleteCustomWidget = async (id: string, userId: string) => {
    const r = await getCustomWidget(id, userId);
    await db.customWidget.delete({ where: { id } });
    await cache.delPrefix(`dash:${getTenantId()}:`).catch(() => undefined);
    await recordAudit({ action: 'custom_widget_deleted', entity: 'custom_widget', entityId: id, changes: { name: r.name } });
    return { ok: true };
};
/** A widget as it would look (for the builder's live preview), on the builder's own data. */
export const previewWidget = async (d: WidgetDefinition, userId: string) => {
    const a = await needBuild(userId);
    check(d, a);
    return { ...(await computeWidget(d, userId)), type: TYPE[d.display.type] };
};
