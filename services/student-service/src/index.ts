import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({
        service: 'student-service',
        status: 'UP',
        port: 4004,
        timestamp: new Date().toISOString()
    });
});

const PORT = 4004;
app.listen(PORT, () => {
    console.log('student-service microservice listening on http://localhost:' + PORT);
});
