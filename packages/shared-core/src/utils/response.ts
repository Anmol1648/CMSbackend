export interface ApiResponse<T = any> {
    status: 'success' | 'error';
    data?: T;
    message?: string;
    error?: {
        code: string;
        message: string;
        details?: any;
    };
    timestamp: string;
}

export const successResponse = <T>(res: any, data: T, message = 'Operation successful', statusCode = 200) => {
    const response: ApiResponse<T> = {
        status: 'success',
        data,
        message,
        timestamp: new Date().toISOString()
    };
    return res.status(statusCode).json(response);
};

export const errorResponse = (res: any, message: string, code: string, statusCode = 500, details?: any) => {
    const response: ApiResponse = {
        status: 'error',
        error: {
            code,
            message,
            details
        },
        timestamp: new Date().toISOString()
    };
    return res.status(statusCode).json(response);
};
