import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({
        service: 'academic-service',
        status: 'UP',
        port: 4005,
        timestamp: new Date().toISOString()
    });
});

const PORT = 4005;
app.listen(PORT, () => {
    console.log('academic-service microservice listening on http://localhost:' + PORT);
});
