import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { getSettings } from '../../core/settings';
import { listOptions } from '../masters/masters.service';
import { ALERTS, CHANNELS } from './alerts.settings';
import { listAlertDefs } from './alerts.registry';
import { alertSetup } from './deliver';

/** The bell: a person's own notifications, and their channel choices (My Profile → Notifications). */

/** Types and priorities from Masters (icon, pinned, toast), for showing notifications. */
const looks = async () => {
    const [types, priorities] = await Promise.all([listOptions('notification_type'), listOptions('alert_priority')]);
    return {
        types: types.map((t) => ({ code: t.code ?? t.name, name: t.name, icon: String(((t.extra ?? {}) as Record<string, unknown>).icon ?? 'notifications') })),
        priorities: priorities.map((p) => {
            const x = (p.extra ?? {}) as Record<string, unknown>;
            return { code: p.code ?? p.name, name: p.name, pinned: !!x.pinned, toast: !!x.toast };
        }),
    };
};

export const listQuery = z.object({
    unread: z.coerce.boolean().optional(),
    type: z.string().trim().max(40).optional(),
    page: z.coerce.number().int().min(1).default(1),
    take: z.coerce.number().int().min(1).max(50).default(20),
});

export const myNotifications = async (userId: string, q: z.infer<typeof listQuery>) => {
    const where = { userId, ...(q.unread ? { readAt: null } : {}), ...(q.type ? { type: q.type } : {}) };
    const l = await looks();
    const pinned = l.priorities.filter((p) => p.pinned).map((p) => p.code);
    const [rows, total, unread, pinnedUnread] = await Promise.all([
        db.notification.findMany({ where: { ...where, ...(pinned.length ? { NOT: { priority: { in: pinned }, readAt: null } } : {}) }, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.take, take: q.take }),
        db.notification.count({ where }),
        db.notification.count({ where: { userId, readAt: null } }),
        // Important ones stay on top until read.
        pinned.length && q.page === 1 ? db.notification.findMany({ where: { ...where, priority: { in: pinned }, readAt: null }, orderBy: { createdAt: 'desc' }, take: 20 }) : [],
    ]);
    const typeOf = new Map(l.types.map((t) => [t.code, t]));
    const show = (n: (typeof rows)[number]) => ({ id: n.id, type: n.type, typeName: typeOf.get(n.type)?.name ?? n.type, icon: typeOf.get(n.type)?.icon ?? 'notifications', title: n.title, body: n.body, link: n.link, priority: n.priority, read: !!n.readAt, at: n.createdAt });
    return { rows: [...pinnedUnread.map(show), ...rows.map(show)], total, unread, page: q.page, pages: Math.max(1, Math.ceil(total / q.take)), types: l.types };
};

/** For the bell: how many unread, the newest few, and those that should pop up. */
export const bell = async (userId: string, since?: Date) => {
    const [l, s] = await Promise.all([looks(), getSettings({ toast: ALERTS.toast, refresh: ALERTS.refreshSeconds, inApp: ALERTS.inApp })]);
    const toastCodes = l.priorities.filter((p) => p.toast).map((p) => p.code);
    const [unread, latest, fresh] = await Promise.all([
        db.notification.count({ where: { userId, readAt: null } }),
        db.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 10 }),
        since && s.toast && toastCodes.length ? db.notification.findMany({ where: { userId, readAt: null, createdAt: { gt: since }, priority: { in: toastCodes } }, orderBy: { createdAt: 'desc' }, take: 3 }) : [],
    ]);
    const typeOf = new Map(l.types.map((t) => [t.code, t]));
    const show = (n: (typeof latest)[number]) => ({ id: n.id, type: n.type, icon: typeOf.get(n.type)?.icon ?? 'notifications', title: n.title, body: n.body, link: n.link, priority: n.priority, read: !!n.readAt, at: n.createdAt });
    return { on: s.inApp, unread, latest: latest.map(show), toasts: fresh.map(show), refreshSeconds: s.refresh, now: new Date() };
};

export const markRead = async (userId: string, ids: string[] | 'all') => {
    const where = { userId, readAt: null, ...(ids === 'all' ? {} : { id: { in: ids } }) };
    const notes = ids === 'all' ? [] : await db.notification.findMany({ where, select: { messageId: true } });
    const r = await db.notification.updateMany({ where, data: { readAt: new Date() } });
    // The sender's Sent box shows it as read.
    const messageIds = [...new Set(notes.map((n) => n.messageId!).filter(Boolean))];
    if (messageIds.length) await db.messageDelivery.updateMany({ where: { messageId: { in: messageIds }, userId, channel: 'in_app', readAt: null }, data: { readAt: new Date() } });
    return { read: r.count };
};

export const removeNotification = async (userId: string, id: string) => {
    await db.notification.deleteMany({ where: { id, userId } });
    return { id, deleted: true };
};

// ─── My channel choices ──────────────────────────────────────────────────────

export const myPreferences = async (userId: string) => {
    const [l, prefs, on] = await Promise.all([looks(), db.notificationPreference.findMany({ where: { userId } }), getSettings({ in_app: ALERTS.inApp, email: ALERTS.email, sms: ALERTS.sms, whatsapp: ALERTS.whatsapp })]);
    // A type is "required" when every alert of it is marked required by the school.
    const required = new Set<string>();
    const byType = new Map<string, boolean[]>();
    for (const d of listAlertDefs()) byType.set(d.type, [...(byType.get(d.type) ?? []), (await alertSetup(d.key)).required]);
    for (const [t, flags] of byType) if (flags.length && flags.every(Boolean)) required.add(t);
    const muted = new Map(prefs.map((p) => [p.type, new Set(p.muted)]));
    return {
        channels: CHANNELS.filter((c) => on[c]),
        types: l.types.map((t) => ({ code: t.code, name: t.name, icon: t.icon, required: required.has(t.code), muted: [...(muted.get(t.code) ?? [])] })),
    };
};

export const preferencesSchema = z.strictObject({ types: z.array(z.strictObject({ code: z.string().trim().min(1).max(40), muted: z.array(z.enum(CHANNELS)).max(4) })).max(50) });
export const savePreferences = async (userId: string, input: z.infer<typeof preferencesSchema>) => {
    const tenantId = getTenantId()!;
    for (const t of input.types) {
        await db.notificationPreference.upsert({
            where: { tenantId_userId_type: { tenantId, userId, type: t.code } },
            create: { tenantId, userId, type: t.code, muted: t.muted },
            update: { muted: t.muted },
        });
    }
    return myPreferences(userId);
};
