import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, forbidden, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { getUserAccess } from '../rbac/access.service';
import * as setup from './setup.service';
import * as marks from './marks.service';
import * as results from './results.service';
import { examLabels } from './exams.labels';
import { getSettings } from '../../core/settings';
import { EXAMS } from './exams.settings';

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
const year = z.object({ year: z.uuid() });
const ENTERERS = ['exam.marks', 'exam.marks_any', 'exam.moderate'];

export const examRoutes = Router();
const setupOnly = can('exam.setup');

// Grading scales and result rules.
// What the school calls stages and mark statuses (anyone who works with exams or sees results).
examRoutes.get('/labels', authenticated, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await examLabels(), 'Labels')));
examRoutes.get('/scales', authenticated, needAny(['exam.setup', ...ENTERERS, 'exam.view']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await setup.listScales(), 'Grading scales')));
examRoutes.post('/scales', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.saveScale(null, parse(setup.scaleSchema, req.body)), 'Saved', 201)));
examRoutes.put('/scales/:id', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.saveScale(req.params.id, parse(setup.scaleSchema, req.body)), 'Saved')));
examRoutes.delete('/scales/:id', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.deleteScale(req.params.id), 'Deleted')));
examRoutes.get('/rules', setupOnly, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await setup.listRules(), 'Result rules')));
examRoutes.post('/rules', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.saveRule(null, parse(setup.ruleSchema, req.body)), 'Saved', 201)));
examRoutes.put('/rules/:id', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.saveRule(req.params.id, parse(setup.ruleSchema, req.body)), 'Saved')));
examRoutes.delete('/rules/:id', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.deleteRule(req.params.id), 'Deleted')));

// Terms and exams of a session.
examRoutes.get('/terms', authenticated, needAny(['exam.setup', 'exam.view', ...ENTERERS]), asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.listTerms(parse(year, req.query).year), 'Terms')));
examRoutes.post('/terms', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.saveTerm(parse(year, req.query).year, null, parse(setup.termSchema, req.body)), 'Term added', 201)));
examRoutes.put('/terms/:id', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.saveTerm(parse(year, req.query).year, req.params.id, parse(setup.termSchema, req.body)), 'Term saved')));
examRoutes.delete('/terms/:id', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.deleteTerm(req.params.id), 'Term deleted')));
examRoutes.get('/', authenticated, needAny(['exam.setup', 'exam.view', 'exam.publish']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.listExams(parse(year, req.query).year), 'Exams')));
examRoutes.post('/', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.createExam(parse(year, req.query).year, parse(setup.examSchema, req.body)), 'Exam added', 201)));

// Marks entry.
examRoutes.get('/entry', authenticated, needAny(ENTERERS), asyncHandler(async (req: Request, res: Response) => successResponse(res, await marks.myExams(parse(year, req.query).year, uid(req)), 'Exams')));
examRoutes.get('/sheet', authenticated, needAny(ENTERERS), asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ subject: z.uuid(), section: z.uuid() }), req.query);
    successResponse(res, await marks.getSheet(q.subject, q.section, uid(req)), 'Marks');
}));
examRoutes.put('/sheet', authenticated, needAny(ENTERERS), asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ subject: z.uuid(), section: z.uuid() }), req.query);
    successResponse(res, await marks.saveSheet(q.subject, q.section, parse(marks.sheetSchema, req.body), uid(req)), 'Marks saved');
}));

// Results.
examRoutes.get('/results/choices', authenticated, needAny(['exam.view', 'exam.publish']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await results.resultChoices(parse(year, req.query).year, uid(req)), 'Choices')));
examRoutes.get('/results', authenticated, needAny(['exam.view', 'exam.publish']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await results.sectionResults(parse(results.scopeQuery, req.query), uid(req)), 'Results')));
examRoutes.post('/results/publish', can('exam.publish'), asyncHandler(async (req: Request, res: Response) => {
    const b = parse(z.strictObject({ year: z.uuid(), scope: z.enum(['term', 'final']), termId: z.uuid().nullable().optional(), publish: z.boolean() }), req.body);
    successResponse(res, await results.publishScope(b.year, b.scope, b.termId ?? null, b.publish, uid(req)), b.publish ? 'Published' : 'Unpublished');
}));
examRoutes.get('/mine', can('exam.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await results.myResults(uid(req)), 'My results')));

// One exam.
examRoutes.put('/:id', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.updateExam(req.params.id, parse(setup.examSchema, req.body)), 'Exam saved')));
examRoutes.delete('/:id', setupOnly, asyncHandler(async (req: Request, res: Response) => {
    await setup.deleteExam(req.params.id);
    successResponse(res, null, 'Exam deleted');
}));
examRoutes.post('/:id/status', authenticated, needAny(['exam.setup', 'exam.publish']), asyncHandler(async (req: Request, res: Response) => {
    const { status } = parse(z.strictObject({ status: z.enum(['draft', 'open', 'locked', 'published']) }), req.body);
    const a = await getUserAccess(uid(req));
    const exam = await setup.loadExam(req.params.id);
    // Publishing results (or taking them back) is for those who may publish; the rest for exam set-up.
    if ((status === 'published' || exam.status === 'published') && !a.permissions['exam.publish']) throw forbidden('Only those who publish results (principal) can do this');
    if (status !== 'published' && exam.status !== 'published' && !a.permissions['exam.setup']) throw forbidden();
    if (status === 'published' && exam.status !== 'locked') {
        const { lock } = await getSettings({ lock: EXAMS.lockBeforePublish });
        if (lock || exam.status !== 'open') throw badRequest(lock ? 'Lock marks entry first (System Settings → Exams)' : 'Open marks entry first');
    }
    successResponse(res, await setup.setExamStatus(req.params.id, status, uid(req)), 'Saved');
}));
examRoutes.get('/:id/subjects', authenticated, needAny(['exam.setup', 'exam.view', ...ENTERERS]), asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.examSubjects(req.params.id), 'Subjects')));
examRoutes.put('/:id/subjects', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.saveSubjects(req.params.id, parse(setup.subjectRowsSchema, req.body)), 'Saved')));
examRoutes.post('/:id/datesheet', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.publishDatesheet(req.params.id, uid(req)), 'Date sheet published')));
examRoutes.get('/:id/sheets', authenticated, needAny(ENTERERS), asyncHandler(async (req: Request, res: Response) => successResponse(res, await marks.mySheets(req.params.id, uid(req)), 'Sheets')));
examRoutes.get('/:id/progress', authenticated, needAny(['exam.setup', 'exam.marks_any', 'exam.publish']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await marks.progress(req.params.id), 'Progress')));
examRoutes.get('/:id/class-sheet', authenticated, needAny(ENTERERS), asyncHandler(async (req: Request, res: Response) => successResponse(res, await marks.getClassSheet(req.params.id, parse(z.object({ section: z.uuid() }), req.query).section, uid(req)), 'Class sheet')));
examRoutes.put('/:id/class-sheet', authenticated, needAny(ENTERERS), asyncHandler(async (req: Request, res: Response) => successResponse(res, await marks.saveClassSheet(req.params.id, parse(z.object({ section: z.uuid() }), req.query).section, parse(marks.classSheetSchema, req.body), uid(req)), 'Saved')));
