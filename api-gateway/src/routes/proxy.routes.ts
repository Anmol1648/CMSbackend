import { Router } from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();

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
router.use('/api/auth/users', authenticate); 

// 2. Generic protected routes for other services
router.use('/api/students', authenticate, makeProxy(() => process.env.STUDENT_SERVICE_URL!, 'Student Service', '/api/students'));
router.use('/api/rbac', authenticate, makeProxy(() => process.env.RBAC_SERVICE_URL!, 'RBAC Service', '/api/rbac'));

// ─── Auth Service Proxy (Handles both Public and Authenticated routes) ────────
// This will forward /api/auth/login -> /login and /api/auth/users/profile -> /users/profile
router.use('/api/auth', makeProxy(() => process.env.AUTH_SERVICE_URL!, 'Auth Service', '/api/auth'));

export default router;
