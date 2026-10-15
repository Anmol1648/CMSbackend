import type { Express, RequestHandler } from 'express';

/**
 * Every route must start with an access rule (publicRoute / authenticated / can(...) / hasRole(...)).
 * Access rules are tagged handlers; at startup `assertRoutesProtected(app)` walks the Express stack
 * and refuses to start if any route's first handler is not one — so nothing ships unprotected by accident.
 */

const ACCESS = Symbol.for('cms.access-rule');

export type AccessRule = RequestHandler & { [ACCESS]: string };

export const tagAccess = (label: string, handler: RequestHandler): AccessRule =>
    Object.assign(handler, { [ACCESS]: label }) as AccessRule;

export const accessLabel = (handler: unknown): string | undefined =>
    typeof handler === 'function' ? (handler as any)[ACCESS] : undefined;

/** Turns an Express mount regexp back into a readable path prefix (for error messages / listings). */
const mountPath = (layer: any): string => {
    if (!layer.regexp || layer.regexp.fast_slash) return '';
    return layer.regexp.source
        .replace(/^\^/, '')
        .replace(/\\\/\?\(\?=\\\/\|\$\)$/i, '')
        .replace(/\\\//g, '/');
};

export interface RouteInfo {
    method: string;
    path: string;
    access?: string;
}

/** Lists every route in the app with its access rule (undefined = unprotected). */
export const listRoutes = (app: Express): RouteInfo[] => {
    const routes: RouteInfo[] = [];
    const walk = (stack: any[], prefix: string) => {
        for (const layer of stack) {
            if (layer.route) {
                const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
                const access = accessLabel(layer.route.stack[0]?.handle);
                for (const method of methods) routes.push({ method: method.toUpperCase(), path: prefix + layer.route.path, access });
            } else if (layer.name === 'router' && layer.handle?.stack) {
                walk(layer.handle.stack, prefix + mountPath(layer));
            }
        }
    };
    walk((app as any)._router?.stack ?? [], '');
    return routes;
};

export const findUnprotectedRoutes = (app: Express): RouteInfo[] => listRoutes(app).filter((r) => !r.access);

export const assertRoutesProtected = (app: Express) => {
    const unprotected = findUnprotectedRoutes(app);
    if (unprotected.length) {
        const list = unprotected.map((r) => `  - ${r.method} ${r.path}`).join('\n');
        throw new Error(
            `These routes have no access rule (start them with publicRoute, authenticated, can(...) or hasRole(...)):\n${list}`
        );
    }
};
