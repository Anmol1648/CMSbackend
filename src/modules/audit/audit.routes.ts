import { Router, Request, Response } from 'express';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest } from '../../core/errors';
import { parseListQuery } from '../../core/http/list-query';
import { can } from '../../middlewares/access';
import { auditListSpec } from './audit.schemas';
import * as audit from './audit.service';

export const auditRoutes = Router();

auditRoutes.get('/', can('audit.view'), asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await audit.listAudit(parseListQuery(req.query, auditListSpec)), 'Audit trail');
}));

auditRoutes.get('/facets', can('audit.view'), asyncHandler(async (_req: Request, res: Response) => {
    successResponse(res, await audit.auditFacets(), 'Audit filters');
}));

auditRoutes.get('/history/:entity/:entityId', can('audit.view'), asyncHandler(async (req: Request, res: Response) => {
    if (!/^[a-z_]{2,40}$/.test(req.params.entity)) throw badRequest('Unknown record type');
    successResponse(res, await audit.recordHistory(req.params.entity, req.params.entityId), 'Record history');
}));
