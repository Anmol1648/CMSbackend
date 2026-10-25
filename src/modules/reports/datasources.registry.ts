import type { ReportFilter } from './reports.registry';

/**
 * Data sources for the Report Builder. Each module offers safe views of its data (`<module>.datasources.ts`):
 * the fields people may pick, who may use it, and how its rows are loaded, already limited to the
 * person's school and reach (a class teacher's sections, a parent's children…). People then choose
 * columns, filters, sorting and grouping without writing code or touching the database.
 */

export type DataFieldType = 'text' | 'number' | 'money' | 'date' | 'boolean';

export interface DataField {
    key: string;
    label: string;
    type: DataFieldType;
    /** Heading the field is listed under in the builder ("Family", "Address"…). */
    group?: string;
    /** Shown only to people with the source's sensitive permission; never filtered, sorted or grouped on. */
    sensitive?: boolean;
}

export interface DataSourceContext {
    userId: string;
    /** May the person see the sensitive fields. */
    sensitive: boolean;
}

export interface DataSourceDef {
    key: string;
    label: string;
    description: string;
    /** Library section custom reports on it are listed under by default. */
    category: string;
    /** Any one of these lets a person use it. */
    permissions: string[];
    /** Needed to see the fields marked sensitive. */
    sensitivePermission?: string;
    /** Asked before the rows are loaded (session, period…), with their defaults. */
    params: ReportFilter[];
    fields: DataField[];
    load(params: Record<string, string>, ctx: DataSourceContext): Promise<Record<string, unknown>[]>;
}

const sources = new Map<string, DataSourceDef>();

export const defineDataSource = (def: DataSourceDef) => {
    if (sources.has(def.key)) throw new Error(`Data source "${def.key}" is defined twice`);
    const keys = new Set<string>();
    for (const f of def.fields) {
        if (keys.has(f.key)) throw new Error(`Data source "${def.key}": field "${f.key}" twice`);
        keys.add(f.key);
    }
    sources.set(def.key, def);
    return def;
};

export const findDataSource = (key: string) => sources.get(key);
export const listDataSources = () => [...sources.values()];

/**
 * Fields a school adds to a source (e.g. the extra fields of Setup → Form Builder): listed for the
 * person and filled in on the loaded rows (each row carries its record's id as `_id`).
 */
export interface DataSourceExtension {
    fields: (userId: string) => Promise<DataField[]>;
    fill: (rows: Record<string, unknown>[], userId: string) => Promise<void>;
}
const extensions = new Map<string, DataSourceExtension>();
export const extendDataSource = (key: string, ext: DataSourceExtension) => extensions.set(key, ext);

/** The source as this school and person see it: its own fields plus the school's extra ones. */
export const resolveDataSource = async (key: string, userId: string): Promise<DataSourceDef | undefined> => {
    const def = sources.get(key);
    const ext = extensions.get(key);
    if (!def || !ext) return def;
    const extra = await ext.fields(userId);
    if (!extra.length) return def;
    return {
        ...def,
        fields: [...def.fields, ...extra.filter((f) => !def.fields.some((d) => d.key === f.key))],
        load: async (params, ctx) => {
            const rows = await def.load(params, ctx);
            await ext.fill(rows, ctx.userId);
            return rows;
        },
    };
};
export const resolveDataSources = async (userId: string) => Promise.all([...sources.keys()].map(async (k) => (await resolveDataSource(k, userId))!));

// ─── Small helpers for the modules' loaders ──────────────────────────────────

export const isoDay = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
export const personName = (p: { firstName: string; middleName?: string | null; lastName?: string | null } | null | undefined) =>
    p ? [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ') : null;
/** Whole years from a date to today. */
export const yearsSince = (d: Date | null | undefined) => {
    if (!d) return null;
    const now = new Date();
    let y = now.getUTCFullYear() - d.getUTCFullYear();
    if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) y--;
    return y;
};
export const titleCase = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : null);
