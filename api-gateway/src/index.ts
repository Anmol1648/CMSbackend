import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
    res.json({
        status: 'success',
        message: 'CMS API Gateway is running!',
        timestamp: new Date().toISOString()
    });
});

const PORT = 4000;
app.listen(PORT, () => {
    console.log(`API Gateway microservice listening on http://localhost:${PORT}`);
});
