import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-request context (request id + signed-in user), available anywhere in the request's
 * async call chain — used by logging, audit fields and the audit log.
 */

export interface UserContext {
    id: string;
    email: string;
    tenantId: string;
}

export interface RequestContext {
    requestId: string;
    user?: UserContext;
}

const contextStorage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` inside a fresh request context. */
export const runWithContext = <T>(ctx: RequestContext, fn: () => T): T => contextStorage.run(ctx, fn);

export const getContext = (): RequestContext | undefined => contextStorage.getStore();

export const getRequestId = (): string | undefined => contextStorage.getStore()?.requestId;

/** Attaches the signed-in user to the current request context (or starts one if there is none). */
export const runWithUser = <T>(user: UserContext, next: () => T): T => {
    const store = contextStorage.getStore();
    if (store) {
        store.user = user;
        return next();
    }
    return contextStorage.run({ requestId: 'internal', user }, next);
};

export const getCurrentUser = (): UserContext | undefined => contextStorage.getStore()?.user;
