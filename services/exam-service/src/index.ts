import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({
        service: 'exam-service',
        status: 'UP',
        port: 4008,
        timestamp: new Date().toISOString()
    });
});

const PORT = 4008;
app.listen(PORT, () => {
    console.log('exam-service microservice listening on http://localhost:' + PORT);
});
