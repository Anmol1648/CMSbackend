import express from 'express';
import cors from 'cors';
import { connectCentralDb } from './central-db';
import { tenantRouter } from './routes/tenants.router';
import { startTenantHealthCheck } from './jobs/tenantHealthCheck.job';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({
        service: 'tenant-service',
        status: 'UP',
        port: 4002,
        timestamp: new Date().toISOString()
    });
});

app.use((req, res, next) => {
    console.log(`[Tenant Service] ${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
});

app.use('/', tenantRouter);

const PORT = process.env.PORT || 4002;

async function start() {
    await connectCentralDb();
    startTenantHealthCheck();

    app.listen(PORT, () => {
        console.log('tenant-service microservice listening on http://localhost:' + PORT);
    });
}

start();
