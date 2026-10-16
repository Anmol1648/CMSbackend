import { Prisma, PrismaClient } from '@prisma/client';
import { getContext } from '../context';

/**
 * The one database client. On every model that has `tenantId` it:
 *   - adds `tenantId = <current school>` to every read / update / delete / count,
 *   - fills `tenantId` on create (and rejects a different one),
 *   - refuses to run at all when no school is in context (fail closed),
 * hides soft-deleted rows (`deletedAt`) from reads unless the query asks about `deletedAt` itself,
 * and fills createdBy / updatedBy from the signed-in user.
 *
 * Inside runAsSystem() scoping is off (creating schools, platform jobs). Raw SQL must go through
 * `tenantSql` below; a test fails if $queryRaw / $executeRaw appear anywhere else.
 */

interface ModelMeta {
    tenant: boolean;
    soft: boolean;
    createdBy: boolean;
    updatedBy: boolean;
}

const modelMeta = new Map<string, ModelMeta>(
    Prisma.dmmf.datamodel.models.map((m) => {
        const has = (name: string) => m.fields.some((f) => f.name === name);
        return [m.name, { tenant: has('tenantId'), soft: has('deletedAt'), createdBy: has('createdBy'), updatedBy: has('updatedBy') }];
    })
);

const READS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);
const WHERE_WRITES = new Set(['update', 'updateMany', 'delete', 'deleteMany']);

export class TenantContextError extends Error {}

type Args = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Keeps the caller's where (including unique fields, as Prisma requires) and ANDs `extra` onto it. */
const andWhere = (where: Args | undefined, extra: Args): Args => {
    const current = where ?? {};
    const existing = current.AND === undefined ? [] : Array.isArray(current.AND) ? current.AND : [current.AND];
    return { ...current, AND: [...existing, extra] };
};

/** True if the caller's where talks about deletedAt (at the top level or inside AND/OR/NOT). */
const mentionsDeletedAt = (where: unknown): boolean => {
    if (!where || typeof where !== 'object') return false;
    if (Array.isArray(where)) return where.some(mentionsDeletedAt);
    const w = where as Args;
    return 'deletedAt' in w || mentionsDeletedAt(w.AND) || mentionsDeletedAt(w.OR) || mentionsDeletedAt(w.NOT);
};

const withTenantData = (data: Args | undefined, tenantId: string, model: string): Args => {
    const row = { ...(data ?? {}) };
    if (row.tenantId !== undefined && row.tenantId !== tenantId) {
        throw new TenantContextError(`${model}: tenantId in data does not match the current school`);
    }
    // A nested `tenant: { connect }` would bypass the check above; scoped models take the scalar only.
    if (row.tenant !== undefined) throw new TenantContextError(`${model}: set tenantId, not the tenant relation`);
    row.tenantId = tenantId;
    return row;
};

const stampCreate = (data: Args, meta: ModelMeta, userId?: string): Args => {
    if (!userId) return data;
    const row = { ...data };
    if (meta.createdBy && row.createdBy === undefined) row.createdBy = userId;
    if (meta.updatedBy && row.updatedBy === undefined) row.updatedBy = userId;
    return row;
};

const stampUpdate = (data: Args | undefined, meta: ModelMeta, userId?: string): Args => {
    const row = { ...(data ?? {}) };
    if (userId && meta.updatedBy && row.updatedBy === undefined) row.updatedBy = userId;
    return row;
};

/** Applies scoping and stamps to one operation's args. Exported for tests. */
export const scopeArgs = (model: string, operation: string, input: Args): Args => {
    const meta = modelMeta.get(model);
    if (!meta) return input;
    const ctx = getContext();
    const userId = ctx?.user?.id;
    const args: Args = { ...input };

    if (meta.tenant && !ctx?.system) {
        const tenantId = ctx?.tenantId;
        if (!tenantId) throw new TenantContextError(`${model}.${operation} needs a school in context (or runAsSystem)`);

        if (READS.has(operation) || WHERE_WRITES.has(operation) || operation === 'upsert') {
            // Added as an extra condition (never replacing the caller's own filter), so a query that
            // names another school matches nothing instead of being silently redirected.
            args.where = andWhere(args.where, { tenantId });
        }
        if (operation === 'create') args.data = withTenantData(args.data, tenantId, model);
        if (operation === 'createMany' || operation === 'createManyAndReturn') {
            const rows = Array.isArray(args.data) ? args.data : [args.data];
            args.data = rows.map((r: Args) => withTenantData(r, tenantId, model));
        }
        if (operation === 'upsert') args.create = withTenantData(args.create, tenantId, model);
        if ((operation === 'update' || operation === 'updateMany' || operation === 'upsert') && args.data?.tenantId !== undefined) {
            throw new TenantContextError(`${model}: a record can't be moved to another school`);
        }
        if (operation === 'upsert' && args.update?.tenantId !== undefined) {
            throw new TenantContextError(`${model}: a record can't be moved to another school`);
        }
    }

    if (meta.soft && READS.has(operation) && !mentionsDeletedAt(input.where)) {
        args.where = andWhere(args.where, { deletedAt: null });
    }

    if (operation === 'create') args.data = stampCreate(args.data ?? {}, meta, userId);
    if (operation === 'createMany' || operation === 'createManyAndReturn') {
        args.data = (args.data as Args[]).map((r) => stampCreate(r, meta, userId));
    }
    if (operation === 'update' || operation === 'updateMany') args.data = stampUpdate(args.data, meta, userId);
    if (operation === 'upsert') {
        args.create = stampCreate(args.create ?? {}, meta, userId);
        args.update = stampUpdate(args.update, meta, userId);
    }
    return args;
};

/**
 * The database address with patient connection limits (unless the URL sets its own): Prisma's
 * defaults (5 s to connect, 10 s to wait for a free connection) are too short for a remote
 * database that is far away or waking up from sleep, and fail requests that would have worked.
 */
const withTimeouts = (url: string | undefined) => {
    if (!url) return url;
    try {
        const u = new URL(url);
        if (!u.searchParams.has('connect_timeout')) u.searchParams.set('connect_timeout', '20');
        if (!u.searchParams.has('pool_timeout')) u.searchParams.set('pool_timeout', '20');
        return u.toString();
    } catch {
        return url;
    }
};

const base = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? [{ emit: 'event', level: 'warn' }] : [],
    datasources: { db: { url: withTimeouts(process.env.DATABASE_URL) } },
});

// ─── Automatic change history (opt-in per model) ─────────────────────────────

interface AuditedModel {
    entity: string;
    exclude: Set<string>;
}

const audited = new Map<string, AuditedModel>();
const ALWAYS_SKIPPED = ['createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'tenantId'];

/**
 * Records every single-row create / update / delete of `model` in the audit log with
 * field-level [old, new] values. Modules opt their tables in; secrets go in `exclude`.
 * Note: the entry is written right after the statement, outside any surrounding transaction.
 */
export const auditModel = (model: Prisma.ModelName, entity: string, exclude: string[] = []) =>
    audited.set(model, { entity, exclude: new Set([...ALWAYS_SKIPPED, ...exclude]) });

const comparable = (v: unknown) => (v instanceof Date ? v.toISOString() : v === undefined ? null : v);

/** The model's own columns (no relations), so included related records never count as changes. */
const columnsOf = new Map(
    Prisma.dmmf.datamodel.models.map((m) => [m.name, m.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum').map((f) => f.name)])
);

const diffRows = (model: string, before: Args | null, after: Args | null, exclude: Set<string>) => {
    const changes: Record<string, [unknown, unknown]> = {};
    for (const key of columnsOf.get(model) ?? []) {
        if (exclude.has(key)) continue;
        const a = comparable(before?.[key]);
        const b = comparable(after?.[key]);
        if (JSON.stringify(a) !== JSON.stringify(b)) changes[key] = [a, b];
    }
    return changes;
};

const delegate = (model: string) => (base as unknown as Record<string, { findFirst: (a: Args) => Promise<Args | null> }>)[model[0].toLowerCase() + model.slice(1)];

const writeHistory = async (model: string, operation: string, before: Args | null, after: Args | null) => {
    const spec = audited.get(model)!;
    const changes = diffRows(model, before, after, spec.exclude);
    if (operation === 'update' && !Object.keys(changes).length) return;
    const row = after ?? before;
    const ctx = getContext();
    const tenantId = (row?.tenantId as string | undefined) ?? ctx?.tenantId;
    if (!tenantId) return;
    try {
        await base.auditLog.create({
            data: {
                tenantId,
                userId: ctx?.user?.id ?? null,
                action: operation,
                entity: spec.entity,
                entityId: String(row?.id ?? row?.tenantId ?? ''),
                changes: changes as object,
                ip: ctx?.ip ?? null,
                userAgent: ctx?.userAgent ?? null,
                requestId: ctx?.requestId ?? null,
            },
        });
    } catch (error) {
        // The change itself succeeded; a missing history line must not fail the request.
        process.stderr.write(`Audit history write failed for ${model}.${operation}: ${(error as Error).message}\n`);
    }
};

export const db = base.$extends({
    name: 'tenant-scoping',
    query: {
        $allModels: {
            async $allOperations({ model, operation, args, query }) {
                const scoped = scopeArgs(model, operation, args as Args) as typeof args;
                if (!audited.has(model) || !['create', 'update', 'delete'].includes(operation)) return query(scoped);

                const before = operation === 'create' ? null : await delegate(model).findFirst({ where: (scoped as Args).where });
                const result = (await query(scoped)) as Args;
                await writeHistory(model, operation, before, operation === 'delete' ? null : result);
                return result;
            },
        },
    },
});

export type Db = typeof db;
/** The client inside db.$transaction(async (tx) => …). */
export type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];

/** Runs `fn` in one transaction; pass `tx` to every service involved. */
export const withTransaction = <T>(fn: (tx: Tx) => Promise<T>, options?: { timeout?: number }) =>
    db.$transaction(fn, { timeout: options?.timeout ?? 15_000, maxWait: 10_000 });

/**
 * The only way to run raw SQL. The callback receives the current school's id and must use it
 * (e.g. `WHERE tenant_id = ${tenantId}::uuid`). Values are always bound parameters (Prisma.sql).
 */
export const tenantSql = async <T = unknown>(build: (tenantId: string) => Prisma.Sql): Promise<T[]> => {
    const ctx = getContext();
    if (!ctx?.tenantId) throw new TenantContextError('tenantSql needs a school in context');
    return db.$queryRaw<T[]>(build(ctx.tenantId));
};

/** Raw SQL that is deliberately not tied to one school (health checks, platform scripts). */
export const systemSql = async <T = unknown>(sql: Prisma.Sql): Promise<T[]> => db.$queryRaw<T[]>(sql);

export { Prisma };
