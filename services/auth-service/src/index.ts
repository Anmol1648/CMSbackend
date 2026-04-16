import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.routes';
import { globalErrorHandler } from './utils/errorHandler';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4001;

app.use(cors());
app.use(express.json());

// Request Logger
app.use((req, res, next) => {
    console.log(`[Auth Service] ${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
});

// Routes
app.use('/', authRoutes);

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
