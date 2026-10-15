import { Router, Request, Response } from 'express';
import { asyncHandler, successResponse } from '../../core/index';
import { validationError } from '../../core/errors';
import { authenticated, can, publicRoute } from '../../middlewares/access';
import { updateSchoolProfileSchema } from './school-profile.schemas';
import * as service from './school-profile.service';

export const schoolProfileRoutes = Router();

schoolProfileRoutes.get('/', authenticated, asyncHandler(async (_req: Request, res: Response) => {
    successResponse(res, await service.getSchoolProfile(), 'School profile');
}));

schoolProfileRoutes.patch('/', can('school_profile.update'), asyncHandler(async (req: Request, res: Response) => {
    const parsed = updateSchoolProfileSchema.safeParse(req.body);
    if (!parsed.success) throw validationError(parsed.error);
    successResponse(res, await service.updateSchoolProfile(parsed.data), 'School profile saved');
}));

/** Branding for the sign-in page (no login needed). */
export const publicSchoolRoutes = Router();

publicSchoolRoutes.get('/', publicRoute, asyncHandler(async (_req: Request, res: Response) => {
    successResponse(res, await service.getPublicBranding(), 'School');
}));
