import express, { Request, Response } from 'express';
import cors, { CorsOptions } from 'cors';
import helmet from 'helmet';
import { env, isProduction } from './config/env';
import { globalErrorHandler } from './core/error-handler';
import { errorResponse } from './core/response';
import { getRequestId } from './core/context';
import { assertRoutesProtected } from './core/http/route-guard';
import { publicRoute } from './middlewares/access';
import { requestContext } from './middlewares/request-context';
import authRoutes from './modules/auth/auth.routes';
import userRoutes from './modules/users/user.routes';
import rbacRoutes from './modules/rbac/rbac.routes';
import widgetRoutes from './modules/dashboard/widget.routes';
import roleWidgetMappingRoutes from './modules/dashboard/role-widget-mapping.routes';
import dashboardRoutes from './modules/dashboard/dashboard.routes';
import tenantRoutes from './modules/tenants/tenant.routes';

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

// ─── Health Check ────────────────────────────────────────────────────────────
app.get('/health', publicRoute, (_req: Request, res: Response) => {
    res.json({ service: 'cms-backend', status: 'UP', timestamp: new Date().toISOString() });
});

// ─── Modules (every route declares its own access rule) ──────────────────────
app.use('/api/auth/users', userRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/rbac', rbacRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/widgets', widgetRoutes);
app.use('/api/role-widget-mappings', roleWidgetMappingRoutes);
app.use('/api/tenants', tenantRoutes);

app.use((req: Request, res: Response) => {
    errorResponse(res, `No route for ${req.method} ${req.path}`, 'NOT_FOUND', 404, undefined, getRequestId());
});

// ─── Global Error Handler ────────────────────────────────────────────────────
app.use(globalErrorHandler);

// Refuse to start if any route lacks an access rule.
assertRoutesProtected(app);
