import { db } from '../models/prisma';
import { AppError } from '../utils/errors';
import { ErrorCode, serviceHandler } from '@shared/core';

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
