import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { validationError } from '../../core/errors';
import { can } from '../../middlewares/access';
import * as a from './assistant.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};
const uid = (req: Request) => req.user!.userId;

export const assistantRoutes = Router();

assistantRoutes.get('/suggestions', can('ai.chat'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await a.suggestions(uid(req)), 'Suggestions')));
assistantRoutes.get('/chats', can('ai.chat'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await a.listChats(uid(req)), 'Conversations')));
assistantRoutes.get('/chats/:id', can('ai.chat'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await a.getChat(req.params.id, uid(req)), 'Conversation')));
assistantRoutes.delete('/chats/:id', can('ai.chat'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await a.deleteChat(req.params.id, uid(req)), 'Deleted')));
assistantRoutes.post('/ask', can('ai.chat'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await a.ask(parse(a.askSchema, req.body), uid(req)), 'Answer')));
assistantRoutes.post('/messages/:id/feedback', can('ai.chat'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await a.setFeedback(req.params.id, parse(a.feedbackSchema, req.body).feedback, uid(req)), 'Thank you')));
