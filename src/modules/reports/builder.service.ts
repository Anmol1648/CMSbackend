import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getUserAccess } from '../rbac/access.service';
import { DataField, DataSourceDef, findDataSource, resolveDataSource, resolveDataSources } from './datasources.registry';
import type { ReportColumn, ReportDef, ReportFilter } from './reports.registry';

/**
 * The Report Builder: reports people make themselves from a data source (columns, filters, sorting,
 * grouping), saved and shared with roles. A saved one becomes a normal report of the Report Center
 * (key "custom_<id>"), with PDF / Excel / Word and its own Jasper designs.
 */

export const CUSTOM_PREFIX = 'custom_';

// ─── What a report is made of ────────────────────────────────────────────────

export const OPS = ['eq', 'neq', 'contains', 'notContains', 'starts', 'in', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'notEmpty', 'yes', 'no'] as const;
export type Op = (typeof OPS)[number];

/** The conditions that make sense for each kind of field (the builder offers these). */
export const OPS_FOR: Record<DataField['type'], Op[]> = {
    text: ['eq', 'neq', 'contains', 'notContains', 'starts', 'in', 'empty', 'notEmpty'],
    number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'notEmpty'],
    money: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'notEmpty'],
    date: ['eq', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'notEmpty'],
    boolean: ['yes', 'no'],
};
export const NO_VALUE: Op[] = ['empty', 'notEmpty', 'yes', 'no'];

const fieldKey = z.string().trim().min(1).max(60);
export const definitionSchema = z.strictObject({
    source: z.string().trim().min(1).max(60),
    /** The source's own inputs (session, period): a value or a default like "current" / "today". Asked again each run. */
    params: z.record(z.string(), z.string().trim().max(40)).default({}),
    columns: z
        .array(z.strictObject({ field: fieldKey, label: z.string().trim().max(60).optional() }))
        .min(1, 'choose at least one column')
        .max(40, 'at most 40 columns'),
    filters: z
        .array(
            z.strictObject({
                field: fieldKey,
                op: z.enum(OPS),
                value: z.string().trim().max(300).default(''),
                value2: z.string().trim().max(300).default(''),
                /** Asked when the report is run (the saved value is the default). */
                ask: z.boolean().default(false),
                label: z.string().trim().max(60).optional(),
            })
        )
        .max(20)
        .default([]),
    sort: z.array(z.strictObject({ field: fieldKey, dir: z.enum(['asc', 'desc']).default('asc') })).max(3).default([]),
    groupBy: fieldKey.nullable().default(null),
    /** Number / money columns to add up (group subtotals and the grand total). */
    totals: z.array(fieldKey).max(20).default([]),
    orientation: z.enum(['portrait', 'landscape']).default('portrait'),
});
export type Definition = z.infer<typeof definitionSchema>;

export const customReportSchema = z.strictObject({
    name: z.string().trim().min(2, 'is too short').max(80),
    description: z.string().trim().max(300).default(''),
    category: z.string().trim().min(1).max(40).default('My reports'),
    roleIds: z.array(z.uuid()).max(50).default([]),
    definition: definitionSchema,
});

// ─── Who may use what ────────────────────────────────────────────────────────

const accessOf = (userId: string) => getUserAccess(userId);

const mayUseSource = (src: DataSourceDef, permissions: Record<string, unknown>) => src.permissions.some((p) => permissions[p]);

const sourceFor = async (key: string, userId: string) => {
    const src = await resolveDataSource(key, userId);
    if (!src) throw badRequest('No such data source', [{ field: 'source', message: 'is not a data source' }]);
    const a = await accessOf(userId);
    if (!mayUseSource(src, a.permissions)) throw forbidden('You can’t use this data');
    return { src, sensitive: !!(src.sensitivePermission && a.permissions[src.sensitivePermission]) };
};

const needBuild = async (userId: string) => {
    if (!(await accessOf(userId)).permissions['report.build']) throw forbidden('You can’t make reports');
};

/** The data sources a person may build on, with the fields they may see. */
export const listSources = async (userId: string) => {
    await needBuild(userId);
    const a = await accessOf(userId);
    return (await resolveDataSources(userId))
        .filter((s) => mayUseSource(s, a.permissions))
        .map((s) => {
            const sensitive = !!(s.sensitivePermission && a.permissions[s.sensitivePermission]);
            return {
                key: s.key,
                label: s.label,
                description: s.description,
                category: s.category,
                params: s.params,
                fields: s.fields.filter((f) => sensitive || !f.sensitive).map((f) => ({ ...f, ops: f.sensitive ? [] : OPS_FOR[f.type] })),
            };
        });
};

export const shareableRoles = async (userId: string) => {
    await needBuild(userId);
    return db.role.findMany({ where: { isSystem: false }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
};

// ─── Checking a definition ───────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const checkValue = (f: DataField, v: string, where: string) => {
    if (!v) return;
    if ((f.type === 'number' || f.type === 'money') && !Number.isFinite(Number(v))) throw badRequest(`${f.label}: “${v}” is not a number`, [{ field: where, message: 'is not a number' }]);
    if (f.type === 'date' && !ISO_DATE.test(v)) throw badRequest(`${f.label}: not a date`, [{ field: where, message: 'must be a date' }]);
};

/** Checks the fields and conditions against the source (and what the person may see). */
export const checkDefinition = async (d: Definition, userId: string) => {
    const { src, sensitive } = await sourceFor(d.source, userId);
    const byKey = new Map(src.fields.map((f) => [f.key, f]));
    const get = (key: string, where: string) => {
        const f = byKey.get(key);
        if (!f) throw badRequest(`“${key}” is not a field of ${src.label}`, [{ field: where, message: 'is not a field of this data' }]);
        if (f.sensitive && !sensitive) throw forbidden(`You can’t use ${f.label}`);
        return f;
    };
    const seen = new Set<string>();
    d.columns.forEach((c, i) => {
        get(c.field, `columns.${i}`);
        if (seen.has(c.field)) throw badRequest(`${byKey.get(c.field)!.label} is chosen twice`, [{ field: `columns.${i}`, message: 'is chosen twice' }]);
        seen.add(c.field);
    });
    const plain = (key: string, where: string, what: string) => {
        const f = get(key, where);
        if (f.sensitive) throw badRequest(`${f.label} can be shown but not used to ${what}`, [{ field: where, message: `can’t be used to ${what}` }]);
        return f;
    };
    d.filters.forEach((x, i) => {
        const f = plain(x.field, `filters.${i}`, 'filter');
        if (!OPS_FOR[f.type].includes(x.op)) throw badRequest(`${f.label}: that condition doesn’t fit this field`, [{ field: `filters.${i}.op`, message: 'does not fit this field' }]);
        if (!NO_VALUE.includes(x.op) && x.op !== 'in' && x.op !== 'between') checkValue(f, x.value, `filters.${i}.value`);
        if (x.op === 'between') {
            checkValue(f, x.value, `filters.${i}.value`);
            checkValue(f, x.value2, `filters.${i}.value2`);
        }
        if (!x.ask && !NO_VALUE.includes(x.op) && !x.value && !(x.op === 'between' && x.value2)) throw badRequest(`${f.label}: give a value, or tick “ask when running”`, [{ field: `filters.${i}.value`, message: 'is required' }]);
    });
    d.sort.forEach((s, i) => plain(s.field, `sort.${i}`, 'sort'));
    if (d.groupBy) plain(d.groupBy, 'groupBy', 'group');
    d.totals.forEach((t, i) => {
        const f = get(t, `totals.${i}`);
        if (f.type !== 'number' && f.type !== 'money') throw badRequest(`${f.label} can’t be added up`, [{ field: `totals.${i}`, message: 'is not a number' }]);
        if (!seen.has(t)) throw badRequest(`${f.label} is added up but not shown: add it as a column`, [{ field: `totals.${i}`, message: 'is not a column' }]);
    });
    for (const k of Object.keys(d.params)) if (!src.params.some((p) => p.key === k)) throw badRequest(`“${k}” is not an input of ${src.label}`);
    return src;
};

// ─── Running a definition ────────────────────────────────────────────────────

const lower = (v: unknown) => String(v ?? '').toLowerCase();
const isEmpty = (v: unknown) => v === null || v === undefined || v === '';

export const matches = (raw: unknown, f: DataField, op: Op, a: string, b: string) => {
    if (op === 'empty') return isEmpty(raw);
    if (op === 'notEmpty') return !isEmpty(raw);
    if (op === 'yes') return raw === true;
    if (op === 'no') return raw !== true;
    if (!a && !(op === 'between' && b)) return true; // not given (asked and left blank) = anything
    if (f.type === 'text') {
        const v = lower(raw);
        const x = a.toLowerCase();
        switch (op) {
            case 'eq': return v === x;
            case 'neq': return v !== x;
            case 'contains': return v.includes(x);
            case 'notContains': return !v.includes(x);
            case 'starts': return v.startsWith(x);
            case 'in': return a.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).includes(v);
            default: return true;
        }
    }
    const num = f.type === 'number' || f.type === 'money';
    if (isEmpty(raw)) return op === 'neq';
    const v = num ? Number(raw) : String(raw).slice(0, 10);
    const A = num ? Number(a) : a;
    const B = num ? Number(b) : b;
    switch (op) {
        case 'eq': return v === A;
        case 'neq': return v !== A;
        case 'gt': return v > A;
        case 'gte': return v >= A;
        case 'lt': return v < A;
        case 'lte': return v <= A;
        case 'between': return (!a || v >= A) && (!b || v <= B);
        default: return true;
    }
};

const compare = (x: unknown, y: unknown, f: DataField) => {
    if (isEmpty(x) && isEmpty(y)) return 0;
    if (isEmpty(x)) return 1; // empty last
    if (isEmpty(y)) return -1;
    if (f.type === 'number' || f.type === 'money') return Number(x) - Number(y);
    if (f.type === 'boolean') return (x === true ? 0 : 1) - (y === true ? 0 : 1);
    return String(x).localeCompare(String(y), 'en-IN', { numeric: true, sensitivity: 'base' });
};

export const showValue = (f: DataField, v: unknown) => {
    if (isEmpty(v)) return '—';
    if (f.type === 'boolean') return v === true ? 'Yes' : 'No';
    if (f.type === 'money' && typeof v === 'number') return `₹${v.toLocaleString('en-IN')}`;
    if (f.type === 'date' && typeof v === 'string' && ISO_DATE.test(v.slice(0, 10))) return new Date(`${v.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    return String(v);
};

const WIDTH: Record<DataField['type'], number> = { text: 1.4, number: 0.7, money: 1, date: 0.9, boolean: 0.6 };

/** Keys of the filters asked at run time (a "between" has a second one for its upper end). */
const askKey = (i: number) => `q${i}`;
const askKeyTo = (i: number) => `q${i}to`;

/**
 * A definition as a Report Center report, for one person: sensitive columns they may not see are left
 * out, the source's inputs and the "ask when running" conditions become its filters.
 */
export const definitionReport = async (meta: { key: string; label: string; description: string; category: string }, d: Definition, userId: string): Promise<ReportDef> => {
    const src = await resolveDataSource(d.source, userId);
    if (!src) throw notFound('The data this report was made from is no longer available');
    const a = await accessOf(userId);
    const sensitive = !!(src.sensitivePermission && a.permissions[src.sensitivePermission]);
    const byKey = new Map(src.fields.map((f) => [f.key, f]));
    const visible = d.columns.filter((c) => byKey.has(c.field) && (sensitive || !byKey.get(c.field)!.sensitive));
    const columns: ReportColumn[] = visible.map((c) => {
        const f = byKey.get(c.field)!;
        return { key: f.key, label: c.label || f.label, type: f.type === 'boolean' ? 'text' : f.type, width: WIDTH[f.type], total: d.totals.includes(f.key) };
    });
    const filters: ReportFilter[] = [
        ...src.params.map((p) => ({ ...p, default: d.params[p.key] || p.default })),
        ...d.filters.flatMap((x, i): ReportFilter[] => {
            if (!x.ask) return [];
            const f = byKey.get(x.field);
            if (!f) return [];
            const label = x.label || f.label;
            if (f.type === 'boolean') return [];
            const type = f.type === 'date' ? 'date' : 'text';
            if (x.op === 'between') return [{ key: askKey(i), label: `${label} from`, type, default: x.value || undefined }, { key: askKeyTo(i), label: `${label} to`, type, default: x.value2 || undefined }];
            return [{ key: askKey(i), label: x.op === 'in' ? `${label} (one of, with commas)` : label, type, default: x.value || undefined }];
        }),
    ];
    const group = d.groupBy ? byKey.get(d.groupBy) : undefined;
    const sorts = d.sort.map((s) => ({ f: byKey.get(s.field), dir: s.dir === 'desc' ? -1 : 1 })).filter((s): s is { f: DataField; dir: number } => !!s.f);

    return {
        key: meta.key,
        category: meta.category,
        label: meta.label,
        description: meta.description,
        permissions: src.permissions,
        orientation: d.orientation,
        filters,
        columns,
        async run(values, ctx) {
            const params = Object.fromEntries(src.params.map((p) => [p.key, values[p.key] ?? '']).filter(([, v]) => v !== ''));
            let rows = await src.load(params, { userId: ctx.userId, sensitive });
            d.filters.forEach((x, i) => {
                const f = byKey.get(x.field);
                if (!f) return;
                const v1 = x.ask ? (values[askKey(i)] ?? '') : x.value;
                const v2 = x.ask ? (values[askKeyTo(i)] ?? '') : x.value2;
                if (x.ask && x.op !== 'between') checkValue(f, v1, askKey(i));
                rows = rows.filter((r) => matches(r[f.key], f, x.op, v1, v2));
            });
            rows.sort((x, y) => {
                if (group) {
                    const g = compare(x[group.key], y[group.key], group);
                    if (g) return g;
                }
                for (const s of sorts) {
                    const c = compare(x[s.f.key], y[s.f.key], s.f) * s.dir;
                    if (c) return c;
                }
                return 0;
            });
            let n = 0;
            let last: unknown = Symbol('none');
            const out = rows.map((r) => {
                const row: Record<string, unknown> = {};
                for (const c of columns) {
                    const f = byKey.get(c.key)!;
                    row[c.key] = f.type === 'boolean' ? (r[c.key] === true ? 'Yes' : 'No') : (r[c.key] ?? null);
                }
                if (group) {
                    if (lower(r[group.key]) !== lower(last)) {
                        n++;
                        last = r[group.key];
                    }
                    row.groupKey = String(n).padStart(5, '0');
                    row.groupLabel = showValue(group, r[group.key]);
                }
                return row;
            });
            // The inputs in words: "2026-27 · As on 21 Oct 2026".
            const shown: string[] = [];
            for (const p of src.params) {
                const v = values[p.key];
                if (!v) continue;
                if (p.type === 'year') shown.push((await db.academicYear.findUnique({ where: { id: v }, select: { name: true } }))?.name ?? '');
                else if (p.type === 'date') shown.push(`${p.label} ${showValue({ key: p.key, label: p.label, type: 'date' }, v)}`);
                else shown.push(v);
            }
            return { rows: out, subtitle: shown.filter(Boolean).join(' · '), groupedBy: group ? group.label : null };
        },
    };
};

// ─── Saved reports ───────────────────────────────────────────────────────────

const idOf = (key: string) => {
    const id = key.slice(CUSTOM_PREFIX.length);
    if (!z.uuid().safeParse(id).success) throw notFound('No such report');
    return id;
};

const meta = (r: { id: string; name: string; description: string; category: string }) => ({ key: `${CUSTOM_PREFIX}${r.id}`, label: r.name, description: r.description || 'A report made in the Report Builder.', category: r.category });

/** May this person run the saved report: report builders, and the roles it is shared with. */
const mayRunCustom = (r: { roleIds: string[] }, access: Awaited<ReturnType<typeof accessOf>>) => !!access.permissions['report.build'] || access.roles.some((x) => r.roleIds.includes(x.id));

/** A saved report as a Report Center report (or not found / not allowed). */
export const customReportDef = async (key: string, userId: string) => {
    const r = await db.customReport.findFirst({ where: { id: idOf(key) } });
    if (!r) throw notFound('No such report');
    const a = await accessOf(userId);
    if (!mayRunCustom(r, a)) throw forbidden('You can’t run this report');
    return definitionReport(meta(r), definitionSchema.parse(r.definition), userId);
};

/** The saved reports a person may run (shown in the library with the others). */
export const visibleCustomReports = async (userId: string) => {
    const a = await accessOf(userId);
    const all = await db.customReport.findMany({ orderBy: { name: 'asc' } });
    return all
        .filter((r) => mayRunCustom(r, a))
        .filter((r) => {
            const src = findDataSource((r.definition as { source?: string }).source ?? '');
            return !!src && mayUseSource(src, a.permissions);
        })
        .map((r) => ({ ...meta(r), id: r.id }));
};

export const getCustomReport = async (id: string, userId: string) => {
    await needBuild(userId);
    if (!z.uuid().safeParse(id).success) throw notFound('No such report');
    const r = await db.customReport.findFirst({ where: { id } });
    if (!r) throw notFound('No such report');
    return { id: r.id, key: `${CUSTOM_PREFIX}${r.id}`, name: r.name, description: r.description, category: r.category, roleIds: r.roleIds, definition: definitionSchema.parse(r.definition), updatedAt: r.updatedAt };
};

const checkRoles = async (ids: string[]) => {
    if (!ids.length) return;
    const n = await db.role.count({ where: { id: { in: ids }, isSystem: false } });
    if (n !== new Set(ids).size) throw badRequest('One of the roles was not found', [{ field: 'roleIds', message: 'has a role that does not exist' }]);
};

export const createCustomReport = async (input: z.infer<typeof customReportSchema>, userId: string) => {
    await needBuild(userId);
    await checkDefinition(input.definition, userId);
    await checkRoles(input.roleIds);
    const r = await db.customReport.create({ data: { tenantId: getTenantId()!, name: input.name, description: input.description, category: input.category, roleIds: input.roleIds, definition: input.definition } });
    await recordAudit({ action: 'custom_report_created', entity: 'custom_report', entityId: r.id, changes: { name: r.name, source: input.definition.source } });
    return getCustomReport(r.id, userId);
};

export const updateCustomReport = async (id: string, input: z.infer<typeof customReportSchema>, userId: string) => {
    await getCustomReport(id, userId);
    await checkDefinition(input.definition, userId);
    await checkRoles(input.roleIds);
    await db.customReport.update({ where: { id }, data: { name: input.name, description: input.description, category: input.category, roleIds: input.roleIds, definition: input.definition } });
    await recordAudit({ action: 'custom_report_updated', entity: 'custom_report', entityId: id, changes: { name: input.name } });
    return getCustomReport(id, userId);
};

export const deleteCustomReport = async (id: string, userId: string) => {
    const r = await getCustomReport(id, userId);
    await withTransaction(async (tx) => {
        await tx.reportDesign.deleteMany({ where: { reportKey: r.key } });
        await tx.reportSetting.deleteMany({ where: { reportKey: r.key } });
        await tx.customReport.delete({ where: { id } });
    });
    await recordAudit({ action: 'custom_report_deleted', entity: 'custom_report', entityId: id, changes: { name: r.name } });
};
