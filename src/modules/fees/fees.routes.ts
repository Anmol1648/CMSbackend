import { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { DataScope } from '@prisma/client';
import { asyncHandler, successResponse } from '../../core/index';
import { forbidden, validationError } from '../../core/errors';
import { parseListQuery } from '../../core/http/list-query';
import { sendFile } from '../../core/http/files';
import { getSetting, getSettings } from '../../core/settings';
import { UPLOADS } from '../../core/files';
import { buildWorkbook, XLSX_MIME } from '../../core/excel';
import { authenticated, can } from '../../middlewares/access';
import { getUserAccess } from '../rbac/access.service';
import * as setup from './fee-setup.service';
import * as receipts from './receipts.service';
import * as reports from './fee-reports.service';
import { myFees, myReceipt } from './my-fees.service';
import { FEES } from './fees.settings';
import { collectionQuerySchema, duesQuerySchema, receiptListSpec } from './fees.schemas';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};

/** Whose fees the person may see: fee.view's scope; people who only collect see everyone. */
const viewer = async (req: Request): Promise<receipts.Viewer> => {
    const access = await getUserAccess(req.user!.userId);
    const scope = (access.permissions['fee.view'] ?? (access.permissions['fee.collect'] ? 'all' : 'own')) as DataScope;
    return { userId: req.user!.userId, scope };
};
const needAny = async (req: Request, keys: string[]) => {
    const access = await getUserAccess(req.user!.userId);
    if (!keys.some((k) => access.permissions[k])) throw forbidden();
};
const yearQuery = z.object({ year: z.uuid('choose an academic year') });

export const feeRoutes = Router();
const setupOnly = can('fee.setup');
const view = can('fee.view');
const collect = can('fee.collect');
const concession = can('fee.concession');
const reportsOnly = can('fee.reports');

// ─── Set-up ──────────────────────────────────────────────────────────────────
feeRoutes.get('/setup/config', authenticated, asyncHandler(async (req: Request, res: Response) => {
    await needAny(req, ['fee.setup', 'fee.view', 'fee.collect', 'fee.concession', 'fee.reports']);
    const s = await getSettings({ partial: FEES.partialPayment, fineMode: FEES.fineMode, fineAmount: FEES.fineAmount, graceDays: FEES.fineGraceDays, fineCap: FEES.fineCap, receiptFormat: FEES.receiptFormat });
    successResponse(res, { ...s, heads: await setup.feeHeads(false) }, 'Fee settings');
}));
feeRoutes.get('/setup/instalments', authenticated, asyncHandler(async (req: Request, res: Response) => {
    await needAny(req, ['fee.setup', 'fee.view', 'fee.collect', 'fee.concession', 'fee.reports']);
    successResponse(res, await setup.listInstalments(parse(yearQuery, req.query).year), 'Instalments');
}));
feeRoutes.post('/setup/instalments', setupOnly, asyncHandler(async (req: Request, res: Response) => {
    const { year } = parse(yearQuery, req.query);
    successResponse(res, await setup.createInstalment(year, parse(setup.instalmentSchema, req.body)), 'Instalment added', 201);
}));
feeRoutes.post('/setup/instalments/generate', setupOnly, asyncHandler(async (req: Request, res: Response) => {
    const { year } = parse(yearQuery, req.query);
    successResponse(res, await setup.generateInstalments(year, parse(setup.generateSchema, req.body)), 'Instalments made', 201);
}));
feeRoutes.patch('/setup/instalments/:id', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.updateInstalment(req.params.id, parse(setup.instalmentSchema.partial(), req.body)), 'Saved')));
feeRoutes.delete('/setup/instalments/:id', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.deleteInstalment(req.params.id), 'Instalment removed')));

feeRoutes.get('/setup/structure', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.structureOverview(parse(yearQuery, req.query).year), 'Fee structure')));
feeRoutes.get('/setup/structure/:classId', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.structureGrid(parse(yearQuery, req.query).year, req.params.classId), 'Fee structure')));
feeRoutes.put('/setup/structure/:classId', setupOnly, asyncHandler(async (req: Request, res: Response) => {
    const { year } = parse(yearQuery, req.query);
    successResponse(res, await setup.saveStructure(year, req.params.classId, parse(setup.structureSchema, req.body)), 'Fee structure saved');
}));
feeRoutes.post('/setup/structure/:classId/copy', setupOnly, asyncHandler(async (req: Request, res: Response) => {
    const { year } = parse(yearQuery, req.query);
    const r = await setup.copyStructure(year, req.params.classId, parse(setup.copyStructureSchema, req.body));
    successResponse(res, r, `Copied to ${r.classes} class(es)`);
}));
feeRoutes.post('/setup/copy-year', setupOnly, asyncHandler(async (req: Request, res: Response) => {
    const { year } = parse(yearQuery, req.query);
    const r = await setup.copyFromYear(year, parse(setup.copyYearSchema, req.body));
    successResponse(res, r, `Copied ${r.instalments} instalments, ${r.amounts} amounts and ${r.concessions} concessions`);
}));

feeRoutes.get('/setup/concessions', authenticated, asyncHandler(async (req: Request, res: Response) => {
    await needAny(req, ['fee.setup', 'fee.concession', 'fee.view']);
    successResponse(res, await setup.listConcessions(parse(yearQuery, req.query).year), 'Concessions');
}));
feeRoutes.post('/setup/concessions', setupOnly, asyncHandler(async (req: Request, res: Response) => {
    const { year } = parse(yearQuery, req.query);
    successResponse(res, await setup.createConcession(year, parse(setup.concessionSchema, req.body)), 'Concession added', 201);
}));
feeRoutes.put('/setup/concessions/:id', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.updateConcession(req.params.id, parse(setup.concessionSchema, req.body)), 'Concession saved')));
feeRoutes.delete('/setup/concessions/:id', setupOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.deleteConcession(req.params.id), 'Concession removed')));

// ─── Counter ─────────────────────────────────────────────────────────────────
feeRoutes.get('/students', authenticated, asyncHandler(async (req: Request, res: Response) => {
    await needAny(req, ['fee.collect', 'fee.view']);
    const q = parse(z.object({ search: z.string().max(100).default('') }), req.query);
    successResponse(res, await receipts.searchStudents(q.search, await viewer(req)), 'Students');
}));
feeRoutes.get('/students/:id', authenticated, asyncHandler(async (req: Request, res: Response) => {
    await needAny(req, ['fee.collect', 'fee.view']);
    const q = parse(z.object({ year: z.uuid().optional() }), req.query);
    successResponse(res, await receipts.studentFees(req.params.id, q.year, await viewer(req)), 'Fees');
}));
feeRoutes.post('/students/:id/concessions', concession, asyncHandler(async (req: Request, res: Response) => successResponse(res, await receipts.giveConcession(req.params.id, parse(receipts.giveConcessionSchema, req.body), await viewer(req)), 'Concession given', 201)));
feeRoutes.delete('/students/:id/concessions/:concessionId', concession, asyncHandler(async (req: Request, res: Response) => successResponse(res, await receipts.removeConcession(req.params.id, req.params.concessionId, await viewer(req)), 'Concession taken off')));
feeRoutes.post('/students/:id/adjustments', concession, asyncHandler(async (req: Request, res: Response) => successResponse(res, await receipts.addAdjustment(req.params.id, parse(receipts.adjustmentSchema, req.body), await viewer(req)), 'Saved', 201)));
feeRoutes.delete('/students/:id/adjustments/:adjustmentId', concession, asyncHandler(async (req: Request, res: Response) => successResponse(res, await receipts.removeAdjustment(req.params.id, req.params.adjustmentId, await viewer(req)), 'Removed')));

feeRoutes.post('/receipts', collect, asyncHandler(async (req: Request, res: Response) => successResponse(res, await receipts.collectFee(parse(receipts.collectSchema, req.body), await viewer(req)), 'Fee received', 201)));
feeRoutes.get('/receipts', view, asyncHandler(async (req: Request, res: Response) => successResponse(res, await receipts.listReceipts(parseListQuery(req.query, receiptListSpec), await viewer(req)), 'Receipts')));
feeRoutes.get('/receipts/export', view, asyncHandler(async (req: Request, res: Response) => {
    const max = await getSetting(UPLOADS.maxExportRows);
    const q = parseListQuery({ ...req.query, page: '1', pageSize: String(Math.min(200, max)) }, receiptListSpec);
    const rows = (await receipts.listReceipts(q, await viewer(req))).items;
    const data = await buildWorkbook('Receipts', [
        { header: 'Receipt no.', width: 18, value: (r) => r.receiptNo },
        { header: 'Date', width: 12, value: (r) => r.date },
        { header: 'Student', width: 26, value: (r) => r.student.name },
        { header: 'Admission no.', width: 14, value: (r) => r.student.admissionNo },
        { header: 'Class', value: (r) => r.student.section },
        { header: 'Mode', value: (r) => r.mode },
        { header: 'Reference', width: 18, value: (r) => r.reference },
        { header: 'Amount', value: (r) => r.amount },
        { header: 'Status', value: (r) => r.status },
        { header: 'Collected by', width: 20, value: (r) => r.collectedBy },
    ], rows);
    sendFile(res, `receipts-${new Date().toISOString().slice(0, 10)}.xlsx`, XLSX_MIME, data);
}));
feeRoutes.get('/receipts/:id', view, asyncHandler(async (req: Request, res: Response) => successResponse(res, await receipts.getReceipt(req.params.id, await viewer(req)), 'Receipt')));
feeRoutes.post('/receipts/:id/cancel', can('fee.cancel'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await receipts.cancelReceipt(req.params.id, parse(receipts.cancelSchema, req.body), await viewer(req)), 'Receipt cancelled')));

// ─── Reports ─────────────────────────────────────────────────────────────────
feeRoutes.get('/reports/dues', view, asyncHandler(async (req: Request, res: Response) => successResponse(res, await reports.duesReport(parse(duesQuerySchema, req.query), await viewer(req)), 'Fee dues')));
feeRoutes.get('/reports/dues/export', view, asyncHandler(async (req: Request, res: Response) => {
    const r = await reports.duesReport(parse(duesQuerySchema, req.query), await viewer(req));
    const data = await buildWorkbook('Fee dues', [
        { header: 'Class', value: (s) => s.section },
        { header: 'Roll', value: (s) => s.roll },
        { header: 'Admission no.', width: 14, value: (s) => s.admissionNo },
        { header: 'Student', width: 26, value: (s) => s.name },
        { header: 'Parent', width: 24, value: (s) => s.parent?.name },
        { header: 'Mobile', width: 14, value: (s) => s.parent?.mobile },
        { header: 'Fees this year', value: (s) => s.net },
        { header: 'Paid', value: (s) => s.paid },
        { header: 'Balance', value: (s) => s.balance },
        { header: 'Overdue', value: (s) => s.overdue },
        { header: 'Late fine', value: (s) => s.fine },
        { header: 'Overdue since', width: 14, value: (s) => s.overdueSince },
    ], r.students);
    sendFile(res, `fee-dues-${r.asOf}.xlsx`, XLSX_MIME, data);
}));
feeRoutes.get('/reports/classes', reportsOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await reports.classSummary(parse(z.object({ year: z.uuid().optional() }), req.query).year, await viewer(req)), 'Class summary')));
feeRoutes.get('/reports/collection', reportsOnly, asyncHandler(async (req: Request, res: Response) => successResponse(res, await reports.collectionReport(parse(collectionQuerySchema, req.query), await viewer(req)), 'Collection')));

// ─── My fees (students and parents) ──────────────────────────────────────────
feeRoutes.get('/my', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await myFees(req.user!.userId), 'My fees')));
feeRoutes.get('/my/receipts/:id', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await myReceipt(req.user!.userId, req.params.id), 'Receipt')));
