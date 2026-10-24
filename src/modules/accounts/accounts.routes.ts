import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, forbidden, notFound, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { readFile, saveUpload } from '../../core/files';
import { sendFile, upload } from '../../core/http/files';
import { db } from '../../core/db';
import { getUserAccess } from '../rbac/access.service';
import * as acc from './accounts.service';
import * as post from './posting.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};
const uid = (req: Request) => req.user!.userId;
const needAny = (keys: string[]) =>
    asyncHandler(async (req: Request, _res: Response, next: () => void) => {
        const a = await getUserAccess(uid(req));
        if (!keys.some((k) => a.permissions[`accounts.${k}`])) throw forbidden();
        next();
    });
const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const period = z.object({ from: D, to: D });

export const accountsRoutes = Router();

// Chart, years, openings, budgets.
accountsRoutes.get('/chart', authenticated, needAny(['setup', 'entry', 'view', 'approve', 'reconcile', 'close']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await acc.chart(), 'Chart')));
accountsRoutes.post('/groups', can('accounts.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await acc.saveGroup(null, parse(acc.groupSchema, req.body)), 'Saved', 201)));
accountsRoutes.put('/groups/:id', can('accounts.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await acc.saveGroup(req.params.id, parse(acc.groupSchema, req.body)), 'Saved')));
accountsRoutes.post('/ledgers', can('accounts.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await acc.saveLedger(null, parse(acc.ledgerSchema, req.body)), 'Saved', 201)));
accountsRoutes.put('/ledgers/:id', can('accounts.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await acc.saveLedger(req.params.id, parse(acc.ledgerSchema, req.body)), 'Saved')));
accountsRoutes.get('/years', authenticated, needAny(['setup', 'entry', 'view', 'close']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await acc.years(), 'Years')));
accountsRoutes.put('/openings', can('accounts.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await acc.saveOpenings(parse(acc.openingSchema, req.body)), 'Saved')));
accountsRoutes.put('/budgets', can('accounts.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await acc.saveBudgets(parse(acc.budgetSchema, req.body)), 'Saved')));
accountsRoutes.post('/years/close', can('accounts.close'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await acc.closeYear(parse(z.object({ start: D }), req.body).start, uid(req)), 'Closed')));

// Vouchers.
accountsRoutes.post('/files', authenticated, needAny(['entry']), upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose a file');
    const f = await saveUpload({ data: req.file.buffer, originalName: req.file.originalname, purpose: 'document', allowed: ['jpeg', 'png', 'webp', 'pdf'] });
    successResponse(res, { id: f.id, name: f.originalName }, 'Uploaded', 201);
}));
accountsRoutes.get('/files/:fileId', authenticated, needAny(['entry', 'view', 'approve']), asyncHandler(async (req: Request, res: Response) => {
    if (!(await db.accVoucher.count({ where: { attachmentId: req.params.fileId } }))) throw notFound('File not found');
    const { file, data } = await readFile(req.params.fileId);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true });
}));
accountsRoutes.get('/vouchers', authenticated, needAny(['entry', 'view', 'approve']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await acc.listVouchers(parse(acc.vouchersQuery, req.query)), 'Vouchers')));
accountsRoutes.post('/vouchers', can('accounts.entry'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await acc.createVoucher({ ...parse(acc.voucherSchema, req.body), source: 'manual' }, uid(req)), 'Saved', 201)));
accountsRoutes.get('/vouchers/:id', authenticated, needAny(['entry', 'view', 'approve']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await acc.voucherView(req.params.id), 'Voucher')));
accountsRoutes.post('/vouchers/:id/approve', can('accounts.approve'), asyncHandler(async (req: Request, res: Response) => {
    const b = parse(z.object({ approve: z.boolean(), reason: z.string().trim().max(300).nullable().optional() }), req.body);
    successResponse(res, await acc.approveVoucher(req.params.id, b.approve, b.reason || null, uid(req)), 'Answered');
}));
accountsRoutes.post('/vouchers/:id/cancel', can('accounts.approve'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await acc.cancelVoucher(req.params.id, parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body).reason, uid(req)), 'Cancelled')));

// Posting from the other modules.
accountsRoutes.post('/post', can('accounts.entry'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await post.syncAll({ from: parse(z.object({ from: D.optional() }), req.body).from }), 'Posted')));
accountsRoutes.post('/salary-paid', can('accounts.entry'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await post.markSalaryPaid(parse(post.salaryPaidSchema, req.body), uid(req)), 'Posted', 201)));
accountsRoutes.get('/salary-months', can('accounts.entry'), asyncHandler(async (_req: Request, res: Response) => {
    const runs = await db.payrollRun.findMany({ where: { status: 'finalised' }, orderBy: { month: 'desc' }, take: 12, select: { month: true } });
    const paid = new Set((await db.accVoucher.findMany({ where: { source: 'salary_paid', sourceKey: { not: null } }, select: { sourceKey: true } })).map((v) => v.sourceKey));
    successResponse(res, runs.map((r) => ({ month: r.month, paid: paid.has(`salary_paid:${r.month}`) })), 'Months');
}));

// Books and statements.
accountsRoutes.get('/money', authenticated, needAny(['view', 'entry']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await acc.moneyNow(), 'Cash and bank')));
accountsRoutes.get('/daybook', can('accounts.view'), asyncHandler(async (req: Request, res: Response) => { const q = parse(period, req.query); successResponse(res, await acc.dayBook(q.from, q.to), 'Day book'); }));
accountsRoutes.get('/ledger/:id', can('accounts.view'), asyncHandler(async (req: Request, res: Response) => { const q = parse(period, req.query); successResponse(res, await acc.ledgerStatement(req.params.id, q.from, q.to), 'Ledger'); }));
accountsRoutes.get('/trial-balance', can('accounts.view'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await acc.trialBalance(parse(z.object({ asOf: D }), req.query).asOf), 'Trial balance')));
accountsRoutes.get('/income-expenditure', can('accounts.view'), asyncHandler(async (req: Request, res: Response) => { const q = parse(period, req.query); successResponse(res, await acc.incomeExpenditure(q.from, q.to), 'Income and expenditure'); }));
accountsRoutes.get('/balance-sheet', can('accounts.view'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await acc.balanceSheet(parse(z.object({ asOf: D }), req.query).asOf), 'Balance sheet')));
accountsRoutes.get('/receipts-payments', can('accounts.view'), asyncHandler(async (req: Request, res: Response) => { const q = parse(period, req.query); successResponse(res, await acc.receiptsPayments(q.from, q.to), 'Receipts and payments'); }));
accountsRoutes.get('/budget', can('accounts.view'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await acc.budgetVsActual(parse(z.object({ start: D }), req.query).start), 'Budget')));
accountsRoutes.get('/payables', can('accounts.view'), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await acc.payables(), 'Payables')));

// Bank reconciliation.
accountsRoutes.get('/bank/:ledgerId', can('accounts.reconcile'), asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ upTo: D, show: z.enum(['open', 'all']).default('open') }), req.query);
    successResponse(res, await post.bankEntries(req.params.ledgerId, q.upTo, q.show), 'Bank');
}));
accountsRoutes.post('/bank/reconcile', can('accounts.reconcile'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await post.reconcile(parse(post.reconcileSchema, req.body)), 'Saved')));
accountsRoutes.post('/bank/:ledgerId/statement', can('accounts.reconcile'), upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose the bank statement (Excel)');
    successResponse(res, await post.matchStatement(req.params.ledgerId, req.file.buffer), 'Matched');
}));
