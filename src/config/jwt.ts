import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { JwtPayload } from '../core/index';
import { logger } from '../core/logger';

import './env';

const rawKey = process.env.JWT_PRIVATE_KEY || '';
const PRIVATE_KEY = Buffer.from(
    rawKey
        .replace(/\\n/g, '\n')
        .replace(/\r/g, '')
        .replace(/"/g, '')
        .trim(),
    'utf-8'
);

if (PRIVATE_KEY.length === 0) {
    logger.error('JWT_PRIVATE_KEY is empty: tokens cannot be issued');
}

// Public half of the signing key, used to verify access tokens.
const PUBLIC_KEY = PRIVATE_KEY.length > 0 ? crypto.createPublicKey(PRIVATE_KEY) : null;

// Marks access tokens so refresh / MFA-challenge tokens (same key) can't be used to call the API.
const ACCESS_TOKEN_USE = 'access';

export const generateAccessToken = (payload: JwtPayload): string => {
    try {
        return jwt.sign({ ...payload, token_use: ACCESS_TOKEN_USE }, PRIVATE_KEY, {
            algorithm: 'RS256',
            expiresIn: '15m',
            jwtid: uuidv4()
        });
    } catch (error: any) {
        logger.error('Access token generation failed', { error: error.message });
        throw error;
    }
};

export const generateRefreshToken = (payload: JwtPayload): string => {
    try {
        return jwt.sign(payload, PRIVATE_KEY, {
            algorithm: 'RS256',
            expiresIn: '7d',
            jwtid: uuidv4()
        });
    } catch (error: any) {
        logger.error('Refresh token generation failed', { error: error.message });
        throw error;
    }
};

export const generateMfaChallengeToken = (userId: string): string => {
    try {
        return jwt.sign({ userId, mfa_pending: true }, PRIVATE_KEY, {
            algorithm: 'RS256',
            expiresIn: '5m',
            jwtid: uuidv4()
        });
    } catch (error: any) {
        logger.error('MFA challenge token generation failed', { error: error.message });
        throw error;
    }
};

/** Verifies an access token; throws if it is invalid, expired or not an access token. */
export const verifyAccessToken = (token: string): JwtPayload => {
    if (!PUBLIC_KEY) throw new Error('JWT signing key not configured');
    const payload = jwt.verify(token, PUBLIC_KEY, { algorithms: ['RS256'] }) as JwtPayload & { token_use?: string };
    if (payload.token_use !== ACCESS_TOKEN_USE) throw new Error('Not an access token');
    return payload;
};

export const verifyToken = (token: string): any => {
    try {
        return jwt.verify(token, PRIVATE_KEY, { algorithms: ['RS256'] });
    } catch (error) {
        return null;
    }
};

