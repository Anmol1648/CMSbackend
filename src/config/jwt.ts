import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../core/auth.types';
import { logger } from '../core/logger';
import './env';

/**
 * Signed tokens (RS256). Two kinds, told apart by `token_use` so one can never stand in for the other:
 *   - access:        15-minute (setting) API token: user, school, session, password-change flag
 *   - mfa_challenge: 5-minute token between "password OK" and "MFA code OK"
 * Refresh tokens are not JWTs: they are random values stored only as hashes (user_sessions).
 */

const rawKey = process.env.JWT_PRIVATE_KEY || '';
const PRIVATE_KEY = Buffer.from(rawKey.replace(/\\n/g, '\n').replace(/\r/g, '').replace(/"/g, '').trim(), 'utf-8');

if (PRIVATE_KEY.length === 0) {
    logger.error('JWT_PRIVATE_KEY is empty: tokens cannot be issued');
}

const PUBLIC_KEY = PRIVATE_KEY.length > 0 ? crypto.createPublicKey(PRIVATE_KEY) : null;

type TokenUse = 'access' | 'mfa_challenge' | 'platform' | 'platform_mfa';

interface Claims {
    token_use: TokenUse;
    uid: string;
    tid: string;
    sid?: string;
    pwd?: boolean;
    /** mfa_challenge only: the user ticked "keep me signed in". */
    rm?: boolean;
}

const sign = (claims: Claims, expiresInSeconds: number) =>
    jwt.sign(claims, PRIVATE_KEY, { algorithm: 'RS256', expiresIn: expiresInSeconds, jwtid: crypto.randomUUID() });

const verify = (token: string, use: TokenUse): Claims & { jti?: string; iat?: number; exp?: number } => {
    if (!PUBLIC_KEY) throw new Error('JWT signing key not configured');
    const payload = jwt.verify(token, PUBLIC_KEY, { algorithms: ['RS256'] }) as Claims & { jti?: string; iat?: number; exp?: number };
    if (payload.token_use !== use) throw new Error(`Not a ${use} token`);
    return payload;
};

export interface AccessTokenInput {
    userId: string;
    tenantId: string;
    sessionId: string;
    /** The user must change their password before using anything else. */
    pwdChange?: boolean;
}

export const generateAccessToken = (input: AccessTokenInput, expiresInSeconds = 15 * 60): string =>
    sign({ token_use: 'access', uid: input.userId, tid: input.tenantId, sid: input.sessionId, ...(input.pwdChange ? { pwd: true } : {}) }, expiresInSeconds);

/** Verifies an access token; throws if it is invalid, expired or not an access token. */
export const verifyAccessToken = (token: string): JwtPayload => {
    const p = verify(token, 'access');
    if (!p.sid) throw new Error('Access token without a session');
    return { userId: p.uid, tenantId: p.tid, sessionId: p.sid, pwdChange: p.pwd === true, jti: p.jti, iat: p.iat, exp: p.exp };
};

export const generateMfaChallengeToken = (userId: string, tenantId: string, rememberMe = false): string =>
    sign({ token_use: 'mfa_challenge', uid: userId, tid: tenantId, ...(rememberMe ? { rm: true } : {}) }, 5 * 60);

export const verifyMfaChallengeToken = (token: string): { userId: string; tenantId: string; rememberMe: boolean } => {
    const p = verify(token, 'mfa_challenge');
    return { userId: p.uid, tenantId: p.tid, rememberMe: p.rm === true };
};

/**
 * The platform console (Klytos staff, not a school): its own token kinds, never accepted as a school
 * sign-in (and school tokens are never accepted by the console). `tid` is "platform".
 */
export const generatePlatformToken = (platformUserId: string, expiresInSeconds = 8 * 3600): string => sign({ token_use: 'platform', uid: platformUserId, tid: 'platform' }, expiresInSeconds);
export const verifyPlatformToken = (token: string) => verify(token, 'platform').uid;
/** Between "password OK" and "authenticator code OK" (or setting the authenticator up). */
export const generatePlatformMfaToken = (platformUserId: string): string => sign({ token_use: 'platform_mfa', uid: platformUserId, tid: 'platform' }, 10 * 60);
export const verifyPlatformMfaToken = (token: string) => verify(token, 'platform_mfa').uid;
