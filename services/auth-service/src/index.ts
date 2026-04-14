import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({
        service: 'auth-service',
        status: 'UP',
        port: 4001,
        timestamp: new Date().toISOString()
    });
});

const PORT = 4001;
app.listen(PORT, () => {
    console.log('auth-service microservice listening on http://localhost:' + PORT);
});
