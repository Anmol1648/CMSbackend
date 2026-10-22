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
dashboardRoutes.get('/widgets/:key', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await dash.widgetData(req.params.key, uid(req), req.query.fresh === '1'), 'Widget')));

// Setting up each role's dashboard.
dashboardRoutes.get('/setup/catalogue', can('dashboard.setup'), asyncHandler(async (_req: Request, res: Response) => successResponse(res, dash.catalogue(), 'Widgets')));
dashboardRoutes.get('/setup/roles', can('dashboard.setup'), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await dash.rolesForSetup(), 'Roles')));
dashboardRoutes.get('/setup/roles/:roleId', can('dashboard.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await dash.roleLayout(req.params.roleId), 'Layout')));
dashboardRoutes.put('/setup/roles/:roleId', can('dashboard.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await dash.saveLayout(req.params.roleId, parse(dash.layoutSchema, req.body)), 'Dashboard saved')));
dashboardRoutes.delete('/setup/roles/:roleId', can('dashboard.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await dash.resetLayout(req.params.roleId), 'Back to the built-in dashboard')));
