import { Router, Request, Response } from 'express';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest } from '../../core/errors';
import { XLSX_MIME } from '../../core/excel';
import { authenticated } from '../../middlewares/access';
import { sendFile, upload } from '../../core/http/files';
import * as imports from './import.service';

/** Each import checks its own permission (the definition says which), so routes only need a sign-in. */
export const importRoutes = Router();

importRoutes.get('/jobs', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const kind = String(req.query.kind ?? '');
    if (!/^[a-z_]+$/.test(kind)) throw badRequest('Say which import (?kind=users)');
    successResponse(res, await imports.listImportJobs(kind, req.user!.userId), 'Recent imports');
}));

importRoutes.post('/jobs/:id/run', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const result = await imports.runImport(req.params.id, req.user!.userId);
    successResponse(res, result, `${result.job.importedRows} row${result.job.importedRows === 1 ? '' : 's'} imported`);
}));

importRoutes.get('/jobs/:id/problems', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const report = await imports.importErrorReport(req.params.id, req.user!.userId);
    sendFile(res, report.fileName, XLSX_MIME, report.data);
}));

importRoutes.get('/:kind/template', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const t = await imports.importTemplate(req.params.kind, req.user!.userId);
    sendFile(res, t.fileName, XLSX_MIME, t.data);
}));

importRoutes.post('/:kind/check', authenticated, upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose the Excel file to upload');
    const result = await imports.validateImport(req.params.kind, { data: req.file.buffer, originalName: req.file.originalname }, req.user!.userId);
    const ok = result.job.validRows;
    successResponse(res, result, result.problems.length ? 'The file has problems' : `${ok} of ${result.job.totalRows} rows are ready to import`);
}));
