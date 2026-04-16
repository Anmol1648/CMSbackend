import { Request, Response, NextFunction } from 'express';
import { getCurrentUser, ErrorCode } from '@shared/core';
import { AppError } from '../utils/errors';

export const protect = (req: Request, res: Response, next: NextFunction) => {
    const user = getCurrentUser();
    if (!user) {
        return next(new AppError('Unauthorized - Authentication required', 401, ErrorCode.UNAUTHORIZED));
    }
    
    // Attach user to req for convenience in controllers (though getCurrentUser() also works)
    (req as any).user = { userId: user.id, email: user.email, tenantId: user.tenantId };
    
    next();
};
