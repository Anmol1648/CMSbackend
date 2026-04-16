import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from '../utils/errors';
import { JwtPayload, ErrorCode } from '@shared/core';

declare global {
    namespace Express {
        interface Request {
            user?: JwtPayload;
        }
    }
}

export const authenticate = (req: Request, res: Response, next: NextFunction) => {
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

        req.user = payload;

        req.headers['x-user-id'] = payload.userId;
        req.headers['x-user-email'] = payload.email;
        req.headers['x-tenant-id'] = payload.tenantId;
        req.headers['x-internal-secret'] = process.env.INTERNAL_SECRET || '';

        return next();
    } catch (err) {
        return next(new AppError('Invalid or expired token', 401, ErrorCode.UNAUTHORIZED));
    }
};
