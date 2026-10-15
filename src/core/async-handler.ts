import { Request, Response, NextFunction } from 'express';

/**
 * For Express Controllers/Middleware
 * Automatically catches errors and passes them to next()
 */
export const asyncHandler = (fn: Function) => {
    return (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};

/**
 * For Service Functions (Business Logic)
 * Ensures consistent execution and error propagation for non-Express functions
 */
export const serviceHandler = (fn: Function) => {
    return async (...args: any[]) => {
        try {
            return await fn(...args);
        } catch (error) {
            // Re-throw to be caught by the calling controller's asyncHandler
            throw error;
        }
    };
};
    