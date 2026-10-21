import express, { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { validationError } from '../../core/errors';
import { can } from '../../middlewares/access';
import * as reports from './reports.service';
import * as builder from './builder.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};

/** The query string minus the route's own options = the report's filters. */
const filtersOf = (req: Request, drop: string[] = []) => Object.fromEntries(Object.entries(req.query).filter(([k, v]) => typeof v === 'string' && !drop.includes(k))) as Record<string, string>;

const formatSchema = z.object({ format: z.enum(['pdf', 'xlsx', 'docx']).default('pdf'), download: z.string().optional() });

const sendFile = (res: Response, f: { file: Buffer; contentType: string; filename: string; engine: string; note: string | null }, download: boolean) => {
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Length', String(f.file.length));
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${f.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Report-Engine', encodeURIComponent(f.engine));
    if (f.note) res.setHeader('X-Report-Note', encodeURIComponent(f.note));
    res.setHeader('Access-Control-Expose-Headers', 'X-Report-Engine, X-Report-Note, Content-Disposition');
    res.end(f.file);
};

export const reportRoutes = Router();
const view = can('report.view');
const design = can('report.design');
const uid = (req: Request) => req.user!.userId;

const build = can('report.build');

// Report Builder (people with report.build): data sources, preview, saved reports. Before /:key.
reportRoutes.get('/builder/sources', build, asyncHandler(async (req: Request, res: Response) => successResponse(res, await builder.listSources(uid(req)), 'Data sources')));
reportRoutes.get('/builder/roles', build, asyncHandler(async (req: Request, res: Response) => successResponse(res, await builder.shareableRoles(uid(req)), 'Roles')));
reportRoutes.post('/builder/preview', build, asyncHandler(async (req: Request, res: Response) => {
    const { definition } = parse(z.object({ definition: builder.definitionSchema }), req.body);
    successResponse(res, await reports.previewDefinition(definition, uid(req)), 'Preview');
}));
reportRoutes.get('/builder/reports/:id', build, asyncHandler(async (req: Request, res: Response) => successResponse(res, await builder.getCustomReport(req.params.id, uid(req)), 'Report')));
reportRoutes.post('/builder/reports', build, asyncHandler(async (req: Request, res: Response) => successResponse(res, await builder.createCustomReport(parse(builder.customReportSchema, req.body), uid(req)), 'Report saved', 201)));
reportRoutes.put('/builder/reports/:id', build, asyncHandler(async (req: Request, res: Response) => successResponse(res, await builder.updateCustomReport(req.params.id, parse(builder.customReportSchema, req.body), uid(req)), 'Report saved')));
reportRoutes.delete('/builder/reports/:id', build, asyncHandler(async (req: Request, res: Response) => {
    await builder.deleteCustomReport(req.params.id, uid(req));
    successResponse(res, null, 'Report deleted');
}));

// The library and running a report (each report checks its own permission too).
reportRoutes.get('/', view, asyncHandler(async (req: Request, res: Response) => successResponse(res, await reports.listReports(uid(req)), 'Reports')));
reportRoutes.get('/:key', view, asyncHandler(async (req: Request, res: Response) => successResponse(res, await reports.getReport(req.params.key, uid(req)), 'Report')));
reportRoutes.get('/:key/run', view, asyncHandler(async (req: Request, res: Response) => successResponse(res, await reports.runReport(req.params.key, filtersOf(req), uid(req)), 'Report')));
reportRoutes.get('/:key/file', view, asyncHandler(async (req: Request, res: Response) => {
    const { format, download } = parse(formatSchema, req.query);
    sendFile(res, await reports.exportReport(req.params.key, filtersOf(req, ['format', 'download']), format, uid(req)), download === '1' || format !== 'pdf');
}));

// A Jasper design made from the report's columns (report designers and builders). Before /:id/download.
reportRoutes.get('/:key/designs/generated/download', view, asyncHandler(async (req: Request, res: Response) => {
    const d = await reports.generatedDesign(req.params.key, uid(req));
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${d.fileName}"`);
    res.end(d.jrxml);
}));

// Designs (super admin)
reportRoutes.get('/:key/designs', design, asyncHandler(async (req: Request, res: Response) => successResponse(res, await reports.getDesigns(req.params.key, uid(req)), 'Designs')));
// The .jrxml is the request body (XML, up to 2 MB); its file name and a note come in the query.
reportRoutes.post(
    '/:key/designs',
    design,
    express.text({ type: ['application/xml', 'text/xml', 'text/plain'], limit: '2mb' }),
    asyncHandler(async (req: Request, res: Response) => {
        const q = parse(z.object({ fileName: z.string().optional(), note: z.string().optional() }), req.query);
        const input = parse(reports.designUploadSchema, { fileName: q.fileName ?? 'design.jrxml', note: q.note, jrxml: typeof req.body === 'string' ? req.body : '' });
        successResponse(res, await reports.uploadDesign(req.params.key, input, uid(req)), 'Design uploaded', 201);
    })
);
reportRoutes.post('/:key/designs/reset', design, asyncHandler(async (req: Request, res: Response) => successResponse(res, await reports.resetDesign(req.params.key, uid(req)), 'Back to the built-in design')));
reportRoutes.post('/:key/designs/:id/activate', design, asyncHandler(async (req: Request, res: Response) => successResponse(res, await reports.activateDesign(req.params.key, req.params.id, uid(req)), 'Design in use')));
reportRoutes.delete('/:key/designs/:id', design, asyncHandler(async (req: Request, res: Response) => successResponse(res, await reports.deleteDesign(req.params.key, req.params.id, uid(req)), 'Design deleted')));
reportRoutes.get('/:key/designs/:id/download', design, asyncHandler(async (req: Request, res: Response) => {
    const d = await reports.downloadDesign(req.params.key, req.params.id, uid(req));
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${d.fileName.replace(/[^A-Za-z0-9._-]+/g, '-')}"`);
    res.end(d.jrxml);
}));
reportRoutes.get('/:key/designs/:id/preview', design, asyncHandler(async (req: Request, res: Response) => {
    const { format } = parse(formatSchema, req.query);
    sendFile(res, await reports.previewDesign(req.params.key, req.params.id, filtersOf(req, ['format', 'download']), format, uid(req)), format !== 'pdf');
}));
reportRoutes.put('/:key/engine', design, asyncHandler(async (req: Request, res: Response) => successResponse(res, await reports.setEngine(req.params.key, parse(reports.engineSchema, req.body).engine, uid(req)), 'Saved')));
reportRoutes.get('/:key/sample', design, asyncHandler(async (req: Request, res: Response) => {
    const data = await reports.sampleData(req.params.key, filtersOf(req), uid(req));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.key}-sample-data.json"`);
    res.end(JSON.stringify(data, null, 2));
}));
