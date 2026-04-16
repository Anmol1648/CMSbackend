import { Request, Response, NextFunction } from 'express';
import { AppError } from './errors';
import { ErrorCode } from '@shared/core';
import { errorResponse } from '@shared/core';

export const globalErrorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
    console.error(`[Gateway Error] ${new Date().toISOString()} ${req.method} ${req.path}:`, err.message);

    if (err instanceof AppError) {
        return errorResponse(res, err.message, err.errorCode, err.statusCode);
    }

    return errorResponse(
        res, 
        'Internal Server Error', 
        ErrorCode.INTERNAL_SERVER_ERROR, 
        500,
        process.env.NODE_ENV === 'development' ? err.message : undefined
    );
};

