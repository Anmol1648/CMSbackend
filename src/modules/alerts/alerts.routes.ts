import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, forbidden, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { sendFile, upload } from '../../core/http/files';
import { saveUpload } from '../../core/files';
import { buildWorkbook, XLSX_MIME } from '../../core/excel';
import { getUserAccess } from '../rbac/access.service';
import * as notes from './notifications.service';
import * as messages from './messages.service';
import * as alerts from './alerts.service';

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

export const alertRoutes = Router();

// ─── My notifications (everyone) ─────────────────────────────────────────────

alertRoutes.get('/bell', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const since = typeof req.query.since === 'string' && !Number.isNaN(Date.parse(req.query.since)) ? new Date(req.query.since) : undefined;
    successResponse(res, await notes.bell(uid(req), since), 'Notifications');
}));
alertRoutes.get('/notifications', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await notes.myNotifications(uid(req), parse(notes.listQuery, req.query)), 'Notifications')));
alertRoutes.post('/notifications/read', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const b = parse(z.strictObject({ ids: z.union([z.literal('all'), z.array(z.uuid()).max(200)]) }), req.body);
    successResponse(res, await notes.markRead(uid(req), b.ids), 'Marked as read');
}));
alertRoutes.delete('/notifications/:id', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await notes.removeNotification(uid(req), req.params.id), 'Deleted')));
alertRoutes.get('/preferences', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await notes.myPreferences(uid(req)), 'Preferences')));
alertRoutes.put('/preferences', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await notes.savePreferences(uid(req), parse(notes.preferencesSchema, req.body)), 'Saved')));

// ─── Compose and sent messages ───────────────────────────────────────────────

const senders = needAny(['message.send']);
alertRoutes.get('/compose/options', authenticated, senders, asyncHandler(async (req: Request, res: Response) => successResponse(res, await messages.pickerOptions(uid(req), typeof req.query.search === 'string' ? req.query.search.slice(0, 60) : undefined), 'Options')));
alertRoutes.post('/compose/preview', authenticated, senders, asyncHandler(async (req: Request, res: Response) => successResponse(res, await messages.previewMessage(parse(messages.composeSchema, req.body), uid(req)), 'Preview')));
alertRoutes.post('/compose', authenticated, senders, asyncHandler(async (req: Request, res: Response) => successResponse(res, await messages.sendMessage(parse(messages.composeSchema, req.body), uid(req)), 'Sent', 201)));
alertRoutes.post('/attachments', authenticated, senders, upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose a file (PDF, PNG or JPG)');
    const f = await saveUpload({ data: req.file.buffer, originalName: req.file.originalname, purpose: 'document', allowed: ['pdf', 'png', 'jpeg'] });
    successResponse(res, { id: f.id, name: f.originalName }, 'Uploaded', 201);
}));
const sentViewers = needAny(['message.send', 'message.view_sent']);
alertRoutes.get('/messages', authenticated, sentViewers, asyncHandler(async (req: Request, res: Response) => successResponse(res, await messages.listSent(parse(messages.sentQuery, req.query), uid(req)), 'Messages')));
alertRoutes.get('/messages/:id', authenticated, sentViewers, asyncHandler(async (req: Request, res: Response) => successResponse(res, await messages.getMessage(req.params.id, uid(req)), 'Message')));
alertRoutes.post('/messages/:id/cancel', authenticated, sentViewers, asyncHandler(async (req: Request, res: Response) => successResponse(res, await messages.cancelMessage(req.params.id, uid(req)), 'Cancelled')));

alertRoutes.get('/templates', authenticated, needAny(['message.send', 'alert.templates']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await messages.listTemplates(), 'Templates')));
alertRoutes.post('/templates', can('alert.templates'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await messages.saveTemplate(null, parse(messages.templateSchema, req.body)), 'Saved', 201)));
alertRoutes.put('/templates/:id', can('alert.templates'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await messages.saveTemplate(req.params.id, parse(messages.templateSchema, req.body)), 'Saved')));
alertRoutes.delete('/templates/:id', can('alert.templates'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await messages.deleteTemplate(req.params.id), 'Deleted')));

alertRoutes.get('/groups', authenticated, senders, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await messages.listGroups(), 'Groups')));
alertRoutes.post('/groups', authenticated, senders, asyncHandler(async (req: Request, res: Response) => successResponse(res, await messages.saveGroup(null, parse(messages.groupSchema, req.body), uid(req)), 'Saved', 201)));
alertRoutes.put('/groups/:id', authenticated, senders, asyncHandler(async (req: Request, res: Response) => successResponse(res, await messages.saveGroup(req.params.id, parse(messages.groupSchema, req.body), uid(req)), 'Saved')));
alertRoutes.delete('/groups/:id', authenticated, needAny(['message.send_groups', 'alert.setup']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await messages.deleteGroup(req.params.id), 'Deleted')));

// ─── Built-in alerts, daily jobs, channels ───────────────────────────────────

const setup = can('alert.setup');
alertRoutes.get('/builtin', setup, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await alerts.listAlerts(), 'Alerts')));
alertRoutes.get('/builtin/:key', setup, asyncHandler(async (req: Request, res: Response) => successResponse(res, await alerts.getAlert(req.params.key), 'Alert')));
alertRoutes.put('/builtin/:key', setup, asyncHandler(async (req: Request, res: Response) => successResponse(res, await alerts.saveAlert(req.params.key, parse(alerts.alertSchema, req.body), uid(req)), 'Saved')));
alertRoutes.post('/builtin/:key/reset', setup, asyncHandler(async (req: Request, res: Response) => successResponse(res, await alerts.resetAlert(req.params.key), 'Back to the default')));
alertRoutes.post('/builtin/:key/preview', setup, asyncHandler(async (req: Request, res: Response) => successResponse(res, await alerts.previewAlert(req.params.key, parse(alerts.alertSchema.partial(), req.body)), 'Preview')));
alertRoutes.post('/builtin/:key/test', setup, asyncHandler(async (req: Request, res: Response) => successResponse(res, await alerts.testAlert(req.params.key, uid(req), parse(alerts.alertSchema.partial(), req.body)), 'Test sent')));
alertRoutes.get('/jobs', setup, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await alerts.listJobs(), 'Jobs')));
alertRoutes.post('/jobs/:key/run', setup, asyncHandler(async (req: Request, res: Response) => successResponse(res, await alerts.runJobNow(req.params.key), 'Done')));
alertRoutes.get('/channels', setup, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await alerts.channelSetup(), 'Channels')));
alertRoutes.put('/channels/keys', setup, asyncHandler(async (req: Request, res: Response) => successResponse(res, await alerts.saveChannelKeys(parse(alerts.channelKeysSchema, req.body), uid(req)), 'Saved')));

// ─── Alert log ───────────────────────────────────────────────────────────────

const logViewers = can('alert.log');
alertRoutes.get('/log', logViewers, asyncHandler(async (req: Request, res: Response) => successResponse(res, await alerts.alertLog(parse(alerts.logQuery, req.query), uid(req)), 'Log')));
alertRoutes.get('/log/export', logViewers, asyncHandler(async (req: Request, res: Response) => {
    const rows = await alerts.exportLog(parse(alerts.logQuery, req.query), uid(req));
    const data = await buildWorkbook(
        'Alert log',
        [
            { header: 'Time', width: 20, type: 'date', value: (r) => r.createdAt },
            { header: 'Alert / message', width: 28, value: (r) => r.alertKey },
            { header: 'To', width: 26, value: (r) => r.recipientName },
            { header: 'Who', width: 10, value: (r) => r.recipientKind },
            { header: 'Address', width: 28, value: (r) => r.address },
            { header: 'Channel', width: 10, value: (r) => r.channel },
            { header: 'Status', width: 10, value: (r) => r.status },
            { header: 'Subject', width: 40, value: (r) => r.subject },
            { header: 'Reason', width: 40, value: (r) => r.reason },
        ],
        rows,
        { title: 'Alert log' }
    );
    sendFile(res, `alert-log-${new Date().toISOString().slice(0, 10)}.xlsx`, XLSX_MIME, data);
}));
alertRoutes.get('/log/bouncing', logViewers, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await alerts.bouncing(), 'Addresses')));
alertRoutes.post('/log/:id/retry', logViewers, asyncHandler(async (req: Request, res: Response) => successResponse(res, await alerts.retryDelivery(req.params.id), 'Queued again')));
