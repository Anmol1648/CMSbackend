import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis.config';
import { AppError } from '../utils/errors';
import { ErrorCode } from '@shared/core';

interface RateLimitOptions {
    windowInMinutes: number;
    maxAttempts: number;
    keyPrefix: string;
}

/**
 * Enhanced Redis-based Rate Limiter for sensitive endpoints (MFA, Login)
 */
export const createRateLimiter = (options: RateLimitOptions) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        // Use IP address + optional user identifier as the key
        const identifier = req.ip || req.headers['x-forwarded-for'] || 'unknown';
        const key = `ratelimit:${options.keyPrefix}:${identifier}`;

        try {
            const currentAttempts = await redis.get(key);
            const attempts = currentAttempts ? parseInt(currentAttempts) : 0;

            if (attempts >= options.maxAttempts) {
                return next(new AppError(
                    `Too many attempts. Please try again in ${options.windowInMinutes} minutes.`, 
                    429, 
                    ErrorCode.INTERNAL_SERVER_ERROR // Use a generic 429 later
                ));
            }

            // Increment and set expiry if it's the first attempt
            if (attempts === 0) {
                await redis.set(key, '1', 'EX', options.windowInMinutes * 60);
            } else {
                await redis.incr(key);
            }

            next();
        } catch (error) {
            // If Redis fails, we allow the request but log it (don't block the user due to infra issues)
            console.error('[RateLimiter] Redis error:', error);
            next();
        }
    };
};
