import { Request, Response, NextFunction } from 'express';
import { AppError, JwtPayload, ErrorCode, runWithUser } from '../core/index';
import { verifyAccessToken } from '../config/jwt';
import { findTenantById } from '../modules/tenants';
import { isSessionRevoked } from '../modules/auth/session.service';

declare global {
    namespace Express {
        interface Request {
            user?: JwtPayload;
        }
    }
}

export interface AuthenticateOptions {
    /** Let users who must change their password through (change password, who am I, logout). */
    allowPasswordChange?: boolean;
}

/**
 * Verifies the Bearer access token, rejects ended sessions, other schools' tokens and suspended
 * schools, enforces "change your password first", and runs the rest of the request as that user
 * in their school.
 */
export const authenticateWith = (options: AuthenticateOptions = {}) => async (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return next(new AppError('Please sign in', 401, ErrorCode.UNAUTHORIZED));
    }

    let payload: JwtPayload;
    try {
        payload = verifyAccessToken(authHeader.slice('Bearer '.length));
    } catch {
        return next(new AppError('Your sign-in has expired', 401, ErrorCode.AUTH_TOKEN_EXPIRED));
    }

    try {
        if (await isSessionRevoked(payload.sessionId)) {
            return next(new AppError('Your session has ended. Please sign in again.', 401, ErrorCode.UNAUTHORIZED));
        }
        if (req.hostTenant?.source === 'domain' && req.hostTenant.id !== payload.tenantId) {
            return next(new AppError('This sign-in belongs to another school', 401, ErrorCode.UNAUTHORIZED));
        }
        const tenant = await findTenantById(payload.tenantId);
        if (!tenant) return next(new AppError('Your sign-in has expired', 401, ErrorCode.UNAUTHORIZED));
        if (tenant.status !== 'active') return next(new AppError('This school account is suspended', 403, ErrorCode.FORBIDDEN));
        if (payload.pwdChange && !options.allowPasswordChange) {
            return next(new AppError('Please choose a new password first', 403, ErrorCode.PASSWORD_CHANGE_REQUIRED));
        }
    } catch (err) {
        return next(err);
    }

    req.user = payload;
    return runWithUser({ id: payload.userId, tenantId: payload.tenantId, sessionId: payload.sessionId }, next);
};

export const authenticate = authenticateWith();
