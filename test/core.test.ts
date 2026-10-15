import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { z } from 'zod';
import { parseEnv } from '../src/config/env';
import { parseListQuery, toOrderBy, listResult } from '../src/core/http/list-query';
import { MemoryCache } from '../src/core/cache';
import { findUnprotectedRoutes, tagAccess, accessLabel } from '../src/core/http/route-guard';
import { AppError } from '../src/core/errors';

const validEnv = {
    DATABASE_URL: 'postgresql://u:p@localhost/db',
    JWT_PRIVATE_KEY: 'key',
    MFA_ENCRYPTION_KEY: 'a'.repeat(64),
};

describe('environment check', () => {
    it('accepts a valid environment and applies defaults', () => {
        const env = parseEnv(validEnv);
        expect(env.PORT).toBe(8000);
        expect(env.NODE_ENV).toBe('development');
        expect(env.REDIS_URL).toBeUndefined();
    });

    it('treats blank optional values as missing', () => {
        expect(parseEnv({ ...validEnv, REDIS_URL: '   ' }).REDIS_URL).toBeUndefined();
    });

    it('lists every problem by name and never echoes values', () => {
        const secret = 'not-hex-super-secret';
        try {
            parseEnv({ JWT_PRIVATE_KEY: 'k', MFA_ENCRYPTION_KEY: secret, PORT: 'abc' });
            throw new Error('should have thrown');
        } catch (e) {
            const message = (e as Error).message;
            expect(message).toContain('DATABASE_URL');
            expect(message).toContain('MFA_ENCRYPTION_KEY');
            expect(message).toContain('PORT');
            expect(message).not.toContain(secret);
        }
    });
});

describe('list query', () => {
    const spec = {
        sortable: ['name', 'createdAt'],
        defaultSort: 'name',
        search: true,
        filters: { status: z.enum(['active', 'disabled']), age: z.coerce.number().int() },
    } as const;

    it('applies defaults', () => {
        const q = parseListQuery({}, spec);
        expect(q).toMatchObject({ page: 1, pageSize: 25, skip: 0, take: 25, sort: 'name', order: 'asc', filters: {} });
    });

    it('parses paging, sort, search and typed filters', () => {
        const q = parseListQuery(
            { page: '3', pageSize: '10', sort: 'createdAt', order: 'DESC', search: '  ram ', filter: { status: 'active', age: '12' } },
            spec
        );
        expect(q).toMatchObject({ page: 3, pageSize: 10, skip: 20, sort: 'createdAt', order: 'desc', search: 'ram' });
        expect(q.filters).toEqual({ status: 'active', age: 12 });
        expect(toOrderBy(q)).toEqual({ createdAt: 'desc' });
        expect(listResult([1, 2], 22, q)).toEqual({ items: [1, 2], total: 22, page: 3, pageSize: 10 });
    });

    it('rejects unknown sort columns (no injection through ?sort=)', () => {
        expect(() => parseListQuery({ sort: 'name; DROP TABLE users' }, spec)).toThrowError(AppError);
    });

    it('rejects unknown filters, bad values and oversized pages with field details', () => {
        try {
            parseListQuery({ pageSize: '500', filter: { password: 'x', status: 'gone' } }, spec);
            throw new Error('should have thrown');
        } catch (e) {
            const err = e as AppError;
            expect(err.statusCode).toBe(400);
            const fields = err.details?.map((d) => d.field);
            expect(fields).toEqual(expect.arrayContaining(['pageSize', 'filter.password', 'filter.status']));
        }
    });

    it('rejects search when the list does not support it', () => {
        expect(() => parseListQuery({ search: 'x' }, { sortable: ['name'], defaultSort: 'name' })).toThrowError(AppError);
    });
});

describe('memory cache', () => {
    afterEach(() => vi.useRealTimers());

    it('stores, expires and deletes values', async () => {
        vi.useFakeTimers();
        const cache = new MemoryCache();
        await cache.set('a', '1', 10);
        await cache.set('b', '2');
        expect(await cache.get('a')).toBe('1');
        vi.advanceTimersByTime(11_000);
        expect(await cache.get('a')).toBeNull();
        expect(await cache.get('b')).toBe('2');
        await cache.del('b');
        expect(await cache.get('b')).toBeNull();
        await cache.close();
    });

    it('counts within a window and restarts after it', async () => {
        vi.useFakeTimers();
        const cache = new MemoryCache();
        expect(await cache.incr('hits', 60)).toBe(1);
        expect(await cache.incr('hits', 60)).toBe(2);
        vi.advanceTimersByTime(61_000);
        expect(await cache.incr('hits', 60)).toBe(1);
        await cache.close();
    });

    it('deletes by prefix only', async () => {
        const cache = new MemoryCache();
        await cache.set('rbac:t1:u1', 'x');
        await cache.set('rbac:t1:u2', 'x');
        await cache.set('rbac:t2:u1', 'x');
        await cache.delPrefix('rbac:t1:');
        expect(await cache.get('rbac:t1:u1')).toBeNull();
        expect(await cache.get('rbac:t2:u1')).toBe('x');
        await cache.close();
    });
});

describe('route guard', () => {
    it('finds routes whose first handler is not an access rule', () => {
        const app = express();
        const open = tagAccess('public', (_req, _res, next) => next());
        const router = express.Router();
        router.get('/ok', open, (_req, res) => res.end());
        router.post('/forgot', (_req, res) => res.end());
        app.use('/api/things', router);
        app.get('/health', open, (_req, res) => res.end());

        expect(accessLabel(open)).toBe('public');
        expect(findUnprotectedRoutes(app)).toEqual([{ method: 'POST', path: '/api/things/forgot', access: undefined }]);
    });
});
