import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError, validationError } from './errors';
import { ErrorCode } from './auth.types';
import { errorResponse } from './response';
import { getRequestId } from './context';
import { logger } from './logger';

/** Maps well-known library errors (body parser, multer, zod) to AppErrors. */
const normalise = (err: any): AppError | null => {
    if (err instanceof AppError) return err;
    if (err instanceof z.ZodError) return validationError(err);
    if (err?.type === 'entity.parse.failed') return new AppError('Request body is not valid JSON', 400, ErrorCode.VALIDATION_ERROR);
    if (err?.type === 'entity.too.large') return new AppError('Request body is too large', 413, ErrorCode.PAYLOAD_TOO_LARGE);
    if (err?.name === 'MulterError') {
        return err.code === 'LIMIT_FILE_SIZE'
            ? new AppError('File is too large', 413, ErrorCode.PAYLOAD_TOO_LARGE)
            : new AppError(err.message, 400, ErrorCode.VALIDATION_ERROR);
    }
    return null;
};

export const globalErrorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
    const requestId = getRequestId();
    const known = normalise(err);

    if (known) {
        // Expected (4xx) errors: one line; unexpected ones keep the stack.
        if (known.isOperational && known.statusCode < 500) {
            logger.warn(`${req.method} ${req.originalUrl} -> ${known.statusCode} ${known.message}`);
        } else {
            logger.error(`${req.method} ${req.originalUrl} failed`, { error: err });
        }
        return errorResponse(res, known.message, known.errorCode, known.statusCode, known.details, requestId);
    }

    logger.error(`${req.method} ${req.originalUrl} failed`, { error: err instanceof Error ? err : new Error(String(err)) });
    // Never expose internal messages; the request id links the response to the log line.
    return errorResponse(res, 'Something went wrong. Please try again.', ErrorCode.INTERNAL_SERVER_ERROR, 500, undefined, requestId);
};
