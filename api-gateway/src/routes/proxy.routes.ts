import { Router } from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import { authenticate } from '../middlewares/auth.middleware';
import { createRateLimiter } from '../middlewares/rateLimiter.middleware';

const router = Router();

// ─── Rate Limiters ────────────────────────────────────────────────────────────
const authLimiter = createRateLimiter({ windowInMinutes: 15, maxAttempts: 10, keyPrefix: 'auth' });
const mfaLimiter = createRateLimiter({ windowInMinutes: 15, maxAttempts: 5, keyPrefix: 'mfa' });
const forgotPasswordLimiter = createRateLimiter({ windowInMinutes: 60, maxAttempts: 3, keyPrefix: 'forgot-password' });
const resetPasswordLimiter = createRateLimiter({ windowInMinutes: 15, maxAttempts: 5, keyPrefix: 'reset-password' });

router.post('/api/auth/login', authLimiter);
router.post('/api/auth/verify-mfa', mfaLimiter);
router.post('/api/auth/forgot-password', forgotPasswordLimiter);
router.post('/api/auth/reset-password', resetPasswordLimiter);

// ─── Helper ───────────────────────────────────────────────────────────────────
const makeProxy = (getTarget: () => string, name: string, targetPath: string) =>
    createProxyMiddleware({
        target: getTarget(),
        router: () => getTarget(),
        changeOrigin: true,
        pathRewrite: (path) => {
            // 'path' here is what Express passes after stripping the mount prefix
            // e.g. router.use('/api/widgets') → path is '/widgets/...' or just '/'
            // We want to forward to targetPath + path
            // e.g. targetPath='/widgets', path='/' → '/widgets'
            // e.g. targetPath='/widgets', path='/123' → '/widgets/123'
            const suffix = path === '/' ? '' : path;
            const result = `${targetPath}${suffix}`;
            console.log(`[Gateway] ${name}: "${path}" → "${result}"`);
            return result;
        },
        on: {
            proxyReq: fixRequestBody,
            error: (err, req, res: any) => {
                console.error(`[Gateway] ${name} proxy error:`, err.message);
                res.status(502).json({ status: 'error', code: 'BAD_GATEWAY', message: `${name} is unavailable` });
            },
        },
    });

// ─── Protected Routes ─────────────────────────────────────────────────────────
router.use(['/api/auth/users', '/api/auth/logout', '/api/auth/logout-all'], authenticate);

// /api/widgets/*  →  auth-service /widgets/*
router.use('/api/widgets', authenticate, makeProxy(
    () => process.env.AUTH_SERVICE_URL || 'http://127.0.0.1:4001',
    'Widgets',
    '/widgets'
));

// /api/role-widget-mappings/*  →  auth-service /role-widget-mappings/*
router.use('/api/role-widget-mappings', authenticate, makeProxy(
    () => process.env.AUTH_SERVICE_URL || 'http://127.0.0.1:4001',
    'RoleWidgetMappings',
    '/role-widget-mappings'
));

// /api/dashboard/*  →  auth-service /dashboard/*
router.use('/api/dashboard', authenticate, makeProxy(
    () => process.env.AUTH_SERVICE_URL || 'http://127.0.0.1:4001',
    'Dashboard',
    '/dashboard'
));

// /api/tenants/*  →  tenant-service /tenants/*
router.use('/api/tenants', authenticate, makeProxy(
    () => process.env.TENANT_SERVICE_URL || 'http://127.0.0.1:4002',
    'Tenants',
    '/tenants'
));

// /api/rbac/*  →  auth-service /rbac/*
router.use('/api/rbac', authenticate, makeProxy(
    () => process.env.AUTH_SERVICE_URL || 'http://127.0.0.1:4001',
    'RBAC',
    '/rbac'
));

// /api/auth/*  →  auth-service /*  (public + authenticated auth routes)
router.use('/api/auth', makeProxy(
    () => process.env.AUTH_SERVICE_URL!,
    'Auth',
    ''   // /api/auth/login → Express strips to '/login' → forward as '/login'
));

export default router;