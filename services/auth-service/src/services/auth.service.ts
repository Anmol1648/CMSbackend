import { db } from '../models/prisma';
import { comparePassword } from '../utils/password.util';
import { generateAccessToken, generateRefreshToken, verifyToken } from '../config/jwt.config';
import { AppError } from '../utils/errors';
import { ErrorCode } from '@shared/core';
import { serviceHandler } from '@shared/core';

export const login = serviceHandler(async (email: string, password: string) => {
    const user = await db.user.findUnique({
        where: { email }
    });

    if (!user) {
        throw new AppError('User not found', 404, ErrorCode.AUTH_USER_NOT_FOUND);
    }

    if (!user.is_active) {
        throw new AppError('Account is disabled', 403, ErrorCode.AUTH_USER_DISABLED);
    }

    const isPasswordValid = await comparePassword(password, user.password_hash);

    if (!isPasswordValid) {
        throw new AppError('Invalid credentials', 401, ErrorCode.AUTH_INVALID_CREDENTIALS);
    }

    const payload = {
        userId: user.id,
        email: user.email,
        tenantId: user.tenant_id
    };

    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    // Store refresh token in database (7 days expiry)
    await db.refreshToken.create({
        data: {
            token: refreshToken,
            user_id: user.id,
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        }
    });

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

