import Redis from 'ioredis';
import { logger } from '../logger';

/**
 * Small key/value store for counters, short-lived flags and caches.
 * Uses Redis when REDIS_URL is set; otherwise an in-memory store (fine for a single server process —
 * values reset on restart). Keys are plain strings; values are strings (callers JSON-encode).
 */
export interface CacheStore {
    readonly kind: 'redis' | 'memory';
    get(key: string): Promise<string | null>;
    /** ttlSeconds omitted = no expiry. */
    set(key: string, value: string, ttlSeconds?: number): Promise<void>;
    del(key: string): Promise<void>;
    /** Deletes every key starting with `prefix`. */
    delPrefix(prefix: string): Promise<void>;
    /** Increments a counter; the expiry is set when the counter is created. Returns the new value. */
    incr(key: string, ttlSeconds: number): Promise<number>;
    close(): Promise<void>;
}

export class MemoryCache implements CacheStore {
    readonly kind = 'memory' as const;
    private entries = new Map<string, { value: string; expiresAt: number | null }>();
    private sweeper: NodeJS.Timeout;

    constructor(sweepEveryMs = 60_000) {
        this.sweeper = setInterval(() => this.sweep(), sweepEveryMs);
        this.sweeper.unref();
    }

    private live(key: string) {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
            this.entries.delete(key);
            return undefined;
        }
        return entry;
    }

    private sweep() {
        const now = Date.now();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt !== null && entry.expiresAt <= now) this.entries.delete(key);
        }
    }

    async get(key: string) {
        return this.live(key)?.value ?? null;
    }

    async set(key: string, value: string, ttlSeconds?: number) {
        this.entries.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
    }

    async del(key: string) {
        this.entries.delete(key);
    }

    async delPrefix(prefix: string) {
        for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.entries.delete(key);
    }

    async incr(key: string, ttlSeconds: number) {
        const entry = this.live(key);
        if (!entry) {
            this.entries.set(key, { value: '1', expiresAt: Date.now() + ttlSeconds * 1000 });
            return 1;
        }
        const next = (parseInt(entry.value, 10) || 0) + 1;
        entry.value = String(next);
        return next;
    }

    async close() {
        clearInterval(this.sweeper);
        this.entries.clear();
    }
}

export class RedisCache implements CacheStore {
    readonly kind = 'redis' as const;
    private client: Redis;

    constructor(url: string) {
        this.client = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: false, lazyConnect: false });
        this.client.on('ready', () => logger.info('Redis connected'));
        this.client.on('error', (err) => logger.error('Redis error', { error: err.message }));
    }

    async get(key: string) {
        return this.client.get(key);
    }

    async set(key: string, value: string, ttlSeconds?: number) {
        if (ttlSeconds) await this.client.set(key, value, 'EX', ttlSeconds);
        else await this.client.set(key, value);
    }

    async del(key: string) {
        await this.client.del(key);
    }

    async delPrefix(prefix: string) {
        let cursor = '0';
        do {
            const [next, keys] = await this.client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
            if (keys.length) await this.client.del(...keys);
            cursor = next;
        } while (cursor !== '0');
    }

    async incr(key: string, ttlSeconds: number) {
        const [[, count]] = (await this.client.multi().incr(key).expire(key, ttlSeconds, 'NX').exec()) as [[Error | null, number]];
        return count;
    }

    async close() {
        await this.client.quit();
    }
}

export const createCache = (redisUrl?: string): CacheStore => (redisUrl ? new RedisCache(redisUrl) : new MemoryCache());

// Tests always use the in-memory store so they never touch a real Redis.
const redisUrl = process.env.NODE_ENV === 'test' ? undefined : process.env.REDIS_URL?.trim();
export const cache: CacheStore = createCache(redisUrl || undefined);
