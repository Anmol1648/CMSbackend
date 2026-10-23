import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import { z } from 'zod';
import { db, lockInTransaction, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { decryptSecret, encryptSecret } from '../../core/encryption';
import { logger } from '../../core/logger';
import { isProduction } from '../../config/env';
import { ListQuery, listResult } from '../../core/http/list-query';
import { currentYear } from '../academic/years.service';
import { fullName } from '../students/students.service';
import { ADMISSIONS } from '../admissions/admissions.settings';
import { registrationPaidOnline } from '../admissions/enquiries.service';
import { FEES } from '../fees/fees.settings';
import { allocate, coversWhole } from '../fees/dues.service';
import { duesOf, recordReceipt } from '../fees/receipts.service';
import { GatewayConfig, mockSignature, PROVIDERS } from './providers';
import type { onlinePaymentFilters } from './payments.schemas';
import { alertReceipt } from '../fees/fee.alerts';

/** Online payments: the school's gateway account, orders, confirmation (browser + webhook), status checks. */

const today = () => new Date().toISOString().slice(0, 10);
const uuidOk = (id: string) => z.uuid().safeParse(id).success;

// ─── The school's gateway ────────────────────────────────────────────────────

export const mockAllowed = () => !isProduction;
type Mode = 'test' | 'live';
type ModeConfig = GatewayConfig & { mode: Mode };

/** The keys of a mode (the one in use, unless asked): test keys, or the live ones (real money). */
const loadGateway = async (mode?: Mode): Promise<ModeConfig | null> => {
    const g = await db.paymentGateway.findFirst();
    if (!g) return null;
    if (g.provider === 'mock' && !mockAllowed()) return null;
    const m = (mode ?? g.mode) as Mode;
    const dec = (v: string | null) => (v ? decryptSecret(v) : null);
    return m === 'live'
        ? { provider: g.provider as GatewayConfig['provider'], mode: 'live', keyId: g.liveKeyId, keySecret: dec(g.liveKeySecretEnc), webhookSecret: dec(g.liveWebhookSecretEnc) }
        : { provider: g.provider as GatewayConfig['provider'], mode: 'test', keyId: g.keyId, keySecret: dec(g.keySecretEnc), webhookSecret: dec(g.webhookSecretEnc) };
};

const ready = (g: GatewayConfig | null) => !!g && (g.provider === 'mock' || (!!g.keyId && !!g.keySecret));

/** For the set-up screen: never the secrets themselves. */
export const gatewaySettings = async (webhookBase: string, schoolCode: string) => {
    const g = await db.paymentGateway.findFirst();
    const s = await getSettings({ fees: FEES.onlineFees, registration: FEES.onlineRegistration });
    return {
        provider: g?.provider ?? null,
        mode: (g?.mode ?? 'test') as Mode,
        test: { keyId: g?.keyId ?? null, hasKeySecret: !!g?.keySecretEnc, hasWebhookSecret: !!g?.webhookSecretEnc, ready: ready(await loadGateway('test')) },
        live: { keyId: g?.liveKeyId ?? null, hasKeySecret: !!g?.liveKeySecretEnc, hasWebhookSecret: !!g?.liveWebhookSecretEnc, ready: g?.provider === 'razorpay' && ready(await loadGateway('live')) },
        ready: ready(await loadGateway()),
        mockAllowed: mockAllowed(),
        webhookUrl: `${webhookBase}/api/public/payments/razorpay/webhook/${schoolCode}`,
        onlineFees: s.fees,
        onlineRegistration: s.registration,
        updatedAt: g?.updatedAt ?? null,
    };
};

const optionalText = z.union([z.literal('').transform(() => null), z.string().trim().max(100), z.null()]).optional();
/** A Razorpay secret is letters and digits (24 today); this stops a browser's saved password being stored. */
const secret = z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === '' || /^[A-Za-z0-9]{16,64}$/.test(v), "doesn't look like a Razorpay secret (letters and digits only, from the dashboard)")
    .optional();
export const gatewaySchema = z.strictObject({
    provider: z.enum(['razorpay', 'mock']),
    /** Which keys are used: test (no real money) or live. */
    mode: z.enum(['test', 'live']).optional(),
    keyId: optionalText,
    /** Empty / left out = keep the saved one. */
    keySecret: secret,
    webhookSecret: z.string().trim().max(200).optional(),
    liveKeyId: optionalText,
    liveKeySecret: secret,
    liveWebhookSecret: z.string().trim().max(200).optional(),
});

export const saveGateway = async (input: z.infer<typeof gatewaySchema>) => {
    if (input.provider === 'mock' && !mockAllowed()) throw badRequest('The test gateway is not available on the live system');
    if (input.provider === 'razorpay' && input.keyId && !/^rzp_test_[A-Za-z0-9]+$/.test(input.keyId)) throw badRequest('A Razorpay test key id looks like rzp_test_…', [{ field: 'keyId', message: 'should start with rzp_test_' }]);
    if (input.liveKeyId && !/^rzp_live_[A-Za-z0-9]+$/.test(input.liveKeyId)) throw badRequest('A Razorpay live key id looks like rzp_live_…', [{ field: 'liveKeyId', message: 'should start with rzp_live_' }]);
    const tenantId = getTenantId()!;
    const current = await db.paymentGateway.findFirst();
    const data = {
        provider: input.provider,
        ...(input.keyId !== undefined ? { keyId: input.keyId } : {}),
        ...(input.keySecret ? { keySecretEnc: encryptSecret(input.keySecret) } : {}),
        ...(input.webhookSecret ? { webhookSecretEnc: encryptSecret(input.webhookSecret) } : {}),
        ...(input.liveKeyId !== undefined ? { liveKeyId: input.liveKeyId } : {}),
        ...(input.liveKeySecret ? { liveKeySecretEnc: encryptSecret(input.liveKeySecret) } : {}),
        ...(input.liveWebhookSecret ? { liveWebhookSecretEnc: encryptSecret(input.liveWebhookSecret) } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
    };
    // Live mode needs live keys (the test gateway has no live mode).
    const liveKeyId = input.liveKeyId !== undefined ? input.liveKeyId : current?.liveKeyId;
    const liveSecret = !!input.liveKeySecret || !!current?.liveKeySecretEnc;
    if ((input.mode ?? current?.mode) === 'live' && (input.provider !== 'razorpay' || !liveKeyId || !liveSecret)) {
        throw badRequest('Live mode needs the Razorpay live key id and secret', [{ field: 'mode', message: 'enter the live keys first' }]);
    }
    await db.paymentGateway.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
    await recordAudit({
        action: 'payment_gateway_saved',
        entity: 'school',
        changes: { provider: input.provider, mode: input.mode ?? current?.mode ?? 'test', keyId: input.keyId ?? undefined, liveKeyId: input.liveKeyId ?? undefined, secretsChanged: !!(input.keySecret || input.webhookSecret || input.liveKeySecret || input.liveWebhookSecret) },
    });
};

// ─── Starting a payment ──────────────────────────────────────────────────────

const convenienceFee = async (amount: number) => {
    const s = await getSettings({ mode: FEES.convenienceMode, value: FEES.convenienceValue });
    return s.mode === 'percent' ? Math.ceil((amount * s.value) / 100) : s.mode === 'fixed' ? Math.ceil(s.value) : 0;
};

/** What the browser needs to open the gateway's window. */
const checkout = (g: GatewayConfig, p: { id: string; orderId: string; amount: number }, label: string, prefill: { name?: string; email?: string | null; contact?: string | null }) => ({
    paymentId: p.id,
    provider: g.provider,
    keyId: g.provider === 'razorpay' ? g.keyId : null,
    orderId: p.orderId,
    amount: p.amount,
    amountPaise: p.amount * 100,
    currency: 'INR',
    description: label,
    prefill,
});

/** The signed-in person is the student, or a parent in the student's family. */
export const assertPayer = async (userId: string, studentId: string) => {
    const s = uuidOk(studentId)
        ? await db.student.findFirst({ where: { id: studentId, OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, include: { family: { select: { guardians: { where: { userId }, select: { name: true, email: true, mobile: true } } } } } })
        : null;
    if (!s) throw notFound('Student not found');
    return s;
};

export const payFeesSchema = z.strictObject({
    studentId: z.uuid(),
    instalmentIds: z.array(z.uuid()).max(24).optional(),
    /** Less than the whole of the chosen dues (when part payment is allowed). */
    amount: z.number().int('whole rupees').min(1).max(10_000_000).optional(),
});

/** What a fee payment pays (the dues it clears) and its total, checked the same way everywhere. */
const prepareFeePayment = async (studentId: string, input: { instalmentIds?: string[]; amount?: number }, opts: { counter: boolean; userId: string }) => {
    const s = await getSettings({ enabled: FEES.onlineFees, partial: FEES.partialPayment, minimum: FEES.minimumOnline });
    if (!opts.counter && !s.enabled) throw forbidden('Online payment is switched off; please pay at the school office');
    const g = await loadGateway();
    if (!ready(g)) throw badRequest(opts.counter ? 'Set up the payment gateway first (Fees → Online Payments)' : 'Online payment is not set up yet; please pay at the school office');
    const student = opts.counter
        ? await db.student.findUnique({ where: { id: studentId }, include: { family: { select: { guardians: { where: { isPrimary: true }, select: { name: true, email: true, mobile: true } } } } } })
        : await assertPayer(opts.userId, studentId);
    if (!student) throw notFound('Student not found');
    const year = await currentYear();
    if (!year) throw badRequest('No current academic year');
    const dues = await duesOf(student.id, year.id);
    if (!dues) throw badRequest('The student is not enrolled this year');
    const only = input.instalmentIds?.length ? input.instalmentIds : undefined;
    const payable = dues.instalments.filter((i) => !only || only.includes(i.id)).reduce((a, i) => a + i.balance, 0);
    const amount = input.amount ?? payable;
    if (!payable) throw badRequest('Nothing is due');
    if (amount > payable) throw badRequest(`Only ₹${payable} is due`, [{ field: 'amount', message: `must be at most ₹${payable}` }]);
    if (amount < Math.min(s.minimum, payable)) throw badRequest(`The smallest online payment is ₹${s.minimum}`, [{ field: 'amount', message: `must be at least ₹${s.minimum}` }]);
    const { lines } = allocate(dues, amount, only);
    if (!s.partial && !coversWhole(dues, lines)) throw badRequest('Pay whole instalments (part payment is switched off)', [{ field: 'amount', message: 'must cover whole instalments' }]);
    // The school takes it at its own counter: no convenience fee there.
    const fee = opts.counter ? 0 : await convenienceFee(amount);
    return { g: g!, student, year, lines, amount, fee, total: amount + fee };
};

export const startFeePayment = async (userId: string, input: z.infer<typeof payFeesSchema>) => {
    const { g, student, year, lines, fee, total } = await prepareFeePayment(input.studentId, input, { counter: false, userId });
    const reference = `fee-${crypto.randomUUID().slice(0, 8)}`;
    const order = await PROVIDERS[g.provider].createOrder(g, total, reference, { student: student.admissionNo, purpose: 'fees' });
    const p = await db.onlinePayment.create({
        data: { tenantId: getTenantId()!, purpose: 'fees', provider: g.provider, mode: g.mode, orderId: order.orderId, amount: total, convenienceFee: fee, studentId: student.id, academicYearId: year.id, allocation: lines as unknown as Prisma.InputJsonValue, userId },
    });
    const payer = student.family?.guardians[0];
    return checkout(g, p, `Fees of ${fullName(student)} (${student.admissionNo})`, { name: payer?.name ?? fullName(student), email: payer?.email ?? student.email, contact: payer?.mobile ?? null });
};

// ─── UPI QR codes ────────────────────────────────────────────────────────────

const QR_MINUTES = 15;

export const qrSchema = payFeesSchema;

/**
 * A UPI QR code for exactly the amount: the parent scans it with any UPI app. At the counter the
 * cashier shows it (`counter`); in My Fees the parent opens it. The screen asks every few seconds
 * whether it was paid; the receipt is made as soon as the gateway says so.
 */
export const startQrPayment = async (userId: string, input: z.infer<typeof qrSchema>, counter: boolean) => {
    const { g, student, year, lines, fee, total } = await prepareFeePayment(input.studentId, input, { counter, userId });
    const closeBy = new Date(Date.now() + QR_MINUTES * 60_000);
    const qr = await PROVIDERS[g.provider].createQr(g, total, `Fees ${student.admissionNo}`, `Fees of ${fullName(student)} (${student.admissionNo})`, closeBy, { student: student.admissionNo, purpose: 'fees' });
    const p = await db.onlinePayment.create({
        data: {
            tenantId: getTenantId()!,
            purpose: 'fees',
            provider: g.provider,
            mode: g.mode,
            method: 'qr',
            orderId: qr.qrId,
            qrImageUrl: qr.imageUrl,
            expiresAt: closeBy,
            amount: total,
            convenienceFee: fee,
            studentId: student.id,
            academicYearId: year.id,
            allocation: lines as unknown as Prisma.InputJsonValue,
            userId,
        },
    });
    await recordAudit({ action: 'qr_payment_started', entity: 'online_payment', entityId: p.id, changes: { amount: total, student: student.admissionNo, counter } });
    return paymentResult(p.id);
};

/** Has the QR code been paid? (asked by the screen showing it). An expired one is closed. */
export const pollQr = async (paymentId: string, userId: string | null) => {
    const p = uuidOk(paymentId) ? await db.onlinePayment.findUnique({ where: { id: paymentId } }) : null;
    if (!p || p.method !== 'qr' || (p.userId && p.userId !== userId)) throw notFound('Payment not found');
    if (p.status !== 'created') return paymentResult(p.id);
    const g = await loadGateway(p.mode as Mode);
    if (!g || g.provider !== p.provider) return paymentResult(p.id);
    const s = await PROVIDERS[g.provider].fetchQr(g, p.orderId);
    if (s.paid && s.paymentRef) await markPaid(p.id, s.paymentRef);
    else if (p.expiresAt && p.expiresAt < new Date()) {
        await PROVIDERS[g.provider].closeQr(g, p.orderId);
        await markFailed(p.id, 'The QR code expired before it was paid');
    }
    return paymentResult(p.id);
};

/** The payer went away: the QR code stops taking money (a payment that already came is still recorded). */
export const cancelQr = async (paymentId: string, userId: string | null) => {
    const p = uuidOk(paymentId) ? await db.onlinePayment.findUnique({ where: { id: paymentId } }) : null;
    if (!p || p.method !== 'qr' || (p.userId && p.userId !== userId)) throw notFound('Payment not found');
    if (p.status !== 'created') return paymentResult(p.id);
    const g = await loadGateway(p.mode as Mode);
    if (g && g.provider === p.provider) {
        const s = await PROVIDERS[g.provider].fetchQr(g, p.orderId);
        if (s.paid && s.paymentRef) {
            await markPaid(p.id, s.paymentRef);
            return paymentResult(p.id);
        }
        await PROVIDERS[g.provider].closeQr(g, p.orderId);
    }
    await markFailed(p.id, 'Cancelled before it was paid');
    return paymentResult(p.id);
};

/** The website form's registration fee (no login). */
export const startRegistrationPayment = async (enquiryId: string) => {
    const s = await getSettings({ enabled: FEES.onlineRegistration, fee: ADMISSIONS.registrationFee, registration: ADMISSIONS.registrationEnabled });
    if (!s.enabled || !s.registration || s.fee <= 0) return null;
    const g = await loadGateway();
    if (!ready(g)) return null;
    const e = await db.enquiry.findUniqueOrThrow({ where: { id: enquiryId } });
    if (e.registrationFee) return null;
    const fee = await convenienceFee(s.fee);
    const order = await PROVIDERS[g!.provider].createOrder(g!, s.fee + fee, `reg-${e.enquiryNo}`, { enquiry: e.enquiryNo, purpose: 'registration' });
    const p = await db.onlinePayment.create({ data: { tenantId: getTenantId()!, purpose: 'registration', provider: g!.provider, mode: g!.mode, orderId: order.orderId, amount: s.fee + fee, convenienceFee: fee, enquiryId: e.id } });
    return checkout(g!, p, `Registration fee for ${e.studentFirstName} (${e.enquiryNo})`, { name: e.parentName, email: e.email, contact: e.mobile });
};

/** What the website form offers before submitting. */
export const registrationFeeOffer = async () => {
    const s = await getSettings({ enabled: FEES.onlineRegistration, fee: ADMISSIONS.registrationFee, registration: ADMISSIONS.registrationEnabled });
    if (!s.enabled || !s.registration || s.fee <= 0 || !ready(await loadGateway())) return null;
    return { amount: s.fee, convenienceFee: await convenienceFee(s.fee) };
};

// ─── Paid ────────────────────────────────────────────────────────────────────

/**
 * Turns a paid order into its receipt (or registration). Safe to call twice (browser and
 * webhook both arrive): the second call finds it already paid.
 */
const markPaid = async (paymentId: string, paymentRef: string) => {
    const result = await withTransaction(
        async (tx) => {
            // Lock the payment row: the browser callback and the webhook may arrive together.
            await lockInTransaction(tx, `payment:${paymentId}`);
            const p = await tx.onlinePayment.findUniqueOrThrow({ where: { id: paymentId }, include: { receipt: { select: { id: true } } } });
            if (p.status === 'paid') return { already: true, payment: p, receiptId: p.receipt?.id ?? null };
            let receiptId: string | null = null;
            let error: string | null = null;
            if (p.purpose === 'fees') {
                const r = await recordReceipt(
                    tx,
                    { studentId: p.studentId!, yearId: p.academicYearId!, date: today(), mode: p.method === 'qr' ? 'upi' : 'online', reference: paymentRef, amount: p.amount - p.convenienceFee, onlinePaymentId: p.id, note: p.convenienceFee ? `Convenience fee ₹${p.convenienceFee} paid online with it.` : null },
                    { allowExcess: true }
                );
                receiptId = r.receipt?.id ?? null;
                if (r.excess > 0) error = `₹${r.excess} more than was due (paid at the counter meanwhile?): refund it from the gateway`;
            }
            const updated = await tx.onlinePayment.update({ where: { id: p.id }, data: { status: 'paid', paymentRef, paidAt: new Date(), error } });
            return { already: false, payment: updated, receiptId };
        },
        { timeout: 30_000 }
    );
    if (!result.already) {
        const p = result.payment;
        if (p.purpose === 'registration' && p.enquiryId) await registrationPaidOnline(p.enquiryId, p.amount - p.convenienceFee, paymentRef);
        await recordAudit({ action: 'online_payment_paid', entity: 'online_payment', entityId: p.id, changes: { amount: p.amount, purpose: p.purpose, paymentRef } });
        if (result.receiptId) alertReceipt(result.receiptId, p.userId ?? null);
        if (p.error) logger.warn('Online payment needs attention', { paymentId: p.id, error: p.error });
    }
    return result;
};

const markFailed = async (paymentId: string, error: string | undefined) => {
    await db.onlinePayment.updateMany({ where: { id: paymentId, status: 'created' }, data: { status: 'failed', error: error?.slice(0, 300) ?? 'Payment failed' } });
};

export const confirmSchema = z.strictObject({ paymentRef: z.string().trim().min(3).max(100), signature: z.string().trim().min(10).max(200) });

/** The browser comes back from the gateway: check the signature, then record the payment. */
export const confirmPayment = async (paymentId: string, input: z.infer<typeof confirmSchema>, userId: string | null) => {
    const p = uuidOk(paymentId) ? await db.onlinePayment.findUnique({ where: { id: paymentId } }) : null;
    if (!p || (p.userId && p.userId !== userId)) throw notFound('Payment not found');
    const g = await loadGateway(p.mode as Mode);
    if (!g || g.provider !== p.provider) throw conflict('The payment gateway was changed; ask the school to check this payment');
    if (!PROVIDERS[g.provider].verifyPayment(g, p.orderId, input.paymentRef, input.signature)) throw badRequest('The payment could not be verified. If money was taken, it will be confirmed by the gateway shortly.');
    const r = await markPaid(p.id, input.paymentRef);
    return paymentResult(r.payment.id);
};

export const failSchema = z.strictObject({ error: z.string().trim().max(300).optional() });

/** The gateway window reported a failure (shown to the payer; the order stays open for a retry). */
export const reportFailure = async (paymentId: string, input: z.infer<typeof failSchema>, userId: string | null) => {
    const p = uuidOk(paymentId) ? await db.onlinePayment.findUnique({ where: { id: paymentId } }) : null;
    if (!p || (p.userId && p.userId !== userId)) throw notFound('Payment not found');
    await markFailed(p.id, input.error);
    return paymentResult(p.id);
};

export const mockSchema = z.strictObject({ outcome: z.enum(['paid', 'failed']) });

/** The test gateway's "Pay" / "Fail" buttons. */
export const mockComplete = async (paymentId: string, input: z.infer<typeof mockSchema>, userId: string | null) => {
    if (!mockAllowed()) throw notFound('Payment not found');
    const p = uuidOk(paymentId) ? await db.onlinePayment.findUnique({ where: { id: paymentId } }) : null;
    if (!p || p.provider !== 'mock' || (p.userId && p.userId !== userId)) throw notFound('Payment not found');
    if (input.outcome === 'failed') return reportFailure(p.id, { error: 'Declined on the test gateway' }, userId);
    const paymentRef = `mock_pay_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
    return confirmPayment(p.id, { paymentRef, signature: mockSignature(p.orderId, paymentRef) }, userId);
};

/** The gateway's server-to-server message (the school is in the URL). */
export const handleWebhook = async (provider: string, rawBody: Buffer, headers: Record<string, string | string[] | undefined>) => {
    // Test and live webhooks come to the same address, each signed with its own secret.
    const configs = (await Promise.all((['live', 'test'] as Mode[]).map((m) => loadGateway(m)))).filter((g): g is ModeConfig => !!g && g.provider === provider && !!g.webhookSecret);
    if (!configs.length) throw notFound('No such gateway');
    let event: ReturnType<(typeof PROVIDERS)['razorpay']['parseWebhook']> | null = null;
    let lastError: unknown = null;
    for (const g of configs) {
        try {
            event = PROVIDERS[g.provider].parseWebhook(g, rawBody, headers);
            break;
        } catch (err) {
            lastError = err;
        }
    }
    if (!event) throw lastError;
    if (event.kind === 'ignored' || !event.orderId) return { handled: false };
    const p = await db.onlinePayment.findFirst({ where: { provider, orderId: event.orderId } });
    if (!p) return { handled: false };
    if (event.kind === 'paid' && event.paymentRef) await markPaid(p.id, event.paymentRef);
    if (event.kind === 'failed') await markFailed(p.id, event.error);
    return { handled: true };
};

/** Asks the gateway about a payment whose result never came (the payer closed the window…). */
export const checkStatus = async (paymentId: string) => {
    const p = uuidOk(paymentId) ? await db.onlinePayment.findUnique({ where: { id: paymentId } }) : null;
    if (!p) throw notFound('Payment not found');
    if (p.status === 'paid') return paymentResult(p.id);
    const g = await loadGateway(p.mode as Mode);
    if (!g || g.provider !== p.provider) throw conflict('This payment was made with another gateway set-up');
    if (p.method === 'qr') {
        const q = await PROVIDERS[g.provider].fetchQr(g, p.orderId);
        if (q.paid && q.paymentRef) await markPaid(p.id, q.paymentRef);
        return paymentResult(p.id);
    }
    const s = await PROVIDERS[g.provider].fetchStatus(g, p.orderId);
    if (s.paid && s.paymentRef) await markPaid(p.id, s.paymentRef);
    else if (s.failed) await markFailed(p.id, 'Failed at the gateway');
    return paymentResult(p.id);
};

export const paymentResult = async (paymentId: string) => {
    const p = await db.onlinePayment.findUniqueOrThrow({ where: { id: paymentId }, include: { receipt: { select: { id: true, receiptNo: true } }, enquiry: { select: { enquiryNo: true, registrationNo: true } } } });
    return {
        id: p.id,
        status: p.status,
        purpose: p.purpose,
        amount: p.amount,
        convenienceFee: p.convenienceFee,
        paymentRef: p.paymentRef,
        error: p.status === 'failed' ? p.error : null,
        receipt: p.receipt,
        registrationNo: p.enquiry?.registrationNo ?? null,
        enquiryNo: p.enquiry?.enquiryNo ?? null,
        mode: p.mode,
        method: p.method,
        provider: p.provider,
        qrImageUrl: p.method === 'qr' && p.status === 'created' ? p.qrImageUrl : null,
        expiresAt: p.expiresAt,
    };
};

// ─── The office's list ───────────────────────────────────────────────────────

export const listOnlinePayments = async (q: ListQuery<typeof onlinePaymentFilters>) => {
    const f = q.filters;
    const where: Prisma.OnlinePaymentWhereInput = {
        ...(f.status ? { status: f.status } : {}),
        ...(f.purpose ? { purpose: f.purpose } : {}),
        ...(f.attention === 'yes' ? { error: { not: null }, status: 'paid' } : {}),
        ...(q.search
            ? {
                  OR: [
                      { orderId: { contains: q.search, mode: 'insensitive' } },
                      { paymentRef: { contains: q.search, mode: 'insensitive' } },
                      { student: { admissionNo: { contains: q.search, mode: 'insensitive' } } },
                      { student: { firstName: { contains: q.search, mode: 'insensitive' } } },
                      { enquiry: { enquiryNo: { contains: q.search, mode: 'insensitive' } } },
                  ],
              }
            : {}),
    };
    const [rows, total] = await Promise.all([
        db.onlinePayment.findMany({
            where,
            include: { student: { select: { id: true, admissionNo: true, firstName: true, middleName: true, lastName: true } }, enquiry: { select: { id: true, enquiryNo: true, studentFirstName: true } }, receipt: { select: { id: true, receiptNo: true } } },
            orderBy: { createdAt: 'desc' },
            skip: q.skip,
            take: q.take,
        }),
        db.onlinePayment.count({ where }),
    ]);
    return listResult(
        rows.map((p) => ({
            id: p.id,
            createdAt: p.createdAt,
            paidAt: p.paidAt,
            purpose: p.purpose,
            provider: p.provider,
            mode: p.mode,
            method: p.method,
            orderId: p.orderId,
            paymentRef: p.paymentRef,
            amount: p.amount,
            convenienceFee: p.convenienceFee,
            status: p.status,
            error: p.error,
            student: p.student ? { id: p.student.id, name: fullName(p.student), admissionNo: p.student.admissionNo } : null,
            enquiry: p.enquiry ? { id: p.enquiry.id, enquiryNo: p.enquiry.enquiryNo, name: p.enquiry.studentFirstName } : null,
            receipt: p.receipt,
        })),
        total,
        q
    );
};
