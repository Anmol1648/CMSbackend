import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, forbidden, notFound, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { getUserAccess } from '../rbac/access.service';
import * as setup from './setup.service';
import * as track from './tracking.service';
import * as gps from './gps.service';
import { readFile, saveUpload } from '../../core/files';
import { sendFile, upload } from '../../core/http/files';
import { getTenantId } from '../../core/context';

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
const viewers = needAny(['transport.view', 'transport.manage', 'transport.track_all']);
const manage = can('transport.manage');

export const transportRoutes = Router();

// Set-up.
transportRoutes.get('/vehicles', authenticated, viewers, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await setup.listVehicles(), 'Vehicles')));
transportRoutes.post('/vehicles', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.saveVehicle(null, parse(setup.vehicleSchema, req.body), uid(req)), 'Saved', 201)));
transportRoutes.put('/vehicles/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.saveVehicle(req.params.id, parse(setup.vehicleSchema, req.body), uid(req)), 'Saved')));
transportRoutes.delete('/vehicles/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.deleteVehicle(req.params.id), 'Deleted')));
transportRoutes.get('/vehicles/:id/documents', authenticated, viewers, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.listDocuments(req.params.id), 'Papers')));
transportRoutes.post('/vehicles/:id/documents', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.addDocument(req.params.id, parse(setup.documentSchema, req.body)), 'Added', 201)));
transportRoutes.post('/files', manage, upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose a file');
    const f = await saveUpload({ data: req.file.buffer, originalName: req.file.originalname, purpose: 'transport', allowed: ['pdf', 'png', 'jpeg'] });
    successResponse(res, { id: f.id, name: f.originalName }, 'Uploaded', 201);
}));
transportRoutes.get('/documents/:id/file', authenticated, viewers, asyncHandler(async (req: Request, res: Response) => {
    const doc = await setup.paperFile(req.params.id);
    if (!doc) throw notFound('No scan for this paper');
    const { file, data } = await readFile(doc);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true });
}));
transportRoutes.put('/documents/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.updateDocument(req.params.id, parse(setup.documentSchema, req.body)), 'Saved')));
transportRoutes.delete('/documents/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.deleteDocument(req.params.id), 'Deleted')));

transportRoutes.get('/routes', authenticated, viewers, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await setup.listRoutes(), 'Routes')));
transportRoutes.post('/routes', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.saveRoute(null, parse(setup.routeSchema, req.body)), 'Saved', 201)));
transportRoutes.put('/routes/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.saveRoute(req.params.id, parse(setup.routeSchema, req.body)), 'Saved')));
transportRoutes.delete('/routes/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.deleteRoute(req.params.id), 'Deleted')));
transportRoutes.post('/routes/:id/stops', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.addStop(req.params.id, parse(setup.stopSchema, req.body)), 'Added', 201)));
transportRoutes.put('/stops/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.updateStop(req.params.id, parse(setup.stopSchema, req.body)), 'Saved')));
transportRoutes.delete('/stops/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.deleteStop(req.params.id), 'Deleted')));
transportRoutes.post('/stops/:id/move', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.moveStop(req.params.id, parse(z.strictObject({ direction: z.enum(['up', 'down']) }), req.body).direction), 'Moved')));
transportRoutes.get('/staff', manage, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await setup.staffOptions(), 'Staff')));

transportRoutes.get('/students', authenticated, viewers, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.listStudents(parse(setup.studentsQuery, req.query)), 'Students')));
transportRoutes.post('/students/assign', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.assignStudents(parse(setup.assignSchema, req.body), uid(req)), 'Saved')));
transportRoutes.post('/students/end', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.endTransport(parse(setup.endSchema, req.body)), 'Saved')));

// Live tracking.
const driver = can('transport.drive');
const watchAll = can('transport.track_all');
transportRoutes.get('/live', watchAll, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await track.liveAll(), 'Live')));
transportRoutes.get('/trips', watchAll, asyncHandler(async (req: Request, res: Response) => successResponse(res, await track.listTrips(parse(track.tripsQuery, req.query)), 'Trips')));
transportRoutes.get('/trips/:id', authenticated, needAny(['transport.track_all', 'transport.drive']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await track.tripView(req.params.id), 'Trip')));
transportRoutes.post('/simulate', watchAll, asyncHandler(async (req: Request, res: Response) => {
    const b = parse(z.strictObject({ routeId: z.uuid(), kind: z.enum(['morning', 'afternoon']) }), req.body);
    successResponse(res, await track.simulate(b.routeId, b.kind, uid(req)), 'Started', 201);
}));
transportRoutes.get('/drive', driver, asyncHandler(async (req: Request, res: Response) => successResponse(res, await track.myDriving(uid(req)), 'My trips')));
transportRoutes.post('/trips', driver, asyncHandler(async (req: Request, res: Response) => successResponse(res, await track.startTrip(parse(track.startSchema, { ...req.body, source: 'phone' }), uid(req)), 'Started', 201)));
transportRoutes.post('/trips/:id/ping', driver, asyncHandler(async (req: Request, res: Response) => successResponse(res, await track.ping(req.params.id, parse(track.pingSchema, req.body), uid(req)), 'Saved')));
transportRoutes.post('/trips/:id/board', driver, asyncHandler(async (req: Request, res: Response) => successResponse(res, await track.board(req.params.id, parse(track.boardSchema, req.body), uid(req)), 'Saved')));
transportRoutes.post('/trips/:id/sos', driver, asyncHandler(async (req: Request, res: Response) => successResponse(res, await track.sos(req.params.id, parse(track.sosSchema, req.body).note, uid(req)), 'Sent')));
transportRoutes.post('/trips/:id/end', authenticated, needAny(['transport.track_all', 'transport.drive']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await track.endTrip(req.params.id, uid(req)), 'Ended')));
transportRoutes.get('/my-bus', can('transport.track_mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await track.myBus(uid(req)), 'My bus')));

// GPS devices and Google Maps.
const setupOnly = can('transport.setup');
transportRoutes.get('/connect', setupOnly, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await gps.connectInfo(), 'GPS & Maps')));
transportRoutes.put('/connect', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await gps.saveConnect(parse(gps.connectSchema, req.body), uid(req)), 'Saved')));
transportRoutes.post('/connect/test', setupOnly, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await gps.testGps(), 'Read')));
transportRoutes.get('/map', authenticated, needAny(['transport.view', 'transport.manage', 'transport.track_all', 'transport.drive', 'transport.track_mine', 'transport.setup']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await gps.mapTiles(getTenantId()!), 'Map')));
