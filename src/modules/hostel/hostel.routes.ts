import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { forbidden, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { getUserAccess } from '../rbac/access.service';
import * as h from './hostel.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};
const uid = (req: Request) => req.user!.userId;
const needAny = (keys: string[]) =>
    asyncHandler(async (req: Request, _res: Response, next: () => void) => {
        const a = await getUserAccess(uid(req));
        if (!keys.some((k) => a.permissions[`hostel.${k}`])) throw forbidden();
        next();
    });
const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const RUN = ['warden', 'setup', 'allot', 'view'];

export const hostelRoutes = Router();

// Hostels, rooms, beds.
hostelRoutes.get('/', authenticated, needAny(RUN), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.listHostels(uid(req)), 'Hostels')));
hostelRoutes.post('/', can('hostel.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.saveHostel(null, parse(h.hostelSchema, req.body)), 'Added', 201)));
hostelRoutes.put('/:id', can('hostel.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.saveHostel(req.params.id, parse(h.hostelSchema, req.body)), 'Saved')));
hostelRoutes.get('/:id/rooms', authenticated, needAny(RUN), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.occupancy(req.params.id, uid(req)), 'Rooms')));
hostelRoutes.post('/:id/rooms', can('hostel.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.saveRoom(req.params.id, null, parse(h.roomSchema, req.body)), 'Added', 201)));
hostelRoutes.post('/:id/rooms/bulk', can('hostel.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.addRooms(req.params.id, parse(h.bulkRoomsSchema, req.body)), 'Added', 201)));
hostelRoutes.put('/:id/rooms/:roomId', can('hostel.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.saveRoom(req.params.id, req.params.roomId, parse(h.roomSchema, req.body)), 'Saved')));
hostelRoutes.delete('/:id/rooms/:roomId', can('hostel.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.deleteRoom(req.params.roomId), 'Removed')));

// Allotment.
hostelRoutes.get('/find/students', authenticated, needAny(['allot', 'warden']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.findStudents(parse(z.object({ q: z.string().max(60).default('') }), req.query).q), 'Students')));
hostelRoutes.post('/allot', can('hostel.allot'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.allot(parse(h.allotSchema, req.body), uid(req)), 'Allotted', 201)));
hostelRoutes.post('/allotments/:id/vacate', can('hostel.allot'), asyncHandler(async (req: Request, res: Response) => {
    const b = parse(z.object({ date: D, note: z.string().trim().max(300).nullable().optional() }), req.body);
    successResponse(res, await h.vacate(req.params.id, b.date, b.note || null, uid(req)), 'Vacated');
}));

// Roll call.
hostelRoutes.get('/:id/roll-call', can('hostel.warden'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.rollCall(req.params.id, parse(z.object({ date: D }), req.query).date, uid(req)), 'Roll call')));
hostelRoutes.put('/:id/roll-call', can('hostel.warden'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.saveRollCall(req.params.id, parse(h.rollSchema, req.body), uid(req)), 'Saved')));

// Leave and the gate.
hostelRoutes.get('/leave/list', authenticated, needAny(['warden', 'view']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.listLeaves(parse(h.leavesQuery, req.query), uid(req)), 'Leave')));
hostelRoutes.post('/leave', can('hostel.warden'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.askLeave(parse(h.leaveSchema, req.body), uid(req), false), 'Saved', 201)));
hostelRoutes.post('/leave/:id/answer', can('hostel.warden'), asyncHandler(async (req: Request, res: Response) => {
    const b = parse(z.object({ approve: z.boolean(), answer: z.string().trim().max(300).nullable().optional() }), req.body);
    successResponse(res, await h.answerLeave(req.params.id, b.approve, b.answer || null, uid(req)), b.approve ? 'Approved' : 'Not approved');
}));
hostelRoutes.post('/leave/:id/cancel', authenticated, needAny(['warden', 'mine']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.cancelLeave(req.params.id, uid(req)), 'Cancelled')));
hostelRoutes.post('/gate/scan', can('hostel.gate'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.scanPass(parse(z.object({ code: z.string().trim().min(4).max(20) }), req.body).code, uid(req)), 'Done')));
hostelRoutes.get('/gate/out', can('hostel.gate'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.listLeaves({ show: 'out' }, uid(req)), 'Out')));

// Visitors, sick bay, inspections and fines.
hostelRoutes.get('/visitors/:studentId', authenticated, needAny(['warden', 'gate', 'view', 'mine']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.visitors(req.params.studentId), 'Visitors')));
hostelRoutes.post('/visitors', authenticated, needAny(['warden', 'mine']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.addVisitor(parse(h.visitorSchema, req.body), uid(req)), 'Added', 201)));
hostelRoutes.delete('/visitors/:id', authenticated, needAny(['warden', 'mine']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.removeVisitor(req.params.id, uid(req)), 'Removed')));
hostelRoutes.get('/care/medical', can('hostel.warden'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.listMedical(uid(req)), 'Sick bay')));
hostelRoutes.post('/care/medical', can('hostel.warden'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.addMedical(parse(h.medicalSchema, req.body), uid(req)), 'Saved', 201)));
hostelRoutes.get('/:id/notes', can('hostel.warden'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.listNotes(req.params.id, uid(req)), 'Notes')));
hostelRoutes.post('/notes', can('hostel.warden'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.addNote(parse(h.noteSchema, req.body), uid(req)), 'Saved', 201)));

// Parents and students.
hostelRoutes.get('/mine/view', can('hostel.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.myHostel(uid(req)), 'My hostel')));
hostelRoutes.post('/mine/leave', can('hostel.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await h.askLeave(parse(h.leaveSchema, req.body), uid(req), true), 'Sent', 201)));
