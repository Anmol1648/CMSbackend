import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { forbidden, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { getUserAccess } from '../rbac/access.service';
import * as promotion from './promotion.service';
import * as tc from './tc.service';

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

// ─── Promotion ───────────────────────────────────────────────────────────────

export const promotionRoutes = Router();
const manage = can('promotion.manage');

promotionRoutes.get('/', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await promotion.promotionOverview(parse(promotion.overviewQuery, req.query).year), 'Promotion')));
promotionRoutes.get('/section', manage, asyncHandler(async (req: Request, res: Response) => {
    const q = parse(promotion.sectionQuery, req.query);
    successResponse(res, await promotion.sectionPromotion(q.year, q.section), 'Section');
}));
promotionRoutes.post('/', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await promotion.promote(parse(promotion.promoteSchema, req.body), uid(req)), 'Done')));
promotionRoutes.post('/undo', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await promotion.undoPromotion(parse(promotion.undoSchema, req.body)), 'Undone')));

// ─── Transfer certificates ───────────────────────────────────────────────────

export const tcRoutes = Router();
const office = can('tc.manage');
const anyTc = needAny(['tc.manage', 'tc.clear']);

tcRoutes.get('/', authenticated, anyTc, asyncHandler(async (req: Request, res: Response) => successResponse(res, await tc.listTcs(parse(tc.listQuery, req.query)), 'Transfer certificates')));
tcRoutes.post('/', office, asyncHandler(async (req: Request, res: Response) => successResponse(res, await tc.requestTc(parse(tc.requestSchema, req.body), uid(req)), 'TC asked for', 201)));
tcRoutes.get('/student/:studentId', authenticated, anyTc, asyncHandler(async (req: Request, res: Response) => {
    const list = await tc.listTcs({ status: 'all' });
    successResponse(res, list.filter((t) => t.student.id === req.params.studentId), 'TCs of the student');
}));
tcRoutes.get('/:id', authenticated, anyTc, asyncHandler(async (req: Request, res: Response) => successResponse(res, await tc.getTc(req.params.id), 'TC')));
tcRoutes.put('/:id', office, asyncHandler(async (req: Request, res: Response) => successResponse(res, await tc.updateTc(req.params.id, parse(tc.updateSchema, req.body)), 'Saved')));
tcRoutes.post('/:id/clearances', authenticated, anyTc, asyncHandler(async (req: Request, res: Response) => successResponse(res, await tc.setClearance(req.params.id, parse(z.strictObject({ clearanceId: z.uuid(), done: z.boolean() }), req.body), uid(req)), 'Saved')));
tcRoutes.post('/:id/issue', office, asyncHandler(async (req: Request, res: Response) => successResponse(res, await tc.issueTc(req.params.id, uid(req)), 'TC issued')));
tcRoutes.post('/:id/cancel', office, asyncHandler(async (req: Request, res: Response) => successResponse(res, await tc.cancelTc(req.params.id, parse(z.strictObject({ note: z.string().trim().min(3, 'say why').max(300) }), req.body).note), 'TC cancelled')));
