import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { forbidden, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { getUserAccess } from '../rbac/access.service';
import * as ai from './ai.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};
const uid = (req: Request) => req.user!.userId;

export const aiRoutes = Router();

/** Whether AI can be used (for showing "with AI" buttons). */
aiRoutes.get('/status', authenticated, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await ai.aiStatus(), 'AI')));
aiRoutes.get('/setup', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const a = await getUserAccess(uid(req));
    if (!a.permissions['ai.setup'] && !a.permissions['ai.usage']) throw forbidden();
    successResponse(res, await ai.setupInfo(), 'AI');
}));
aiRoutes.put('/key', can('ai.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ai.saveKey(parse(ai.keySchema, req.body).key, uid(req)), 'Saved')));
aiRoutes.post('/test', can('ai.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ai.testAi(uid(req)), 'AI answered')));
aiRoutes.get('/usage', can('ai.usage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ai.usage(parse(ai.usageQuery, req.query)), 'Usage')));
