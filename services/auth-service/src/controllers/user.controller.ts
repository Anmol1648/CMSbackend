import { Request, Response } from 'express';
import * as userService from '../services/user.service';
import { asyncHandler, successResponse, StorageFactory } from '@shared/core';

export const getProfile = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const profile = await userService.getProfile(userId);
    return successResponse(res, profile, 'Profile retrieved successfully');
});

export const updateProfile = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const profile = await userService.updateProfile(userId, req.body);
    return successResponse(res, profile, 'Profile updated successfully');
});

export const updateAvatar = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    
    if (!req.file) {
        throw new Error('No file uploaded');
    }

    const storage = StorageFactory.getProvider('cloudinary');
    const uploadResult = await storage.upload(req.file.buffer, {
        folder: 'avatars',
        publicId: `avatar_${userId}`
    });

    const profile = await userService.updateProfile(userId, {
        avatar_url: uploadResult.url
    });

    return successResponse(res, profile, 'Avatar updated successfully');
});

export const changePassword = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const { oldPassword, newPassword } = req.body;
    
    await userService.changePassword(userId, oldPassword, newPassword);
    return successResponse(res, null, 'Password changed successfully');
});


