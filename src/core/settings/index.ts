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
