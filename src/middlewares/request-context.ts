import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithContext, RequestContext } from '../core/context';
import { logger } from '../core/logger';

const INCOMING_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Gives every request an id (kept from X-Request-Id if the caller sent a sane one), returns it in
 * the X-Request-Id header, runs the request inside its context and logs one line when it finishes.
 */
export const requestContext = (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-request-id');
    const requestId = incoming && INCOMING_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', requestId);

    // The same object is the request's context; authenticate adds the user to it.
    const ctx: RequestContext = { requestId };
    const started = process.hrtime.bigint();
    res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(0)}ms`, {
            requestId,
            userId: ctx.user?.id,
        });
    });

    runWithContext(ctx, next);
};
