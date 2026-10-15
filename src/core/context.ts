import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-request context, available anywhere in the request's async call chain:
 *   - requestId  (logging, error responses)
 *   - tenantId   (which school; the database layer scopes every query to it)
 *   - user       (audit fields, audit log)
 *   - system     (platform work that is deliberately not tied to one school, e.g. creating a school)
 */

export interface UserContext {
    id: string;
    tenantId: string;
    sessionId?: string;
}

export interface RequestContext {
    requestId: string;
    tenantId?: string;
    user?: UserContext;
    system?: boolean;
    ip?: string;
    userAgent?: string;
}

const contextStorage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` inside a fresh request context. */
export const runWithContext = <T>(ctx: RequestContext, fn: () => T): T => contextStorage.run(ctx, fn);

export const getContext = (): RequestContext | undefined => contextStorage.getStore();

export const getRequestId = (): string | undefined => contextStorage.getStore()?.requestId;

export const getTenantId = (): string | undefined => contextStorage.getStore()?.tenantId;

export const isSystemContext = (): boolean => contextStorage.getStore()?.system === true;

/** Sets the school for the rest of the current request. */
export const setTenant = (tenantId: string) => {
    const store = contextStorage.getStore();
    if (!store) throw new Error('setTenant called outside a request context');
    store.tenantId = tenantId;
};

/** Attaches the signed-in user (and their school) to the current request context. */
export const runWithUser = <T>(user: UserContext, next: () => T): T => {
    const store = contextStorage.getStore();
    if (store) {
        store.user = user;
        store.tenantId = user.tenantId;
        return next();
    }
    return contextStorage.run({ requestId: 'internal', user, tenantId: user.tenantId }, next);
};

export const getCurrentUser = (): UserContext | undefined => contextStorage.getStore()?.user;

// Prisma queries are lazy (they start when awaited), so these helpers await inside the context;
// otherwise `runAsTenant(id, () => db.user.count())` would run after the context had ended.

/** Runs `fn` as work for one school (scripts, jobs, tests). */
export const runAsTenant = <T>(tenantId: string, fn: () => T | Promise<T>, user?: UserContext): Promise<T> =>
    contextStorage.run({ requestId: getRequestId() ?? 'job', tenantId, user }, async () => await fn());

/** Runs `fn` as platform work across schools. Use sparingly: tenant scoping is off inside. */
export const runAsSystem = <T>(fn: () => T | Promise<T>): Promise<T> =>
    contextStorage.run({ requestId: getRequestId() ?? 'system', system: true }, async () => await fn());
