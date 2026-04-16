import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { JwtPayload } from '@shared/core';

dotenv.config();

const rawKey = process.env.JWT_PRIVATE_KEY || '';
const PRIVATE_KEY = Buffer.from(
    rawKey
        .replace(/\\n/g, '\n')
        .replace(/\r/g, '')
        .replace(/"/g, '')
        .trim(),
    'utf-8'
);

if (PRIVATE_KEY.length > 0) {
    console.log('[JWT-OK] Private key loaded. Starts with:', PRIVATE_KEY.slice(0, 20).toString());
} else {
    console.error('[JWT-ERROR] Private key is EMPTY.');
}

export const generateAccessToken = (payload: JwtPayload): string => {
    try {
        return jwt.sign(payload, PRIVATE_KEY, {
            algorithm: 'RS256',
            expiresIn: '15m'
        });
    } catch (error: any) {
        console.error('[JWT Error] Access token generation failed:', error.message);
        throw error;
    }
};

export const generateRefreshToken = (payload: JwtPayload): string => {
    try {
        return jwt.sign(payload, PRIVATE_KEY, {
            algorithm: 'RS256',
            expiresIn: '7d'
        });
    } catch (error: any) {
        console.error('[JWT Error] Refresh token generation failed:', error.message);
        throw error;
    }
};

export const verifyToken = (token: string): any => {
    try {
        return jwt.verify(token, PRIVATE_KEY, { algorithms: ['RS256'] });
    } catch (error) {
        return null;
    }
};

