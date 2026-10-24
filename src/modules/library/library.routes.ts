import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, forbidden, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { readFile, saveUpload } from '../../core/files';
import { sendFile, upload } from '../../core/http/files';
import { getUserAccess } from '../rbac/access.service';
import * as books from './books.service';
import * as desk from './circulation.service';
import * as lib from './library.service';
import { cards, cardsQuery, memberCard, memberPhoto, myMembers, schoolLogo, searchMembers } from './members.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};
const uid = (req: Request) => req.user!.userId;
const needAny = (keys: string[]) =>
    asyncHandler(async (req: Request, _res: Response, next: () => void) => {
        const a = await getUserAccess(uid(req));
        if (!keys.some((k) => a.permissions[k])) throw forbidden();
        next();
    });
const has = async (req: Request, key: string) => !!(await getUserAccess(uid(req))).permissions[key];
const staffSide = needAny(['library.view', 'library.manage', 'library.issue', 'library.fines']);
const manage = can('library.manage');
const counter = can('library.issue');
const fines = can('library.fines');
const mine = can('library.mine');
const member = z.object({ kind: z.enum(['student', 'staff']), id: z.uuid() });

export const libraryRoutes = Router();

// Catalogue.
libraryRoutes.get('/books', authenticated, needAny(['library.view', 'library.manage', 'library.issue', 'library.mine']), asyncHandler(async (req: Request, res: Response) => {
    const staff = await has(req, 'library.view') || await has(req, 'library.manage') || await has(req, 'library.issue');
    successResponse(res, await books.listBooks(parse(books.booksQuery, req.query), { activeOnly: !staff }), 'Books');
}));
libraryRoutes.get('/books/:id', authenticated, needAny(['library.view', 'library.manage', 'library.issue', 'library.mine']), asyncHandler(async (req: Request, res: Response) => {
    const staff = await has(req, 'library.view') || await has(req, 'library.issue');
    successResponse(res, await books.getBook(req.params.id, { members: staff }), 'Book');
}));
libraryRoutes.post('/books', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await books.saveBook(null, parse(books.bookSchema, req.body), uid(req)), 'Added', 201)));
libraryRoutes.put('/books/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await books.saveBook(req.params.id, parse(books.bookSchema, req.body), uid(req)), 'Saved')));
libraryRoutes.delete('/books/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await books.deleteBook(req.params.id), 'Deleted')));
libraryRoutes.post('/books/:id/copies', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await books.addCopies(req.params.id, parse(books.copiesSchema, req.body), uid(req)), 'Added', 201)));
libraryRoutes.put('/copies/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await books.updateCopy(req.params.id, parse(books.copySchema, req.body)), 'Saved')));
libraryRoutes.delete('/copies/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await books.deleteCopy(req.params.id), 'Deleted')));
libraryRoutes.get('/labels', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await books.labels(parse(books.labelsQuery, req.query)), 'Labels')));
libraryRoutes.post('/files', manage, upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose a file');
    const f = await saveUpload({ data: req.file.buffer, originalName: req.file.originalname, purpose: 'document', allowed: ['pdf', 'png', 'jpeg', 'webp'] });
    successResponse(res, { id: f.id, name: f.originalName }, 'Uploaded', 201);
}));
// Covers and e-books: anyone who can see the catalogue.
libraryRoutes.get('/books/:id/:what(cover|file)', authenticated, needAny(['library.view', 'library.manage', 'library.issue', 'library.mine']), asyncHandler(async (req: Request, res: Response) => {
    const b = await books.getBook(req.params.id, { members: false });
    const id = req.params.what === 'cover' ? b.coverFileId : b.fileId;
    if (!id) throw badRequest('Nothing to show');
    const { file, data } = await readFile(id);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true, cacheSeconds: 3600 });
}));

// The counter.
libraryRoutes.get('/summary', authenticated, staffSide, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await lib.counterSummary(), 'Today')));
libraryRoutes.get('/members', authenticated, needAny(['library.issue', 'library.view', 'library.fines']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await searchMembers(parse(z.object({ q: z.string().max(60).default('') }), req.query).q), 'Members')));
libraryRoutes.get('/members/:kind/:id', authenticated, needAny(['library.issue', 'library.view', 'library.fines']), asyncHandler(async (req: Request, res: Response) => {
    const m = parse(member, req.params);
    successResponse(res, await memberCard(m.kind, m.id), 'Member');
}));
// Library cards (printed with a barcode of the admission no / employee code).
libraryRoutes.get('/cards', authenticated, needAny(['library.manage', 'library.issue']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await cards(parse(cardsQuery, req.query)), 'Cards')));
libraryRoutes.get('/cards/logo', authenticated, needAny(['library.manage', 'library.issue']), asyncHandler(async (_req: Request, res: Response) => {
    const id = await schoolLogo();
    if (!id) throw badRequest('No logo');
    const { file, data } = await readFile(id);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true, cacheSeconds: 3600 });
}));
libraryRoutes.get('/members/:kind/:id/photo', authenticated, needAny(['library.manage', 'library.issue']), asyncHandler(async (req: Request, res: Response) => {
    const m = parse(member, req.params);
    const id = await memberPhoto(m.kind, m.id);
    if (!id) throw badRequest('No photo');
    const { file, data } = await readFile(id);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true, cacheSeconds: 3600 });
}));
libraryRoutes.get('/copies/find', authenticated, staffSide, asyncHandler(async (req: Request, res: Response) => {
    const c = await books.findCopy(parse(z.object({ accession: z.string().min(1).max(30) }), req.query).accession);
    successResponse(res, { id: c.id, accessionNo: c.accessionNo, status: c.status, bookId: c.bookId, title: c.book.title, authors: c.book.authors, kind: c.book.kind }, 'Copy');
}));
libraryRoutes.post('/issue', counter, asyncHandler(async (req: Request, res: Response) => successResponse(res, await desk.issue(parse(desk.issueSchema, req.body), uid(req)), 'Issued', 201)));
libraryRoutes.post('/return', counter, asyncHandler(async (req: Request, res: Response) => successResponse(res, await desk.returnBook(parse(desk.returnSchema, req.body), uid(req), await has(req, 'library.fines')), 'Returned')));
libraryRoutes.post('/loans/:id/renew', counter, asyncHandler(async (req: Request, res: Response) => successResponse(res, await desk.renew(req.params.id, uid(req), false), 'Renewed')));
libraryRoutes.post('/loans/:id/lost', fines, asyncHandler(async (req: Request, res: Response) => successResponse(res, await desk.markLost(req.params.id, uid(req)), 'Marked lost')));
libraryRoutes.get('/loans', authenticated, needAny(['library.view', 'library.issue']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await lib.listLoans(parse(lib.loansQuery, req.query)), 'Loans')));

// Reservations (the counter, for a member).
libraryRoutes.get('/reservations', authenticated, needAny(['library.view', 'library.issue']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await lib.listReservations(parse(lib.reservationsQuery, req.query)), 'Reservations')));
libraryRoutes.post('/reservations', counter, asyncHandler(async (req: Request, res: Response) => successResponse(res, await desk.reserve(parse(desk.reserveSchema, req.body), uid(req), false), 'Reserved', 201)));
libraryRoutes.post('/reservations/:id/cancel', counter, asyncHandler(async (req: Request, res: Response) => successResponse(res, await desk.cancelReservation(req.params.id, uid(req), false), 'Cancelled')));

// Fines.
libraryRoutes.get('/fines', authenticated, needAny(['library.view', 'library.fines']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await lib.listFines(parse(lib.finesQuery, req.query)), 'Fines')));
libraryRoutes.post('/fines/:id/waive', fines, asyncHandler(async (req: Request, res: Response) => successResponse(res, await desk.waiveFine(req.params.id, parse(desk.waiveSchema, req.body), uid(req)), 'Waived')));
libraryRoutes.post('/fines/:id/collect', fines, asyncHandler(async (req: Request, res: Response) => successResponse(res, await desk.collectFine(req.params.id, uid(req)), 'Paid')));

// Stock checks.
libraryRoutes.get('/stock', manage, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await lib.listStockChecks(), 'Stock checks')));
libraryRoutes.post('/stock', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await lib.startStockCheck(parse(z.object({ name: z.string().trim().max(80).default('') }), req.body).name, uid(req)), 'Started', 201)));
libraryRoutes.get('/stock/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await lib.stockCheck(req.params.id), 'Stock check')));
libraryRoutes.post('/stock/:id/scan', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await lib.scanStock(req.params.id, parse(z.object({ accessionNo: z.string().trim().min(1).max(30) }), req.body).accessionNo), 'Scanned')));
libraryRoutes.post('/stock/:id/close', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await lib.closeStockCheck(req.params.id, parse(z.object({ markLost: z.boolean().default(false) }), req.body).markLost, uid(req)), 'Closed')));

// My Library (students, parents, staff).
libraryRoutes.get('/mine', mine, asyncHandler(async (req: Request, res: Response) => successResponse(res, await lib.myLibrary(uid(req)), 'My library')));
libraryRoutes.post('/mine/renew/:id', mine, asyncHandler(async (req: Request, res: Response) => successResponse(res, await desk.renew(req.params.id, uid(req), true), 'Renewed')));
libraryRoutes.post('/mine/reserve', mine, asyncHandler(async (req: Request, res: Response) => successResponse(res, await desk.reserve(parse(desk.reserveSchema, req.body), uid(req), true), 'Reserved', 201)));
libraryRoutes.post('/mine/reservations/:id/cancel', mine, asyncHandler(async (req: Request, res: Response) => successResponse(res, await desk.cancelReservation(req.params.id, uid(req), true), 'Cancelled')));
libraryRoutes.get('/mine/members', mine, asyncHandler(async (req: Request, res: Response) => successResponse(res, await myMembers(uid(req)), 'Members')));
