import express from 'express';
import cors from 'cors';

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

const PORT = 4002;
app.listen(PORT, () => {
    console.log('tenant-service microservice listening on http://localhost:' + PORT);
});
