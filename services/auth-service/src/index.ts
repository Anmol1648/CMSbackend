import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import { globalErrorHandler } from './utils/errorHandler';
import { contextMiddleware } from './middlewares/context.middleware';
import { db } from './models/prisma';

declare global {
    namespace Express {
        interface Request {
            db: typeof db;
        }
    }
}

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4001;

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
    req.db = db;
    next();
});
app.use(contextMiddleware);


// Request Logger
app.use((req, res, next) => {
    console.log(`[Auth Service] ${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
});

import rbacRoutes from './routes/rbac.routes';
import widgetRoutes from './routes/widget.routes';
import roleWidgetMappingRoutes from './routes/roleWidgetMapping.routes';
import dashboardRoutes from './routes/dashboard.routes';

// Routes
app.use('/', authRoutes);
app.use('/users', userRoutes);
app.use('/rbac', rbacRoutes);
app.use('/widgets', widgetRoutes);
app.use('/role-widget-mappings', roleWidgetMappingRoutes);
app.use('/dashboard', dashboardRoutes);
app.use((req, res, next) => {
    console.log(`[DEBUG] path: "${req.path}" | originalUrl: "${req.originalUrl}"`);
    next();
});
app.get('/health', (req, res) => {
    res.json({
        service: 'auth-service',
        status: 'UP',
        port: PORT,
        timestamp: new Date().toISOString()
    });
});

// Global Error Handler (Centralized in utils)
app.use(globalErrorHandler);

app.listen(PORT, () => {
    console.log(`auth-service microservice listening on http://localhost:${PORT}`);
});
