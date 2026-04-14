import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({
        service: 'attendance-service',
        status: 'UP',
        port: 4006,
        timestamp: new Date().toISOString()
    });
});

const PORT = 4006;
app.listen(PORT, () => {
    console.log('attendance-service microservice listening on http://localhost:' + PORT);
});
