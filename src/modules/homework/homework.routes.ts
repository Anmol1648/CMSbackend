import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, forbidden, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { sendFile, upload } from '../../core/http/files';
import { readFile, saveUpload } from '../../core/files';
import { getSettings } from '../../core/settings';
import { getUserAccess } from '../rbac/access.service';
import { HOMEWORK } from './homework.settings';
import * as hw from './homework.service';

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
const staff = needAny(['homework.give', 'homework.view', 'homework.check']);

export const homeworkRoutes = Router();

// Files: the teacher's attachments and the students' work.
homeworkRoutes.post('/files', authenticated, needAny(['homework.give', 'homework.mine']), upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose a file');
    const { types } = await getSettings({ types: HOMEWORK.fileTypes });
    const f = await saveUpload({ data: req.file.buffer, originalName: req.file.originalname, purpose: 'homework', allowed: types as ('pdf' | 'png' | 'jpeg')[] });
    successResponse(res, { id: f.id, name: f.originalName }, 'Uploaded', 201);
}));
homeworkRoutes.get('/:id/files/:fileId', authenticated, asyncHandler(async (req: Request, res: Response) => {
    if (!(await hw.mayOpenFile(req.params.id, req.params.fileId, uid(req)))) throw forbidden();
    const { file, data } = await readFile(req.params.fileId);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true });
}));

// Students and parents.
homeworkRoutes.get('/mine', can('homework.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await hw.myHomework(uid(req)), 'Homework')));
homeworkRoutes.post('/:id/submit', can('homework.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await hw.submitHomework(req.params.id, parse(hw.submitSchema, req.body), uid(req)), 'Handed in')));

// Teachers, class teachers, office.
homeworkRoutes.get('/options', authenticated, staff, asyncHandler(async (req: Request, res: Response) => successResponse(res, await hw.giveOptions(uid(req)), 'Options')));
homeworkRoutes.get('/diary/sections', can('homework.view'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await hw.diarySections(uid(req)), 'Sections')));
homeworkRoutes.get('/diary', can('homework.view'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await hw.diary(parse(hw.diaryQuery, req.query), uid(req)), 'Diary')));
homeworkRoutes.get('/', authenticated, staff, asyncHandler(async (req: Request, res: Response) => successResponse(res, await hw.listHomework(parse(hw.listQuery, req.query), uid(req)), 'Homework')));
homeworkRoutes.post('/', can('homework.give'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await hw.giveHomework(parse(hw.giveSchema, req.body), uid(req)), 'Given', 201)));
homeworkRoutes.get('/:id', authenticated, staff, asyncHandler(async (req: Request, res: Response) => successResponse(res, await hw.getHomework(req.params.id, uid(req)), 'Homework')));
homeworkRoutes.put('/:id', can('homework.give'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await hw.updateHomework(req.params.id, parse(hw.updateSchema, req.body), uid(req)), 'Saved')));
homeworkRoutes.delete('/:id', can('homework.give'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await hw.deleteHomework(req.params.id, uid(req)), 'Deleted')));
homeworkRoutes.put('/:id/check', can('homework.check'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await hw.checkHomework(req.params.id, parse(hw.checkSchema, req.body), uid(req)), 'Saved')));
