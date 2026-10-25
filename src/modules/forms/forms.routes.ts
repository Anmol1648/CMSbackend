import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { notFound, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import * as forms from './forms.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};

/** Setup → Form Builder (Roles & Permissions: forms.manage). */
export const formRoutes = Router();

// The school's words (every signed-in person's screens use them; the Form Builder changes them).
formRoutes.get('/terms', authenticated, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await forms.getTerms(), 'Terms')));
formRoutes.put('/terms', can('forms.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await forms.saveTerms(parse(forms.saveTermsSchema, req.body), req.user!.userId), 'Saved')));
// What a form needs to draw its extra fields (every signed-in person who fills one).
formRoutes.get('/:key/extras', authenticated, asyncHandler(async (req: Request, res: Response) => {
    if (!forms.FORMS[req.params.key]) throw notFound('Form not found');
    successResponse(res, await forms.formExtras(req.params.key as forms.FormKey, req.user!.userId), 'Form');
}));
formRoutes.get('/', can('forms.manage'), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await forms.listForms(), 'Forms')));
formRoutes.get('/:key', can('forms.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await forms.getForm(req.params.key), 'Form')));
formRoutes.put('/:key', can('forms.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await forms.saveForm(req.params.key, parse(forms.saveFormSchema, req.body), req.user!.userId), 'Form saved')));
