import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { forbidden, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { sendFile } from '../../core/http/files';
import { readFile } from '../../core/files';
import { getUserAccess } from '../rbac/access.service';
import * as ts from './tests.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};
const uid = (req: Request) => req.user!.userId;
const needAny = (keys: string[]) =>
    asyncHandler(async (req: Request, _res: Response, next: () => void) => {
        const a = await getUserAccess(uid(req));
        if (!keys.some((k) => a.permissions[k])) throw forbidden();
        next();
    });
const staff = needAny(['test.create', 'test.view', 'test.mark']);
const bankQuery = z.object({ chapter: z.uuid().optional(), type: z.string().max(20).optional(), difficulty: z.uuid().optional(), search: z.string().max(100).optional() });

export const testRoutes = Router();

// Students and parents.
testRoutes.get('/mine', can('test.take'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.myTests(uid(req)), 'Tests')));
testRoutes.post('/:id/start', can('test.take'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.startTest(req.params.id, uid(req)), 'Started')));
testRoutes.put('/:id/answers', can('test.take'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.saveAnswers(req.params.id, parse(ts.answersSchema, req.body), uid(req)), 'Saved')));
testRoutes.post('/:id/submit', can('test.take'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.submitTest(req.params.id, parse(ts.answersSchema, req.body), uid(req)), 'Submitted')));
testRoutes.get('/:id/my-result', can('test.take'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.myResult(req.params.id, uid(req), typeof req.query.student === 'string' ? req.query.student : undefined), 'Result')));
testRoutes.get('/:id/questions/:tqId/image', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const fileId = await ts.imageFor(req.params.id, req.params.tqId, uid(req));
    const { file, data } = await readFile(fileId);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true, cacheSeconds: 3600 });
}));

// Teachers.
testRoutes.get('/options', authenticated, staff, asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.createOptions(uid(req)), 'Options')));
testRoutes.get('/', authenticated, staff, asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.listTests(parse(ts.listQuery, req.query), uid(req)), 'Tests')));
testRoutes.post('/', can('test.create'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.createTest(parse(ts.testSchema, req.body), uid(req)), 'Made', 201)));
testRoutes.get('/attempts/:attemptId', authenticated, staff, asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.attemptForTeacher(req.params.attemptId, uid(req)), 'Attempt')));
testRoutes.put('/attempts/:attemptId/marks', can('test.mark'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.markAttempt(req.params.attemptId, parse(ts.markSchema, req.body), uid(req)), 'Saved')));
testRoutes.post('/attempts/:attemptId/suggest', can('test.mark'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.suggestMarks(req.params.attemptId, parse(z.strictObject({ question: z.uuid() }), req.body).question, uid(req)), 'Suggested')));
testRoutes.get('/:id', authenticated, staff, asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.getTest(req.params.id, uid(req)), 'Test')));
testRoutes.put('/:id', can('test.create'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.updateTest(req.params.id, parse(ts.testSchema, req.body), uid(req)), 'Saved')));
testRoutes.delete('/:id', can('test.create'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.deleteTest(req.params.id, uid(req)), 'Deleted')));
testRoutes.get('/:id/bank', can('test.create'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.bankFor(req.params.id, parse(bankQuery, req.query), uid(req)), 'Questions')));
testRoutes.post('/:id/questions', can('test.create'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.addQuestions(req.params.id, parse(z.strictObject({ ids: z.array(z.uuid()).min(1).max(200) }), req.body).ids, uid(req)), 'Added')));
testRoutes.post('/:id/auto', can('test.create'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.autoPick(req.params.id, parse(ts.autoSchema, req.body), uid(req)), 'Added')));
testRoutes.put('/:id/questions/:tqId', can('test.create'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.editTestQuestion(req.params.id, req.params.tqId, parse(ts.editQuestionSchema, req.body), uid(req)), 'Saved')));
testRoutes.delete('/:id/questions/:tqId', can('test.create'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.removeQuestion(req.params.id, req.params.tqId, uid(req)), 'Removed')));
testRoutes.post('/:id/publish', can('test.create'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.publishTest(req.params.id, parse(z.strictObject({ publish: z.boolean() }), req.body).publish, uid(req)), 'Saved')));
testRoutes.get('/:id/results', authenticated, staff, asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.results(req.params.id, uid(req)), 'Results')));
testRoutes.post('/:id/results/publish', can('test.mark'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.publishResults(req.params.id, parse(z.strictObject({ publish: z.boolean() }), req.body).publish, uid(req)), 'Saved')));
testRoutes.get('/:id/analysis', authenticated, staff, asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.analysis(req.params.id, uid(req)), 'Analysis')));
testRoutes.get('/:id/exam-targets', can('test.mark'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.examTargets(req.params.id, uid(req)), 'Exams')));
testRoutes.post('/:id/to-exam', can('test.mark'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ts.pushToExam(req.params.id, parse(ts.toExamSchema, req.body), uid(req)), 'Marks put in')));
