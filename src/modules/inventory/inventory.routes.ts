import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, forbidden, notFound, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { readFile, saveUpload } from '../../core/files';
import { sendFile, upload } from '../../core/http/files';
import { db } from '../../core/db';
import { getUserAccess } from '../rbac/access.service';
import * as inv from './inventory.service';
import * as pur from './purchase.service';
import * as sal from './sales.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};
const uid = (req: Request) => req.user!.userId;
const needAny = (keys: string[]) =>
    asyncHandler(async (req: Request, _res: Response, next: () => void) => {
        const a = await getUserAccess(uid(req));
        if (!keys.some((k) => a.permissions[`inventory.${k}`])) throw forbidden();
        next();
    });
const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const inventoryRoutes = Router();

inventoryRoutes.get('/options', authenticated, needAny(['manage', 'store', 'purchase', 'approve', 'request', 'sell', 'view']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.options(uid(req)), 'Options')));
inventoryRoutes.get('/pick', authenticated, needAny(['manage', 'store', 'purchase', 'approve', 'request', 'sell']), asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ q: z.string().max(60).default(''), store: z.uuid().optional(), sellable: z.enum(['1', '0']).optional() }), req.query);
    successResponse(res, await inv.pickItems(q.q, q.store, q.sellable === '1'), 'Items');
}));
inventoryRoutes.post('/files', authenticated, needAny(['store', 'purchase']), upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose a file');
    const f = await saveUpload({ data: req.file.buffer, originalName: req.file.originalname, purpose: 'document', allowed: ['jpeg', 'png', 'webp', 'pdf'] });
    successResponse(res, { id: f.id, name: f.originalName }, 'Uploaded', 201);
}));
inventoryRoutes.get('/files/:fileId', authenticated, needAny(['store', 'purchase', 'approve', 'view']), asyncHandler(async (req: Request, res: Response) => {
    if (!(await db.invReceipt.count({ where: { billFileId: req.params.fileId } }))) throw notFound('File not found');
    const { file, data } = await readFile(req.params.fileId);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true });
}));

// Items and stock.
inventoryRoutes.get('/items', authenticated, needAny(['view', 'store', 'manage', 'purchase', 'approve']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.listItems(parse(inv.itemsQuery, req.query)), 'Items')));
inventoryRoutes.post('/items', can('inventory.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.saveItem(null, parse(inv.itemSchema, req.body), uid(req)), 'Added', 201)));
inventoryRoutes.get('/items/:id', authenticated, needAny(['view', 'store', 'manage', 'purchase', 'approve']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.itemView(req.params.id), 'Item')));
inventoryRoutes.put('/items/:id', can('inventory.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.saveItem(req.params.id, parse(inv.itemSchema.omit({ opening: true }), req.body), uid(req)), 'Saved')));
inventoryRoutes.get('/low', authenticated, needAny(['view', 'store', 'purchase', 'approve']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await inv.lowStock(), 'Low stock')));
inventoryRoutes.get('/expiring', authenticated, needAny(['view', 'store', 'approve']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await inv.expiring(), 'Expiring')));

// Staff requests.
inventoryRoutes.get('/requests/mine', can('inventory.request'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.myRequests(uid(req)), 'My requests')));
inventoryRoutes.post('/requests', can('inventory.request'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.createRequest(parse(inv.requestSchema, req.body), uid(req)), 'Sent', 201)));
inventoryRoutes.post('/requests/:id/cancel', can('inventory.request'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.cancelRequest(req.params.id, uid(req)), 'Cancelled')));
inventoryRoutes.get('/requests', authenticated, needAny(['store', 'approve']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.listRequests(parse(inv.requestsQuery, req.query)), 'Requests')));
inventoryRoutes.post('/requests/:id/answer', can('inventory.approve'), asyncHandler(async (req: Request, res: Response) => {
    const b = parse(z.object({ approve: z.boolean(), answer: z.string().trim().max(300).nullable().optional() }), req.body);
    successResponse(res, await inv.answerRequest(req.params.id, b.approve, b.answer || null, uid(req)), 'Answered');
}));
inventoryRoutes.post('/requests/:id/close', can('inventory.store'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.closeRequest(req.params.id, uid(req)), 'Closed')));

// Store work.
inventoryRoutes.post('/issue', can('inventory.store'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.issue(parse(inv.issueSchema, req.body), uid(req)), 'Issued')));
inventoryRoutes.post('/return', can('inventory.store'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.takeBack(parse(inv.returnSchema, req.body), uid(req)), 'Taken back')));
inventoryRoutes.post('/transfer', can('inventory.store'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.transfer(parse(inv.transferSchema, req.body), uid(req)), 'Moved')));
inventoryRoutes.get('/issued', authenticated, needAny(['store', 'approve', 'view']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.issuedTo(parse(z.object({ departmentId: z.uuid().optional(), staffId: z.uuid().optional(), from: D, to: D }), req.query)), 'Issued')));

// Write-offs and counts.
inventoryRoutes.post('/writeoffs', can('inventory.store'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.requestWriteoff(parse(inv.writeoffSchema, req.body), uid(req)), 'Saved', 201)));
inventoryRoutes.get('/adjustments', authenticated, needAny(['store', 'approve']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.listAdjustments(parse(inv.adjustmentsQuery, req.query)), 'Adjustments')));
inventoryRoutes.post('/adjustments/:id/answer', can('inventory.approve'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.answerAdjustment(req.params.id, parse(z.object({ approve: z.boolean() }), req.body).approve, uid(req)), 'Answered')));
inventoryRoutes.get('/counts', authenticated, needAny(['store', 'approve']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await inv.listCounts(), 'Counts')));
inventoryRoutes.post('/counts', can('inventory.store'), asyncHandler(async (req: Request, res: Response) => {
    const b = parse(z.object({ storeId: z.uuid(), name: z.string().trim().max(100).default('') }), req.body);
    successResponse(res, await inv.startCount(b.storeId, b.name, uid(req)), 'Started', 201);
}));
inventoryRoutes.get('/counts/:id', authenticated, needAny(['store', 'approve']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.countView(req.params.id), 'Count')));
inventoryRoutes.put('/counts/:id', can('inventory.store'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.saveCount(req.params.id, parse(inv.countSchema, req.body)), 'Saved')));
inventoryRoutes.post('/counts/:id/submit', can('inventory.store'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await inv.submitCount(req.params.id, uid(req)), 'Submitted')));

// Purchase orders and goods received.
inventoryRoutes.get('/pos', authenticated, needAny(['purchase', 'store', 'approve', 'view']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pur.listPOs(parse(pur.posQuery, req.query)), 'Orders')));
inventoryRoutes.post('/pos', can('inventory.purchase'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pur.savePO(null, parse(pur.poSchema, req.body), uid(req)), 'Saved', 201)));
inventoryRoutes.get('/pos/:id', authenticated, needAny(['purchase', 'store', 'approve', 'view']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pur.poView(req.params.id), 'Order')));
inventoryRoutes.put('/pos/:id', can('inventory.purchase'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pur.savePO(req.params.id, parse(pur.poSchema, req.body), uid(req)), 'Saved')));
inventoryRoutes.post('/pos/:id/submit', can('inventory.purchase'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pur.submitPO(req.params.id, uid(req)), 'Sent')));
inventoryRoutes.post('/pos/:id/answer', can('inventory.approve'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pur.answerPO(req.params.id, parse(z.object({ approve: z.boolean() }), req.body).approve, uid(req)), 'Answered')));
inventoryRoutes.post('/pos/:id/cancel', can('inventory.purchase'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pur.cancelPO(req.params.id), 'Cancelled')));
inventoryRoutes.get('/receipts', authenticated, needAny(['purchase', 'store', 'approve', 'view']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pur.listReceipts(parse(pur.receiptsQuery, req.query)), 'Receipts')));
inventoryRoutes.post('/receipts', can('inventory.store'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pur.receive(parse(pur.receiveSchema, req.body), uid(req)), 'Received', 201)));
inventoryRoutes.get('/receipts/:id', authenticated, needAny(['purchase', 'store', 'approve', 'view']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pur.receiptView(req.params.id), 'Receipt')));
inventoryRoutes.post('/vendor-returns', can('inventory.store'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await pur.vendorReturn(parse(pur.vendorReturnSchema, req.body), uid(req)), 'Returned')));

// Student sales.
inventoryRoutes.get('/students', can('inventory.sell'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await sal.findStudents(parse(z.object({ q: z.string().max(60).default('') }), req.query).q), 'Students')));
inventoryRoutes.get('/sales', can('inventory.sell'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await sal.listSales(parse(sal.salesQuery, req.query)), 'Sales')));
inventoryRoutes.post('/sales', can('inventory.sell'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await sal.sell(parse(sal.saleSchema, req.body), uid(req)), 'Sold', 201)));
inventoryRoutes.get('/sales/:id', can('inventory.sell'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await sal.saleView(req.params.id), 'Sale')));
inventoryRoutes.post('/sales/:id/cancel', can('inventory.sell'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await sal.cancelSale(req.params.id, uid(req)), 'Cancelled')));
