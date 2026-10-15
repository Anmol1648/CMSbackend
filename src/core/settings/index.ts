import { z } from 'zod';
import { db } from '../db';
import { cache } from '../cache';
import { getTenantId } from '../context';
import { logger } from '../logger';

/**
 * Settings registry. Each module declares its settings in code (key, group, label, help, type,
 * default, validation). Schools override them in `tenant_settings` (only overrides are stored);
 * everything else uses the default. The System Settings screen (F5) is generated from this registry.
 */

export type SettingType = 'boolean' | 'number' | 'text' | 'select' | 'multiselect';

export interface SettingDef<T = unknown> {
    key: string;
    group: string;
    label: string;
    help?: string;
    type: SettingType;
    default: T;
    schema: z.ZodType<T>;
    options?: { value: string; label: string }[];
    /** Hidden from the screen (internal tuning); still overridable. */
    hidden?: boolean;
}

const registry = new Map<string, SettingDef>();

/** Order of groups on the System Settings screen (groups not listed come after, alphabetically). */
const GROUP_ORDER = ['Login', 'Security', 'Passwords', 'Accounts', 'Uploads & exports', 'Audit'];
const groupRank = (g: string) => {
    const i = GROUP_ORDER.indexOf(g);
    return i === -1 ? GROUP_ORDER.length : i;
};

/** Declares a setting; returns it so modules can read it type-safely with getSetting(def). */
export const defineSetting = <T>(def: SettingDef<T>): SettingDef<T> => {
    if (registry.has(def.key)) throw new Error(`Setting "${def.key}" is defined twice`);
    const check = def.schema.safeParse(def.default);
    if (!check.success) throw new Error(`Default for setting "${def.key}" is invalid`);
    registry.set(def.key, def as SettingDef);
    return def;
};

export const listSettingDefs = (): SettingDef[] => [...registry.values()];
export const findSettingDef = (key: string): SettingDef | undefined => registry.get(key);

const TTL_SECONDS = 60;
const cacheKey = (tenantId: string) => `settings:${tenantId}`;

const loadOverrides = async (tenantId: string): Promise<Record<string, unknown>> => {
    const hit = await cache.get(cacheKey(tenantId));
    if (hit) return JSON.parse(hit);
    const rows = await db.tenantSetting.findMany({ select: { key: true, value: true } });
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    await cache.set(cacheKey(tenantId), JSON.stringify(map), TTL_SECONDS);
    return map;
};

/** The current school's value for a setting (override if valid, else the default). */
export const getSetting = async <T>(def: SettingDef<T>): Promise<T> => {
    const tenantId = getTenantId();
    if (!tenantId) return def.default;
    const overrides = await loadOverrides(tenantId);
    if (!(def.key in overrides)) return def.default;
    const parsed = def.schema.safeParse(overrides[def.key]);
    if (parsed.success) return parsed.data;
    logger.warn(`Ignoring invalid stored value for setting ${def.key}; using the default`);
    return def.default;
};

/** Reads several settings at once (one cache read). */
export const getSettings = async <D extends Record<string, SettingDef<any>>>(defs: D): Promise<{ [K in keyof D]: D[K]['default'] }> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const entries = await Promise.all(Object.entries(defs).map(async ([name, def]) => [name, await getSetting(def)] as const));
    return Object.fromEntries(entries) as { [K in keyof D]: D[K]['default'] };
};

/** Saves (or clears, with `undefined`) a school's override. Validation errors throw. */
export const setSetting = async <T>(def: SettingDef<T>, value: T | undefined, userId?: string) => {
    const tenantId = getTenantId();
    if (!tenantId) throw new Error('setSetting needs a school in context');
    if (value === undefined) {
        await db.tenantSetting.deleteMany({ where: { key: def.key } });
    } else {
        const parsed = def.schema.parse(value);
        await db.tenantSetting.upsert({
            where: { tenantId_key: { tenantId, key: def.key } },
            create: { tenantId, key: def.key, value: parsed as object, updatedBy: userId },
            update: { value: parsed as object, updatedBy: userId },
        });
    }
    await cache.del(cacheKey(tenantId));
};

// ─── For the System Settings screen ──────────────────────────────────────────

/** Number limits read from the zod schema (for the input's min / max). */
const numberLimits = (def: SettingDef) => {
    const s = def.schema as unknown as { minValue?: number | null; maxValue?: number | null };
    return def.type === 'number' ? { min: s.minValue ?? null, max: s.maxValue ?? null } : {};
};

/** Every visible setting with the school's current value, grouped in declaration order. */
export const settingsSnapshot = async () => {
    const tenantId = getTenantId();
    if (!tenantId) throw new Error('settingsSnapshot needs a school in context');
    const rows = await db.tenantSetting.findMany();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const groups: { group: string; settings: unknown[] }[] = [];
    for (const def of listSettingDefs().filter((d) => !d.hidden)) {
        const row = byKey.get(def.key);
        const stored = row ? def.schema.safeParse(row.value) : null;
        const item = {
            key: def.key,
            label: def.label,
            help: def.help ?? null,
            type: def.type,
            options: def.options ?? null,
            default: def.default,
            value: stored?.success ? stored.data : def.default,
            isDefault: !stored?.success,
            updatedAt: stored?.success ? row!.updatedAt : null,
            updatedBy: stored?.success ? row!.updatedBy : null,
            ...numberLimits(def),
        };
        let group = groups.find((g) => g.group === def.group);
        if (!group) groups.push((group = { group: def.group, settings: [] }));
        group.settings.push(item);
    }
    return groups.sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.group.localeCompare(b.group));
};

/**
 * Saves several settings at once (all or nothing). `null` resets a setting to its default.
 * Returns what actually changed as { key: [old, new] }.
 */
export const saveSettings = async (changes: Record<string, unknown>, userId: string) => {
    const tenantId = getTenantId();
    if (!tenantId) throw new Error('saveSettings needs a school in context');
    const issues: { field: string; message: string }[] = [];
    const parsed: { def: SettingDef; value: unknown | null }[] = [];
    for (const [key, raw] of Object.entries(changes)) {
        const def = findSettingDef(key);
        if (!def || def.hidden) {
            issues.push({ field: key, message: 'is not a known setting' });
            continue;
        }
        if (raw === null) {
            parsed.push({ def, value: null });
            continue;
        }
        const result = def.schema.safeParse(raw);
        if (result.success) parsed.push({ def, value: result.data });
        else issues.push({ field: key, message: result.error.issues[0]?.message ?? 'is not valid' });
    }
    if (issues.length) {
        const err = new Error('Some settings are not valid') as Error & { issues: typeof issues };
        err.issues = issues;
        throw err;
    }

    const before = new Map((await db.tenantSetting.findMany({ where: { key: { in: parsed.map((p) => p.def.key) } } })).map((r) => [r.key, r.value]));
    const diff: Record<string, [unknown, unknown]> = {};
    await db.$transaction(
        parsed.map(({ def, value }) => {
            const old = before.has(def.key) ? before.get(def.key) : def.default;
            const next = value === null ? def.default : value;
            if (JSON.stringify(old) !== JSON.stringify(next)) diff[def.key] = [old, next];
            // Storing a value equal to the default is the same as resetting it.
            return value === null || JSON.stringify(value) === JSON.stringify(def.default)
                ? db.tenantSetting.deleteMany({ where: { key: def.key } })
                : db.tenantSetting.upsert({
                      where: { tenantId_key: { tenantId, key: def.key } },
                      create: { tenantId, key: def.key, value: value as object, updatedBy: userId },
                      update: { value: value as object, updatedBy: userId },
                  });
        })
    );
    await cache.del(cacheKey(tenantId));
    return diff;
};
