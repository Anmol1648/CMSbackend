import { Request, Response, NextFunction } from 'express';
import { AppError } from './errors';
import { ErrorCode } from './auth.types';
import { errorResponse } from './response';

export const globalErrorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
    const where = `${new Date().toISOString()} ${req.method} ${req.path}`;

    if (err instanceof AppError) {
        // Expected (4xx) errors: one line; unexpected ones keep the stack.
        if (err.isOperational && err.statusCode < 500) console.warn(`[API] ${where} -> ${err.statusCode} ${err.message}`);
        else console.error(`[API Error] ${where}:`, err);
        return errorResponse(res, err.message, err.errorCode, err.statusCode);
    }

    console.error(`[API Error] ${where}:`, err);

    // Default error
    return errorResponse(
        res, 
        'Internal Server Error', 
        ErrorCode.INTERNAL_SERVER_ERROR, 
        500,
        process.env.NODE_ENV === 'development' ? err.message : undefined
    );
};

