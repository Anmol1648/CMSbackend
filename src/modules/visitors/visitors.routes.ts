import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, forbidden, notFound, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { readFile, saveUpload } from '../../core/files';
import { sendFile, upload } from '../../core/http/files';
import { getUserAccess } from '../rbac/access.service';
import * as gate from './visitors.service';
import * as pickup from './pickup.service';

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
const atGate = can('visitor.gate');
const office = needAny(['visitor.gate', 'visitor.view', 'visitor.manage']);
const manage = can('visitor.manage');
const sendPhoto = async (res: Response, fileId: string | null) => {
    if (!fileId) throw notFound('No photo');
    const { file, data } = await readFile(fileId);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true, cacheSeconds: 3600 });
};

export const visitorRoutes = Router();

// Photos (taken at the gate, or by a parent for the pickup list).
visitorRoutes.post('/photos', authenticated, needAny(['visitor.gate', 'visitor.manage', 'visitor.pickup_mine']), upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose a photo');
    const f = await saveUpload({ data: req.file.buffer, originalName: req.file.originalname || 'photo.jpg', purpose: 'visitor', allowed: ['jpeg', 'png', 'webp'] });
    successResponse(res, { id: f.id }, 'Uploaded', 201);
}));
visitorRoutes.get('/visits/:id/photo', authenticated, office, asyncHandler(async (req: Request, res: Response) => sendPhoto(res, await gate.visitPhoto(req.params.id))));
visitorRoutes.get('/visitors/:id/photo', authenticated, office, asyncHandler(async (req: Request, res: Response) => sendPhoto(res, await gate.visitorPhoto(req.params.id))));
visitorRoutes.get('/students/:id/photo', authenticated, office, asyncHandler(async (req: Request, res: Response) => sendPhoto(res, await pickup.studentPhoto(req.params.id))));
visitorRoutes.get('/pickups/:id/photo', authenticated, office, asyncHandler(async (req: Request, res: Response) => sendPhoto(res, await pickup.pickupPhoto(req.params.id))));
visitorRoutes.get('/people/:id/photo', authenticated, needAny(['visitor.gate', 'visitor.view', 'visitor.manage', 'visitor.pickup_mine']), asyncHandler(async (req: Request, res: Response) => sendPhoto(res, await pickup.personPhoto(req.params.id, uid(req)))));

// The gate.
visitorRoutes.get('/setup', authenticated, needAny(['visitor.gate', 'visitor.view', 'visitor.expect']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await gate.gateSetup(), 'Setup')));
visitorRoutes.get('/today', atGate, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await gate.gateToday(), 'Today')));
visitorRoutes.get('/lookup', atGate, asyncHandler(async (req: Request, res: Response) => successResponse(res, await gate.lookup(parse(z.object({ mobile: z.string().max(20) }), req.query).mobile), 'Visitor')));
visitorRoutes.get('/hosts', atGate, asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ kind: z.enum(['staff', 'student']), q: z.string().max(60).default('') }), req.query);
    successResponse(res, await gate.hostSearch(q.kind, q.q), 'Hosts');
}));
visitorRoutes.post('/enter', atGate, asyncHandler(async (req: Request, res: Response) => successResponse(res, await gate.enter(parse(gate.entrySchema, req.body), uid(req)), 'In', 201)));
visitorRoutes.post('/out', atGate, asyncHandler(async (req: Request, res: Response) => successResponse(res, await gate.checkOut(parse(z.object({ key: z.string().trim().min(3).max(60) }), req.body).key, uid(req)), 'Out')));
visitorRoutes.get('/visits/:id', authenticated, needAny(['visitor.gate', 'visitor.view', 'visitor.expect']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await gate.visitView(req.params.id), 'Visit')));
visitorRoutes.get('/visits/:id/pass', atGate, asyncHandler(async (req: Request, res: Response) => successResponse(res, await gate.pass(req.params.id), 'Pass')));

// Staff: their visitors.
visitorRoutes.get('/mine', can('visitor.expect'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await gate.myVisitors(uid(req)), 'My visitors')));
visitorRoutes.post('/expect', can('visitor.expect'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await gate.expect(parse(gate.expectSchema, req.body), uid(req)), 'Saved', 201)));
visitorRoutes.delete('/expect/:id', can('visitor.expect'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await gate.cancelExpected(req.params.id, uid(req)), 'Removed')));
visitorRoutes.post('/visits/:id/answer', authenticated, needAny(['visitor.expect', 'visitor.manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await gate.answer(req.params.id, parse(gate.answerSchema, req.body), uid(req)), 'Answered')));

// The log and the blacklist.
visitorRoutes.get('/log', can('visitor.view'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await gate.visitLog(parse(gate.logQuery, req.query)), 'Log')));
visitorRoutes.get('/blacklist', manage, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await gate.blacklist(), 'Blacklist')));
visitorRoutes.post('/blacklist', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await gate.setBlacklist(parse(gate.blacklistSchema, req.body), uid(req)), 'Saved')));

// Student pickup.
visitorRoutes.get('/pickup/today', authenticated, needAny(['visitor.gate', 'visitor.manage']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await pickup.pickupsToday(), 'Pickups')));
visitorRoutes.get('/pickup/student/:id', authenticated, needAny(['visitor.gate', 'visitor.manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pickup.gateStudent(req.params.id), 'Student')));
visitorRoutes.post('/pickup', authenticated, needAny(['visitor.gate', 'visitor.manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pickup.recordPickup(parse(pickup.pickupSchema, req.body), uid(req)), 'Saved', 201)));
visitorRoutes.post('/pickup/:id/answer', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await pickup.answerPickup(req.params.id, parse(z.object({ allow: z.boolean() }), req.body).allow, uid(req)), 'Answered')));

// Pickup lists (the office, or the parents for their own children).
visitorRoutes.get('/pickup/mine', can('visitor.pickup_mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pickup.myPickup(uid(req)), 'My pickup list')));
visitorRoutes.post('/pickup/student/:id/people', authenticated, needAny(['visitor.manage', 'visitor.pickup_mine']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pickup.addPerson(req.params.id, parse(pickup.personSchema, req.body), uid(req)), 'Added', 201)));
visitorRoutes.put('/pickup/people/:id', authenticated, needAny(['visitor.manage', 'visitor.pickup_mine']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pickup.updatePerson(req.params.id, parse(pickup.personSchema, req.body), uid(req)), 'Saved')));
visitorRoutes.delete('/pickup/people/:id', authenticated, needAny(['visitor.manage', 'visitor.pickup_mine']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pickup.removePerson(req.params.id, uid(req)), 'Removed')));
