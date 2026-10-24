import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { forbidden, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { getUserAccess } from '../rbac/access.service';
import { db } from '../../core/db';
import { isoOf } from '../attendance/attendance.settings';
import * as ptm from './ptm.service';

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
const manage = can('ptm.manage');
const desk = needAny(['ptm.desk', 'ptm.manage']);

export const ptmRoutes = Router();

// Planning (office / principal).
ptmRoutes.get('/', manage, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await ptm.listPtms(), 'PTMs')));
ptmRoutes.get('/defaults', manage, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await ptm.ptmDefaults(), 'Defaults')));
// For report filters: the PTMs of the school (newest first).
ptmRoutes.get('/options', authenticated, needAny(['ptm.manage', 'ptm.desk']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, (await db.ptm.findMany({ where: { status: { in: ['published', 'done'] } }, orderBy: { date: 'desc' }, take: 50, select: { id: true, title: true, date: true } })).map((p) => ({ id: p.id, label: `${p.title} (${isoOf(p.date)})` })), 'PTMs')));
ptmRoutes.post('/', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await ptm.savePtm(null, parse(ptm.ptmSchema, req.body), uid(req)), 'Saved', 201)));

// Parents (and students).
ptmRoutes.get('/mine', can('ptm.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ptm.myPtms(uid(req)), 'My PTMs')));
ptmRoutes.post('/mine/book', can('ptm.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ptm.book(parse(ptm.bookSchema, req.body), uid(req)), 'Booked', 201)));
ptmRoutes.post('/mine/cancel/:id', can('ptm.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ptm.cancelBooking(req.params.id, uid(req)), 'Cancelled')));

// Teachers.
ptmRoutes.get('/meet', can('ptm.meet'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ptm.myMeetings(uid(req), parse(z.object({ ptm: z.uuid().optional() }), req.query).ptm), 'My meetings')));
ptmRoutes.put('/meet/:ptmId/:studentId', can('ptm.meet'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ptm.saveMeeting(req.params.ptmId, req.params.studentId, parse(ptm.meetingSchema, req.body), uid(req)), 'Saved')));

// The desk.
ptmRoutes.get('/desk', authenticated, desk, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await ptm.deskPtms(), 'PTMs')));
ptmRoutes.get('/desk/:id', authenticated, desk, asyncHandler(async (req: Request, res: Response) => successResponse(res, await ptm.deskBoard(req.params.id), 'Board')));
ptmRoutes.get('/desk/:id/search', authenticated, desk, asyncHandler(async (req: Request, res: Response) => successResponse(res, await ptm.deskSearch(req.params.id, parse(z.object({ q: z.string().max(60).default('') }), req.query).q), 'Students')));
ptmRoutes.get('/desk/:id/family/:studentId', authenticated, desk, asyncHandler(async (req: Request, res: Response) => successResponse(res, await ptm.deskFamily(req.params.id, req.params.studentId), 'Family')));
ptmRoutes.post('/desk/:id/check-in', authenticated, desk, asyncHandler(async (req: Request, res: Response) => successResponse(res, await ptm.checkIn(req.params.id, parse(ptm.checkInSchema, req.body), uid(req)), 'Checked in')));

// One PTM (after the fixed paths above).
ptmRoutes.get('/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await ptm.getPtm(req.params.id), 'PTM')));
ptmRoutes.put('/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await ptm.savePtm(req.params.id, parse(ptm.ptmSchema, req.body), uid(req)), 'Saved')));
ptmRoutes.delete('/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await ptm.deletePtm(req.params.id), 'Deleted')));
ptmRoutes.get('/:id/meetings', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await ptm.ptmMeetings(req.params.id), 'Meetings')));
ptmRoutes.put('/:id/teachers/:staffId', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await ptm.setTeacher(req.params.id, req.params.staffId, parse(ptm.teacherSchema, req.body)), 'Saved')));
ptmRoutes.post('/:id/publish', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await ptm.publishPtm(req.params.id, uid(req)), 'Published')));
ptmRoutes.post('/:id/cancel', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await ptm.cancelPtm(req.params.id, parse(z.object({ reason: z.string().trim().min(3, 'is required').max(300) }), req.body).reason), 'Cancelled')));
ptmRoutes.post('/:id/complete', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await ptm.completePtm(req.params.id), 'Closed')));
