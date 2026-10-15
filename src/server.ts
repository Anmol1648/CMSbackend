import { env } from './config/env';
import { app } from './app';
import { cache } from './core/cache';
import { logger } from './core/logger';
import { db } from './core/db';

const server = app.listen(env.PORT, '0.0.0.0', () => {
    logger.info(`cms-backend running on http://0.0.0.0:${env.PORT}`, { env: env.NODE_ENV, cache: cache.kind });
});

// Finish in-flight requests, then release connections.
const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    server.close(async () => {
        await Promise.allSettled([db.$disconnect(), cache.close()]);
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
