import { Request, Response, NextFunction } from 'express';

/**
 * For Express Controllers/Middleware
 * Automatically catches errors and passes them to next()
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

export const asyncHandler = (fn: AnyFn) => {
    return (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};

/** Kept for existing services; errors simply propagate to the controller's asyncHandler. */
export const serviceHandler = <T extends AnyFn>(fn: T): T => fn;
    