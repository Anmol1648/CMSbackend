import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, forbidden, notFound, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { readFile } from '../../core/files';
import { sendFile, upload } from '../../core/http/files';
import { db } from '../../core/db';
import { getUserAccess } from '../rbac/access.service';
import * as ic from './idcards.service';
import { cardsPdf, cardsPdfSchema, myCardPdf, myCardPng, previewPng, previewSchema } from './idcards.print';

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
const image = (req: Request) => {
    if (!req.file) throw badRequest('Choose a photo (PNG, JPG or WebP)');
    return req.file;
};
const any = needAny(['idcard.print', 'idcard.design', 'idcard.view', 'idcard.photos', 'idcard.verify', 'idcard.mine']);
const send = async (res: Response, fileId: string) => {
    const { file, data } = await readFile(fileId);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true, cacheSeconds: 86_400 });
};

export const idCardRoutes = Router();

idCardRoutes.get('/options', authenticated, needAny(['idcard.print', 'idcard.design', 'idcard.view']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ic.options(uid(req)), 'Options')));

// Designs.
idCardRoutes.get('/designs', authenticated, needAny(['idcard.design', 'idcard.print']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await ic.listDesigns(), 'Designs')));
idCardRoutes.post('/designs/image', can('idcard.design'), upload.single('image'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ic.uploadImage(image(req)), 'Uploaded', 201)));
idCardRoutes.post('/designs', can('idcard.design'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ic.saveDesign(null, parse(ic.designSchema, req.body), uid(req)), 'Saved', 201)));
idCardRoutes.put('/designs/:id', can('idcard.design'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ic.saveDesign(req.params.id, parse(ic.designSchema, req.body), uid(req)), 'Saved')));
idCardRoutes.post('/designs/:id/copy', can('idcard.design'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ic.copyDesign(req.params.id, uid(req)), 'Copied', 201)));
idCardRoutes.delete('/designs/:id', can('idcard.design'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ic.deleteDesign(req.params.id), 'Removed')));
idCardRoutes.get('/designs/:id/signature', authenticated, any, asyncHandler(async (req: Request, res: Response) => {
    const d = await db.idCardDesign.findFirst({ where: { id: req.params.id }, select: { signatureFileId: true } });
    if (!d?.signatureFileId) throw notFound('No signature');
    await send(res, d.signatureFileId);
}));
/** The design being edited, drawn on a sample person (PNG, for the app's design screen). */
idCardRoutes.post('/designs/preview', can('idcard.design'), asyncHandler(async (req: Request, res: Response) => {
    sendFile(res, 'card.png', 'image/png', await previewPng(parse(previewSchema, req.body)), { inline: true });
}));
/** A design image just uploaded (preview before saving). */
idCardRoutes.get('/images/:fileId', can('idcard.design'), asyncHandler(async (req: Request, res: Response) => send(res, req.params.fileId)));

// Choosing people and printing.
idCardRoutes.post('/pick', can('idcard.print'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ic.pick(parse(ic.pickSchema, req.body)), 'People')));
idCardRoutes.get('/search', can('idcard.print'), asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ type: z.enum(['student', 'staff']), q: z.string().max(60).default('') }), req.query);
    successResponse(res, await ic.search(q.type, q.q), 'People');
}));
idCardRoutes.post('/print', can('idcard.print'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ic.print(parse(ic.printSchema, req.body), uid(req)), 'Recorded')));

/** The cards as a PDF to print (A4 sheets or one side per page), from the app; doesn't record a print (POST /print does). */
idCardRoutes.post('/pdf', can('idcard.print'), asyncHandler(async (req: Request, res: Response) => {
    sendFile(res, 'id-cards.pdf', 'application/pdf', await cardsPdf(parse(cardsPdfSchema, req.body)), { inline: true });
}));

// Cards given.
idCardRoutes.get('/cards', authenticated, needAny(['idcard.print', 'idcard.view']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ic.listCards(parse(ic.cardsQuery, req.query)), 'Cards')));
idCardRoutes.post('/cards/:id/duplicate', can('idcard.print'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ic.duplicate(req.params.id, parse(ic.duplicateSchema, req.body), uid(req)), 'Replaced', 201)));
idCardRoutes.post('/cards/:id/cancel', can('idcard.print'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ic.cancelCard(req.params.id), 'Cancelled')));
idCardRoutes.post('/cards/:id/printed', can('idcard.print'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ic.markPrinted(req.params.id), 'Recorded')));

// Checking a card.
idCardRoutes.get('/verify/:code', can('idcard.verify'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ic.verify(req.params.code), 'Checked')));

// Photos.
idCardRoutes.get('/photo/:type/:id', authenticated, any, asyncHandler(async (req: Request, res: Response) => {
    const type = parse(z.enum(['student', 'staff']), req.params.type);
    await send(res, await ic.photoFile(type, req.params.id, uid(req)));
}));
idCardRoutes.get('/photos/sections', authenticated, needAny(['idcard.photos', 'idcard.print']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ic.photoSections(uid(req)), 'Sections')));
idCardRoutes.get('/photos/sections/:id', authenticated, needAny(['idcard.photos', 'idcard.print']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ic.sectionPhotos(req.params.id, uid(req)), 'Students')));
idCardRoutes.post('/photos/student/:id', authenticated, needAny(['idcard.photos', 'idcard.print']), upload.single('image'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ic.takeStudentPhoto(req.params.id, image(req), uid(req)), 'Photo saved')));
idCardRoutes.post('/photos/staff/:id', can('idcard.print'), upload.single('image'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ic.takeStaffPhoto(req.params.id, image(req)), 'Photo saved')));
idCardRoutes.get('/photo-requests', can('idcard.print'), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await ic.photoRequests(), 'Photos sent')));
idCardRoutes.get('/photo-requests/:id/image', authenticated, any, asyncHandler(async (req: Request, res: Response) => send(res, await ic.requestFile(req.params.id, uid(req)))));
idCardRoutes.post('/photo-requests/:id/answer', can('idcard.print'), asyncHandler(async (req: Request, res: Response) => {
    const b = parse(z.object({ approve: z.boolean(), note: z.string().trim().max(300).nullable().optional() }), req.body);
    successResponse(res, await ic.answerRequest(req.params.id, b.approve, b.note || null, uid(req)), 'Answered');
}));

// My ID card.
idCardRoutes.get('/mine', can('idcard.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ic.myCards(uid(req)), 'My card')));
idCardRoutes.get('/mine/:type/:id/card.png', can('idcard.mine'), asyncHandler(async (req: Request, res: Response) => {
    const type = parse(z.enum(['student', 'staff']), req.params.type);
    const side = parse(z.enum(['front', 'back']).default('front'), req.query.side);
    sendFile(res, `card-${side}.png`, 'image/png', await myCardPng(uid(req), type, req.params.id, side), { inline: true });
}));
idCardRoutes.get('/mine/:type/:id/pdf', can('idcard.mine'), asyncHandler(async (req: Request, res: Response) => {
    const type = parse(z.enum(['student', 'staff']), req.params.type);
    const c = await myCardPdf(uid(req), type, req.params.id);
    sendFile(res, `${c.name.replace(/[^\w]+/g, '-')}-id-card.pdf`, 'application/pdf', c.pdf, { inline: true });
}));
idCardRoutes.post('/mine/photo/:studentId', can('idcard.mine'), upload.single('image'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await ic.sendPhoto(req.params.studentId, image(req), uid(req)), 'Sent', 201)));
