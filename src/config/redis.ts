import { cache } from '../core/cache';

/**
 * Token revocation helpers on top of the cache store (Redis when configured, otherwise in-memory).
 */

/** Blacklist a token by its jti until it would have expired anyway. */
export const blacklistToken = async (jti: string, expirySeconds: number) => {
    if (expirySeconds > 0) {
        await cache.set(`blacklist:${jti}`, 'true', expirySeconds);
    }
};

export const isTokenBlacklisted = async (jti: string): Promise<boolean> => {
    return (await cache.get(`blacklist:${jti}`)) === 'true';
};

/** Tokens issued before this moment (seconds) are rejected — "log out everywhere". */
export const revokeTokensIssuedBefore = async (userId: string, epochSeconds: number, ttlSeconds: number) => {
    await cache.set(`user:revoke_before:${userId}`, String(epochSeconds), ttlSeconds);
};

export const getRevokeBefore = async (userId: string): Promise<number | null> => {
    const value = await cache.get(`user:revoke_before:${userId}`);
    return value ? parseInt(value, 10) : null;
};
