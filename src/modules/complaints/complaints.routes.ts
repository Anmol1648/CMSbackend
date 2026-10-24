import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, forbidden, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { readFile, saveUpload } from '../../core/files';
import { sendFile, upload } from '../../core/http/files';
import { getUserAccess } from '../rbac/access.service';
import * as cmp from './complaints.service';

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
const anyone = needAny(['complaint.raise', 'complaint.handle', 'complaint.manage']);
const staffSide = needAny(['complaint.handle', 'complaint.manage']);

export const complaintRoutes = Router();

// Raising (and files).
complaintRoutes.get('/options', authenticated, needAny(['complaint.raise', 'complaint.manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await cmp.raiseOptions(uid(req)), 'Options')));
complaintRoutes.post('/files', authenticated, anyone, upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose a file');
    const f = await saveUpload({ data: req.file.buffer, originalName: req.file.originalname, purpose: 'document', allowed: ['jpeg', 'png', 'webp', 'pdf'] });
    successResponse(res, { id: f.id, name: f.originalName }, 'Uploaded', 201);
}));
complaintRoutes.post('/', authenticated, needAny(['complaint.raise', 'complaint.manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await cmp.raise(parse(cmp.raiseSchema, req.body), uid(req)), 'Raised', 201)));
complaintRoutes.get('/mine', can('complaint.raise'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await cmp.myComplaints(uid(req)), 'My complaints')));

// The desk.
complaintRoutes.get('/desk', authenticated, staffSide, asyncHandler(async (req: Request, res: Response) => successResponse(res, await cmp.desk(parse(cmp.deskQuery, req.query), uid(req)), 'Complaints')));
complaintRoutes.get('/handlers', can('complaint.manage'), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await cmp.handlers(), 'Handlers')));

// One complaint.
complaintRoutes.get('/:id', authenticated, anyone, asyncHandler(async (req: Request, res: Response) => successResponse(res, await cmp.complaintView(req.params.id, uid(req)), 'Complaint')));
complaintRoutes.get('/:id/files/:fileId', authenticated, anyone, asyncHandler(async (req: Request, res: Response) => {
    const id = await cmp.attachment(req.params.id, req.params.fileId, uid(req));
    const { file, data } = await readFile(id);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true });
}));
complaintRoutes.post('/:id/reply', authenticated, anyone, asyncHandler(async (req: Request, res: Response) => successResponse(res, await cmp.reply(req.params.id, parse(cmp.messageSchema, req.body), uid(req)), 'Sent')));
complaintRoutes.post('/:id/note', authenticated, staffSide, asyncHandler(async (req: Request, res: Response) => successResponse(res, await cmp.note(req.params.id, parse(cmp.messageSchema, req.body), uid(req)), 'Saved')));
complaintRoutes.post('/:id/assign', can('complaint.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await cmp.assign(req.params.id, parse(z.object({ to: z.uuid() }), req.body).to, uid(req)), 'Assigned')));
complaintRoutes.post('/:id/resolve', authenticated, staffSide, asyncHandler(async (req: Request, res: Response) => successResponse(res, await cmp.resolve(req.params.id, parse(cmp.resolveSchema, req.body).resolution, uid(req)), 'Resolved')));
complaintRoutes.post('/:id/close', can('complaint.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await cmp.close(req.params.id, parse(cmp.closeSchema, req.body).note, uid(req)), 'Closed')));
complaintRoutes.post('/:id/accept', can('complaint.raise'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await cmp.accept(req.params.id, parse(cmp.acceptSchema, req.body), uid(req)), 'Closed')));
complaintRoutes.post('/:id/rate', can('complaint.raise'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await cmp.rate(req.params.id, parse(cmp.acceptSchema, req.body), uid(req)), 'Thank you')));
complaintRoutes.post('/:id/reopen', can('complaint.raise'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await cmp.reopen(req.params.id, parse(cmp.reopenSchema, req.body).reason, uid(req)), 'Reopened')));
