import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { validationError } from '../../core/errors';
import { authenticated, publicRoute } from '../../middlewares/access';
import * as devices from './mobile.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};

/** The mobile app's phone: push registration, and the version check at start. */
export const mobileRoutes = Router();

mobileRoutes.get('/app-info', publicRoute, (_req: Request, res: Response) => successResponse(res, devices.appInfo(), 'App'));
mobileRoutes.post('/devices', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await devices.registerDevice(parse(devices.registerSchema, req.body), req.user!.userId), 'Registered')));
mobileRoutes.post('/devices/forget', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await devices.forgetDevice(parse(z.object({ token: z.string().max(200) }), req.body).token, req.user!.userId), 'Forgotten')));
