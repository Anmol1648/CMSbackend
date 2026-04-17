import { Request, Response } from 'express';
import * as authService from '../services/auth.service';
import { asyncHandler, successResponse } from '@shared/core';

export const login = asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body;
    const response = await authService.login(email, password);
    return successResponse(res, response, 'Login successful');
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
    const { refreshToken } = req.body;
    const response = await authService.refresh(refreshToken);
    return successResponse(res, response, 'Token refreshed');
});

export const verifyMfa = asyncHandler(async (req: Request, res: Response) => {
    const { mfaToken, otpToken } = req.body;
    const response = await authService.verifyMfaLogin(mfaToken, otpToken);
    return successResponse(res, response, 'MFA Verification successful');
});

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
    const { email } = req.body;
    const response = await authService.forgotPassword(email);
    return successResponse(res, response, response.message);
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
    const { email, otp, newPassword } = req.body;
    const response = await authService.resetPassword(email, otp, newPassword);
    return successResponse(res, response, response.message);
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
    const { refreshToken } = req.body;
    const authHeader = req.headers['authorization'];
    const accessToken = authHeader?.split(' ')[1];

    if (!accessToken) {
        return successResponse(res, {}, 'Logged out (no token provided)');
    }

    // Decode token to get jti and exp
    const jwt = require('jsonwebtoken');
    const decoded = jwt.decode(accessToken) as any;

    const response = await authService.logout(
        refreshToken, 
        decoded?.jti || '', 
        decoded?.exp || 0
    );

    return successResponse(res, response, 'Logout successful');
});

export const logoutAll = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const response = await authService.logoutAll(userId);
    return successResponse(res, response, 'Successfully logged out from all devices');
});



