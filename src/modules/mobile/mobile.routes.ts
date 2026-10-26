import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { validationError } from '../../core/errors';
import { authenticated, publicRoute } from '../../middlewares/access';
import { sendFile } from '../../core/http/files';
import * as devices from './mobile.service';
import { childPhoto, myChildren } from './mobile.children';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};

/** The mobile app: push registration, the version check at start, and the home header's children. */
export const mobileRoutes = Router();

mobileRoutes.get('/app-info', publicRoute, (_req: Request, res: Response) => successResponse(res, devices.appInfo(), 'App'));
mobileRoutes.post('/devices', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await devices.registerDevice(parse(devices.registerSchema, req.body), req.user!.userId), 'Registered')));
mobileRoutes.post('/devices/forget', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await devices.forgetDevice(parse(z.object({ token: z.string().max(200) }), req.body).token, req.user!.userId), 'Forgotten')));
mobileRoutes.get('/children', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await myChildren(req.user!.userId), 'Children')));
mobileRoutes.get('/children/:id/photo', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const { file, data } = await childPhoto(req.user!.userId, req.params.id);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true, cacheSeconds: 86_400 });
}));
