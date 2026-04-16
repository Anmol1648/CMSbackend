import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '../utils/errors';
import { ErrorCode } from '@shared/core';


export const validate = (schema: z.ZodObject<any>) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            await schema.parseAsync({
                body: req.body, 
                query: req.query,
                params: req.params,
            });
            return next();
        } catch (error) {
            if (error instanceof z.ZodError) {
                return next(new AppError(
                    "Validation failed",
                    400,
                    ErrorCode.VALIDATION_ERROR
                ));
            }
            return next(error);
        }
    };
};

export const loginSchema = z.object({
    body: z.object({
        email: z.string().email("Invalid email format").min(1, "Email is required"),
        password: z.string().min(1, "Password is required"),
    }),
});

export const refreshSchema = z.object({
    body: z.object({
        refreshToken: z.string().min(1, "Refresh token is required"),
    }),
});

export const changePasswordSchema = z.object({
    body: z.object({
        oldPassword: z.string().min(1, "Current password is required"),
        newPassword: z.string().min(6, "New password must be at least 6 characters"),
    }),
});

