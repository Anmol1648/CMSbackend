import 'dotenv/config';
import { app } from './app';

const PORT = Number(process.env.PORT) || 8000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[API] cms-backend running on http://0.0.0.0:${PORT}`);
});
