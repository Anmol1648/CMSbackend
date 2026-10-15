import { Request, Response, NextFunction } from 'express';
import { AppError } from '../core/errors';
import { ErrorCode } from '../core/index';
import { db } from '../core/db';

/**
 * Interim permission checks (F2). F4 replaces these with the permission registry, data scopes
 * and a per-user cache; the route-level API (can / hasRole) stays the same.
 */

/** True if one of the user's roles is the system role (Super Admin) or grants `key`. */
export const userHasPermission = async (userId: string, key: string): Promise<boolean> => {
    const roles = await db.userRole.findMany({
        where: { userId, role: { deletedAt: null } },
        select: { role: { select: { isSystem: true, permissions: { where: { permissionKey: key }, select: { scope: true } } } } },
    });
    return roles.some((r) => r.role.isSystem || r.role.permissions.length > 0);
};

export const requirePermission = (resource: string, action: string) => {
    const key = `${resource}.${action}`;
    return async (req: Request, _res: Response, next: NextFunction) => {
        try {
            if (!req.user) return next(new AppError('Unauthorized', 401, ErrorCode.UNAUTHORIZED));
            if (!(await userHasPermission(req.user.userId, key))) {
                return next(new AppError('You do not have permission to do this', 403, ErrorCode.FORBIDDEN));
            }
            next();
        } catch (error) {
            next(error);
        }
    };
};

/** Allows the request only if the user holds one of the given role slugs. */
export const requireRole = (...slugs: string[]) => {
    return async (req: Request, _res: Response, next: NextFunction) => {
        try {
            if (!req.user) return next(new AppError('Unauthorized', 401, ErrorCode.UNAUTHORIZED));
            const match = await db.userRole.findFirst({
                where: { userId: req.user.userId, role: { slug: { in: slugs }, deletedAt: null } },
                select: { roleId: true },
            });
            if (!match) return next(new AppError('Forbidden: Missing required role', 403, ErrorCode.FORBIDDEN));
            next();
        } catch (error) {
            next(error);
        }
    };
};
