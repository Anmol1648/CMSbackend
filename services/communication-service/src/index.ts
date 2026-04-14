import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({
        service: 'communication-service',
        status: 'UP',
        port: 4010,
        timestamp: new Date().toISOString()
    });
});

const PORT = 4010;
app.listen(PORT, () => {
    console.log('communication-service microservice listening on http://localhost:' + PORT);
});
