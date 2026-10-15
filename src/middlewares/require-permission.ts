import { Request, Response, NextFunction } from 'express';
import { getPermissionSet } from '../modules/rbac/rbac.service';
import { AppError } from '../core/errors';
import { ErrorCode } from '../core/index';
import { db } from '../db/prisma';

/** Allows the request only if the user holds one of the given role slugs. */
export const requireRole = (...slugs: string[]) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            const user = req.user;
            if (!user) {
                return next(new AppError('Unauthorized', 401, ErrorCode.UNAUTHORIZED));
            }

            const match = await db.userRole.findFirst({
                where: {
                    user_id: user.userId,
                    tenant_id: { in: [user.tenantId, 'system'] },
                    role: { slug: { in: slugs }, deleted_at: null },
                },
                select: { id: true },
            });

            if (!match) {
                return next(new AppError('Forbidden: Missing required role', 403, ErrorCode.FORBIDDEN));
            }

            next();
        } catch (error) {
            next(error);
        }
    };
};

export const requirePermission = (resource: string, action: string) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            const user = (req as any).user;
            if (!user) {
                return next(new AppError('Unauthorized', 401, ErrorCode.UNAUTHORIZED));
            }

            const permissions = await getPermissionSet(user.userId, user.tenantId);
            
            // Check if user has explicit permission
            const hasPermission = permissions.some(
                (p: any) => p.resource === resource && p.action === action
            );

            // Also allow if user has wildcard admin permission '*.*' or 'resource.*'
            const hasWildcard = permissions.some(
                (p: any) => (p.resource === '*' && p.action === '*') || (p.resource === resource && p.action === '*')
            );

            if (!hasPermission && !hasWildcard) {
                return next(new AppError('Forbidden: Missing required permission', 403, ErrorCode.FORBIDDEN));
            }

            next();
        } catch (error) {
            next(error);
        }
    };
};
