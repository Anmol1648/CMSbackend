export interface AccessTokenPayload {
    userId: string;
    email: string;
    tenantId: string;
}

export interface JwtPayload {
    userId: string;
    email: string;
    tenantId: string;
}

// Standard Error Codes for the whole system
export enum ErrorCode {
    UNAUTHORIZED = 'UNAUTHORIZED',
    FORBIDDEN = 'FORBIDDEN',
    NOT_FOUND = 'NOT_FOUND',
    VALIDATION_ERROR = 'VALIDATION_ERROR',
    INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
    BAD_GATEWAY = 'BAD_GATEWAY',
    AUTH_USER_NOT_FOUND = 'AUTH_USER_NOT_FOUND',
    AUTH_USER_DISABLED = 'AUTH_USER_DISABLED',
    AUTH_INVALID_CREDENTIALS = 'AUTH_INVALID_CREDENTIALS',
    AUTH_TOKEN_EXPIRED = 'AUTH_TOKEN_EXPIRED',
    AUTH_INVALID_TOKEN = 'AUTH_INVALID_TOKEN',
}
