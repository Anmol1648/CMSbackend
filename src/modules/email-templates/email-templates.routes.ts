import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { validationError } from '../../core/errors';
import { can } from '../../middlewares/access';
import * as templates from './email-templates.service';

/** Setup → Email Templates. Seeing needs settings.view; changing / test emails need settings.update. */
export const emailTemplateRoutes = Router();

const wording = z.strictObject({
    subject: z.string().trim().min(1, 'is required').max(200),
    body: z.string().trim().min(1, 'is required').max(5000),
});
const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) throw validationError(parsed.error);
    return parsed.data;
};
const optionalWording = (body: unknown) => (body && typeof body === 'object' && Object.keys(body).length ? parse(wording, body) : undefined);

emailTemplateRoutes.get('/', can('settings.view'), asyncHandler(async (_req: Request, res: Response) => {
    successResponse(res, await templates.listTemplates(), 'Email templates');
}));

emailTemplateRoutes.get('/:key', can('settings.view'), asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await templates.getTemplate(req.params.key), 'Email template');
}));

emailTemplateRoutes.put('/:key', can('settings.update'), asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await templates.saveTemplate(req.params.key, parse(wording, req.body), req.user!.userId), 'Email template saved');
}));

emailTemplateRoutes.delete('/:key', can('settings.update'), asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await templates.resetTemplate(req.params.key), 'Back to the default wording');
}));

// Preview with example values; body may carry unsaved wording.
emailTemplateRoutes.post('/:key/preview', can('settings.view'), asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await templates.previewTemplate(req.params.key, optionalWording(req.body)), 'Preview');
}));

emailTemplateRoutes.post('/:key/test', can('settings.update'), asyncHandler(async (req: Request, res: Response) => {
    const r = await templates.sendTestEmail(req.params.key, req.user!.userId, optionalWording(req.body));
    successResponse(res, r, `Test email sent to ${r.to}`);
}));
