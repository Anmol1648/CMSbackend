import { Request, Response, NextFunction } from 'express';
import { cache } from '../core/cache';
import { AppError } from '../core/errors';
import { ErrorCode } from '../core/index';
import { logger } from '../core/logger';

interface RateLimitOptions {
    windowInMinutes: number;
    maxAttempts: number;
    keyPrefix: string;
}

/**
 * Counts requests per client IP in a fixed window (cache store: Redis or in-memory).
 * Used on sensitive endpoints (login, MFA, password reset).
 */
export const createRateLimiter = (options: RateLimitOptions) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        const key = `ratelimit:${options.keyPrefix}:${req.ip || 'unknown'}`;

        try {
            const attempts = await cache.incr(key, options.windowInMinutes * 60);
            if (attempts > options.maxAttempts) {
                return next(new AppError(
                    `Too many attempts. Please try again in ${options.windowInMinutes} minutes.`,
                    429,
                    ErrorCode.TOO_MANY_REQUESTS
                ));
            }
            next();
        } catch (error) {
            // Don't lock users out because the cache is down; log it instead.
            logger.error('Rate limiter cache error', { error: (error as Error).message });
            next();
        }
    };
};
