import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import { ErrorCode } from '@shared/core';
import { redis } from '../config/redis.config';
import axios from 'axios';

/**
 * Enforces Role-Based Access Control at the Gateway limit.
 * If permission is granted but has conditions (e.g. own_data), 
 * it forwards the condition in headers to downstream microservices.
 */
export const requirePermission = (resource: string, action: string) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        const user = req.user; 

        if (!user || !user.userId || !user.tenantId) {
            return next(new AppError('Unauthorized', 401, ErrorCode.UNAUTHORIZED));
        }

        const cacheKey = `rbac:${user.tenantId}:${user.userId}`;

        try {
            let permissions: any[] = [];
            const cached = await redis.get(cacheKey);

            if (cached) {
                permissions = JSON.parse(cached);
            } else {
                // Fetch from Auth service (RBAC controller) using internal route
                const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://127.0.0.1:4001';
                const response = await axios.get(`${authServiceUrl}/rbac/internal/permissions`, {
                    headers: {
                        'x-user-id': user.userId,
                        'x-tenant-id': user.tenantId,
                        'x-internal-secret': process.env.INTERNAL_SECRET || ''
                    }
                });
                
                permissions = response.data.data;
            }

            // Super admin bypass check could go here if we attach is_system to token in the future
            
            // Check if user has the requested permission
            const hasPermission = permissions.find(p => p.resource === resource && p.action === action);

            if (!hasPermission) {
                return next(new AppError(`Forbidden: Missing ${action} permission on ${resource}`, 403, ErrorCode.RBAC_FORBIDDEN));
            }

            // If there's a condition, pass it down to microservice via headers
            if (hasPermission.condition) {
                req.headers['x-rbac-conditions'] = JSON.stringify(hasPermission.condition);
            }

            next();
        } catch (error: any) {
            console.error('[RBAC Gateway] Error enforcing permission:', error?.message);
            return next(new AppError('Error checking permissions', 500, ErrorCode.INTERNAL_SERVER_ERROR));
        }
    };
};
