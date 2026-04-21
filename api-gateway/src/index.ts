import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import proxyRoutes from './routes/proxy.routes';
import { globalErrorHandler } from './utils/errorHandler';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
    origin: 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Basic request logger
app.use((req, _res, next) => {
    console.log(`[Gateway] ${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
    res.json({
        service: 'api-gateway',
        status: 'UP',
        port: PORT,
        timestamp: new Date().toISOString(),
    });
});

// ─── Proxy Routes ─────────────────────────────────────────────────────────────
app.use(proxyRoutes);

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use(globalErrorHandler);

app.listen(8000, '0.0.0.0', () => {
    console.log(`[Gateway] API Gateway running on http://0.0.0.0:8000`);
});

