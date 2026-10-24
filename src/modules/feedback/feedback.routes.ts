import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { validationError } from '../../core/errors';
import { can } from '../../middlewares/access';
import * as fb from './feedback.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};
const uid = (req: Request) => req.user!.userId;
const manage = can('feedback.manage');

export const feedbackRoutes = Router();

// Question sets and rounds.
feedbackRoutes.get('/forms', manage, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await fb.listForms(), 'Question sets')));
feedbackRoutes.post('/forms', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await fb.saveForm(null, parse(fb.formSchema, req.body)), 'Saved', 201)));
feedbackRoutes.put('/forms/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await fb.saveForm(req.params.id, parse(fb.formSchema, req.body)), 'Saved')));
feedbackRoutes.get('/rounds', manage, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await fb.listRounds(), 'Rounds')));
feedbackRoutes.get('/rounds/defaults', manage, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await fb.roundDefaults(), 'Defaults')));
feedbackRoutes.post('/rounds', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await fb.saveRound(null, parse(fb.roundSchema, req.body), uid(req)), 'Saved', 201)));
feedbackRoutes.put('/rounds/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await fb.saveRound(req.params.id, parse(fb.roundSchema, req.body), uid(req)), 'Saved')));
feedbackRoutes.delete('/rounds/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await fb.deleteRound(req.params.id), 'Deleted')));
feedbackRoutes.post('/rounds/:id/open', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await fb.openRound(req.params.id), 'Opened')));
feedbackRoutes.post('/rounds/:id/close', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await fb.closeRound(req.params.id), 'Closed')));
feedbackRoutes.post('/rounds/:id/release', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await fb.releaseRound(req.params.id), 'Released')));
feedbackRoutes.get('/rounds/:id/comments', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await fb.pendingComments(req.params.id), 'Comments')));
feedbackRoutes.post('/comments', manage, asyncHandler(async (req: Request, res: Response) => {
    const b = parse(z.object({ ids: z.array(z.uuid()).min(1).max(500), status: z.enum(['shown', 'hidden']) }), req.body);
    successResponse(res, await fb.screen(b.ids, b.status), 'Saved');
}));

// Results.
feedbackRoutes.get('/rounds/:id/results', can('feedback.results'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await fb.results(req.params.id, uid(req), parse(z.object({ staff: z.uuid().optional() }), req.query).staff), 'Results')));
feedbackRoutes.get('/mine/rounds', can('feedback.own'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await fb.myRounds(uid(req)), 'Rounds')));
feedbackRoutes.get('/mine/rounds/:id', can('feedback.own'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await fb.results(req.params.id, uid(req), 'me'), 'My results')));

// Students and parents.
feedbackRoutes.get('/give', can('feedback.give'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await fb.myFeedback(uid(req)), 'Feedback')));
feedbackRoutes.post('/give', can('feedback.give'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await fb.submit(parse(fb.submitSchema, req.body), uid(req)), 'Thank you', 201)));
