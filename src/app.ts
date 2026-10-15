import express, { Request, Response } from 'express';
import cors from 'cors';
import { globalErrorHandler } from './core/error-handler';
import { authenticate } from './middlewares/authenticate';
import { requireRole } from './middlewares/require-permission';
import authRoutes from './modules/auth/auth.routes';
import userRoutes from './modules/users/user.routes';
import rbacRoutes from './modules/rbac/rbac.routes';
import widgetRoutes from './modules/dashboard/widget.routes';
import roleWidgetMappingRoutes from './modules/dashboard/role-widget-mapping.routes';
import dashboardRoutes from './modules/dashboard/dashboard.routes';
import tenantRoutes from './modules/tenants/tenant.routes';

export const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);
        // Allow localhost and LAN IPs on any port
        const allowed = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(origin);
        callback(null, allowed);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '1mb' }));

// Request logger
app.use((req, _res, next) => {
    console.log(`[API] ${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
});

// ─── Health Check ────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
    res.json({ service: 'cms-backend', status: 'UP', timestamp: new Date().toISOString() });
});

// ─── Modules ─────────────────────────────────────────────────────────────────
const superAdmin = [authenticate, requireRole('super-admin')];

app.use('/api/auth/users', userRoutes);          // routes apply authenticate themselves
app.use('/api/auth', authRoutes);                // public login/refresh/reset + authenticated logout
app.use('/api/rbac', rbacRoutes);                // authenticate + per-route permissions
app.use('/api/dashboard', authenticate, dashboardRoutes);
app.use('/api/widgets', ...superAdmin, widgetRoutes);   // widgets hold raw SQL: super admin only
app.use('/api/role-widget-mappings', ...superAdmin, roleWidgetMappingRoutes);
app.use('/api/tenants', ...superAdmin, tenantRoutes);

app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Route not found' }, timestamp: new Date().toISOString() });
});

// ─── Global Error Handler ────────────────────────────────────────────────────
app.use(globalErrorHandler);
