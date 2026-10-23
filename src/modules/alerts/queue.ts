import { db } from '../../core/db';
import { runAsSystem, runAsTenant } from '../../core/context';
import { getSettings } from '../../core/settings';
import { logger } from '../../core/logger';
import { ALERTS, Channel } from './alerts.settings';
import { Outbound, PermanentError, sendEmail, sendSms, sendWhatsapp } from './channels';

/**
 * The outbox: email / SMS / WhatsApp waiting in message_deliveries are sent here, a few at a time,
 * at most N emails a minute (System Settings → Alerts), retried with growing waits, never twice.
 * Runs every few seconds in the server and right after something is queued.
 */

const SENDERS: Record<Exclude<Channel, 'in_app'>, (m: Outbound) => Promise<void>> = { email: sendEmail, sms: sendSms, whatsapp: sendWhatsapp };
const BATCH = 25;

let running = false;
let again = false;
let lastHooks = 0;

/** Hooks run on each pass (scheduled messages, daily alerts); set by the modules that need them. */
const passHooks: (() => Promise<void>)[] = [];
export const onQueuePass = (hook: () => Promise<void>) => passHooks.push(hook);

const sendOne = async (d: { id: string; channel: string; address: string | null; subject: string; body: string; attempts: number; attachmentIds: string[]; document: unknown }, retries: number, on: Record<string, boolean>) => {
    const channel = d.channel as Exclude<Channel, 'in_app'>;
    if (!on[channel]) {
        await db.messageDelivery.update({ where: { id: d.id }, data: { status: 'skipped', reason: `${channel} was switched off before it was sent` } });
        return;
    }
    try {
        await SENDERS[channel]({ to: d.address!, subject: d.subject, body: d.body, attachmentIds: d.attachmentIds, documents: (Array.isArray(d.document) ? d.document : []) as Outbound['documents'] });
        await db.messageDelivery.update({ where: { id: d.id }, data: { status: 'sent', sentAt: new Date(), attempts: d.attempts + 1, reason: null } });
    } catch (err) {
        const attempts = d.attempts + 1;
        const final = err instanceof PermanentError || attempts > retries;
        const reason = (err as Error).message.slice(0, 300);
        await db.messageDelivery.update({
            where: { id: d.id },
            data: final ? { status: 'failed', attempts, reason } : { status: 'queued', attempts, reason, nextAttemptAt: new Date(Date.now() + 2 ** attempts * 60_000) },
        });
        if (final) logger.warn('Message not delivered', { channel, id: d.id, reason });
    }
};

const passForSchool = async () => {
    const s = await getSettings({ retries: ALERTS.retries, perMinute: ALERTS.perMinute, email: ALERTS.email, sms: ALERTS.sms, whatsapp: ALERTS.whatsapp });
    const on = { email: s.email, sms: s.sms, whatsapp: s.whatsapp };
    // Ones left "sending" by a server that stopped mid-way go back in the queue.
    await db.messageDelivery.updateMany({ where: { status: 'sending', nextAttemptAt: { lt: new Date(Date.now() - 10 * 60_000) } }, data: { status: 'queued' } });
    const sentLastMinute = await db.messageDelivery.count({ where: { channel: 'email', status: 'sent', sentAt: { gte: new Date(Date.now() - 60_000) } } });
    const emailRoom = Math.max(0, s.perMinute - sentLastMinute);
    const due = await db.messageDelivery.findMany({
        where: { status: 'queued', nextAttemptAt: { lte: new Date() }, ...(emailRoom ? {} : { channel: { not: 'email' } }) },
        orderBy: { createdAt: 'asc' },
        take: Math.min(BATCH, emailRoom || BATCH),
        select: { id: true, channel: true, address: true, subject: true, body: true, attempts: true, attachmentIds: true, document: true },
    });
    let emails = 0;
    for (const d of due) {
        if (d.channel === 'email' && ++emails > emailRoom) continue;
        // Claim it (another server may be sending too).
        const claimed = await db.messageDelivery.updateMany({ where: { id: d.id, status: 'queued' }, data: { status: 'sending', nextAttemptAt: new Date() } });
        if (claimed.count) await sendOne(d, s.retries, on);
    }
    return due.length === BATCH;
};

/** One pass over every school with something due. */
export const runQueue = async () => {
    if (running) {
        again = true;
        return;
    }
    running = true;
    try {
        do {
            again = false;
            // Scheduled things are checked once a minute.
            if (Date.now() - lastHooks >= 60_000) {
                lastHooks = Date.now();
                for (const hook of passHooks) await hook().catch((err) => logger.error('Alert job failed', { error: (err as Error).message }));
            }
            const schools = await runAsSystem(() => db.messageDelivery.groupBy({ by: ['tenantId'], where: { status: { in: ['queued', 'sending'] }, nextAttemptAt: { lte: new Date() } } }));
            for (const sc of schools) if (await runAsTenant(sc.tenantId, passForSchool)) again = true;
        } while (again);
    } catch (err) {
        logger.error('Outbox pass failed', { error: (err as Error).message });
    } finally {
        running = false;
    }
};

let kicked: NodeJS.Timeout | null = null;
/** Something was queued: send soon (not inside the request). */
export const kickQueue = () => {
    if (process.env.NODE_ENV === 'test' || kicked) return;
    kicked = setTimeout(() => {
        kicked = null;
        void runQueue();
    }, 1500);
    kicked.unref();
};

/** Started by the server: a pass every 20 seconds. */
export const startQueue = () => {
    setTimeout(() => void runQueue(), 10_000).unref();
    setInterval(() => void runQueue(), 20_000).unref();
};
