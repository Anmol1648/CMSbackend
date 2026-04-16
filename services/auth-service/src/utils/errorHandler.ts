import { Request, Response, NextFunction } from 'express';
import { AppError, ErrorCode } from './errors';

export const globalErrorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
    console.error(`[Error] ${new Date().toISOString()}:`, err);

    if (err instanceof AppError) {
        return res.status(err.statusCode).json({
            status: 'error',
            code: err.errorCode,
            message: err.message
        });
    }

    // Default error
    return res.status(500).json({
        status: 'error',
        code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Something went incredibly wrong'
    });
};
