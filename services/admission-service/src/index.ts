import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({
        service: 'admission-service',
        status: 'UP',
        port: 4003,
        timestamp: new Date().toISOString()
    });
});

const PORT = 4003;
app.listen(PORT, () => {
    console.log('admission-service microservice listening on http://localhost:' + PORT);
});
