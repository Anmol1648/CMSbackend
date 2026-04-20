import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis.config';
import axios from 'axios';

/**
 * Intercepts the response body and removes fields the user is not allowed to read.
 * This checks the FieldPermission config cached for the user.
 */
export const filterFields = (modelName: string) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        const user = req.user;

        if (!user || (!user.userId && !user.tenantId)) {
            return next();
        }

        const originalJson = res.json;

        // Override res.json to filter before sending
        res.json = function (body: any) {
            // We need async logic to fetch from Redis, but res.json is synchronous.
            // A common Express hack is to proxy the send instead, or pre-fetch permissions
            // before overriding. Since we are in an async middleware:
            
            // Revert to original
            res.json = originalJson;

            // In a real high-throughput system, body manipulation should happen 
            // inside the microservice where Prisma can selectively SELECT columns.
            // Gateway interception of large arrays of objects is computationally expensive.
            
            // For demonstration of the spec requirement, we allow it through or 
            // strip simple top-level keys if forbidden fields exist.
            
            // We assume a pre-fetched req.forbiddenFields populated by an upstream middleware
            const forbidden = (req as any).forbiddenFields || [];
            if (forbidden.length > 0 && body && body.data) {
                const stripFields = (obj: any) => {
                    if (Array.isArray(obj)) {
                        obj.forEach(stripFields);
                    } else if (obj !== null && typeof obj === 'object') {
                        forbidden.forEach((field: string) => delete obj[field]);
                    }
                };
                // Assuming standard ApiResponse { data: ... }
                stripFields(body.data);
            }

            return originalJson.call(this, body);
        };

        // Pre-fetch field permissions for the current model
        try {
            const cacheKey = `rbac_fields:${user.tenantId}:${user.userId}:${modelName}`;
            let fields: any[] = [];
            const cached = await redis.get(cacheKey);

            if (cached) {
                fields = JSON.parse(cached);
            } else {
                 const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://127.0.0.1:4001';
                 const response = await axios.get(`${authServiceUrl}/rbac/internal/field-permissions/${modelName}`, {
                     headers: {
                         'x-user-id': user.userId,
                         'x-tenant-id': user.tenantId,
                         'x-internal-secret': process.env.INTERNAL_SECRET || ''
                     }
                 });
                 fields = response.data.data || [];
            }
            
            // Identify fields with can_read = false
            const forbiddenFields = fields.filter((f: any) => f.can_read === false).map((f: any) => f.field_name);
            (req as any).forbiddenFields = forbiddenFields;

        } catch (error) {
            console.error('[RBAC Gateway] Error fetching field permissions:', error);
        }

        next();
    };
};
