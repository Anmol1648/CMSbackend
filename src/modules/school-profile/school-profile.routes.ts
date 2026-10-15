import { Router, Request, Response } from 'express';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, validationError } from '../../core/errors';
import { sendFile, upload } from '../../core/http/files';
import { authenticated, can, publicRoute } from '../../middlewares/access';
import { updateSchoolProfileSchema } from './school-profile.schemas';
import * as service from './school-profile.service';
import { runAsTenant } from '../../core/context';
import { findTenantByCode } from '../tenants';

export const schoolProfileRoutes = Router();

schoolProfileRoutes.get('/', authenticated, asyncHandler(async (_req: Request, res: Response) => {
    successResponse(res, await service.getSchoolProfile(), 'School profile');
}));

schoolProfileRoutes.patch('/', can('school_profile.update'), asyncHandler(async (req: Request, res: Response) => {
    const parsed = updateSchoolProfileSchema.safeParse(req.body);
    if (!parsed.success) throw validationError(parsed.error);
    successResponse(res, await service.updateSchoolProfile(parsed.data), 'School profile saved');
}));

schoolProfileRoutes.post('/logo', can('school_profile.update'), upload.single('logo'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose an image (PNG, JPG or WebP)');
    successResponse(res, await service.setSchoolLogo({ data: req.file.buffer, originalName: req.file.originalname }), 'Logo saved');
}));

schoolProfileRoutes.delete('/logo', can('school_profile.update'), asyncHandler(async (_req: Request, res: Response) => {
    successResponse(res, await service.removeSchoolLogo(), 'Logo removed');
}));

/** Branding for the sign-in page (no login needed). */
export const publicSchoolRoutes = Router();

publicSchoolRoutes.get('/', publicRoute, asyncHandler(async (_req: Request, res: Response) => {
    successResponse(res, await service.getPublicBranding(), 'School');
}));

// <img> requests carry no Origin header, so the URL names the school (?school=<code>); the logo is public anyway.
publicSchoolRoutes.get('/logo', publicRoute, asyncHandler(async (req: Request, res: Response) => {
    const code = typeof req.query.school === 'string' ? req.query.school.toLowerCase() : null;
    const tenant = code && /^[a-z0-9-]{2,40}$/.test(code) ? await findTenantByCode(code) : null;
    const load = () => service.schoolLogo();
    const { file, data } = tenant?.status === 'active' ? await runAsTenant(tenant.id, load) : await load();
    // The logo is public branding: any page (even on another domain) may show it.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    sendFile(res, file.originalName, file.mimeType, data, { inline: true, cacheSeconds: 86_400 });
}));
