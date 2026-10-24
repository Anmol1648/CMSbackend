import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, forbidden, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { readFile, saveUpload } from '../../core/files';
import { sendFile, upload } from '../../core/http/files';
import { getUserAccess } from '../rbac/access.service';
import * as dis from './discipline.service';

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
const staff = needAny(['discipline.view', 'discipline.record', 'discipline.approve']);

export const disciplineRoutes = Router();

disciplineRoutes.get('/options', authenticated, staff, asyncHandler(async (req: Request, res: Response) => successResponse(res, await dis.recordOptions(uid(req)), 'Options')));
disciplineRoutes.get('/students', can('discipline.record'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await dis.studentSearch(parse(z.object({ q: z.string().max(60).default('') }), req.query).q, uid(req)), 'Students')));
disciplineRoutes.post('/files', can('discipline.record'), upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose a file');
    const f = await saveUpload({ data: req.file.buffer, originalName: req.file.originalname, purpose: 'document', allowed: ['jpeg', 'png', 'webp', 'pdf'] });
    successResponse(res, { id: f.id, name: f.originalName }, 'Uploaded', 201);
}));
disciplineRoutes.post('/', can('discipline.record'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await dis.record(parse(dis.recordSchema, req.body), uid(req)), 'Recorded', 201)));
disciplineRoutes.get('/', authenticated, staff, asyncHandler(async (req: Request, res: Response) => successResponse(res, await dis.listIncidents(parse(dis.listQuery, req.query), uid(req)), 'Incidents')));
disciplineRoutes.get('/pending', can('discipline.approve'), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await dis.pendingActions(), 'Pending')));
disciplineRoutes.get('/student/:id', can('discipline.view'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await dis.studentConduct(req.params.id, uid(req)), 'Conduct')));

// Parents and students.
disciplineRoutes.get('/mine', can('discipline.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await dis.myConduct(uid(req)), 'Conduct')));
disciplineRoutes.post('/mine/:id/acknowledge', can('discipline.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await dis.acknowledge(req.params.id, parse(dis.ackSchema, req.body).reply, uid(req)), 'Acknowledged')));

// Actions.
disciplineRoutes.post('/actions/:id/answer', can('discipline.approve'), asyncHandler(async (req: Request, res: Response) => {
    const b = parse(z.object({ approve: z.boolean(), answer: z.string().trim().max(500).nullable().optional() }), req.body);
    successResponse(res, await dis.answerAction(req.params.id, b.approve, b.answer ?? null, uid(req)), 'Answered');
}));

// One incident.
disciplineRoutes.get('/:id', authenticated, staff, asyncHandler(async (req: Request, res: Response) => successResponse(res, await dis.incidentView(req.params.id, uid(req)), 'Incident')));
disciplineRoutes.get('/:id/files/:fileId', authenticated, staff, asyncHandler(async (req: Request, res: Response) => {
    const id = await dis.incidentFile(req.params.id, req.params.fileId, uid(req));
    const { file, data } = await readFile(id);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true });
}));
disciplineRoutes.post('/:id/actions', can('discipline.action'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await dis.addAction(req.params.id, parse(dis.actionSchema, req.body), uid(req)), 'Saved')));
disciplineRoutes.post('/:id/resolve', can('discipline.action'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await dis.resolveIncident(req.params.id, parse(z.object({ resolved: z.boolean() }), req.body).resolved, uid(req)), 'Saved')));
disciplineRoutes.post('/:id/informed', authenticated, needAny(['discipline.record', 'discipline.action']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await dis.markInformed(req.params.id, parse(dis.informedSchema, req.body), uid(req)), 'Saved')));
