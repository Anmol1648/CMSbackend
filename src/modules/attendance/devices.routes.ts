import express, { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { notFound, validationError } from '../../core/errors';
import { db } from '../../core/db';
import { runAsSystem, runAsTenant } from '../../core/context';
import { logger } from '../../core/logger';
import { can, publicRoute } from '../../middlewares/access';
import { createRateLimiter } from '../../middlewares/rate-limit';
import * as devices from './devices.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};

// ─── The office (Attendance → Attendance Devices) ────────────────────────────

export const deviceRoutes = Router();
const manage = can('attendance.staff');
deviceRoutes.get('/', manage, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await devices.listDevices(), 'Devices')));
deviceRoutes.post('/', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await devices.saveDevice(null, parse(devices.deviceSchema, req.body)), 'Device added', 201)));
deviceRoutes.get('/numbers', manage, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await devices.staffNumbers(), 'Machine numbers')));
deviceRoutes.put('/numbers/:staffId', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await devices.setStaffNumber(req.params.staffId, parse(devices.numberSchema, req.body)), 'Saved')));
deviceRoutes.get('/punches', manage, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await devices.recentPunches(), 'Punches')));
deviceRoutes.post('/import', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await devices.fromImport(parse(devices.importSchema, req.body)), 'Imported')));
deviceRoutes.put('/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await devices.saveDevice(req.params.id, parse(devices.deviceSchema, req.body)), 'Saved')));
deviceRoutes.post('/:id/token', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await devices.newDeviceToken(req.params.id), 'New address made')));
deviceRoutes.delete('/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await devices.deleteDevice(req.params.id), 'Removed')));

// ─── Other systems: webhook (no login; the token in the address is the key) ──

export const deviceWebhookRoutes = Router();
const webhookLimiter = createRateLimiter({ windowInMinutes: 1, maxAttempts: 120, keyPrefix: 'device-webhook' });

const deviceByToken = (token: string) =>
    /^[a-f0-9]{36}$/.test(token)
        ? runAsSystem(() => db.attendanceDevice.findFirst({ where: { token, isActive: true, kind: { in: ['webhook', 'import'] } }, select: { id: true, tenantId: true, tenant: { select: { status: true } } } }))
        : Promise.resolve(null);

deviceWebhookRoutes.post('/:token/punches', publicRoute, webhookLimiter, asyncHandler(async (req: Request, res: Response) => {
    const d = await deviceByToken(req.params.token);
    if (!d || d.tenant.status !== 'active') throw notFound('Not found');
    const input = parse(devices.webhookSchema, req.body);
    successResponse(res, await runAsTenant(d.tenantId, () => devices.fromWebhook(d.id, input)), 'Received');
}));

// ─── eSSL / ZKTeco machines: the ADMS push protocol at /iclock ───────────────

export const admsRoutes = Router();
admsRoutes.use(express.text({ type: () => true, limit: '5mb' }));

const machine = async (req: Request) => {
    const sn = String(req.query.SN ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{3,60}$/.test(sn)) return null;
    const d = await runAsSystem(() => db.attendanceDevice.findFirst({ where: { serialNo: sn, kind: 'essl_adms', isActive: true }, select: { id: true, tenantId: true, tenant: { select: { status: true } } } }));
    if (!d || d.tenant.status !== 'active') {
        logger.warn('Attendance machine not added (or switched off)', { sn });
        return null;
    }
    await runAsTenant(d.tenantId, () => db.attendanceDevice.update({ where: { id: d.id }, data: { lastSeenAt: new Date() } })).catch(() => undefined);
    return d;
};
const text = (res: Response, body: string) => res.type('text/plain').send(body);

// The machine asks what to send (on start and now and then).
admsRoutes.get('/cdata', publicRoute, asyncHandler(async (req: Request, res: Response) => {
    const d = await machine(req);
    if (!d) return text(res, 'OK');
    const sn = String(req.query.SN).toUpperCase();
    text(res, [`GET OPTION FROM: ${sn}`, 'ATTLOGStamp=None', 'OPERLOGStamp=9999', 'ATTPHOTOStamp=None', 'ErrorDelay=30', 'Delay=10', 'TransTimes=00:00;14:05', 'TransInterval=1', 'TransFlag=TransData AttLog', 'TimeZone=5.5', 'Realtime=1', 'Encrypt=None'].join('\n'));
}));
// The machine sends its records: attendance (ATTLOG) is used, the rest is acknowledged.
admsRoutes.post('/cdata', publicRoute, asyncHandler(async (req: Request, res: Response) => {
    const d = await machine(req);
    if (!d) return text(res, 'OK');
    const table = String(req.query.table ?? '').toUpperCase();
    const body = typeof req.body === 'string' ? req.body : '';
    if (table === 'ATTLOG') {
        const added = await runAsTenant(d.tenantId, () => devices.fromAdms(d.id, body));
        return text(res, `OK: ${added}`);
    }
    text(res, 'OK');
}));
// Commands for the machine (none) and their results.
admsRoutes.get('/getrequest', publicRoute, asyncHandler(async (req: Request, res: Response) => {
    await machine(req);
    text(res, 'OK');
}));
admsRoutes.post('/devicecmd', publicRoute, (_req: Request, res: Response) => text(res, 'OK'));
