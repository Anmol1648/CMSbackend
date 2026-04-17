import { db } from '../models/prisma';
import { hashPassword, comparePassword } from '../utils/password.util';
import { generateAccessToken, generateRefreshToken, generateMfaChallengeToken, verifyToken } from '../config/jwt.config';
import * as mfaService from './mfa.service';
import { sendPasswordResetEmail } from './notification/email.service';
import { AppError } from '../utils/errors';
import { ErrorCode } from '@shared/core';
import { serviceHandler } from '@shared/core';
import bcrypt from 'bcrypt';
import * as redis from '../config/redis.config';
import { decryptSecret } from '../utils/encryption.util';



export const login = serviceHandler(async (email: string, password: string) => {
    const user = await db.user.findUnique({
        where: { email }
    });

    if (!user) {
        // Log failed login attempt (user not found)
        await db.auditLog.create({
            data: {
                table_name: 'Auth',
                record_id: 'unknown',
                operation: 'LOGIN_FAILED',
                user_id: 'system',
                new_values: { email, reason: 'User not found' }
            }
        });
        throw new AppError('Invalid credentials', 401, ErrorCode.AUTH_INVALID_CREDENTIALS);
    }

    if (!user.is_active) {
        // Log failed login attempt (disabled account)
        await db.auditLog.create({
            data: {
                table_name: 'User',
                record_id: user.id,
                operation: 'LOGIN_FAILED',
                user_id: user.id,
                new_values: { email, reason: 'Account disabled' }
            }
        });
        throw new AppError('Account is disabled', 403, ErrorCode.AUTH_USER_DISABLED);
    }

    const isPasswordValid = await comparePassword(password, user.password_hash);

    if (!isPasswordValid) {
        // Log failed login attempt (wrong password)
        await db.auditLog.create({
            data: {
                table_name: 'User',
                record_id: user.id,
                operation: 'LOGIN_FAILED',
                user_id: user.id,
                new_values: { email, reason: 'Invalid password' }
            }
        });
        throw new AppError('Invalid credentials', 401, ErrorCode.AUTH_INVALID_CREDENTIALS);
    }


    if (user.mfa_enabled) {
        const mfaToken = generateMfaChallengeToken(user.id);
        return {
            status: 'mfa_required',
            mfaToken
        };
    }

    const payload = {
        userId: user.id,
        email: user.email,
        tenantId: user.tenant_id
    };

    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    // Store refresh token in database (7 days expiry)
    await db.$transaction([
        db.refreshToken.create({
            data: {
                token: refreshToken,
                user_id: user.id,
                expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            }
        }),
        // Log successful login
        db.auditLog.create({
            data: {
                table_name: 'User',
                record_id: user.id,
                operation: 'LOGIN_SUCCESS',
                user_id: user.id,
                new_values: { email: user.email }
            }
        })
    ]);

    return {
        user: {
            id: user.id,
            email: user.email,
            tenantId: user.tenant_id
        },
        accessToken,
        refreshToken
    };
});


export const verifyMfaLogin = serviceHandler(async (mfaToken: string, otpToken: string) => {
    // 1. Verify mfaToken
    const decoded = verifyToken(mfaToken);
    if (!decoded || !decoded.mfa_pending) {
        throw new AppError('Invalid or expired MFA token', 401, ErrorCode.AUTH_INVALID_TOKEN);
    }

    // 2. Get user and their secret
    const user = await db.user.findUnique({
        where: { id: decoded.userId }
    });

    if (!user || !user.mfa_enabled || !user.mfa_secret) {
        throw new AppError('MFA not enabled or setup incomplete', 400, ErrorCode.AUTH_MFA_REQUIRED);
    }

    // Decrypt the secret before verification
    const decryptedSecret = decryptSecret(user.mfa_secret);

    // 3. Verify OTP code
    const isValid = await mfaService.verifyMfaToken(otpToken, decryptedSecret);
    if (!isValid) {
        // Log failed MFA verification
        await db.auditLog.create({
            data: {
                table_name: 'User',
                record_id: user.id,
                operation: 'MFA_VERIFY_FAILED',
                user_id: user.id,
                new_values: { email: user.email }
            }
        });
        throw new AppError('Invalid MFA code', 401, ErrorCode.AUTH_INVALID_CREDENTIALS);
    }



    // 4. Issue real tokens
    const payload = {
        userId: user.id,
        email: user.email,
        tenantId: user.tenant_id
    };

    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    await db.$transaction([
        db.refreshToken.create({
            data: {
                token: refreshToken,
                user_id: user.id,
                expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            }
        }),
        // Log successful MFA verification
        db.auditLog.create({
            data: {
                table_name: 'User',
                record_id: user.id,
                operation: 'MFA_VERIFY_SUCCESS',
                user_id: user.id,
                new_values: { email: user.email }
            }
        })
    ]);


    return {
        user: {
            id: user.id,
            email: user.email,
            tenantId: user.tenant_id
        },
        accessToken,
        refreshToken
    };
});

export const refresh = serviceHandler(async (oldRefreshToken: string) => {
    // 1. Verify token signature and expiry
    const decoded = verifyToken(oldRefreshToken);
    if (!decoded) {
        throw new AppError('Invalid or expired refresh token', 401, ErrorCode.AUTH_TOKEN_EXPIRED);
    }

    // 2. Check token in database
    const tokenDoc = await db.refreshToken.findUnique({
        where: { token: oldRefreshToken }
    });

    if (!tokenDoc || tokenDoc.revoked || tokenDoc.expires_at < new Date()) {
        throw new AppError('Invalid or expired refresh token', 401, ErrorCode.AUTH_INVALID_TOKEN);
    }

    // 3. Get user
    const user = await db.user.findUnique({
        where: { id: tokenDoc.user_id }
    });

    if (!user || !user.is_active) {
        throw new AppError('User not found or disabled', 403, ErrorCode.AUTH_USER_DISABLED);
    }

    // 4. Generate new tokens (Token rotation)
    const payload = {
        userId: user.id,
        email: user.email,
        tenantId: user.tenant_id
    };

    const newAccessToken = generateAccessToken(payload);
    const newRefreshToken = generateRefreshToken(payload);

    // 5. Revoke old token and save new one
    await db.$transaction([
        db.refreshToken.delete({ where: { token: oldRefreshToken } }),
        db.refreshToken.create({
            data: {
                token: newRefreshToken,
                user_id: user.id,
                expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            }
        })
    ]);

    return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken
    };
});

export const forgotPassword = serviceHandler(async (email: string) => {
    const user = await db.user.findUnique({ where: { email } });

    // Always return success message even if user doesn't exist for security
    if (!user || !user.is_active) {
        return { message: "If the email exists, OTP has been sent" };
    }

    // 1. Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = await bcrypt.hash(otp, 10);

    // 2. Store in DB with 15 min expiry
    await db.$transaction([
        db.passwordResetToken.create({
            data: {
                user_id: user.id,
                otp_hash: otpHash,
                expires_at: new Date(Date.now() + 15 * 60 * 1000)
            }
        }),
        // Log password reset request
        db.auditLog.create({
            data: {
                table_name: 'User',
                record_id: user.id,
                operation: 'PASSWORD_RESET_REQUESTED',
                user_id: user.id,
                new_values: { email }
            }
        })
    ]);

    // 3. Send Email

    await sendPasswordResetEmail(email, otp);

    return { message: "If the email exists, OTP has been sent" };
});

export const resetPassword = serviceHandler(async (email: string, otp: string, newPassword: string) => {
    const user = await db.user.findUnique({ where: { email } });

    // Use a generic error helper to prevent enumeration
    const throwGenericError = (): never => {
        throw new AppError('Invalid request or expired OTP', 400, ErrorCode.AUTH_INVALID_TOKEN);
    };

    if (!user) {
        throwGenericError();
    }

    // 1. Find latest valid token
    const tokenRecord = await db.passwordResetToken.findFirst({
        where: {
            user_id: user!.id,
            used: false,
            expires_at: { gt: new Date() }
        },
        orderBy: { createdAt: 'desc' }
    });

    if (!tokenRecord) {
        throwGenericError();
    }

    // 2. Verify OTP
    const isValid = await bcrypt.compare(otp, tokenRecord!.otp_hash);
    if (!isValid) {
        throwGenericError();
    }


    // 3. Update Password
    const passwordHash = await hashPassword(newPassword);

    await db.$transaction([
        // Update user password
        db.user.update({
            where: { id: user!.id },
            data: { password_hash: passwordHash }
        }),
        // Mark token as used
        db.passwordResetToken.update({
            where: { id: tokenRecord!.id },
            data: { used: true }
        }),
        // Invalidate all refresh tokens for this user
        db.refreshToken.deleteMany({
            where: { user_id: user!.id }
        }),
        // Log successful password reset
        db.auditLog.create({
            data: {
                table_name: 'User',
                record_id: user!.id,
                operation: 'PASSWORD_RESET_SUCCESS',
                user_id: user!.id,
                new_values: { email }
            }
        })

    ]);





    return { message: "Password reset successful" };
});

export const logout = serviceHandler(async (refreshToken: string, jti: string, exp: number) => {
    // 1. Delete refresh token from DB
    const tokenRecord = await db.refreshToken.findUnique({
        where: { token: refreshToken }
    });

    if (tokenRecord) {
        await db.$transaction([
            db.refreshToken.deleteMany({
                where: { token: refreshToken }
            }),
            db.auditLog.create({
                data: {
                    table_name: 'User',
                    record_id: tokenRecord.user_id,
                    operation: 'LOGOUT',
                    user_id: tokenRecord.user_id
                }
            })
        ]);
    } else {
        await db.refreshToken.deleteMany({
            where: { token: refreshToken }
        });
    }

    // 2. Blacklist access token in Redis

    const now = Math.floor(Date.now() / 1000);
    const expirySeconds = exp - now;

    if (expirySeconds > 0) {
        await redis.blacklistToken(jti, expirySeconds);
    }

    return { message: "Logout successful" };
});

export const logoutAll = serviceHandler(async (userId: string) => {
    // 1. Delete all refresh tokens for this user
    await db.$transaction([
        db.refreshToken.deleteMany({
            where: { user_id: userId }
        }),
        db.auditLog.create({
            data: {
                table_name: 'User',
                record_id: userId,
                operation: 'LOGOUT_ALL',
                user_id: userId
            }
        })
    ]);


    // 2. Set "Revoke Before" timestamp in Redis (Global Revocation)
    // We set it to expire in 15 minutes (max access token lifespan)
    const now = Math.floor(Date.now() / 1000);
    await redis.redis.set(`user:revoke_before:${userId}`, now.toString(), 'EX', 15 * 60);

    return { message: "Successfully logged out from all devices" };
});




