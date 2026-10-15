import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { app } from '../src/app';
import { listRoutes } from '../src/core/http/route-guard';
import { globalErrorHandler } from '../src/core/error-handler';
import { requestContext } from '../src/middlewares/request-context';

describe('app wiring', () => {
    it('every route declares an access rule', () => {
        const routes = listRoutes(app);
        expect(routes.filter((r) => !r.access)).toEqual([]);
        expect(routes).toContainEqual({ method: 'GET', path: '/health', access: 'public' });
        expect(routes).toContainEqual({ method: 'GET', path: '/api/school-profile/', access: 'authenticated' });
        expect(routes).toContainEqual({ method: 'PATCH', path: '/api/school-profile/', access: 'can:school_profile.update' });
        expect(routes).toContainEqual({ method: 'GET', path: '/api/public/school/', access: 'public' });
    });

    it('health check answers with a request id and security headers', async () => {
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('UP');
        expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('keeps a sane incoming request id', async () => {
        const res = await request(app).get('/health').set('X-Request-Id', 'abc12345-trace');
        expect(res.headers['x-request-id']).toBe('abc12345-trace');
    });

    it('allows the local frontend origin in development', async () => {
        const res = await request(app).get('/health').set('Origin', 'http://localhost:3000');
        expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
        const other = await request(app).get('/health').set('Origin', 'https://evil.example');
        expect(other.headers['access-control-allow-origin']).toBeUndefined();
    });
});

describe('error format', () => {
    it('unknown routes return the standard 404 envelope', async () => {
        const res = await request(app).get('/api/nope');
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ status: 'error', error: { code: 'NOT_FOUND' } });
        expect(res.body.requestId).toBe(res.headers['x-request-id']);
    });

    it('protected routes without a token return 401', async () => {
        const res = await request(app).get('/api/school-profile');
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('spoofed identity headers are ignored', async () => {
        const res = await request(app).get('/api/school-profile').set('x-user-id', 'someone').set('x-tenant-id', 't');
        expect(res.status).toBe(401);
    });

    it('a garbage token is a 401', async () => {
        const res = await request(app).get('/api/school-profile').set('Authorization', 'Bearer not.a.token');
        expect(res.status).toBe(401);
    });

    it('invalid JSON is a 400, not a 500', async () => {
        const res = await request(app).patch('/api/school-profile').set('Content-Type', 'application/json').send('{"city":');
        expect(res.status).toBe(400);
        expect(res.body.error.message).toBe('Request body is not valid JSON');
    });

    it('unexpected errors hide their message but keep the request id', async () => {
        const mini = express();
        mini.use(requestContext);
        mini.get('/boom', () => {
            throw new Error('database password is hunter2');
        });
        mini.use(globalErrorHandler);
        const res = await request(mini).get('/boom');
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain('hunter2');
        expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
        expect(res.body.requestId).toBe(res.headers['x-request-id']);
    });
});
