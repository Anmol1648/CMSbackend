import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import * as dash from './dashboard.service';
import * as cw from './custom-widgets.service';

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
dashboardRoutes.get('/setup/catalogue', can('dashboard.setup'), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await dash.fullCatalogue(), 'Widgets')));

// The Widget Builder: widgets the school makes itself.
dashboardRoutes.get('/builder/sources', can('dashboard.build'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await cw.builderSources(uid(req)), 'Data')));
dashboardRoutes.get('/builder/roles', can('dashboard.build'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await cw.builderRoles(uid(req)), 'Roles')));
dashboardRoutes.post('/builder/preview', can('dashboard.build'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await cw.previewWidget(parse(z.object({ definition: cw.widgetDefinitionSchema }), req.body).definition, uid(req)), 'Preview')));
dashboardRoutes.get('/builder/widgets', can('dashboard.build'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await cw.listCustomWidgets(uid(req)), 'Widgets')));
dashboardRoutes.get('/builder/widgets/:id', can('dashboard.build'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await cw.getCustomWidget(req.params.id, uid(req)), 'Widget')));
dashboardRoutes.post('/builder/widgets', can('dashboard.build'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await cw.createCustomWidget(parse(cw.customWidgetSchema, req.body), uid(req)), 'Widget made', 201)));
dashboardRoutes.put('/builder/widgets/:id', can('dashboard.build'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await cw.updateCustomWidget(req.params.id, parse(cw.customWidgetSchema, req.body), uid(req)), 'Widget saved')));
dashboardRoutes.delete('/builder/widgets/:id', can('dashboard.build'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await cw.deleteCustomWidget(req.params.id, uid(req)), 'Widget deleted')));
dashboardRoutes.get('/setup/roles', can('dashboard.setup'), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await dash.rolesForSetup(), 'Roles')));
dashboardRoutes.get('/setup/roles/:roleId', can('dashboard.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await dash.roleLayout(req.params.roleId), 'Layout')));
dashboardRoutes.put('/setup/roles/:roleId', can('dashboard.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await dash.saveLayout(req.params.roleId, parse(dash.layoutSchema, req.body)), 'Dashboard saved')));
dashboardRoutes.delete('/setup/roles/:roleId', can('dashboard.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await dash.resetLayout(req.params.roleId), 'Back to the built-in dashboard')));
