import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, forbidden, validationError } from '../../core/errors';
import { authenticated } from '../../middlewares/access';
import { sendFile, upload } from '../../core/http/files';
import { IMAGE_KINDS, readFile, saveUpload } from '../../core/files';
import { getUserAccess } from '../rbac/access.service';
import * as qs from './questions.service';

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
const anyone = needAny(['syllabus.manage', 'question.view', 'question.add', 'question.approve']);
const adders = needAny(['question.add']);
const draft = (req: Request) => req.query.draft === '1';

export const questionRoutes = Router();

questionRoutes.get('/options', authenticated, anyone, asyncHandler(async (req: Request, res: Response) => successResponse(res, await qs.pickerOptions(uid(req), req.query.for === 'chapters' ? 'chapters' : 'questions'), 'Options')));

// Chapters.
questionRoutes.get('/chapters', authenticated, anyone, asyncHandler(async (req: Request, res: Response) => successResponse(res, await qs.listChapters(parse(qs.chapterQuery, req.query), uid(req)), 'Chapters')));
questionRoutes.post('/chapters', authenticated, needAny(['syllabus.manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await qs.createChapter(parse(qs.chapterSchema, req.body), uid(req)), 'Added', 201)));
questionRoutes.post('/chapters/many', authenticated, needAny(['syllabus.manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await qs.addChapters(parse(qs.manySchema, req.body), uid(req)), 'Added')));
questionRoutes.get('/chapters/suggest', authenticated, needAny(['syllabus.manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await qs.suggestChapters(parse(qs.chapterQuery, req.query), uid(req)), 'Suggested')));
questionRoutes.put('/chapters/:id', authenticated, needAny(['syllabus.manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await qs.updateChapter(req.params.id, parse(qs.chapterSchema.omit({ classId: true, subjectId: true }), req.body), uid(req)), 'Saved')));
questionRoutes.post('/chapters/:id/move', authenticated, needAny(['syllabus.manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await qs.moveChapter(req.params.id, parse(z.strictObject({ direction: z.enum(['up', 'down']) }), req.body).direction, uid(req)), 'Moved')));
questionRoutes.delete('/chapters/:id', authenticated, needAny(['syllabus.manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await qs.deleteChapter(req.params.id, uid(req)), 'Deleted')));

// Questions.
questionRoutes.post('/images', authenticated, adders, upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose a picture');
    const f = await saveUpload({ data: req.file.buffer, originalName: req.file.originalname, purpose: 'document', allowed: IMAGE_KINDS });
    successResponse(res, { id: f.id, name: f.originalName }, 'Uploaded', 201);
}));
questionRoutes.get('/', authenticated, anyone, asyncHandler(async (req: Request, res: Response) => successResponse(res, await qs.listQuestions(parse(qs.listQuery, req.query), uid(req)), 'Questions')));
questionRoutes.post('/generate', authenticated, adders, asyncHandler(async (req: Request, res: Response) => successResponse(res, await qs.generateQuestions(parse(qs.generateSchema, req.body), uid(req)), 'Written', 201)));
questionRoutes.post('/send', authenticated, adders, asyncHandler(async (req: Request, res: Response) => successResponse(res, await qs.sendQuestions(parse(z.strictObject({ ids: z.array(z.uuid()).min(1).max(200) }), req.body).ids, uid(req)), 'Sent')));
questionRoutes.post('/review', authenticated, needAny(['question.approve']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await qs.reviewQuestions(parse(qs.reviewSchema, req.body), uid(req)), 'Done')));
questionRoutes.post('/', authenticated, adders, asyncHandler(async (req: Request, res: Response) => successResponse(res, await qs.createQuestion(parse(qs.questionSchema, req.body), uid(req), { asDraft: draft(req) }), 'Added', 201)));
questionRoutes.get('/:id', authenticated, anyone, asyncHandler(async (req: Request, res: Response) => successResponse(res, await qs.getQuestion(req.params.id, uid(req)), 'Question')));
questionRoutes.get('/:id/image', authenticated, anyone, asyncHandler(async (req: Request, res: Response) => {
    const q = await qs.getQuestion(req.params.id, uid(req));
    if (!q.imageFileId) throw badRequest('No picture');
    const { file, data } = await readFile(q.imageFileId);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true, cacheSeconds: 3600 });
}));
questionRoutes.put('/:id', authenticated, adders, asyncHandler(async (req: Request, res: Response) => successResponse(res, await qs.updateQuestion(req.params.id, parse(qs.questionSchema, req.body), uid(req), { asDraft: draft(req) }), 'Saved')));
questionRoutes.delete('/:id', authenticated, adders, asyncHandler(async (req: Request, res: Response) => successResponse(res, await qs.deleteQuestion(req.params.id, uid(req)), 'Deleted')));
