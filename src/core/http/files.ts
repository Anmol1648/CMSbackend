import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { getContext, runWithContext } from '../context';

/** Hard ceiling only; the school's limit (System Settings → Uploads) is checked when the file is saved. */
const memory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

/**
 * One uploaded file (in req.file). multer continues from a stream callback, which loses the request
 * context (school, user) — so the context is put back before the next handler runs.
 */
const single = (field: string): RequestHandler => {
    const handler = memory.single(field);
    return (req: Request, res: Response, next: NextFunction) => {
        const ctx = getContext();
        handler(req, res, (err?: unknown) => (ctx ? runWithContext(ctx, () => next(err)) : next(err)));
    };
};

export const upload = { single };

/** Sends bytes as a download (attachment) or for display (inline, e.g. a logo). */
export const sendFile = (res: Response, fileName: string, mime: string, data: Buffer, options: { inline?: boolean; cacheSeconds?: number } = {}) => {
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `${options.inline ? 'inline' : 'attachment'}; filename="${fileName.replace(/[^\w.-]/g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', options.cacheSeconds ? `private, max-age=${options.cacheSeconds}` : 'no-store');
    res.send(data);
};
