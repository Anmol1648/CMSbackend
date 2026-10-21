import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import * as documents from './documents.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};

const sendPdf = (res: Response, pdf: Buffer, filename: string, download: boolean) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(pdf.length));
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename.replace(/[^A-Za-z0-9._-]+/g, '-')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(pdf);
};

export const documentRoutes = Router();
const manage = can('documents.manage');

// Templates (Setup → Document Templates)
documentRoutes.get('/', manage, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await documents.listTemplates(), 'Documents')));
documentRoutes.get('/:key/template', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await documents.getTemplate(req.params.key), 'Template')));
documentRoutes.put('/:key/template', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await documents.saveTemplate(req.params.key, parse(documents.templateSchema, req.body)), 'Template saved')));
documentRoutes.delete('/:key/template', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await documents.resetTemplate(req.params.key), 'Back to the built-in template')));
documentRoutes.post('/:key/preview', manage, asyncHandler(async (req: Request, res: Response) => {
    const pdf = await documents.previewTemplate(req.params.key, parse(documents.previewSchema, req.body));
    sendPdf(res, pdf, `${req.params.key}-preview.pdf`, false);
}));

// A document of a record, e.g. /api/documents/fee_receipt/pdf?id=…  (the document decides who may see it)
documentRoutes.get('/:key/pdf', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const params = Object.fromEntries(Object.entries(req.query).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    const { pdf, filename } = await documents.renderDocument(req.params.key, params, req.user!.userId);
    sendPdf(res, pdf, filename, params.download === '1');
}));
