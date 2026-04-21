import { Router } from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import { authenticate } from '../middlewares/auth.middleware';
import { createRateLimiter } from '../middlewares/rateLimiter.middleware';

const router = Router();

// ─── Rate Limiters ──────────────────────────────────────────────────────────
const authLimiter = createRateLimiter({
    windowInMinutes: 15,
    maxAttempts: 10,
    keyPrefix: 'auth'
});

const mfaLimiter = createRateLimiter({
    windowInMinutes: 15,
    maxAttempts: 5,
    keyPrefix: 'mfa'
});

const forgotPasswordLimiter = createRateLimiter({
    windowInMinutes: 60,
    maxAttempts: 3,
    keyPrefix: 'forgot-password'
});

const resetPasswordLimiter = createRateLimiter({
    windowInMinutes: 15,
    maxAttempts: 5,
    keyPrefix: 'reset-password'
});

// Apply rate limiters to specific endpoints
router.post('/api/auth/login', authLimiter);
router.post('/api/auth/verify-mfa', mfaLimiter);
router.post('/api/auth/forgot-password', forgotPasswordLimiter);
router.post('/api/auth/reset-password', resetPasswordLimiter);



// ─── Helper: create a proxy with lazy target resolution ──────────────────────
const makeProxy = (getTarget: () => string, name: string, prefixToStrip?: string) =>
    createProxyMiddleware({
        target: getTarget(), // default target
        router: () => getTarget(),   // resolved per-request, not at boot time
        changeOrigin: true,
        pathRewrite: prefixToStrip ? { [`^${prefixToStrip}`]: '' } : undefined,
        on: {
            proxyReq: fixRequestBody,
            error: (err, req, res: any) => {
                console.error(`[Gateway] ${name} proxy error:`, err.message);
                res.status(502).json({
                    status: 'error',
                    code: 'BAD_GATEWAY',
                    message: `${name} is unavailable`,
                });
            },
        },
    });

// ─── Protected Routes (JWT required) ──────────────────────────────────────────
// 1. Authenticate user-specific auth routes first
router.use(['/api/auth/users', '/api/auth/logout', '/api/auth/logout-all'], authenticate);


// 2. Generic protected routes for other services
router.use('/api/tenants', authenticate, makeProxy(() => process.env.TENANT_SERVICE_URL || 'http://127.0.0.1:4002', 'Tenant Service', '/api/tenants'));
router.use('/api/rbac', authenticate, createProxyMiddleware({
    target: process.env.AUTH_SERVICE_URL || 'http://127.0.0.1:4001',
    changeOrigin: true,
    pathRewrite: {
        '^/': '/rbac/'
    },
    on: {
        proxyReq: fixRequestBody,
        error: (err, req, res: any) => {
            console.error(`[Gateway] RBAC proxy error:`, err.message);
            res.status(502).json({
                status: 'error',
                code: 'BAD_GATEWAY',
                message: `RBAC Service is unavailable`,
            });
        },
    },
}));

// ─── Auth Service Proxy (Handles both Public and Authenticated routes) ────────
// This will forward /api/auth/login -> /login and /api/auth/users/profile -> /users/profile
router.use('/api/auth', makeProxy(() => process.env.AUTH_SERVICE_URL!, 'Auth Service', '/api/auth'));

export default router;
