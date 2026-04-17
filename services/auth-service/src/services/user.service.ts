import { db } from '../models/prisma';
import { AppError } from '../utils/errors';
import { ErrorCode, serviceHandler } from '@shared/core';
import { comparePassword, hashPassword } from '../utils/password.util';
import * as mfaService from './mfa.service';
import { encryptSecret, decryptSecret } from '../utils/encryption.util';


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
                    mfa_enabled: true,
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

    await db.$transaction([
        db.user.update({
            where: { id: userId },
            data: { password_hash: newHash }
        }),
        db.auditLog.create({
            data: {
                table_name: 'User',
                record_id: userId,
                operation: 'PASSWORD_CHANGED',
                user_id: userId
            }
        })
    ]);

    return { message: 'Password changed successfully' };
});


export const enableMfaSetup = serviceHandler(async (userId: string) => {
    const user = await db.user.findUnique({
        where: { id: userId }
    });


    if (!user) {
        throw new AppError('User not found', 404, ErrorCode.AUTH_USER_NOT_FOUND);
    }

    const setup = await mfaService.generateMfaSetup(user.email);
    
    // Encrypt the secret before storing in DB
    const encryptedSecret = encryptSecret(setup.secret);

    await db.$transaction([
        db.user.update({
            where: { id: userId },
            data: { mfa_secret: encryptedSecret }
        }),
        db.auditLog.create({
            data: {
                table_name: 'User',
                record_id: userId,
                operation: 'MFA_SETUP_INITIATED',
                user_id: userId
            }
        })
    ]);


    return {
        qrCode: setup.otpauth,
        secret: setup.secret
    };
});

export const verifyAndEnableMfa = serviceHandler(async (userId: string, token: string) => {
    const user = await db.user.findUnique({
        where: { id: userId }
    });

    if (!user || !user.mfa_secret) {
        throw new AppError('MFA setup not initiated', 400, ErrorCode.AUTH_MFA_REQUIRED);
    }
    
    // Decrypt the secret before verification
    const decryptedSecret = decryptSecret(user.mfa_secret);

    const isValid = await mfaService.verifyMfaToken(token, decryptedSecret);
    if (!isValid) {
        throw new AppError('Invalid verification code', 400, ErrorCode.AUTH_INVALID_CREDENTIALS);
    }


    await db.$transaction([
        db.user.update({
            where: { id: userId },
            data: { mfa_enabled: true }
        }),
        db.auditLog.create({
            data: {
                table_name: 'User',
                record_id: userId,
                operation: 'MFA_ENABLED',
                user_id: userId
            }
        })
    ]);


    return { message: 'MFA enabled successfully' };
});

export const disableMfa = serviceHandler(async (userId: string, password: string, token: string) => {
    const user = await db.user.findUnique({
        where: { id: userId }
    });

    if (!user) {
        throw new AppError('User not found', 404, ErrorCode.AUTH_USER_NOT_FOUND);
    }

    if (!user.mfa_enabled) {
        throw new AppError('MFA is not enabled', 400, ErrorCode.INTERNAL_SERVER_ERROR);
    }

    // 1. Verify Password
    const isPasswordValid = await comparePassword(password, user.password_hash);
    if (!isPasswordValid) {
        throw new AppError('Invalid password', 401, ErrorCode.AUTH_INVALID_CREDENTIALS);
    }

    // 2. Verify TOTP Token
    if (!user.mfa_secret) {
        throw new AppError('MFA secret not found', 400, ErrorCode.INTERNAL_SERVER_ERROR);
    }

    const decryptedSecret = decryptSecret(user.mfa_secret);
    const isTokenValid = await mfaService.verifyMfaToken(token, decryptedSecret);
    
    if (!isTokenValid) {
        throw new AppError('Invalid MFA code', 401, ErrorCode.AUTH_INVALID_CREDENTIALS);
    }

    // 3. Disable MFA and clear secret
    await db.$transaction([
        db.user.update({
            where: { id: userId },
            data: { 
                mfa_enabled: false,
                mfa_secret: null 
            }
        }),
        db.auditLog.create({
            data: {
                table_name: 'User',
                record_id: userId,
                operation: 'MFA_DISABLED',
                user_id: userId
            }
        })
    ]);


    return { message: 'MFA disabled successfully' };
});


