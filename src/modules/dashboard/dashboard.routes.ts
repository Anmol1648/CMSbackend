import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import * as dash from './dashboard.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};
const uid = (req: Request) => req.user!.userId;

export const dashboardRoutes = Router();

// Everyone: their dashboard, and each widget's data.
dashboardRoutes.get('/', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await dash.myDashboard(uid(req)), 'Dashboard')));
dashboardRoutes.get('/widgets/:key', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ fresh: z.enum(['1']).optional(), filter: z.string().max(60).optional() }), req.query);
    successResponse(res, await dash.widgetData(req.params.key, uid(req), q.fresh === '1', q.filter), 'Widget');
}));
dashboardRoutes.get('/actions', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await dash.myActions(uid(req), req.query.fresh === '1'), 'Waiting for you')));

// Everyone: their own arrangement and shortcuts.
dashboardRoutes.get('/mine/catalogue', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await dash.myCatalogue(uid(req)), 'Widgets')));
dashboardRoutes.put('/mine', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await dash.saveMine(uid(req), parse(dash.myLayoutSchema, req.body)), 'Dashboard saved')));
dashboardRoutes.delete('/mine', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await dash.resetMine(uid(req)), 'Back to your role’s dashboard')));
dashboardRoutes.get('/mine/links', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await dash.myLinks(uid(req)), 'Shortcuts')));
dashboardRoutes.put('/mine/links', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await dash.saveLinks(uid(req), parse(dash.linksSchema, req.body)), 'Shortcuts saved')));

// Setting up each role's dashboard.
dashboardRoutes.get('/setup/catalogue', can('dashboard.setup'), asyncHandler(async (_req: Request, res: Response) => successResponse(res, dash.catalogue(), 'Widgets')));
dashboardRoutes.get('/setup/roles', can('dashboard.setup'), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await dash.rolesForSetup(), 'Roles')));
dashboardRoutes.get('/setup/roles/:roleId', can('dashboard.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await dash.roleLayout(req.params.roleId), 'Layout')));
dashboardRoutes.put('/setup/roles/:roleId', can('dashboard.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await dash.saveLayout(req.params.roleId, parse(dash.layoutSchema, req.body)), 'Dashboard saved')));
dashboardRoutes.delete('/setup/roles/:roleId', can('dashboard.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await dash.resetLayout(req.params.roleId), 'Back to the built-in dashboard')));
