import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from '../utils/errors';
import { JwtPayload, ErrorCode } from '@shared/core';

import { isTokenBlacklisted, redis } from '../config/redis.config';

declare global {
    namespace Express {
        interface Request {
            user?: JwtPayload;
        }
    }
}

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return next(new AppError('Missing or invalid authorization header', 401, ErrorCode.UNAUTHORIZED));
    }

    const token = authHeader.split(' ')[1];
    const publicKey = process.env.JWT_PUBLIC_KEY?.replace(/\\n/g, '\n') || '';

    if (!publicKey) {
        return next(new AppError('JWT public key not configured', 500, ErrorCode.INTERNAL_SERVER_ERROR));
    }

    try {
        const payload = jwt.verify(token, publicKey, { algorithms: ['RS256'] }) as JwtPayload;

        // 1. Check Redis Blacklist (Specific Token)
        if (payload.jti) {
            const blacklisted = await isTokenBlacklisted(payload.jti);
            if (blacklisted) {
                return next(new AppError('Token has been revoked', 401, ErrorCode.UNAUTHORIZED));
            }
        }

        // 2. Check Global Revocation (Logout from All Devices)
        if (payload.userId && payload.iat) {
            const revokeBefore = await redis.get(`user:revoke_before:${payload.userId}`);
            if (revokeBefore && payload.iat < parseInt(revokeBefore)) {
                return next(new AppError('Session has been invalidated globally. Please login again.', 401, ErrorCode.UNAUTHORIZED));
            }
        }

        req.user = payload;



        req.headers['x-user-id'] = payload.userId;
        req.headers['x-user-email'] = payload.email;
        req.headers['x-tenant-id'] = payload.tenantId;
        req.headers['x-user-roles'] = JSON.stringify(payload.roleIds || []);
        req.headers['x-internal-secret'] = process.env.INTERNAL_SECRET || '';

        return next();
    } catch (err) {
        return next(new AppError('Invalid or expired token', 401, ErrorCode.UNAUTHORIZED));
    }
};
