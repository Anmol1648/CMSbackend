import crypto from 'crypto';
import { AppError } from '../../core/errors';
import { ErrorCode } from '../../core/index';

/**
 * Payment gateways. The ERP never sees card / UPI details: it creates an order for an exact
 * amount, the gateway's own window takes the money, and the result is trusted only when its
 * signature checks out (in the browser's callback, or the gateway's webhook).
 */

export interface GatewayConfig {
    provider: 'razorpay' | 'mock';
    keyId: string | null;
    keySecret: string | null;
    webhookSecret: string | null;
}

export interface WebhookEvent {
    kind: 'paid' | 'failed' | 'ignored';
    orderId?: string;
    paymentRef?: string;
    error?: string;
}

export interface Provider {
    createOrder(cfg: GatewayConfig, amountRupees: number, reference: string, notes: Record<string, string>): Promise<{ orderId: string }>;
    /** The browser's "paid" callback: is the signature the gateway's? */
    verifyPayment(cfg: GatewayConfig, orderId: string, paymentRef: string, signature: string): boolean;
    /** A webhook call: is it the gateway's, and what does it say? */
    parseWebhook(cfg: GatewayConfig, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent;
    /** Asks the gateway whether an order was paid (for payments whose result never arrived). */
    fetchStatus(cfg: GatewayConfig, orderId: string): Promise<{ paid: boolean; paymentRef?: string; failed?: boolean }>;
}

const hmac = (secret: string, data: string | Buffer) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const sameHex = (a: string, b: string) => a.length === b.length && /^[0-9a-f]+$/i.test(a) && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const gatewayError = (message: string) => new AppError(message, 502, ErrorCode.BAD_GATEWAY);

const need = (v: string | null, what: string) => {
    if (!v) throw new AppError(`The payment gateway is not set up: ${what} is missing (Fees → Online Payments)`, 400, ErrorCode.VALIDATION_ERROR);
    return v;
};

/** Razorpay (https://razorpay.com/docs/api/orders/). Amounts go in paise. */
const razorpay: Provider = {
    async createOrder(cfg, amount, reference, notes) {
        const auth = Buffer.from(`${need(cfg.keyId, 'the key id')}:${need(cfg.keySecret, 'the key secret')}`).toString('base64');
        let res: Response;
        try {
            res = await fetch('https://api.razorpay.com/v1/orders', {
                method: 'POST',
                headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount: amount * 100, currency: 'INR', receipt: reference.slice(0, 40), notes }),
                signal: AbortSignal.timeout(20_000),
            });
        } catch {
            throw gatewayError('Could not reach the payment gateway. Please try again.');
        }
        const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { description?: string } };
        if (!res.ok || !body.id) throw gatewayError(`The payment gateway refused the order${body.error?.description ? `: ${body.error.description}` : ''}`);
        return { orderId: body.id };
    },
    verifyPayment(cfg, orderId, paymentRef, signature) {
        return !!cfg.keySecret && sameHex(hmac(cfg.keySecret, `${orderId}|${paymentRef}`), signature);
    },
    parseWebhook(cfg, rawBody, headers) {
        const sig = headers['x-razorpay-signature'];
        if (!cfg.webhookSecret || typeof sig !== 'string' || !sameHex(hmac(cfg.webhookSecret, rawBody), sig)) throw new AppError('Bad webhook signature', 401, ErrorCode.UNAUTHORIZED);
        const body = JSON.parse(rawBody.toString('utf8')) as {
            event?: string;
            payload?: { payment?: { entity?: { id?: string; order_id?: string; error_description?: string } }; order?: { entity?: { id?: string } } };
        };
        const payment = body.payload?.payment?.entity;
        const orderId = payment?.order_id ?? body.payload?.order?.entity?.id;
        if (body.event === 'payment.captured' || body.event === 'order.paid') return { kind: 'paid', orderId, paymentRef: payment?.id };
        if (body.event === 'payment.failed') return { kind: 'failed', orderId, paymentRef: payment?.id, error: payment?.error_description };
        return { kind: 'ignored' };
    },
    async fetchStatus(cfg, orderId) {
        const auth = Buffer.from(`${need(cfg.keyId, 'the key id')}:${need(cfg.keySecret, 'the key secret')}`).toString('base64');
        const res = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}/payments`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
        if (!res?.ok) throw gatewayError('Could not ask the payment gateway; try again later');
        const body = (await res.json()) as { items?: { id: string; status: string }[] };
        const captured = body.items?.find((p) => p.status === 'captured');
        if (captured) return { paid: true, paymentRef: captured.id };
        return { paid: false, failed: !!body.items?.length && body.items.every((p) => p.status === 'failed') };
    },
};

/**
 * A pretend gateway inside the ERP, to try the whole flow before the school has a gateway account.
 * Its "payments" are confirmed by the ERP itself (never available in production).
 */
const MOCK_SECRET = crypto.randomBytes(32).toString('hex');
export const mockSignature = (orderId: string, paymentRef: string) => hmac(MOCK_SECRET, `${orderId}|${paymentRef}`);
const mock: Provider = {
    async createOrder() {
        return { orderId: `mock_order_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}` };
    },
    verifyPayment(_cfg, orderId, paymentRef, signature) {
        return sameHex(mockSignature(orderId, paymentRef), signature);
    },
    parseWebhook() {
        return { kind: 'ignored' };
    },
    async fetchStatus() {
        return { paid: false };
    },
};

export const PROVIDERS: Record<GatewayConfig['provider'], Provider> = { razorpay, mock };
