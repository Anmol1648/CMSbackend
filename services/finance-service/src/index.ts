import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({
        service: 'finance-service',
        status: 'UP',
        port: 4007,
        timestamp: new Date().toISOString()
    });
});

const PORT = 4007;
app.listen(PORT, () => {
    console.log('finance-service microservice listening on http://localhost:' + PORT);
});
