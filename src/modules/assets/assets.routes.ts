import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, forbidden, notFound, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { readFile, saveUpload } from '../../core/files';
import { sendFile, upload } from '../../core/http/files';
import { db } from '../../core/db';
import { getUserAccess } from '../rbac/access.service';
import * as as from './assets.service';

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
const viewers = needAny(['asset.manage', 'asset.view', 'asset.repair', 'asset.approve_disposal']);
const repairers = needAny(['asset.repair', 'asset.manage']);
const reporters = needAny(['asset.report', 'asset.manage', 'asset.repair']);

export const assetRoutes = Router();

assetRoutes.get('/options', authenticated, needAny(['asset.manage', 'asset.view', 'asset.repair', 'asset.approve_disposal', 'asset.report']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await as.options(), 'Options')));
assetRoutes.post('/files', authenticated, reporters, upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose a file');
    const f = await saveUpload({ data: req.file.buffer, originalName: req.file.originalname, purpose: 'document', allowed: ['jpeg', 'png', 'webp', 'pdf'] });
    successResponse(res, { id: f.id, name: f.originalName }, 'Uploaded', 201);
}));
/** A photo / bill of an asset or a problem (only files attached to assets). */
assetRoutes.get('/files/:fileId', authenticated, reporters, asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.fileId;
    const used = (await db.asset.count({ where: { OR: [{ photoFileId: id }, { billFileId: id }] } })) + (await db.assetIssue.count({ where: { photoFileId: id } }));
    if (!used) throw notFound('File not found');
    const { file, data } = await readFile(id);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true });
}));

// Everyone with an asset role.
assetRoutes.get('/mine', authenticated, needAny(['asset.mine', 'asset.report']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await as.myAssets(uid(req)), 'My assets')));
assetRoutes.get('/pick', authenticated, reporters, asyncHandler(async (req: Request, res: Response) => successResponse(res, await as.pickAssets(parse(z.object({ q: z.string().max(60).default('') }), req.query).q), 'Assets')));
assetRoutes.post('/issues', authenticated, reporters, asyncHandler(async (req: Request, res: Response) => successResponse(res, await as.reportIssue(parse(as.issueSchema, req.body), uid(req)), 'Reported', 201)));

// Repairs and maintenance.
assetRoutes.get('/issues', authenticated, needAny(['asset.repair', 'asset.manage', 'asset.view']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await as.listIssues(parse(as.issuesQuery, req.query)), 'Problems')));
assetRoutes.put('/issues/:id', authenticated, repairers, asyncHandler(async (req: Request, res: Response) => successResponse(res, await as.updateIssue(req.params.id, parse(as.updateIssueSchema, req.body), uid(req)), 'Saved')));
assetRoutes.get('/care', authenticated, needAny(['asset.repair', 'asset.manage', 'asset.view']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await as.careDue(), 'Due')));

// Writing off.
assetRoutes.get('/disposals', authenticated, needAny(['asset.approve_disposal', 'asset.manage']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await as.pendingDisposals(), 'Waiting')));
assetRoutes.post('/disposals/:id/answer', can('asset.approve_disposal'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await as.answerDisposal(req.params.id, parse(z.object({ approve: z.boolean() }), req.body).approve, uid(req)), 'Answered')));

// Verification.
assetRoutes.get('/verifications', can('asset.manage'), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await as.listVerifications(), 'Verifications')));
assetRoutes.post('/verifications', can('asset.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await as.startVerification(parse(z.object({ name: z.string().trim().max(100).default('') }), req.body).name, uid(req)), 'Started', 201)));
assetRoutes.get('/verifications/:id', can('asset.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await as.verification(req.params.id), 'Verification')));
assetRoutes.post('/verifications/:id/found', can('asset.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await as.markFound(req.params.id, parse(as.verifySchema, req.body)), 'Saved')));
assetRoutes.post('/verifications/:id/close', can('asset.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await as.closeVerification(req.params.id, parse(z.object({ moveMisplaced: z.boolean().default(false) }), req.body).moveMisplaced, uid(req)), 'Closed')));

// The register.
assetRoutes.get('/labels', authenticated, needAny(['asset.manage', 'asset.view']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await as.labels(parse(as.labelsQuery, req.query)), 'Labels')));
assetRoutes.get('/code/:code', authenticated, viewers, asyncHandler(async (req: Request, res: Response) => successResponse(res, await as.byCode(req.params.code), 'Asset')));
assetRoutes.get('/', authenticated, viewers, asyncHandler(async (req: Request, res: Response) => successResponse(res, await as.listAssets(parse(as.listQuery, req.query)), 'Assets')));
assetRoutes.post('/', can('asset.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await as.saveAsset(null, parse(as.assetSchema, req.body), uid(req)), 'Added', 201)));
assetRoutes.get('/:id', authenticated, viewers, asyncHandler(async (req: Request, res: Response) => successResponse(res, await as.assetView(req.params.id), 'Asset')));
assetRoutes.put('/:id', can('asset.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await as.saveAsset(req.params.id, parse(as.assetSchema, req.body), uid(req)), 'Saved')));
assetRoutes.post('/:id/move', can('asset.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await as.moveAsset(req.params.id, parse(as.moveSchema, req.body), uid(req)), 'Saved')));
assetRoutes.post('/:id/maintained', authenticated, repairers, asyncHandler(async (req: Request, res: Response) => successResponse(res, await as.recordMaintenance(req.params.id, parse(as.maintainSchema, req.body), uid(req)), 'Saved')));
assetRoutes.post('/:id/dispose', can('asset.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await as.requestDisposal(req.params.id, parse(as.disposalSchema, req.body), uid(req)), 'Saved')));
