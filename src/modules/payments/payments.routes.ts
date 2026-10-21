import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { notFound, validationError } from '../../core/errors';
import { parseListQuery } from '../../core/http/list-query';
import { getTenantId, runAsTenant } from '../../core/context';
import { authenticated, can, publicRoute } from '../../middlewares/access';
import { createRateLimiter } from '../../middlewares/rate-limit';
import { findTenantByCode } from '../tenants';
import { db } from '../../core/db';
import * as payments from './payments.service';
import { onlinePaymentListSpec } from './payments.schemas';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};

declare global {
    namespace Express {
        interface Request {
            /** The exact bytes of a JSON body (gateway webhooks are signed over them). */
            rawBody?: Buffer;
        }
    }
}

/** The signed-in school's code (it names the school in the webhook address). */
const schoolCode = async () => (await db.tenant.findUnique({ where: { id: getTenantId()! }, select: { code: true } }))?.code ?? '';

export const paymentRoutes = Router();
const configure = can('payment.configure');

// The school's gateway and the list of online payments (office)
paymentRoutes.get('/gateway', configure, asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await payments.gatewaySettings(`${req.protocol}://${req.get('host')}`, await schoolCode()), 'Payment gateway');
}));
paymentRoutes.put('/gateway', configure, asyncHandler(async (req: Request, res: Response) => {
    await payments.saveGateway(parse(payments.gatewaySchema, req.body));
    successResponse(res, await payments.gatewaySettings(`${req.protocol}://${req.get('host')}`, await schoolCode()), 'Payment gateway saved');
}));
paymentRoutes.get('/', configure, asyncHandler(async (req: Request, res: Response) => successResponse(res, await payments.listOnlinePayments(parseListQuery(req.query, onlinePaymentListSpec)), 'Online payments')));
paymentRoutes.post('/:id/check', configure, asyncHandler(async (req: Request, res: Response) => successResponse(res, await payments.checkStatus(req.params.id), 'Checked with the gateway')));

// A parent or student paying fees
paymentRoutes.post('/fees', can('fee.pay_online'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await payments.startFeePayment(req.user!.userId, parse(payments.payFeesSchema, req.body)), 'Payment started', 201)));
// UPI QR codes: the parent in My Fees, or the cashier at the counter, shows one; the screen asks until it is paid.
paymentRoutes.post('/fees/qr', can('fee.pay_online'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await payments.startQrPayment(req.user!.userId, parse(payments.qrSchema, req.body), false), 'Scan to pay', 201)));
paymentRoutes.post('/counter-qr', can('fee.collect'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await payments.startQrPayment(req.user!.userId, parse(payments.qrSchema, req.body), true), 'Scan to pay', 201)));
paymentRoutes.get('/:id/qr', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await payments.pollQr(req.params.id, req.user!.userId), 'Payment')));
paymentRoutes.post('/:id/qr/cancel', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await payments.cancelQr(req.params.id, req.user!.userId), 'QR code closed')));
paymentRoutes.post('/:id/confirm', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await payments.confirmPayment(req.params.id, parse(payments.confirmSchema, req.body), req.user!.userId), 'Payment received')));
paymentRoutes.post('/:id/failed', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await payments.reportFailure(req.params.id, parse(payments.failSchema, req.body), req.user!.userId), 'Payment not completed')));
paymentRoutes.post('/:id/mock', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await payments.mockComplete(req.params.id, parse(payments.mockSchema, req.body), req.user!.userId), 'Test payment done')));
paymentRoutes.get('/:id', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const p = z.uuid().safeParse(req.params.id).success ? await db.onlinePayment.findUnique({ where: { id: req.params.id } }) : null;
    if (!p || p.userId !== req.user!.userId) throw notFound('Payment not found');
    successResponse(res, await payments.paymentResult(p.id), 'Payment');
}));

/** No login: the website form's registration fee, and the gateway's webhook. */
export const publicPaymentRoutes = Router();
const publicLimiter = createRateLimiter({ windowInMinutes: 15, maxAttempts: 30, keyPrefix: 'public-payment' });

/** Only payments made without a login (the website form) can be finished here. */
const anonymous = async (id: string) => {
    const p = z.uuid().safeParse(id).success ? await db.onlinePayment.findUnique({ where: { id } }) : null;
    if (!p || p.userId) throw notFound('Payment not found');
    return p;
};
publicPaymentRoutes.post('/:id/confirm', publicRoute, publicLimiter, asyncHandler(async (req: Request, res: Response) => {
    const p = await anonymous(req.params.id);
    successResponse(res, await payments.confirmPayment(p.id, parse(payments.confirmSchema, req.body), null), 'Payment received');
}));
publicPaymentRoutes.post('/:id/failed', publicRoute, publicLimiter, asyncHandler(async (req: Request, res: Response) => {
    const p = await anonymous(req.params.id);
    successResponse(res, await payments.reportFailure(p.id, parse(payments.failSchema, req.body), null), 'Payment not completed');
}));
publicPaymentRoutes.post('/:id/mock', publicRoute, publicLimiter, asyncHandler(async (req: Request, res: Response) => {
    const p = await anonymous(req.params.id);
    successResponse(res, await payments.mockComplete(p.id, parse(payments.mockSchema, req.body), null), 'Test payment done');
}));
// The gateway calls https://<api>/api/public/payments/razorpay/webhook/<school code>.
publicPaymentRoutes.post('/:provider(razorpay)/webhook/:school', publicRoute, asyncHandler(async (req: Request, res: Response) => {
    const code = req.params.school.toLowerCase();
    const tenant = /^[a-z0-9-]{2,40}$/.test(code) ? await findTenantByCode(code) : null;
    if (!tenant || tenant.status !== 'active' || !req.rawBody) throw notFound('Not found');
    const r = await runAsTenant(tenant.id, () => payments.handleWebhook(req.params.provider, req.rawBody!, req.headers));
    successResponse(res, r, 'OK');
}));
