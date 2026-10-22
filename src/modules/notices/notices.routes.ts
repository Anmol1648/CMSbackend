import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, forbidden, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { sendFile, upload } from '../../core/http/files';
import { readFile, saveUpload } from '../../core/files';
import { getUserAccess } from '../rbac/access.service';
import { getSettings } from '../../core/settings';
import { audienceOptions } from './audience';
import { NOTICES } from './notices.settings';
import * as notices from './notices.service';
import * as events from './events.service';

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
const WRITERS = ['notice.create', 'notice.publish', 'event.manage'];

const attachmentUpload = asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose a file (PDF, PNG or JPG)');
    const f = await saveUpload({ data: req.file.buffer, originalName: req.file.originalname, purpose: 'document', allowed: ['pdf', 'png', 'jpeg'] });
    successResponse(res, { id: f.id, name: f.originalName }, 'Uploaded', 201);
});
const sendAttachment = async (res: Response, fileId: string) => {
    const { file, data } = await readFile(fileId);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true });
};

// ─── Notices ─────────────────────────────────────────────────────────────────

export const noticeRoutes = Router();

// Everyone: the notices meant for them.
noticeRoutes.get('/', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await notices.myNotices(parse(notices.listQuery, req.query), uid(req)), 'Notices')));
noticeRoutes.get('/unread', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await notices.unreadCount(uid(req)), 'Unread')));

// The office: writing, publishing, read counts.
noticeRoutes.get('/audience-options', authenticated, needAny(WRITERS), asyncHandler(async (_req: Request, res: Response) => {
    const s = await getSettings({ approval: NOTICES.approval, ackDefault: NOTICES.ackDefault });
    successResponse(res, { ...(await audienceOptions()), ...s }, 'Audience');
}));
noticeRoutes.get('/manage', authenticated, needAny(['notice.create', 'notice.publish']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await notices.manageNotices(parse(notices.manageQuery, req.query), uid(req)), 'Notices')));
noticeRoutes.post('/attachments', authenticated, needAny(WRITERS), upload.single('file'), attachmentUpload);
noticeRoutes.post('/', authenticated, needAny(['notice.create', 'notice.publish']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await notices.createNotice(parse(notices.noticeSchema, req.body), uid(req)), 'Notice saved', 201)));
noticeRoutes.get('/:id/manage', authenticated, needAny(['notice.create', 'notice.publish']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await notices.manageOne(req.params.id), 'Notice')));
noticeRoutes.put('/:id', authenticated, needAny(['notice.create', 'notice.publish']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await notices.updateNotice(req.params.id, parse(notices.noticeSchema, req.body), uid(req)), 'Notice saved')));
noticeRoutes.post('/:id/publish', authenticated, needAny(['notice.create', 'notice.publish']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await notices.publishNotice(req.params.id, uid(req)), 'Done')));
noticeRoutes.post('/:id/unpublish', authenticated, needAny(['notice.create', 'notice.publish']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await notices.unpublishNotice(req.params.id, uid(req)), 'Back to draft')));
noticeRoutes.delete('/:id', authenticated, needAny(['notice.create', 'notice.publish']), asyncHandler(async (req: Request, res: Response) => {
    await notices.deleteNotice(req.params.id, uid(req));
    successResponse(res, null, 'Notice deleted');
}));
noticeRoutes.get('/:id/readers', authenticated, needAny(['notice.create', 'notice.publish', 'notice.reports']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await notices.readers(req.params.id, uid(req)), 'Readers')));

// Everyone: one notice, acknowledging, attachments.
noticeRoutes.get('/:id', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await notices.openNotice(req.params.id, uid(req)), 'Notice')));
noticeRoutes.post('/:id/acknowledge', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await notices.acknowledge(req.params.id, uid(req)), 'Thank you')));
noticeRoutes.get('/:id/attachments/:fileId', authenticated, asyncHandler(async (req: Request, res: Response) => sendAttachment(res, await notices.attachmentOf(req.params.id, req.params.fileId, uid(req)))));

// ─── Events ──────────────────────────────────────────────────────────────────

export const eventRoutes = Router();

eventRoutes.get('/', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await events.calendar(parse(events.calendarQuery, req.query), uid(req)), 'Calendar')));
eventRoutes.get('/upcoming', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await events.upcoming(uid(req)), 'Upcoming')));
eventRoutes.post('/attachments', can('event.manage'), upload.single('file'), attachmentUpload);
eventRoutes.post('/', can('event.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await events.createEvent(parse(events.eventSchema, req.body), uid(req)), 'Event added', 201)));
eventRoutes.put('/:id', can('event.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await events.updateEvent(req.params.id, parse(events.eventSchema, req.body), uid(req)), 'Event saved')));
eventRoutes.post('/:id/cancel', can('event.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await events.setCancelled(req.params.id, parse(z.object({ cancelled: z.boolean().default(true) }), req.body).cancelled, uid(req)), 'Saved')));
eventRoutes.delete('/:id', can('event.manage'), asyncHandler(async (req: Request, res: Response) => {
    await events.deleteEvent(req.params.id, uid(req));
    successResponse(res, null, 'Event deleted');
}));
eventRoutes.get('/:id/attachments/:fileId', authenticated, asyncHandler(async (req: Request, res: Response) => sendAttachment(res, await events.eventAttachment(req.params.id, req.params.fileId, uid(req)))));
