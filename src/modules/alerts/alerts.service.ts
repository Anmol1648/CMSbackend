import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { encryptSecret } from '../../core/encryption';
import { getSettings, setSetting } from '../../core/settings';
import { getUserAccess } from '../rbac/access.service';
import { currentYear } from '../academic/years.service';
import { ALERTS, CHANNELS, Channel } from './alerts.settings';
import { COMMON_FIELDS, findAlertDef, listAlertDefs } from './alerts.registry';
import { alertSetup, deliver, fill } from './deliver';
import { listDailyJobs, runJob } from './jobs';
import { usersOf } from './recipients';

/** Alerts → Built-in Alerts, the Alert Log and Alerts → Channels. */

// ─── Built-in alerts ─────────────────────────────────────────────────────────

export const listAlerts = async () => {
    const out = [];
    for (const d of listAlertDefs()) {
        const a = await alertSetup(d.key);
        const custom = await db.alertConfig.count({ where: { key: d.key } });
        out.push({ key: d.key, label: d.label, description: d.description, type: d.type, when: d.when, enabled: a.enabled, channels: a.channels, recipients: a.recipients, recipientChoices: d.recipients, required: a.required, priority: a.priority, custom: !!custom });
    }
    return out;
};

export const getAlert = async (key: string) => {
    const def = findAlertDef(key);
    if (!def) throw notFound('Alert not found');
    const a = await alertSetup(key);
    return {
        key,
        label: def.label,
        description: def.description,
        type: def.type,
        when: def.when,
        recipientChoices: def.recipients,
        fields: [...def.fields, ...COMMON_FIELDS],
        enabled: a.enabled,
        channels: a.channels,
        recipients: a.recipients,
        priority: a.priority,
        required: a.required,
        subject: a.subject,
        body: a.body,
        shortText: a.shortText,
        defaults: def.defaults,
    };
};

export const alertSchema = z.strictObject({
    enabled: z.boolean(),
    channels: z.array(z.enum(CHANNELS)).min(1, 'choose at least one').max(4),
    recipients: z.array(z.string().trim().max(40)).min(1, 'choose who gets it').max(10),
    priority: z.string().trim().max(30),
    required: z.boolean(),
    subject: z.string().trim().min(1, 'is required').max(200),
    body: z.string().trim().min(1, 'is required').max(5000),
    shortText: z.string().trim().min(1, 'is required').max(480),
});

const checkFields = (key: string, input: { subject: string; body: string; shortText: string }) => {
    const def = findAlertDef(key)!;
    const known = new Set([...def.fields, ...COMMON_FIELDS].map((f) => f.key));
    const issues: { field: string; message: string }[] = [];
    for (const [field, text] of Object.entries(input))
        for (const m of text.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g)) if (!known.has(m[1])) issues.push({ field, message: `{{${m[1]}}} is not a field of this alert` });
    if (issues.length) throw badRequest('Use only the fields listed', issues);
};

export const saveAlert = async (key: string, input: z.infer<typeof alertSchema>, userId: string) => {
    const def = findAlertDef(key);
    if (!def) throw notFound('Alert not found');
    if (input.recipients.some((r) => !def.recipients.some((x) => x.key === r))) throw badRequest('Choose who gets it from the list', [{ field: 'recipients', message: 'is not valid' }]);
    checkFields(key, input);
    const tenantId = getTenantId()!;
    const data = { ...input, updatedBy: userId };
    await db.alertConfig.upsert({ where: { tenantId_key: { tenantId, key } }, create: { tenantId, key, ...data }, update: data });
    await recordAudit({ action: 'alert_changed', entity: 'alert', entityId: key, changes: { alert: def.label, enabled: input.enabled, channels: input.channels.join(', ') } });
    return getAlert(key);
};

export const resetAlert = async (key: string) => {
    await db.alertConfig.deleteMany({ where: { key } });
    await recordAudit({ action: 'alert_reset', entity: 'alert', entityId: key, changes: { alert: findAlertDef(key)?.label ?? key } });
    return getAlert(key);
};

/** The alert as it would look, with the example values. */
export const previewAlert = async (key: string, input?: Partial<z.infer<typeof alertSchema>>) => {
    const a = await getAlert(key);
    const school = await db.schoolProfile.findFirst({ select: { shortName: true, legalName: true } });
    const vars = { ...Object.fromEntries(a.fields.map((f) => [f.key, f.example])), school: school?.shortName ?? school?.legalName ?? '' };
    return { subject: fill(input?.subject ?? a.subject, vars), body: fill(input?.body ?? a.body, vars), shortText: fill(input?.shortText ?? a.shortText, vars) };
};

/** Sends the alert (example values) to the person setting it up, on the chosen channels. */
export const testAlert = async (key: string, userId: string, input?: Partial<z.infer<typeof alertSchema>>) => {
    const a = await getAlert(key);
    const p = await previewAlert(key, input);
    const [me] = await usersOf([userId]);
    if (!me) throw badRequest('Your account has no contact details');
    return deliver({ type: a.type, subject: `[Test] ${p.subject}`, body: p.body, shortText: p.shortText, channels: (input?.channels ?? a.channels) as Channel[], priority: 'normal', required: true, link: '/notifications' }, [me]);
};

// ─── Daily jobs ──────────────────────────────────────────────────────────────

export const listJobs = async () => {
    const runs = await db.jobRun.findMany({ orderBy: { day: 'desc' }, take: 200 });
    return listDailyJobs().map((j) => {
        const last = runs.find((r) => r.key === j.key);
        return { key: j.key, lastDay: last?.day ?? null, lastResult: last?.result ?? null };
    });
};
export const runJobNow = async (key: string) => {
    const job = listDailyJobs().find((j) => j.key === key);
    if (!job) throw notFound('Job not found');
    const result = await runJob(job, true);
    await recordAudit({ action: 'alert_job_run', entity: 'alert', entityId: key, changes: { result } });
    return { key, result };
};

// ─── Alert Log ───────────────────────────────────────────────────────────────

export const logQuery = z.object({
    page: z.coerce.number().int().min(1).default(1),
    search: z.string().trim().max(100).optional(),
    channel: z.enum(CHANNELS).optional(),
    status: z.enum(['queued', 'sending', 'sent', 'failed', 'skipped']).optional(),
    alert: z.string().trim().max(60).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** The sections whose messages a person with the Assigned scope sees (their own). */
const logScope = async (userId: string): Promise<Prisma.MessageDeliveryWhereInput> => {
    const a = await getUserAccess(userId);
    if (a.permissions['alert.log'] === 'all') return {};
    const year = await currentYear();
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    if (!year || !staff) return { id: { in: [] } };
    const [own, teach] = await Promise.all([
        db.section.findMany({ where: { academicYearId: year.id, classTeacherId: staff.id }, select: { id: true } }),
        db.teachingAssignment.findMany({ where: { academicYearId: year.id, staffId: staff.id }, select: { sectionId: true } }),
    ]);
    return { sectionIds: { hasSome: [...new Set([...own.map((s) => s.id), ...teach.map((t) => t.sectionId)])] } };
};

const logWhere = async (q: z.infer<typeof logQuery>, userId: string): Promise<Prisma.MessageDeliveryWhereInput> => ({
    ...(await logScope(userId)),
    ...(q.channel ? { channel: q.channel } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.alert ? (q.alert === 'compose' ? { alertKey: null, messageId: { not: null } } : { alertKey: q.alert }) : {}),
    ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(`${q.from}T00:00:00+05:30`) } : {}), ...(q.to ? { lt: new Date(new Date(`${q.to}T00:00:00+05:30`).getTime() + 86_400_000) } : {}) } } : {}),
    ...(q.search ? { OR: [{ recipientName: { contains: q.search, mode: 'insensitive' } }, { address: { contains: q.search, mode: 'insensitive' } }, { subject: { contains: q.search, mode: 'insensitive' } }] } : {}),
});

export const alertLog = async (q: z.infer<typeof logQuery>, userId: string) => {
    const where = await logWhere(q, userId);
    const take = 50;
    const [rows, total, counts] = await Promise.all([
        db.messageDelivery.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * take, take, select: { id: true, alertKey: true, messageId: true, recipientName: true, recipientKind: true, address: true, channel: true, status: true, reason: true, subject: true, attempts: true, createdAt: true, sentAt: true, nextAttemptAt: true } }),
        db.messageDelivery.count({ where }),
        db.messageDelivery.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);
    const labels = new Map(listAlertDefs().map((d) => [d.key, d.label]));
    return {
        rows: rows.map((r) => ({ ...r, source: r.alertKey ? (labels.get(r.alertKey) ?? r.alertKey) : r.messageId ? 'Message' : 'Test' })),
        total,
        page: q.page,
        pages: Math.max(1, Math.ceil(total / take)),
        counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
        alerts: listAlertDefs().map((d) => ({ key: d.key, label: d.label })),
    };
};

export const exportLog = async (q: z.infer<typeof logQuery>, userId: string) => {
    const where = await logWhere(q, userId);
    const rows = await db.messageDelivery.findMany({ where, orderBy: { createdAt: 'desc' }, take: 20_000, select: { alertKey: true, recipientName: true, recipientKind: true, address: true, channel: true, status: true, reason: true, subject: true, createdAt: true, sentAt: true } });
    const labels = new Map(listAlertDefs().map((d) => [d.key, d.label]));
    return rows.map((r) => ({ ...r, alertKey: r.alertKey ? (labels.get(r.alertKey) ?? r.alertKey) : 'Message' }));
};

/** Sends a failed message again. */
export const retryDelivery = async (id: string) => {
    const d = await db.messageDelivery.findFirst({ where: { id } });
    if (!d) throw notFound('Not found');
    if (d.status !== 'failed') throw badRequest('Only a failed message can be sent again');
    await db.messageDelivery.update({ where: { id }, data: { status: 'queued', attempts: 0, nextAttemptAt: new Date(), reason: null } });
    const { kickQueue } = await import('./queue');
    kickQueue();
    return { id, queued: true };
};

/** Email addresses and mobiles that keep failing (to be corrected on the person's record). */
export const bouncing = async () => {
    const { limit } = await getSettings({ limit: ALERTS.bounceLimit });
    const rows = await db.messageDelivery.groupBy({ by: ['address', 'channel', 'recipientName'], where: { status: 'failed', address: { not: null }, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, _count: { _all: true } });
    return rows.filter((r) => r._count._all >= limit).map((r) => ({ address: r.address, channel: r.channel, name: r.recipientName, failures: r._count._all }));
};

// ─── Channels (provider keys) ────────────────────────────────────────────────

const SECRETS = { smsKey: ALERTS.smsKey, smsAccount: ALERTS.smsAccount, smsTemplate: ALERTS.smsTemplate, whatsappKey: ALERTS.whatsappKey, whatsappAccount: ALERTS.whatsappAccount, whatsappTemplate: ALERTS.whatsappTemplate };

/** Which keys are saved (never the keys themselves). */
export const channelSetup = async () => {
    const s = await getSettings({ ...SECRETS, sms: ALERTS.sms, smsProvider: ALERTS.smsProvider, whatsapp: ALERTS.whatsapp, whatsappProvider: ALERTS.whatsappProvider, email: ALERTS.email, inApp: ALERTS.inApp });
    return {
        inApp: s.inApp,
        email: { on: s.email, configured: !!process.env.SMTP_HOST },
        sms: { on: s.sms, provider: s.smsProvider, saved: { key: !!s.smsKey, account: !!s.smsAccount, template: !!s.smsTemplate } },
        whatsapp: { on: s.whatsapp, provider: s.whatsappProvider, saved: { key: !!s.whatsappKey, account: !!s.whatsappAccount, template: !!s.whatsappTemplate } },
    };
};

const keyText = z.string().trim().max(500).optional();
export const channelKeysSchema = z.strictObject({ smsKey: keyText, smsAccount: keyText, smsTemplate: keyText, whatsappKey: keyText, whatsappAccount: keyText, whatsappTemplate: keyText });

/** Saves the keys typed in (blank = keep; "-" = remove), encrypted. */
export const saveChannelKeys = async (input: z.infer<typeof channelKeysSchema>, userId: string) => {
    const changed: string[] = [];
    for (const [k, def] of Object.entries(SECRETS) as [keyof typeof SECRETS, (typeof SECRETS)[keyof typeof SECRETS]][]) {
        const v = input[k];
        if (v === undefined || v === '') continue;
        await setSetting(def, v === '-' ? undefined : encryptSecret(v), userId);
        changed.push(k);
    }
    await recordAudit({ action: 'alert_channel_keys_changed', entity: 'alert', entityId: 'channels', changes: { keys: changed.join(', ') || 'none' } });
    return channelSetup();
};
