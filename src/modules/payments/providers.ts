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
    /** A UPI QR code for exactly this amount, payable once, until `closeBy`. */
    createQr(cfg: GatewayConfig, amountRupees: number, label: string, description: string, closeBy: Date, notes: Record<string, string>): Promise<{ qrId: string; imageUrl: string }>;
    /** Whether the QR code was paid. */
    fetchQr(cfg: GatewayConfig, qrId: string): Promise<{ paid: boolean; paymentRef?: string; closed?: boolean }>;
    /** Stops the QR code taking money (the payer went away). */
    closeQr(cfg: GatewayConfig, qrId: string): Promise<void>;
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
            payload?: { payment?: { entity?: { id?: string; order_id?: string; error_description?: string } }; order?: { entity?: { id?: string } }; qr_code?: { entity?: { id?: string } } };
        };
        const payment = body.payload?.payment?.entity;
        // A UPI QR payment has no order: the QR code's id stands for it.
        const orderId = payment?.order_id ?? body.payload?.order?.entity?.id ?? body.payload?.qr_code?.entity?.id;
        if (body.event === 'payment.captured' || body.event === 'order.paid' || body.event === 'qr_code.credited') return { kind: 'paid', orderId, paymentRef: payment?.id };
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
    async createQr(cfg, amount, label, description, closeBy, notes) {
        const auth = Buffer.from(`${need(cfg.keyId, 'the key id')}:${need(cfg.keySecret, 'the key secret')}`).toString('base64');
        let res: Response;
        try {
            res = await fetch('https://api.razorpay.com/v1/payments/qr_codes', {
                method: 'POST',
                headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'upi_qr', name: label.slice(0, 40), usage: 'single_use', fixed_amount: true, payment_amount: amount * 100, description: description.slice(0, 250), close_by: Math.floor(closeBy.getTime() / 1000), notes }),
                signal: AbortSignal.timeout(20_000),
            });
        } catch {
            throw gatewayError('Could not reach the payment gateway. Please try again.');
        }
        const body = (await res.json().catch(() => ({}))) as { id?: string; image_url?: string; error?: { description?: string } };
        if (!res.ok || !body.id || !body.image_url) {
            throw gatewayError(`The payment gateway did not make the QR code${body.error?.description ? `: ${body.error.description}` : ''}. QR codes may need to be switched on for the Razorpay account.`);
        }
        return { qrId: body.id, imageUrl: body.image_url };
    },
    async fetchQr(cfg, qrId) {
        const auth = Buffer.from(`${need(cfg.keyId, 'the key id')}:${need(cfg.keySecret, 'the key secret')}`).toString('base64');
        const res = await fetch(`https://api.razorpay.com/v1/payments/qr_codes/${encodeURIComponent(qrId)}/payments`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
        if (!res?.ok) throw gatewayError('Could not ask the payment gateway; try again later');
        const body = (await res.json()) as { items?: { id: string; status: string }[] };
        const captured = body.items?.find((p) => p.status === 'captured');
        return captured ? { paid: true, paymentRef: captured.id } : { paid: false };
    },
    async closeQr(cfg, qrId) {
        const auth = Buffer.from(`${need(cfg.keyId, 'the key id')}:${need(cfg.keySecret, 'the key secret')}`).toString('base64');
        await fetch(`https://api.razorpay.com/v1/payments/qr_codes/${encodeURIComponent(qrId)}/close`, { method: 'POST', headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
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
    async createQr(_cfg, amount) {
        const cells = Array.from({ length: 21 * 21 }, (_, i) => ((i * 7919 + amount) % 5 < 2 ? 1 : 0));
        const rects = cells.map((c, i) => (c ? `<rect x="${(i % 21) * 10}" y="${Math.floor(i / 21) * 10}" width="10" height="10"/>` : '')).join('');
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 210 240"><rect width="210" height="240" fill="#fff"/><g fill="#1a365d">${rects}</g><text x="105" y="232" font-size="14" text-anchor="middle" fill="#b91c1c" font-family="sans-serif">TEST QR · ₹${amount}</text></svg>`;
        return { qrId: `mock_qr_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`, imageUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
    },
    async fetchQr() {
        return { paid: false };
    },
    async closeQr() {},
};

export const PROVIDERS: Record<GatewayConfig['provider'], Provider> = { razorpay, mock };
