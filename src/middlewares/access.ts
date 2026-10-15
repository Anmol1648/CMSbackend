import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { tagAccess } from '../core/http/route-guard';
import { authenticate } from './authenticate';
import { requirePermission, requireRole } from './require-permission';

/**
 * Access rules — the first handler of every route:
 *   router.get('/', can('role.read'), handler)
 *   router.post('/login', publicRoute, handler)
 */

/** Runs handlers in order as one middleware (stops at the first error). */
const chain = (...handlers: RequestHandler[]): RequestHandler => (req: Request, res: Response, next: NextFunction) => {
    let index = 0;
    const step = (err?: unknown): void => {
        if (err) return next(err);
        const handler = handlers[index++];
        if (!handler) return next();
        try {
            const result: unknown = handler(req, res, step);
            if (result && typeof (result as Promise<unknown>).catch === 'function') (result as Promise<unknown>).catch(next);
        } catch (e) {
            next(e);
        }
    };
    step();
};

/** Anyone, signed in or not (login, password reset, health). */
export const publicRoute = tagAccess('public', (_req, _res, next) => next());

/** Any signed-in user (own profile, own menu, logout). */
export const authenticated = tagAccess('authenticated', chain(authenticate));

/** Signed-in user holding the permission, written `resource.action` (e.g. `role.update`). */
export const can = (permission: string) => {
    const [resource, action] = permission.split('.');
    if (!resource || !action) throw new Error(`Permission must look like "resource.action", got "${permission}"`);
    return tagAccess(`can:${permission}`, chain(authenticate, requirePermission(resource, action)));
};

/** Signed-in user holding one of the roles (interim, until those screens get their own permissions). */
export const hasRole = (...slugs: string[]) => tagAccess(`role:${slugs.join('|')}`, chain(authenticate, requireRole(...slugs)));
