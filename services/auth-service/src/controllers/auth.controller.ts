import { Request, Response } from 'express';
import * as authService from '../services/auth.service';
import { asyncHandler } from '@shared/core';

export const login = asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body;
    const response = await authService.login(email, password);
    return res.status(200).json(response);
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
    const { refreshToken } = req.body;
    const response = await authService.refresh(refreshToken);
    return res.status(200).json(response);
});

