import { Router, Request, Response } from 'express';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, notFound, validationError } from '../../core/errors';
import { sendFile, upload } from '../../core/http/files';
import { runAsTenant } from '../../core/context';
import { authenticated, can, publicRoute } from '../../middlewares/access';
import { findTenantByCode } from '../tenants';
import { updateSchoolProfileSchema } from './school-profile.schemas';
import * as service from './school-profile.service';
import { SCHOOL_IMAGES, SchoolImage } from './school-profile.service';

export const schoolProfileRoutes = Router();

schoolProfileRoutes.get('/', authenticated, asyncHandler(async (_req: Request, res: Response) => {
    successResponse(res, await service.getSchoolProfile(), 'School profile');
}));

schoolProfileRoutes.patch('/', can('school_profile.update'), asyncHandler(async (req: Request, res: Response) => {
    const parsed = updateSchoolProfileSchema.safeParse(req.body);
    if (!parsed.success) throw validationError(parsed.error);
    successResponse(res, await service.updateSchoolProfile(parsed.data), 'School profile saved');
}));

const slotOf = (req: Request): SchoolImage => {
    const slot = req.params.slot as SchoolImage;
    if (!(slot in SCHOOL_IMAGES)) throw notFound('Unknown image');
    return slot;
};

// /logo and /login-background
schoolProfileRoutes.post('/:slot(logo|login-background)', can('school_profile.update'), upload.single('image'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose an image (PNG, JPG or WebP)');
    successResponse(res, await service.setSchoolImage(slotOf(req), { data: req.file.buffer, originalName: req.file.originalname }), 'Image saved');
}));

schoolProfileRoutes.delete('/:slot(logo|login-background)', can('school_profile.update'), asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await service.removeSchoolImage(slotOf(req)), 'Image removed');
}));

/** Branding for the sign-in page (no login needed). */
export const publicSchoolRoutes = Router();

publicSchoolRoutes.get('/', publicRoute, asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await service.getPublicBranding(req.hostTenant), 'School');
}));

// <img> requests carry no Origin header, so the URL names the school (?school=<code>); these images are public anyway.
publicSchoolRoutes.get('/:slot(logo|login-background)', publicRoute, asyncHandler(async (req: Request, res: Response) => {
    const slot = slotOf(req);
    const code = typeof req.query.school === 'string' ? req.query.school.toLowerCase() : null;
    const tenant = code && /^[a-z0-9-]{2,40}$/.test(code) ? await findTenantByCode(code) : null;
    const load = () => service.schoolImage(slot);
    const { file, data } = tenant?.status === 'active' ? await runAsTenant(tenant.id, load) : await load();
    // Public branding: any page (even on another domain) may show it.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    sendFile(res, file.originalName, file.mimeType, data, { inline: true, cacheSeconds: 86_400 });
}));
