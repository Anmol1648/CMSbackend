import { Request, Response, NextFunction } from 'express';
import { runWithUser } from '@shared/core';

export const contextMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const userId = req.headers['x-user-id'] as string;
    const email = req.headers['x-user-email'] as string;
    const tenantId = req.headers['x-tenant-id'] as string;

    if (userId) {
        return runWithUser({ id: userId, email, tenantId }, next);
    }

    // Optional: for actions where user context might be missing (like initial login)
    // we can still run with empty or system context
    return next();
};
