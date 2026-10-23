import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { validationError } from '../../core/errors';
import { can } from '../../middlewares/access';
import { defineDailyJob } from '../alerts/jobs';
import * as learn from './learn.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};
const uid = (req: Request) => req.user!.userId;
const chatQuery = z.object({ subject: z.uuid().optional(), chapter: z.uuid().optional() });

export const learnRoutes = Router();

// The student.
learnRoutes.get('/subjects', can('learn.use'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await learn.mySubjects(uid(req)), 'Subjects')));
learnRoutes.get('/chats', can('learn.use'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await learn.myChats(uid(req), parse(chatQuery, req.query)), 'Conversations')));
learnRoutes.post('/chats', can('learn.use'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await learn.startChat(parse(learn.startSchema, req.body), uid(req)), 'Answered', 201)));
learnRoutes.post('/chats/:id/messages', can('learn.use'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await learn.sendMessage(req.params.id, parse(learn.sendSchema, req.body).text, uid(req)), 'Answered')));
learnRoutes.delete('/chats/:id', can('learn.use'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await learn.deleteChat(req.params.id, uid(req)), 'Deleted')));
learnRoutes.post('/quiz', can('learn.use'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await learn.newQuiz(parse(learn.quizSchema, req.body), uid(req)), 'Quiz', 201)));
learnRoutes.post('/quiz/:id/submit', can('learn.use'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await learn.submitQuiz(req.params.id, parse(learn.quizAnswerSchema, req.body).answers, uid(req)), 'Done')));
learnRoutes.get('/me/progress', can('learn.use'), asyncHandler(async (req: Request, res: Response) => {
    const { db } = await import('../../core/db');
    const st = await db.student.findFirst({ where: { userId: uid(req) }, select: { id: true } });
    successResponse(res, st ? await learn.progressOf(st.id, uid(req)) : null, 'Progress');
}));

// Parents and teachers.
learnRoutes.get('/progress/choices', can('learn.view'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await learn.progressChoices(uid(req)), 'Choices')));
learnRoutes.get('/progress/section/:id', can('learn.view'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await learn.sectionProgress(req.params.id, uid(req)), 'Section')));
learnRoutes.get('/progress/student/:id', can('learn.view'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await learn.progressOf(req.params.id, uid(req)), 'Progress')));
learnRoutes.get('/chats/:id', can('learn.use'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await learn.getChat(req.params.id, uid(req)), 'Conversation')));
learnRoutes.get('/view/chats/:id', can('learn.view'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await learn.getChat(req.params.id, uid(req)), 'Conversation')));

defineDailyJob({ key: 'learn_cleanup', at: async () => '02:30', run: learn.purgeOldChats });
