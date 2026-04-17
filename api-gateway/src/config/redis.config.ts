import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

export const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
});

redis.on('connect', () => {
    console.log('[Redis] Gateway connected successfully');
});

redis.on('error', (err) => {
    console.error('[Redis] Gateway connection error:', err);
});

/**
 * Check if a token's jti is blacklisted
 * @param jti The unique ID of the token
 */
export const isTokenBlacklisted = async (jti: string): Promise<boolean> => {
    const result = await redis.get(`blacklist:${jti}`);
    return result === 'true';
};
