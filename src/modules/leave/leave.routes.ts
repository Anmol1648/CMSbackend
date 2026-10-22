import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, forbidden, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { sendFile, upload } from '../../core/http/files';
import { readFile, saveUpload } from '../../core/files';
import { getUserAccess } from '../rbac/access.service';
import * as types from './leave-types.service';
import * as balances from './balances.service';
import * as leave from './staff-leave.service';

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

const ANY = ['leave.apply', 'leave.approve', 'leave.approve_all', 'leave.view', 'leave.manage', 'leave.setup'];
const APPROVERS = ['leave.approve', 'leave.approve_all'];
const yearQuery = z.object({ year: z.iso.date().optional() });

export const leaveRoutes = Router();

// Leave years and types (for every form and filter).
leaveRoutes.get('/years', authenticated, needAny(ANY), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await balances.leaveYears(), 'Leave years')));
leaveRoutes.get('/types', authenticated, needAny(ANY), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await types.leaveTypes(), 'Leave types')));
leaveRoutes.post('/types', can('leave.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await types.createType(parse(types.typeSchema, req.body)), 'Leave type added', 201)));
leaveRoutes.put('/types/:id', can('leave.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await types.updateType(req.params.id, parse(types.typeSchema, req.body)), 'Leave type saved')));
leaveRoutes.post('/types/:id/move', can('leave.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await types.moveType(req.params.id, parse(z.object({ direction: z.enum(['up', 'down']) }), req.body).direction), 'Moved')));
leaveRoutes.delete('/types/:id', can('leave.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await types.deleteType(req.params.id), 'Leave type removed')));

// The person themself.
leaveRoutes.get('/mine', can('leave.apply'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await leave.myLeave(uid(req), parse(yearQuery, req.query).year), 'My leave')));
leaveRoutes.post('/preview', authenticated, needAny(['leave.apply', 'leave.manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await leave.previewLeave(parse(leave.applySchema, req.body), uid(req)), 'Preview')));
leaveRoutes.post('/', authenticated, needAny(['leave.apply', 'leave.manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await leave.applyLeave(parse(leave.applySchema, req.body), uid(req)), 'Leave asked', 201)));
leaveRoutes.post('/attachments', authenticated, needAny(['leave.apply', 'leave.manage']), upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose the certificate (PDF, PNG or JPG)');
    const f = await saveUpload({ data: req.file.buffer, originalName: req.file.originalname, purpose: 'document', allowed: ['pdf', 'png', 'jpeg'] });
    successResponse(res, { id: f.id, name: f.originalName }, 'Uploaded', 201);
}));
leaveRoutes.post('/:id/cancel', authenticated, needAny(ANY), asyncHandler(async (req: Request, res: Response) => successResponse(res, await leave.cancelLeave(req.params.id, uid(req)), 'Cancelled')));
leaveRoutes.get('/:id/attachment', authenticated, needAny(ANY), asyncHandler(async (req: Request, res: Response) => {
    const { file, data } = await readFile(await leave.attachmentOf(req.params.id, uid(req)));
    sendFile(res, file.originalName, file.mimeType, data, { inline: true });
}));

// Approvers.
leaveRoutes.get('/approvals', authenticated, needAny(APPROVERS), asyncHandler(async (req: Request, res: Response) => successResponse(res, await leave.approvals(parse(leave.approvalsQuery, req.query), uid(req)), 'Approvals')));
leaveRoutes.post('/:id/decide', authenticated, needAny(APPROVERS), asyncHandler(async (req: Request, res: Response) => successResponse(res, await leave.decideLeave(req.params.id, parse(leave.decideSchema, req.body), uid(req)), 'Saved')));

// Everyone's leave and balances.
leaveRoutes.get('/register', can('leave.view'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await leave.leaveRegister(parse(leave.registerQuery, req.query), uid(req)), 'Leave register')));
leaveRoutes.get('/away', authenticated, needAny(['leave.view', 'leave.approve', 'leave.approve_all']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await leave.awayOn(parse(z.object({ date: z.iso.date().optional() }), req.query).date), 'Away')));
leaveRoutes.get('/balances', can('leave.view'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await balances.balanceSheet(parse(balances.balancesQuery, req.query)), 'Balances')));
leaveRoutes.get('/balances/:staffId', can('leave.view'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await balances.staffBalance(req.params.staffId, parse(yearQuery, req.query).year), 'Balance')));

// HR: adjustments, comp-offs, the year end.
leaveRoutes.post('/adjustments', can('leave.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await balances.adjustBalance(parse(balances.adjustSchema, req.body)), 'Balance adjusted', 201)));
leaveRoutes.post('/comp-offs', can('leave.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await balances.grantCompOff(parse(balances.compOffSchema, req.body)), 'Comp-off given', 201)));
leaveRoutes.get('/comp-offs/suggestions', can('leave.manage'), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await balances.compOffSuggestions(), 'Worked on a day off')));
leaveRoutes.delete('/entries/:id', can('leave.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await balances.removeEntry(req.params.id), 'Removed')));
leaveRoutes.get('/year-end', can('leave.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await balances.yearEndPreview(parse(z.object({ year: z.iso.date() }), req.query).year), 'Year end')));
leaveRoutes.post('/year-end', can('leave.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await balances.closeYear(parse(z.object({ year: z.iso.date() }), req.body).year), 'Leave year closed')));
leaveRoutes.post('/year-end/undo', can('leave.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await balances.undoCloseYear(parse(z.object({ year: z.iso.date() }), req.body).year), 'Undone')));
