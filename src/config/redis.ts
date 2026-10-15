import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

export const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
});

redis.on('connect', () => {
    console.log('[Redis] Connected successfully');
});

redis.on('error', (err) => {
    console.error('[Redis] Connection error:', err);
});

/**
 * Blacklist a token by its jti
 * @param jti The unique ID of the token
 * @param expirySeconds Expiry time in seconds (matching the token's remaining life)
 */
export const blacklistToken = async (jti: string, expirySeconds: number) => {
    if (expirySeconds > 0) {
        await redis.set(`blacklist:${jti}`, 'true', 'EX', expirySeconds);
    }
};

/**
 * Check if a token's jti is blacklisted
 * @param jti The unique ID of the token
 */
export const isTokenBlacklisted = async (jti: string): Promise<boolean> => {
    const result = await redis.get(`blacklist:${jti}`);
    return result === 'true';
};
