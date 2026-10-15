import { z } from 'zod';
import { ErrorCode } from './auth.types';

/** One field-level problem, shown under the matching form input. */
export interface FieldIssue {
    field: string;
    message: string;
}

export class AppError extends Error {
    public readonly statusCode: number;
    public readonly errorCode: ErrorCode;
    public readonly isOperational: boolean;
    public readonly details?: FieldIssue[];

    constructor(message: string, statusCode: number, errorCode: ErrorCode, isOperational = true, details?: FieldIssue[]) {
        super(message);
        this.statusCode = statusCode;
        this.errorCode = errorCode;
        this.isOperational = isOperational;
        this.details = details;
        Error.captureStackTrace(this, this.constructor);
    }
}

export const badRequest = (message: string, details?: FieldIssue[]) =>
    new AppError(message, 400, ErrorCode.VALIDATION_ERROR, true, details);
export const unauthorized = (message = 'Authentication required') => new AppError(message, 401, ErrorCode.UNAUTHORIZED);
export const forbidden = (message = 'You do not have permission to do this') => new AppError(message, 403, ErrorCode.FORBIDDEN);
export const notFound = (message = 'Not found') => new AppError(message, 404, ErrorCode.NOT_FOUND);
export const conflict = (message: string) => new AppError(message, 409, ErrorCode.CONFLICT);

/** Converts zod issues into field issues; `prefix` paths (body/query/params) are dropped. */
export const zodIssues = (error: z.ZodError, dropFirst = false): FieldIssue[] =>
    error.issues.map((issue) => {
        const path = dropFirst ? issue.path.slice(1) : issue.path;
        return { field: path.join('.') || '(root)', message: issue.message };
    });

/** "Validation failed" with the list of bad fields. */
export const validationError = (error: z.ZodError, dropFirst = false) => {
    const details = zodIssues(error, dropFirst);
    const first = details[0];
    const message = details.length === 1 && first ? `${first.field}: ${first.message}` : 'Some fields are invalid';
    return badRequest(message, details);
};
