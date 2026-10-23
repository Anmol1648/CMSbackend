/**
 * Master lists (states, religions, blood groups, departments…): one engine, one table
 * (master_values), one screen. Each module declares its lists here with defineMaster() when it is
 * built; the list then gets the Configuration → Masters screen, dropdown options, Excel import /
 * export, history and in-use protection without any further code.
 */

export interface MasterGroupDef {
    key: string;
    label: string;
    order: number;
}

export interface MasterFieldDef {
    key: string;
    label: string;
    type: 'text' | 'number' | 'boolean' | 'select';
    /** select: the choices (the value is stored). */
    options?: { value: string; label: string }[];
    required?: boolean;
    max?: number;
    /** text: the value must match (after `upperCase`, if set). */
    pattern?: RegExp;
    patternMessage?: string;
    upperCase?: boolean;
    help?: string;
    example?: string;
}

/** A starter option. `parent` is the path of names from the top list, e.g. ['India', 'Uttarakhand']. */
export interface MasterSeed {
    name: string;
    code?: string;
    parent?: string[];
    extra?: Record<string, string | number | boolean>;
}

export interface MasterDef {
    /** Stored on every option; lower case, e.g. "state". Never rename once in use. */
    key: string;
    /** Singular, e.g. "State". */
    label: string;
    /** e.g. "States". */
    plural: string;
    group: string;
    order: number;
    description?: string;
    /** Key of the parent list: a district belongs to a state. */
    parent?: string;
    /** Whether options have a short code (e.g. "UK" for Uttarakhand). */
    code: 'none' | 'optional' | 'required';
    /** 'manual': the school sets the order (blood groups); 'name': alphabetical (districts). */
    ordering: 'manual' | 'name';
    fields?: MasterFieldDef[];
    /** Permission to change the list (default masters.manage); seeing it needs masters.view. */
    permission?: string;
    seed?: MasterSeed[] | (() => MasterSeed[]);
    /** Hidden from the Masters screen when this returns true (e.g. houses switched off). */
    hidden?: () => Promise<boolean>;
}

/** Something that refers to options of a list (e.g. students → religion); blocks deleting them. */
export interface MasterUsage {
    /** Plural, shown in "Used by 12 students". */
    label: string;
    count: (valueIds: string[]) => Promise<number>;
}

const groups = new Map<string, MasterGroupDef>();
const masters = new Map<string, MasterDef>();
const usages = new Map<string, MasterUsage[]>();

export const defineMasterGroup = (group: MasterGroupDef) => {
    if (groups.has(group.key)) throw new Error(`Master group "${group.key}" is defined twice`);
    groups.set(group.key, group);
};

export const defineMaster = (def: MasterDef) => {
    if (masters.has(def.key)) throw new Error(`Master "${def.key}" is defined twice`);
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(def.key)) throw new Error(`Master key "${def.key}" must be lower case letters, numbers or _`);
    if (!groups.has(def.group)) throw new Error(`Master "${def.key}": unknown group "${def.group}"`);
    if (def.parent && !masters.has(def.parent)) throw new Error(`Master "${def.key}": define its parent "${def.parent}" first`);
    masters.set(def.key, def);
    return def;
};

/** Called by the module that stores the options, e.g. registerMasterUsage('religion', { label: 'students', count }). */
export const registerMasterUsage = (masterKey: string, usage: MasterUsage) => {
    usages.set(masterKey, [...(usages.get(masterKey) ?? []), usage]);
};

export const listMasterGroups = () => [...groups.values()].sort((a, b) => a.order - b.order);
export const listMasters = () => [...masters.values()].sort((a, b) => (groups.get(a.group)!.order - groups.get(b.group)!.order) || a.order - b.order);
export const findMaster = (key: string) => masters.get(key);
/** In the order they were defined: a parent list always comes before its children. */
export const mastersInDefinitionOrder = () => [...masters.values()];
export const masterUsages = (key: string) => usages.get(key) ?? [];
export const childMasters = (key: string) => [...masters.values()].filter((m) => m.parent === key);

/** The list and its ancestors, top first: city → [country, state, district, city]. */
export const masterChain = (key: string): MasterDef[] => {
    const chain: MasterDef[] = [];
    for (let m = masters.get(key); m; m = m.parent ? masters.get(m.parent) : undefined) chain.unshift(m);
    return chain;
};

export const seedsOf = (def: MasterDef) => (typeof def.seed === 'function' ? def.seed() : def.seed ?? []);
