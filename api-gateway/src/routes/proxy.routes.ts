import { Router } from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();

// ─── Helper: create a proxy with lazy target resolution ──────────────────────
const makeProxy = (getTarget: () => string, name: string) =>
    createProxyMiddleware({
        router: () => getTarget(),   // resolved per-request, not at boot time
        changeOrigin: true,
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

// ─── Public: Auth Service (NO authentication) ─────────────────────────────────
router.use('/api/auth', makeProxy(() => process.env.AUTH_SERVICE_URL!, 'Auth Service'));

// ─── Protected Routes (JWT required) ──────────────────────────────────────────
router.use('/api/students', authenticate, makeProxy(() => process.env.STUDENT_SERVICE_URL!, 'Student Service'));
router.use('/api/rbac', authenticate, makeProxy(() => process.env.RBAC_SERVICE_URL!, 'RBAC Service'));

export default router;
