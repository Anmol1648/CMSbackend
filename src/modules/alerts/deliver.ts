import { Prisma } from '@prisma/client';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { getSettings } from '../../core/settings';
import { logger } from '../../core/logger';
import { minutesIST, todayIST } from '../attendance/attendance.settings';
import { ALERTS, Channel } from './alerts.settings';
import { findAlertDef } from './alerts.registry';
import { Recipient, recipientId } from './recipients';
import { kickQueue } from './queue';

/**
 * Sending one message to many people: picks each person's channels (the school's, their own
 * choices, what they can be reached on), writes in-app notifications at once and queues the rest
 * (email / SMS / WhatsApp go out in the background, see queue.ts). Every attempt is in the log.
 */

export interface Attachment {
    key: string;
    params: Record<string, string>;
    asUserId: string;
}

export interface Outgoing {
    alertKey?: string | null;
    messageId?: string | null;
    /** Notification type code (Masters → Notification types). */
    type: string;
    subject: string;
    body: string;
    shortText?: string | null;
    /** Values for {{placeholders}}; {{name}} is each person's own. */
    vars?: Record<string, string>;
    perRecipient?: (r: Recipient & { role?: string }) => Record<string, string>;
    link?: string | null | ((r: Recipient & { role?: string }) => string | null);
    priority?: string;
    channels: Channel[];
    /** People can't turn it off for themselves. */
    required?: boolean;
    /** The same thing is sent to a person on a channel once (e.g. absent:<student>:<day>). */
    dedupe?: string | null;
    sectionIds?: string[];
    attachmentIds?: string[];
    /** ERP documents attached to the email, per person (e.g. each child's report card). */
    documents?: ((r: Recipient & { role?: string }) => Attachment[]) | null;
    cc?: string[];
    isDemo?: boolean;
    /** Custom alerts keep their own "don't repeat within N days" instead of the per-day limit. */
    ignoreDailyLimit?: boolean;
}

export const fill = (text: string, vars: Record<string, string>) => text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g, (_m, k: string) => vars[k] ?? '');

/** The end of quiet hours if now is inside them (SMS / WhatsApp wait until then). */
const afterQuietHours = (from: string, to: string, now = new Date()) => {
    const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
    const [f, t, n] = [m(from), m(to), minutesIST(now)];
    if (f === t) return null;
    const inside = f < t ? n >= f && n < t : n >= f || n < t;
    if (!inside) return null;
    const wait = (t - n + 24 * 60) % (24 * 60);
    return new Date(now.getTime() + wait * 60_000);
};

/** Made-up addresses (example.com, *.test…) are never mailed. */
const PLACEHOLDER = /@(example\.(com|org|net)|[^@]+\.(test|example|invalid|localhost))$/i;
const reach = (r: Recipient, c: Channel) => (c === 'in_app' ? r.userId : c === 'email' ? (r.email && !PLACEHOLDER.test(r.email) ? r.email : null) : r.mobile);

/** The school's choice for each channel (on / off). */
export const channelsOn = async () => {
    const s = await getSettings({ in_app: ALERTS.inApp, email: ALERTS.email, sms: ALERTS.sms, whatsapp: ALERTS.whatsapp });
    return s as Record<Channel, boolean>;
};

export const deliver = async (out: Outgoing, people: (Recipient & { role?: string; sectionIds?: string[] })[]) => {
    const tenantId = getTenantId()!;
    const [on, s] = await Promise.all([channelsOn(), getSettings({ fallback: ALERTS.fallback, quietFrom: ALERTS.quietFrom, quietTo: ALERTS.quietTo, maxPerDay: ALERTS.maxPerDay })]);
    // One person once (a parent of two children, a teacher who is also class teacher).
    const unique = new Map<string, Recipient & { role?: string; sectionIds?: string[] }>();
    for (const p of people) if (!unique.has(recipientId(p))) unique.set(recipientId(p), p);
    const list = [...unique.values()];
    const userIds = list.map((p) => p.userId!).filter(Boolean);
    const prefs = out.required || !userIds.length ? [] : await db.notificationPreference.findMany({ where: { userId: { in: userIds }, type: out.type }, select: { userId: true, muted: true } });
    const muted = new Map(prefs.map((p) => [p.userId, new Set(p.muted)]));

    // At most N copies of the same alert to one person on a channel in a day.
    const sentToday = new Map<string, number>();
    if (out.alertKey && !out.ignoreDailyLimit) {
        const dayStart = new Date(`${todayIST()}T00:00:00+05:30`);
        const rows = await db.messageDelivery.groupBy({ by: ['userId', 'address', 'channel'], where: { alertKey: out.alertKey, createdAt: { gte: dayStart }, status: { in: ['sent', 'queued', 'sending'] } }, _count: { _all: true } });
        for (const r of rows) sentToday.set(`${r.userId ?? r.address}|${r.channel}`, r._count._all);
    }

    const quiet = afterQuietHours(s.quietFrom, s.quietTo);
    const deliveries: Prisma.MessageDeliveryCreateManyInput[] = [];
    const notifications: Prisma.NotificationCreateManyInput[] = [];
    let skipped = 0;
    for (const p of list) {
        const vars = { ...(out.vars ?? {}), name: p.name, ...(out.perRecipient?.(p) ?? {}) };
        const subject = fill(out.subject, vars).replace(/\s+/g, ' ').trim();
        const body = fill(out.body, vars).trim();
        const short = fill(out.shortText || out.body, vars).replace(/\s+/g, ' ').trim();
        const mine = muted.get(p.userId ?? '') ?? new Set<string>();
        const usable = (c: Channel) => on[c] && !!reach(p, c) && !mine.has(c);
        let chosen = out.channels.filter(usable);
        if (!chosen.length) chosen = (s.fallback as Channel[]).filter(usable).slice(0, 1);
        const base = { tenantId, messageId: out.messageId ?? null, alertKey: out.alertKey ?? null, userId: p.userId, recipientName: p.name, recipientKind: p.kind, subject, sectionIds: p.sectionIds ?? out.sectionIds ?? [], isDemo: !!out.isDemo };
        if (!chosen.length) {
            skipped++;
            const why = out.channels.some((c) => on[c]) ? 'no login, email or mobile to reach them on' : 'the chosen channels are switched off (System Settings → Alerts)';
            deliveries.push({ ...base, channel: out.channels[0] ?? 'in_app', address: null, status: 'skipped', reason: why, body: short.slice(0, 500), dedupeKey: out.dedupe ? `${out.dedupe}:${recipientId(p)}:none` : null });
            continue;
        }
        for (const c of chosen) {
            const address = c === 'in_app' ? null : reach(p, c)!;
            const dedupeKey = out.dedupe ? `${out.dedupe}:${recipientId(p)}:${c}` : null;
            if (out.alertKey && !out.ignoreDailyLimit && (sentToday.get(`${p.userId ?? address}|${c}`) ?? 0) >= s.maxPerDay) {
                deliveries.push({ ...base, channel: c, address, status: 'skipped', reason: 'already sent to them today (System Settings → Alerts)', body: short.slice(0, 500), dedupeKey });
                continue;
            }
            if (c === 'in_app') {
                const link = typeof out.link === 'function' ? out.link(p) : (out.link ?? null);
                notifications.push({ tenantId, userId: p.userId!, type: out.type, title: subject.slice(0, 200), body: short.slice(0, 500), link, priority: out.priority ?? 'normal', alertKey: out.alertKey ?? null, messageId: out.messageId ?? null, isDemo: !!out.isDemo });
                deliveries.push({ ...base, channel: c, address: null, status: 'sent', sentAt: new Date(), body: short.slice(0, 500), dedupeKey });
            } else {
                const docs = c === 'email' ? (out.documents?.(p) ?? []) : [];
                deliveries.push({
                    ...base,
                    channel: c,
                    address,
                    status: 'queued',
                    body: c === 'email' ? body : short,
                    dedupeKey,
                    nextAttemptAt: c !== 'email' && quiet ? quiet : new Date(),
                    attachmentIds: c === 'email' ? (out.attachmentIds ?? []) : [],
                    document: docs.length ? (docs as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
                });
            }
        }
    }
    // Already sent (same dedupe key): left out, notification too.
    const keys = deliveries.map((d) => d.dedupeKey!).filter(Boolean);
    const existing = keys.length ? new Set((await db.messageDelivery.findMany({ where: { dedupeKey: { in: keys } }, select: { dedupeKey: true } })).map((d) => d.dedupeKey)) : new Set<string | null>();
    const fresh = deliveries.filter((d) => !d.dedupeKey || !existing.has(d.dedupeKey));
    const freshInApp = new Set(fresh.filter((d) => d.channel === 'in_app' && d.status === 'sent').map((d) => d.userId));
    const freshNotes = keys.length ? notifications.filter((n) => freshInApp.has(n.userId)) : notifications;
    for (let i = 0; i < fresh.length; i += 1000) await db.messageDelivery.createMany({ data: fresh.slice(i, i + 1000), skipDuplicates: true });
    for (let i = 0; i < freshNotes.length; i += 1000) await db.notification.createMany({ data: freshNotes.slice(i, i + 1000) });
    // CC (typed addresses): one copy each, by email.
    for (const cc of out.cc ?? []) {
        await db.messageDelivery.create({ data: { tenantId, messageId: out.messageId ?? null, alertKey: out.alertKey ?? null, userId: null, recipientName: cc, recipientKind: 'other', channel: 'email', address: cc, status: on.email ? 'queued' : 'skipped', reason: on.email ? null : 'email is switched off', subject: fill(out.subject, { ...(out.vars ?? {}), name: '' }), body: fill(out.body, { ...(out.vars ?? {}), name: '' }), attachmentIds: out.attachmentIds ?? [] } });
    }
    if (fresh.some((d) => d.status === 'queued') || out.cc?.length) kickQueue();
    return {
        people: list.length,
        inApp: freshNotes.length,
        queued: fresh.filter((d) => d.status === 'queued').length + (out.cc?.length ?? 0),
        skipped: fresh.filter((d) => d.status === 'skipped').length,
        unreachable: skipped,
    };
};

// ─── Built-in alerts ─────────────────────────────────────────────────────────

/** A built-in alert as the school set it (or its defaults). */
export const alertSetup = async (key: string) => {
    const def = findAlertDef(key);
    if (!def) throw new Error(`Unknown alert ${key}`);
    const c = await db.alertConfig.findFirst({ where: { key } });
    return {
        def,
        enabled: c?.enabled ?? def.defaults.enabled,
        channels: (c?.channels.length ? c.channels : def.defaults.channels) as Channel[],
        recipients: c ? c.recipients : def.defaults.recipients,
        priority: c?.priority ?? def.defaults.priority ?? 'normal',
        required: c?.required ?? def.defaults.required ?? false,
        subject: c?.subject ?? def.defaults.subject,
        body: c?.body ?? def.defaults.body,
        shortText: c?.shortText ?? def.defaults.shortText,
    };
};

type Who = Partial<Record<string, () => Promise<(Recipient & { sectionIds?: string[] })[]>>>;

/**
 * A module raises a built-in alert: `to` gives, per recipient kind (parent, class_teacher…), how
 * to find them; only the kinds the school ticked are looked up. Never throws: an alert must not
 * stop the action that raised it.
 */
export const raise = async (key: string, to: Who, vars: Record<string, string>, opts: Pick<Outgoing, 'dedupe' | 'sectionIds' | 'documents' | 'perRecipient' | 'isDemo' | 'priority'> = {}) => {
    try {
        const a = await alertSetup(key);
        if (!a.enabled) return null;
        const people: (Recipient & { role?: string; sectionIds?: string[] })[] = [];
        for (const role of a.recipients) {
            const find = to[role];
            if (find) for (const p of await find()) people.push({ ...p, role });
        }
        if (!people.length) return null;
        const school = (await db.schoolProfile.findFirst({ select: { shortName: true, legalName: true } })) ?? { shortName: null, legalName: '' };
        const link = a.def.link;
        return await deliver(
            {
                alertKey: key,
                type: a.def.type,
                subject: a.subject,
                body: a.body,
                shortText: a.shortText,
                vars: { school: school.shortName ?? school.legalName, ...vars },
                link: typeof link === 'string' ? link : link ? (p) => link[p.role ?? p.kind] ?? link[p.kind] ?? null : null,
                priority: a.priority,
                channels: a.channels,
                required: a.required,
                ...opts,
            },
            people
        );
    } catch (err) {
        logger.error('Alert could not be raised', { alert: key, error: (err as Error).message });
        return null;
    }
};

/** Raises an alert without making the request wait for it. */
export const raiseLater = (...args: Parameters<typeof raise>) => {
    void raise(...args);
};
