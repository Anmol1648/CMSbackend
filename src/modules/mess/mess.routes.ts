import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { forbidden, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { getUserAccess } from '../rbac/access.service';
import { todayIST } from '../attendance/attendance.settings';
import * as m from './mess.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};
const uid = (req: Request) => req.user!.userId;
const needAny = (keys: string[]) =>
    asyncHandler(async (req: Request, _res: Response, next: () => void) => {
        const a = await getUserAccess(uid(req));
        if (!keys.some((k) => a.permissions[`mess.${k}`])) throw forbidden();
        next();
    });
const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const STAFF = ['manage', 'view', 'setup', 'counter'];

export const messRoutes = Router();

messRoutes.get('/today', authenticated, needAny(STAFF), asyncHandler(async (req: Request, res: Response) => successResponse(res, await m.today(parse(z.object({ date: D.optional() }), req.query).date ?? todayIST()), 'Today')));
messRoutes.get('/meals', authenticated, needAny([...STAFF, 'mine']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await m.meals(), 'Meals')));

// Plans and the menu.
messRoutes.get('/plans', authenticated, needAny(STAFF), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await m.listPlans(), 'Plans')));
messRoutes.post('/plans', can('mess.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await m.savePlan(null, parse(m.planSchema, req.body)), 'Added', 201)));
messRoutes.put('/plans/:id', can('mess.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await m.savePlan(req.params.id, parse(m.planSchema, req.body)), 'Saved')));
messRoutes.get('/menu', authenticated, needAny([...STAFF, 'mine']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await m.getMenu(), 'Menu')));
messRoutes.put('/menu', can('mess.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await m.saveMenu(parse(m.menuSchema, req.body)), 'Saved')));
messRoutes.post('/menu/special', authenticated, needAny(['setup', 'manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await m.saveSpecial(parse(m.specialSchema, req.body)), 'Saved')));
messRoutes.delete('/menu/special/:id', authenticated, needAny(['setup', 'manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await m.deleteSpecial(req.params.id), 'Removed')));

// Members.
messRoutes.get('/members', authenticated, needAny(['manage', 'view']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await m.listMembers(parse(m.membersQuery, req.query)), 'Members')));
messRoutes.get('/people', authenticated, needAny(['manage', 'counter']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await m.findPeople(parse(z.object({ q: z.string().max(60).default('') }), req.query).q), 'People')));
messRoutes.post('/members', can('mess.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await m.subscribe(parse(m.subscribeSchema, req.body), uid(req)), 'Added', 201)));
messRoutes.post('/members/:id/end', can('mess.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await m.endSubscription(req.params.id, parse(z.object({ date: D }), req.body).date), 'Ended')));
messRoutes.post('/skip', can('mess.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await m.setSkip(parse(m.skipSchema, req.body), uid(req), true), 'Saved')));

// The counter.
messRoutes.get('/counter', authenticated, needAny(['counter', 'manage']), asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ date: D.optional(), mealId: z.uuid() }), req.query);
    successResponse(res, await m.counterList(q.date ?? todayIST(), q.mealId), 'Counter');
}));
messRoutes.post('/serve', authenticated, needAny(['counter', 'manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await m.serve(parse(m.serveSchema, req.body), uid(req)), 'Served')));
messRoutes.delete('/serve/:id', authenticated, needAny(['counter', 'manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await m.unserve(req.params.id), 'Removed')));
messRoutes.post('/guests', authenticated, needAny(['counter', 'manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await m.addGuest(parse(m.guestSchema, req.body), uid(req)), 'Added', 201)));

// Members themselves and parents.
messRoutes.get('/mine', can('mess.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await m.myMess(uid(req)), 'My mess')));
messRoutes.post('/mine/skip', can('mess.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await m.setSkip(parse(m.skipSchema, req.body), uid(req), false), 'Saved')));
messRoutes.post('/mine/rate', can('mess.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await m.rate(parse(m.rateSchema, req.body), uid(req)), 'Thank you')));
