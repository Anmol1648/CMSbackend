import { ErrorCode } from '@shared/core';

export class AppError extends Error {
    public readonly statusCode: number;
    public readonly errorCode: ErrorCode;
    public readonly isOperational: boolean;

    constructor(message: string, statusCode: number, errorCode: ErrorCode, isOperational = true) {
        super(message);
        this.statusCode = statusCode;
        this.errorCode = errorCode;
        this.isOperational = isOperational;
        Error.captureStackTrace(this, this.constructor);
    }
}
