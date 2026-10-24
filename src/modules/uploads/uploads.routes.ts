import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, forbidden, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { readFile, saveUpload } from '../../core/files';
import { sendFile, upload } from '../../core/http/files';
import { getUserAccess } from '../rbac/access.service';
import * as up from './uploads.service';

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
const editors = needAny(['upload.manage', 'upload.add']);
const manage = can('upload.manage');

export const uploadRoutes = Router();

// The library (those who manage or add).
uploadRoutes.get('/library', authenticated, editors, asyncHandler(async (req: Request, res: Response) => successResponse(res, await up.library(uid(req)), 'Library')));
uploadRoutes.post('/folders', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await up.saveFolder(null, parse(up.folderSchema, req.body), uid(req)), 'Saved', 201)));
uploadRoutes.put('/folders/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await up.saveFolder(req.params.id, parse(up.folderSchema, req.body), uid(req)), 'Saved')));
uploadRoutes.delete('/folders/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await up.deleteFolder(req.params.id), 'Deleted')));
uploadRoutes.get('/folders/:id/items', authenticated, editors, asyncHandler(async (req: Request, res: Response) => successResponse(res, await up.folderItems(req.params.id, uid(req)), 'Files')));
uploadRoutes.post('/files', authenticated, editors, upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose a file');
    const f = await saveUpload({ data: req.file.buffer, originalName: req.file.originalname, purpose: 'upload', allowed: await up.acceptedKinds() });
    successResponse(res, { id: f.id, name: f.originalName, mimeType: f.mimeType, sizeBytes: f.sizeBytes }, 'Uploaded', 201);
}));
uploadRoutes.post('/items', authenticated, editors, asyncHandler(async (req: Request, res: Response) => successResponse(res, await up.addItem(parse(up.itemSchema, req.body), uid(req)), 'Shared', 201)));
uploadRoutes.put('/items/:id', authenticated, editors, asyncHandler(async (req: Request, res: Response) => successResponse(res, await up.editItem(req.params.id, parse(up.editSchema, req.body), uid(req)), 'Saved')));
uploadRoutes.post('/items/:id/version', authenticated, editors, asyncHandler(async (req: Request, res: Response) => successResponse(res, await up.newVersion(req.params.id, parse(up.versionSchema, req.body), uid(req)), 'Saved')));
uploadRoutes.delete('/items/:id', authenticated, editors, asyncHandler(async (req: Request, res: Response) => successResponse(res, await up.deleteItem(req.params.id, uid(req)), 'Deleted')));
uploadRoutes.post('/items/:id/approve', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await up.approveItem(req.params.id, parse(z.object({ approve: z.boolean() }), req.body).approve, uid(req)), 'Saved')));
uploadRoutes.get('/items/:id/tracking', authenticated, needAny(['upload.reports', 'upload.manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await up.tracking(req.params.id), 'Tracking')));
uploadRoutes.get('/items/:id/versions/:version/file', authenticated, editors, asyncHandler(async (req: Request, res: Response) => {
    const fileId = await up.versionFile(req.params.id, Number(req.params.version), uid(req));
    const { file, data } = await readFile(fileId);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true });
}));

// Downloads (everyone allowed to see shared files).
uploadRoutes.get('/downloads', can('upload.view'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await up.downloads(uid(req), parse(z.object({ search: z.string().trim().max(80).optional() }), req.query).search), 'Downloads')));
uploadRoutes.get('/items/:id/file', authenticated, needAny(['upload.view', 'upload.manage', 'upload.add']), asyncHandler(async (req: Request, res: Response) => {
    const i = await up.openItem(req.params.id, uid(req));
    if (i.kind === 'link' || !i.fileId) {
        successResponse(res, { link: i.link }, 'Link');
        return;
    }
    const { file, data } = await readFile(i.fileId);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true });
}));
uploadRoutes.post('/items/:id/ack', can('upload.view'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await up.acknowledge(req.params.id, uid(req)), 'Thank you')));
