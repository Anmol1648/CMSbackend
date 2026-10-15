import type { Server } from 'http';
import { env } from './config/env';
import { app } from './app';
import { cache } from './core/cache';
import { logger } from './core/logger';
import { db } from './core/db';
import { syncPermissions } from './core/registry/permissions';
import { purgeOldAuditRecords } from './modules/audit/audit.service';

let server: Server | undefined;

const start = async () => {
    // The permission catalogue must match the code before anyone's access is checked.
    const synced = await syncPermissions();
    server = app.listen(env.PORT, '0.0.0.0', () => {
        logger.info(`cms-backend running on http://0.0.0.0:${env.PORT}`, { env: env.NODE_ENV, cache: cache.kind, permissions: synced.total });
    });
    startDailyJobs();
};

/** Housekeeping once shortly after start, then every 24 hours. */
const startDailyJobs = () => {
    const run = () => purgeOldAuditRecords().catch((err) => logger.error('Audit retention job failed', { error: err }));
    setTimeout(run, 60_000).unref();
    setInterval(run, 24 * 60 * 60 * 1000).unref();
};

start().catch((err) => {
    logger.error('Startup failed', { error: err });
    process.exit(1);
});

// Finish in-flight requests, then release connections.
const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    const done = async () => {
        await Promise.allSettled([db.$disconnect(), cache.close()]);
        process.exit(0);
    };
    if (server) server.close(done);
    else void done();
    setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
