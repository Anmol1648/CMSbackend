import { db } from '../models/prisma';
import { AppError } from '../utils/errors';
import { ErrorCode, serviceHandler } from '@shared/core';
import { comparePassword, hashPassword } from '../utils/password.util';

export const getProfile = serviceHandler(async (userId: string) => {
    const profile = await db.userProfile.findUnique({
        where: { user_id: userId },
        include: {
            user: {
                select: {
                    email: true,
                    first_name: true,
                    last_name: true,
                    is_active: true,
                }
            }
        }
    });

    if (!profile) {
        throw new AppError('Profile not found', 404, ErrorCode.NOT_FOUND);
    }

    return profile;
});

export const updateProfile = serviceHandler(async (userId: string, data: any) => {
    // Separate user fields from profile fields
    const { first_name, last_name, ...profileData } = data;

    // Convert string dates to Date objects for Prisma
    if (profileData.date_of_birth === "" || profileData.date_of_birth === null) {
        profileData.date_of_birth = null;
    } else if (profileData.date_of_birth) {
        profileData.date_of_birth = new Date(profileData.date_of_birth);
    }

    // Use transaction to update both if needed
    const result = await db.$transaction(async (tx) => {
        // Update User if names are provided
        if (first_name || last_name) {
            await tx.user.update({
                where: { id: userId },
                data: {
                    first_name,
                    last_name
                }
            });
        }

        // Update or Create profile
        return await tx.userProfile.upsert({
            where: { user_id: userId },
            create: {
                ...profileData,
                user_id: userId
            },
            update: profileData
        });
    });

    return result;
});

export const changePassword = serviceHandler(async (userId: string, oldPassword: string, newPassword: string) => {
    const user = await db.user.findUnique({
        where: { id: userId }
    });

    if (!user) {
        throw new AppError('User not found', 404, ErrorCode.AUTH_USER_NOT_FOUND);
    }

    const isOldValid = await comparePassword(oldPassword, user.password_hash);


    if (!isOldValid) {
        throw new AppError('Invalid current password', 401, ErrorCode.AUTH_INVALID_CREDENTIALS);
    }

    const newHash = await hashPassword(newPassword);

    await db.user.update({
        where: { id: userId },
        data: { password_hash: newHash }
    });

    return { message: 'Password changed successfully' };
});

