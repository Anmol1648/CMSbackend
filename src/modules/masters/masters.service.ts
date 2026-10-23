import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, forbidden, notFound, validationError } from '../../core/errors';
import { ListQuery, listResult } from '../../core/http/list-query';
import { buildWorkbook } from '../../core/excel';
import { getUserAccess } from '../rbac/access.service';
import {
    childMasters,
    findMaster,
    listMasterGroups,
    listMasters,
    MasterDef,
    masterChain,
    masterUsages,
    mastersInDefinitionOrder,
    seedsOf,
} from './masters.registry';
import type { masterValueFilters } from './masters.schemas';

/** Options of master lists (see masters.registry for how lists are declared). */

export const MANAGE = 'masters.manage';

export const masterDef = (key: string) => {
    const def = findMaster(key);
    if (!def) throw notFound('Unknown master list');
    return def;
};

export const managePermission = (def: MasterDef) => def.permission ?? MANAGE;

export const assertCanManage = async (def: MasterDef, userId: string) => {
    if (!(await getUserAccess(userId)).permissions[managePermission(def)]) throw forbidden(`You can't change the ${def.plural.toLowerCase()} list`);
};

/** "  Uttar   Pradesh " → "Uttar Pradesh". */
export const cleanName = (s: string) => s.trim().replace(/\s+/g, ' ');

// ─── Reading ─────────────────────────────────────────────────────────────────

const parentInclude = { parent: { select: { id: true, name: true, master: true, parent: { select: { id: true, name: true, master: true, parent: { select: { id: true, name: true, master: true } } } } } } } as const;
type Row = Prisma.MasterValueGetPayload<{ include: typeof parentInclude }>;
type Ancestor = { id: string; name: string; master: string; parent?: Ancestor | null };

const present = (r: Row) => {
    // Top first: [India, Uttarakhand, Chamoli] for a city.
    const ancestors: { id: string; name: string; master: string }[] = [];
    for (let a = r.parent as Ancestor | null | undefined; a; a = a.parent) ancestors.unshift({ id: a.id, name: a.name, master: a.master });
    return {
        id: r.id,
        name: r.name,
        code: r.code,
        parentId: r.parentId,
        ancestors,
        sortOrder: r.sortOrder,
        isActive: r.isActive,
        extra: r.extra as Record<string, unknown>,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
    };
};

const orderFor = (def: MasterDef): Prisma.MasterValueOrderByWithRelationInput[] =>
    def.ordering === 'manual' ? [{ sortOrder: 'asc' }, { name: 'asc' }] : [{ name: 'asc' }];

/** Every list with how many options it has, grouped as on the screen. */
export const masterCatalogue = async (userId: string) => {
    const access = await getUserAccess(userId);
    const counts = await db.masterValue.groupBy({ by: ['master', 'isActive'], _count: { _all: true } });
    const count = (key: string, active?: boolean) =>
        counts.filter((c) => c.master === key && (active === undefined || c.isActive === active)).reduce((n, c) => n + c._count._all, 0);
    const hidden = new Set<string>();
    for (const m of listMasters()) if (m.hidden && (await m.hidden())) hidden.add(m.key);
    return listMasterGroups().map((g) => ({
        key: g.key,
        label: g.label,
        masters: listMasters()
            .filter((m) => m.group === g.key && !hidden.has(m.key))
            .map((m) => ({
                key: m.key,
                label: m.label,
                plural: m.plural,
                description: m.description ?? null,
                parent: m.parent ?? null,
                chain: masterChain(m.key).map((c) => ({ key: c.key, label: c.label, plural: c.plural })),
                code: m.code,
                ordering: m.ordering,
                fields: (m.fields ?? []).map(({ pattern: _p, patternMessage: _m, ...f }) => f),
                total: count(m.key),
                active: count(m.key, true),
                canManage: !!access.permissions[managePermission(m)],
            })),
    })).filter((g) => g.masters.length);
};

const valuesWhere = (key: string, q: Pick<ListQuery<typeof masterValueFilters>, 'filters' | 'search'>): Prisma.MasterValueWhereInput => ({
    master: key,
    ...(q.filters.parent ? { parentId: q.filters.parent } : {}),
    ...(q.filters.status ? { isActive: q.filters.status === 'active' } : {}),
    ...(q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { code: { contains: q.search, mode: 'insensitive' } }] } : {}),
});

/** The Masters screen: one list's options, paged, with search and filters. */
export const listValues = async (key: string, q: ListQuery<typeof masterValueFilters>) => {
    const def = masterDef(key);
    // A list a newly built module brought starts with its starter options (as dropdowns do).
    if (seedsOf(def).length && !(await db.masterValue.count({ where: { master: key } }))) await seedMasters();
    const where = valuesWhere(key, q);
    const orderBy = q.sort === 'default' ? orderFor(def) : [{ [q.sort]: q.order } as Prisma.MasterValueOrderByWithRelationInput, { name: 'asc' as const }];
    const [rows, total] = await Promise.all([
        db.masterValue.findMany({ where, include: parentInclude, orderBy, skip: q.skip, take: q.take }),
        db.masterValue.count({ where }),
    ]);
    return listResult(rows.map(present), total, q);
};

/**
 * Dropdown options for forms: active options (of one parent, if given), plus any `include`d ones
 * so a record keeps showing an option that was made inactive after it was chosen.
 */
export const listOptions = async (key: string, opts: { parentId?: string; include?: string[] } = {}): Promise<{ id: string; name: string; code: string | null; parentId: string | null; isActive: boolean; extra: Prisma.JsonValue }[]> => {
    const def = masterDef(key);
    const rows = await db.masterValue.findMany({
        where: {
            master: key,
            ...(opts.parentId ? { parentId: opts.parentId } : {}),
            OR: [{ isActive: true }, ...(opts.include?.length ? [{ id: { in: opts.include } }] : [])],
        },
        select: { id: true, name: true, code: true, parentId: true, isActive: true, extra: true },
        orderBy: orderFor(def),
    });
    if (!rows.length && !def.parent && !opts.parentId && seedsOf(def).length && !(await db.masterValue.count({ where: { master: key } }))) {
        await db.masterValue.createMany({
            data: seedsOf(def).map((d, i) => ({ tenantId: getTenantId()!, master: key, name: d.name, code: d.code ?? null, sortOrder: i + 1, extra: (d.extra ?? {}) as object })),
            skipDuplicates: true,
        });
        return listOptions(key, opts);
    }
    return rows;
};

export const getValue = async (key: string, id: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Option not found');
    const row = await db.masterValue.findFirst({ where: { id, master: key }, include: parentInclude });
    if (!row) throw notFound('Option not found');
    return present(row);
};

// ─── Changing ────────────────────────────────────────────────────────────────

/** Checks a list's extra fields (e.g. IFSC prefix) and returns them cleaned. */
export const checkExtra = (def: MasterDef, raw: Record<string, unknown> | undefined) => {
    const issues: { field: string; message: string }[] = [];
    const out: Record<string, string | number | boolean> = {};
    for (const f of def.fields ?? []) {
        let v = raw?.[f.key];
        if (v === undefined || v === null || v === '') {
            if (f.required) issues.push({ field: `extra.${f.key}`, message: 'is required' });
            continue;
        }
        if (f.type === 'boolean') {
            if (typeof v !== 'boolean') issues.push({ field: `extra.${f.key}`, message: 'must be yes or no' });
            else out[f.key] = v;
            continue;
        }
        if (f.type === 'select') {
            if (!f.options?.some((o) => o.value === v)) issues.push({ field: `extra.${f.key}`, message: 'choose one of the options' });
            else out[f.key] = v as string;
            continue;
        }
        if (f.type === 'number') {
            const n = typeof v === 'number' ? v : Number(v);
            if (!Number.isFinite(n)) issues.push({ field: `extra.${f.key}`, message: 'must be a number' });
            else out[f.key] = n;
            continue;
        }
        v = String(v).trim();
        if (f.upperCase) v = (v as string).toUpperCase();
        const text = v as string;
        if (f.max && text.length > f.max) issues.push({ field: `extra.${f.key}`, message: `must be at most ${f.max} characters` });
        else if (f.pattern && !f.pattern.test(text)) issues.push({ field: `extra.${f.key}`, message: f.patternMessage ?? 'is not valid' });
        else out[f.key] = text;
    }
    return { extra: out, issues };
};

export interface ValueInput {
    name?: string;
    code?: string | null;
    parentId?: string | null;
    isActive?: boolean;
    extra?: Record<string, unknown>;
}

const valueSchema = z.strictObject({
    name: z.string().transform(cleanName).pipe(z.string().min(1, 'is required').max(120, 'must be at most 120 characters')).optional(),
    code: z
        .union([z.literal('').transform(() => null), z.string().trim().max(20, 'must be at most 20 characters').regex(/^[A-Za-z0-9._/-]+$/, 'use letters, numbers, dots, dashes or slashes'), z.null()])
        .optional(),
    parentId: z.uuid('choose one').nullable().optional(),
    isActive: z.boolean().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
});

export const parseValueInput = (body: unknown): ValueInput => {
    const parsed = valueSchema.safeParse(body ?? {});
    if (!parsed.success) throw validationError(parsed.error);
    return parsed.data;
};

/** The checks shared by the screen and the Excel import; throws a 400 with field problems. */
const checkValue = async (def: MasterDef, input: Required<Pick<ValueInput, 'name'>> & ValueInput, exceptId?: string) => {
    const issues: { field: string; message: string }[] = [];
    if (def.code === 'none' && input.code) issues.push({ field: 'code', message: 'this list has no codes' });
    if (def.code === 'required' && !input.code) issues.push({ field: 'code', message: 'is required' });
    if (def.parent && !input.parentId) issues.push({ field: 'parentId', message: `choose the ${masterDef(def.parent).label.toLowerCase()}` });
    if (!def.parent && input.parentId) issues.push({ field: 'parentId', message: 'this list has no parent' });
    if (input.parentId && def.parent) {
        const parent = await db.masterValue.findFirst({ where: { id: input.parentId, master: def.parent }, select: { id: true } });
        if (!parent) issues.push({ field: 'parentId', message: `is not a ${masterDef(def.parent).label.toLowerCase()}` });
    }
    const { extra, issues: extraIssues } = checkExtra(def, input.extra);
    issues.push(...extraIssues);
    if (issues.length) throw badRequest(issues.length === 1 ? `${issues[0].field === 'parentId' ? 'Parent' : issues[0].field} ${issues[0].message}` : 'Some fields are not valid', issues);

    const sameName = await db.masterValue.findFirst({
        where: { master: def.key, parentId: input.parentId ?? null, name: { equals: input.name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
        select: { id: true },
    });
    if (sameName) throw conflict(`"${input.name}" is already in the ${def.plural.toLowerCase()} list`);
    if (input.code) {
        const sameCode = await db.masterValue.findFirst({
            where: { master: def.key, code: { equals: input.code, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
            select: { name: true },
        });
        if (sameCode) throw conflict(`The code "${input.code}" is already used by ${sameCode.name}`);
    }
    return extra;
};

/** The database's unique indexes catch a race between two people adding the same option. */
const onDuplicate = (def: MasterDef) => (err: unknown) => {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw conflict(`That option is already in the ${def.plural.toLowerCase()} list`);
    throw err;
};

const nextSortOrder = async (def: MasterDef, parentId: string | null) => {
    if (def.ordering !== 'manual') return 0;
    const last = await db.masterValue.aggregate({ where: { master: def.key, parentId }, _max: { sortOrder: true } });
    return (last._max.sortOrder ?? 0) + 10;
};

export const createValue = async (key: string, input: ValueInput) => {
    const def = masterDef(key);
    if (!input.name) throw badRequest('Name is required', [{ field: 'name', message: 'is required' }]);
    const extra = await checkValue(def, { ...input, name: input.name });
    const parentId = input.parentId ?? null;
    const row = await db.masterValue
        .create({
            data: { tenantId: getTenantId()!, master: key, name: input.name, code: input.code ?? null, parentId, isActive: input.isActive ?? true, extra, sortOrder: await nextSortOrder(def, parentId) },
        })
        .catch(onDuplicate(def));
    return getValue(key, row.id);
};

export const updateValue = async (key: string, id: string, input: ValueInput) => {
    const def = masterDef(key);
    const current = await getValue(key, id);
    const merged = {
        name: input.name ?? current.name,
        code: input.code === undefined ? current.code : input.code,
        parentId: input.parentId === undefined ? current.parentId : input.parentId,
        extra: input.extra === undefined ? current.extra : input.extra,
    };
    const extra = await checkValue(def, merged, id);
    const movedParent = merged.parentId !== current.parentId;
    await db.masterValue
        .update({
            where: { id },
            data: {
                name: merged.name,
                code: merged.code ?? null,
                parentId: merged.parentId ?? null,
                extra,
                ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
                ...(movedParent ? { sortOrder: await nextSortOrder(def, merged.parentId ?? null) } : {}),
            },
        })
        .catch(onDuplicate(def));
    return getValue(key, id);
};

/** Only options nothing refers to can be deleted; otherwise they can be made inactive. */
export const deleteValue = async (key: string, id: string) => {
    const def = masterDef(key);
    const current = await getValue(key, id);
    const children = await db.masterValue.count({ where: { parentId: id } });
    if (children) {
        const child = childMasters(key)[0];
        throw conflict(`${current.name} has ${children} ${children === 1 ? child?.label.toLowerCase() ?? 'option' : child?.plural.toLowerCase() ?? 'options'} under it. Delete those first, or make it inactive instead.`);
    }
    for (const usage of masterUsages(key)) {
        const n = await usage.count([id]);
        if (n) throw conflict(`${current.name} is used by ${n} ${usage.label}. Make it inactive instead, so it can't be chosen any more.`);
    }
    await db.masterValue.delete({ where: { id } });
    return { id, deleted: true, list: def.key };
};

/** Moves an option one place up or down (lists the school orders by hand). */
export const moveValue = async (key: string, id: string, direction: 'up' | 'down') => {
    const def = masterDef(key);
    if (def.ordering !== 'manual') throw badRequest(`${def.plural} are sorted by name`);
    const current = await getValue(key, id);
    await withTransaction(async (tx) => {
        const siblings = await tx.masterValue.findMany({ where: { master: key, parentId: current.parentId }, orderBy: orderFor(def), select: { id: true, sortOrder: true } });
        const i = siblings.findIndex((s) => s.id === id);
        const j = direction === 'up' ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= siblings.length) return;
        [siblings[i], siblings[j]] = [siblings[j], siblings[i]];
        // Renumber 10, 20, 30… and write only the rows whose place changed.
        for (const [n, s] of siblings.entries()) {
            if (s.sortOrder !== (n + 1) * 10) await tx.masterValue.update({ where: { id: s.id }, data: { sortOrder: (n + 1) * 10 } });
        }
    });
    return getValue(key, id);
};

// ─── Excel ───────────────────────────────────────────────────────────────────

/**
 * How options of a list are named in Excel: the name, plus the parent's name when the same name
 * appears twice ("Bilaspur (Chhattisgarh)", "Bilaspur (Himachal Pradesh)").
 */
export const optionLabels = async (key: string) => {
    const rows = await db.masterValue.findMany({ where: { master: key }, select: { id: true, name: true, parent: { select: { name: true } } }, orderBy: { name: 'asc' } });
    const seen = new Map<string, number>();
    for (const r of rows) seen.set(r.name.toLowerCase(), (seen.get(r.name.toLowerCase()) ?? 0) + 1);
    return rows.map((r) => ({ id: r.id, label: (seen.get(r.name.toLowerCase())! > 1 && r.parent ? `${r.name} (${r.parent.name})` : r.name) }));
};

export const exportValues = async (key: string, q: Pick<ListQuery<typeof masterValueFilters>, 'filters' | 'search'>, maxRows: number) => {
    const def = masterDef(key);
    const rows = (await db.masterValue.findMany({ where: valuesWhere(key, q), include: parentInclude, orderBy: def.parent ? [{ parent: { name: 'asc' } }, ...orderFor(def)] : orderFor(def), take: maxRows })).map(present);
    const parentDef = def.parent ? masterDef(def.parent) : null;
    return buildWorkbook(def.plural, [
        { header: 'Name', width: 30, value: (r) => r.name },
        ...(def.code !== 'none' ? [{ header: 'Code', value: (r: (typeof rows)[number]) => r.code }] : []),
        ...(parentDef ? [{ header: parentDef.label, width: 28, value: (r: (typeof rows)[number]) => r.ancestors[r.ancestors.length - 1]?.name ?? null }] : []),
        ...(def.fields ?? []).map((f) => ({ header: f.label, width: 20, value: (r: (typeof rows)[number]) => (r.extra[f.key] === undefined ? null : String(r.extra[f.key])) })),
        ...(def.ordering === 'manual' ? [{ header: 'Order', value: (r: (typeof rows)[number]) => r.sortOrder }] : []),
        { header: 'Active', value: (r) => (r.isActive ? 'Yes' : 'No') },
    ], rows, { plain: true });
};

// ─── Starter options ─────────────────────────────────────────────────────────

/**
 * Adds the starter options of every list that is still empty for the current school (a new
 * school, or a list a newly built module brought). Lists that have any options are left alone,
 * so a school's own changes are never undone.
 */
export const seedMasters = async () => {
    const added: Record<string, number> = {};
    const filled = new Set((await db.masterValue.groupBy({ by: ['master'] })).map((g) => g.master));
    for (const def of mastersInDefinitionOrder()) {
        const seeds = seedsOf(def);
        if (!seeds.length || filled.has(def.key)) continue;

        // Parents by their path of names ("india/uttarakhand"), from the lists above this one.
        const pathToId = new Map<string, string>();
        if (def.parent) {
            const chain = masterChain(def.parent).map((m) => m.key);
            const rows = await db.masterValue.findMany({ where: { master: { in: chain } }, select: { id: true, name: true, parentId: true } });
            const byId = new Map(rows.map((r) => [r.id, r]));
            for (const r of rows) {
                const names: string[] = [];
                for (let x: (typeof rows)[number] | undefined = r; x; x = x.parentId ? byId.get(x.parentId) : undefined) names.unshift(x.name.toLowerCase());
                pathToId.set(names.join('/'), r.id);
            }
        }

        const tenantId = getTenantId()!;
        const data: Prisma.MasterValueCreateManyInput[] = [];
        const order = new Map<string, number>();
        for (const s of seeds) {
            const parentId = s.parent ? pathToId.get(s.parent.map((n) => n.toLowerCase()).join('/')) : undefined;
            if (s.parent && !parentId) continue; // its parent was removed or renamed by the school
            const scope = parentId ?? '';
            order.set(scope, (order.get(scope) ?? 0) + 10);
            data.push({ tenantId, master: def.key, name: cleanName(s.name), code: s.code ?? null, parentId: parentId ?? null, extra: (s.extra ?? {}) as Prisma.InputJsonValue, sortOrder: def.ordering === 'manual' ? order.get(scope)! : 0 });
        }
        for (let i = 0; i < data.length; i += 1000) await db.masterValue.createMany({ data: data.slice(i, i + 1000), skipDuplicates: true });
        added[def.key] = data.length;
    }
    return added;
};
