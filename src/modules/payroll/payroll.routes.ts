import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { forbidden, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { sendFile } from '../../core/http/files';
import { XLSX_MIME } from '../../core/excel';
import { getUserAccess } from '../rbac/access.service';
import * as pay from './payroll.service';
import * as ex from './exports.service';
import { PT_SLABS } from './payroll.settings';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};
const uid = (req: Request) => req.user!.userId;
const needAny = (keys: string[]) =>
    asyncHandler(async (req: Request, _res: Response, next: () => void) => {
        const a = await getUserAccess(uid(req));
        if (!keys.some((k) => a.permissions[`payroll.${k}`])) throw forbidden();
        next();
    });
const month = (req: Request) => parse(z.object({ month: pay.MONTH }), req.params).month;

export const payrollRoutes = Router();

payrollRoutes.get('/heads', authenticated, needAny(['setup', 'salary', 'run', 'view']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, { heads: await pay.heads(), ptStates: Object.entries(PT_SLABS).map(([value, s]) => ({ value, label: s.label, slabs: s.slabs })) }, 'Pay heads')));

// Structures.
payrollRoutes.get('/structures', authenticated, needAny(['setup', 'salary']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await pay.listStructures(), 'Structures')));
payrollRoutes.post('/structures', can('payroll.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pay.saveStructure(null, parse(pay.structureSchema, req.body)), 'Saved', 201)));
payrollRoutes.put('/structures/:id', can('payroll.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pay.saveStructure(req.params.id, parse(pay.structureSchema, req.body)), 'Saved')));
payrollRoutes.delete('/structures/:id', can('payroll.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pay.deleteStructure(req.params.id), 'Removed')));

// Staff salaries and increments.
payrollRoutes.get('/salaries', can('payroll.salary'), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await pay.salaryList(), 'Salaries')));
payrollRoutes.get('/salaries/:staffId', can('payroll.salary'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pay.staffSalary(req.params.staffId), 'Salary')));
payrollRoutes.post('/salaries/:staffId', can('payroll.salary'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pay.saveSalary(req.params.staffId, parse(pay.salarySchema, req.body), uid(req)), 'Saved', 201)));
payrollRoutes.post('/increments', can('payroll.salary'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pay.giveIncrements(parse(pay.incrementSchema, req.body), uid(req)), 'Done')));
payrollRoutes.post('/preview', can('payroll.salary'), asyncHandler(async (req: Request, res: Response) => {
    const b = parse(z.object({ basic: z.number().min(0).max(10_000_000), lines: z.array(pay.lineSchema).max(40) }), req.body);
    successResponse(res, pay.fullAmounts(b.basic, b.lines, await pay.heads()), 'Preview');
}));

// Monthly runs.
payrollRoutes.get('/runs', authenticated, needAny(['run', 'approve', 'view']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await pay.runsList(), 'Months')));
payrollRoutes.get('/runs/:month', authenticated, needAny(['run', 'approve', 'view']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pay.runView(month(req)), 'Month')));
payrollRoutes.post('/runs/:month/prepare', can('payroll.run'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pay.prepare(month(req), uid(req)), 'Prepared')));
payrollRoutes.post('/runs/:month/approve', can('payroll.approve'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pay.approve(month(req), uid(req)), 'Approved')));
payrollRoutes.post('/runs/:month/finalise', can('payroll.approve'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pay.finalise(month(req), uid(req)), 'Finalised')));
payrollRoutes.post('/runs/:month/reopen', can('payroll.approve'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pay.reopen(month(req), parse(z.object({ reason: z.string().trim().min(5, 'say why').max(300) }), req.body).reason, uid(req)), 'Reopened')));
payrollRoutes.get('/runs/:month/bank.xlsx', authenticated, needAny(['view', 'approve']), asyncHandler(async (req: Request, res: Response) => {
    const f = await ex.bankSheet(month(req));
    sendFile(res, f.filename, XLSX_MIME, f.buffer);
}));
payrollRoutes.get('/runs/:month/register.xlsx', authenticated, needAny(['view', 'approve', 'run']), asyncHandler(async (req: Request, res: Response) => {
    const f = await ex.registerSheet(month(req));
    sendFile(res, f.filename, XLSX_MIME, f.buffer);
}));
payrollRoutes.get('/runs/:month/esi.xlsx', authenticated, needAny(['view', 'approve']), asyncHandler(async (req: Request, res: Response) => {
    const f = await ex.esiSheet(month(req));
    sendFile(res, f.filename, XLSX_MIME, f.buffer);
}));
payrollRoutes.get('/runs/:month/pf-ecr.txt', authenticated, needAny(['view', 'approve']), asyncHandler(async (req: Request, res: Response) => {
    const f = await ex.pfEcr(month(req));
    sendFile(res, f.filename, 'text/plain; charset=utf-8', Buffer.from(f.text, 'utf8'));
}));
payrollRoutes.get('/runs/:month/pf-missing', authenticated, needAny(['view', 'approve']), asyncHandler(async (req: Request, res: Response) => successResponse(res, (await ex.pfEcr(month(req))).missing, 'Missing UAN')));

// Additions / deductions for a month.
payrollRoutes.get('/adjustments/:month', authenticated, needAny(['run', 'approve']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pay.listAdjustments(month(req)), 'Adjustments')));
payrollRoutes.post('/adjustments', can('payroll.run'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pay.addAdjustment(parse(pay.adjustmentSchema, req.body), uid(req)), 'Added', 201)));
payrollRoutes.delete('/adjustments/:id', can('payroll.run'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pay.deleteAdjustment(req.params.id), 'Removed')));

// Loans.
payrollRoutes.get('/loans', authenticated, needAny(['loans', 'view']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await pay.listLoans(), 'Loans')));
payrollRoutes.post('/loans', can('payroll.loans'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pay.giveLoan(parse(pay.loanSchema, req.body), uid(req)), 'Given', 201)));
payrollRoutes.post('/loans/:id/close', can('payroll.loans'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pay.closeLoan(req.params.id, uid(req)), 'Closed')));

// Leavers.
payrollRoutes.get('/settlement/:staffId', can('payroll.salary'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ex.settlement(req.params.staffId, parse(z.object({ lastDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.query).lastDay), 'Settlement')));

// Staff: own payslips.
payrollRoutes.get('/mine', can('payroll.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pay.myPayslips(uid(req)), 'My payslips')));
