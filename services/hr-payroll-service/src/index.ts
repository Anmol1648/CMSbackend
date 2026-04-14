import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({
        service: 'hr-payroll-service',
        status: 'UP',
        port: 4009,
        timestamp: new Date().toISOString()
    });
});

const PORT = 4009;
app.listen(PORT, () => {
    console.log('hr-payroll-service microservice listening on http://localhost:' + PORT);
});
