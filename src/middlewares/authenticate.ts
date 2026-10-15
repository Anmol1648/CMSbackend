import { Request, Response, NextFunction } from 'express';
import { AppError, JwtPayload, ErrorCode, runWithUser } from '../core/index';
import { verifyAccessToken } from '../config/jwt';
import { isTokenBlacklisted, getRevokeBefore } from '../config/redis';
import { findTenantById } from '../modules/tenants';

declare global {
    namespace Express {
        interface Request {
            user?: JwtPayload;
        }
    }
}

/**
 * Verifies the Bearer access token, rejects revoked sessions, and runs the rest of the
 * request with the user in context (used for audit fields and audit log).
 */
export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return next(new AppError('Missing or invalid authorization header', 401, ErrorCode.UNAUTHORIZED));
    }

    let payload: JwtPayload;
    try {
        payload = verifyAccessToken(authHeader.split(' ')[1]);
    } catch {
        return next(new AppError('Invalid or expired token', 401, ErrorCode.UNAUTHORIZED));
    }

    try {
        // 1. Check Redis Blacklist (Specific Token)
        if (payload.jti && (await isTokenBlacklisted(payload.jti))) {
            return next(new AppError('Token has been revoked', 401, ErrorCode.UNAUTHORIZED));
        }

        // 2. Check Global Revocation (Logout from All Devices)
        if (payload.userId && payload.iat) {
            const revokeBefore = await getRevokeBefore(payload.userId);
            if (revokeBefore && payload.iat < revokeBefore) {
                return next(new AppError('Session has been invalidated globally. Please login again.', 401, ErrorCode.UNAUTHORIZED));
            }
        }

        // 3. The school must exist and be active, and match the web address if that points to a school.
        if (req.hostTenant?.source === 'domain' && req.hostTenant.id !== payload.tenantId) {
            return next(new AppError('This sign-in belongs to another school', 401, ErrorCode.UNAUTHORIZED));
        }
        const tenant = await findTenantById(payload.tenantId);
        if (!tenant) return next(new AppError('Invalid or expired token', 401, ErrorCode.UNAUTHORIZED));
        if (tenant.status !== 'active') return next(new AppError('This school account is suspended', 403, ErrorCode.FORBIDDEN));
    } catch (err) {
        return next(err);
    }

    req.user = payload;
    return runWithUser({ id: payload.userId, email: payload.email, tenantId: payload.tenantId }, next);
};
