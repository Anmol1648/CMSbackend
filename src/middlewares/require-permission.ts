import { Request, Response, NextFunction } from 'express';
import type { DataScope } from '@prisma/client';
import { AppError } from '../core/errors';
import { ErrorCode } from '../core/index';
import { db } from '../core/db';
import { getUserAccess } from '../modules/rbac/access.service';

declare global {
    namespace Express {
        interface Request {
            /** Data scope the user holds for the route's permission (all / assigned / own). */
            permissionScope?: DataScope;
        }
    }
}

/** Allows the request if the user holds `resource.action`; records the scope for the service to apply. */
export const requirePermission = (resource: string, action: string) => {
    const key = `${resource}.${action}`;
    return async (req: Request, _res: Response, next: NextFunction) => {
        try {
            if (!req.user) return next(new AppError('Unauthorized', 401, ErrorCode.UNAUTHORIZED));
            const scope = (await getUserAccess(req.user.userId)).permissions[key];
            if (!scope) return next(new AppError('You do not have permission to do this', 403, ErrorCode.FORBIDDEN));
            req.permissionScope = scope;
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
