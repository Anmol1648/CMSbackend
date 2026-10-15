import express, { Request, Response } from 'express';
import cors, { CorsOptions } from 'cors';
import helmet from 'helmet';
import { env, isProduction } from './config/env';
import { globalErrorHandler } from './core/error-handler';
import { errorResponse } from './core/response';
import { getRequestId } from './core/context';
import { assertRoutesProtected, listRoutes } from './core/http/route-guard';
import { findPermissionDef } from './core/registry/permissions';
import { publicRoute } from './middlewares/access';
import { requestContext } from './middlewares/request-context';
import { tenantFromHost } from './middlewares/tenant';
import './modules/registry';
import { publicSchoolRoutes, schoolProfileRoutes } from './modules/school-profile';
import { authRoutes } from './modules/auth';
import { meRoutes, roleRoutes } from './modules/rbac/rbac.routes';
import { userRoutes } from './modules/users/users.routes';

export const app = express();

// ─── Platform ────────────────────────────────────────────────────────────────
app.set('trust proxy', env.TRUST_PROXY);
app.use(helmet());

// Development default: localhost and LAN addresses on any port. Production: only CORS_ORIGINS.
const devOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/;
const allowedOrigins = env.CORS_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? [];
const corsOptions: CorsOptions = {
    origin: (origin, callback) => {
        // Requests with no origin (mobile apps, curl, server-to-server)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        callback(null, !isProduction && allowedOrigins.length === 0 && devOrigin.test(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(requestContext);

// ─── Health Check (no database, no school) ───────────────────────────────────
app.get('/health', publicRoute, (_req: Request, res: Response) => {
    res.json({ service: 'cms-backend', status: 'UP', timestamp: new Date().toISOString() });
});

// Which school the calling page belongs to (before sign-in); the token decides after sign-in.
app.use('/api', tenantFromHost);

// ─── Modules (every route declares its own access rule) ──────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/public/school', publicSchoolRoutes);
app.use('/api/school-profile', schoolProfileRoutes);
app.use('/api/me', meRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/users', userRoutes);

app.use((req: Request, res: Response) => {
    errorResponse(res, `No route for ${req.method} ${req.path}`, 'NOT_FOUND', 404, undefined, getRequestId());
});

// ─── Global Error Handler ────────────────────────────────────────────────────
app.use(globalErrorHandler);

// Refuse to start if any route lacks an access rule, or checks a permission nobody registered (a typo).
assertRoutesProtected(app);
const unknownPermissions = listRoutes(app)
    .filter((r) => r.access?.startsWith('can:') && !findPermissionDef(r.access.slice(4)))
    .map((r) => `  - ${r.method} ${r.path} checks "${r.access!.slice(4)}"`);
if (unknownPermissions.length) throw new Error(`Routes check permissions that are not registered:\n${unknownPermissions.join('\n')}`);
