import crypto from 'crypto';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { logger } from '../../core/logger';

/**
 * Phones with the mobile app: each registers its Firebase (FCM) token after sign-in, and every
 * in-app notification is also sent to the person's phones as a push. FCM reaches Android directly
 * and iPhones through Apple's service. Push is on once FCM_SERVICE_ACCOUNT (the Firebase project's
 * service-account key, as JSON) is set; until then only the in-app notification is made. A phone
 * that signs out, or that FCM says is gone, is forgotten.
 */

export const registerSchema = z.strictObject({
    token: z.string().trim().min(20, 'is not a push token').max(4096),
    platform: z.enum(['android', 'ios']),
    appVersion: z.string().trim().max(20).nullable().optional(),
});

export const registerDevice = async (input: z.infer<typeof registerSchema>, userId: string) => {
    const tenantId = getTenantId()!;
    // A phone belongs to whoever signed in on it last.
    await db.deviceToken.upsert({
        where: { tenantId_token: { tenantId, token: input.token } },
        create: { tenantId, userId, token: input.token, platform: input.platform, appVersion: input.appVersion ?? null },
        update: { userId, platform: input.platform, appVersion: input.appVersion ?? null, lastSeenAt: new Date() },
    });
    return { registered: true };
};

export const forgetDevice = async (token: string, userId: string) => {
    await db.deviceToken.deleteMany({ where: { token, userId } });
    return { forgotten: true };
};

// ─── Firebase Cloud Messaging (HTTP v1) ──────────────────────────────────────

interface ServiceAccount {
    project_id: string;
    client_email: string;
    private_key: string;
}
let account: ServiceAccount | null | undefined;
const serviceAccount = () => {
    if (account !== undefined) return account;
    try {
        const raw = process.env.FCM_SERVICE_ACCOUNT;
        account = raw ? (JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')) as ServiceAccount) : null;
    } catch {
        logger.warn('FCM_SERVICE_ACCOUNT is not valid JSON: push is off');
        account = null;
    }
    return account;
};

/** An OAuth access token for FCM, from the service account (kept until a minute before it ends). */
let cached: { token: string; until: number } | null = null;
const accessToken = async (sa: ServiceAccount) => {
    if (cached && cached.until > Date.now() + 60_000) return cached.token;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
    const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }) });
    if (!res.ok) throw new Error(`FCM sign-in failed (${res.status})`);
    const out = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: out.access_token, until: Date.now() + out.expires_in * 1000 };
    return cached.token;
};

/**
 * How each priority arrives on phones (Masters → Priorities → "On phones"): the app's Android
 * channels klytos_urgent / _important / _normal / _quiet. A priority without the choice falls back
 * by its code (emergency → urgent, important → important, the rest → normal).
 */
export const PHONE_KINDS = ['urgent', 'important', 'normal', 'quiet'] as const;
type PhoneKind = (typeof PHONE_KINDS)[number];
const phoneKinds = async (): Promise<(code: string | undefined) => PhoneKind> => {
    const rows = await db.masterValue.findMany({ where: { master: 'alert_priority' }, select: { code: true, extra: true } });
    const set = new Map(rows.map((r) => [r.code ?? '', (r.extra as Record<string, unknown> | null)?.phone]));
    return (code) => {
        const v = set.get(code ?? 'normal');
        if (typeof v === 'string' && (PHONE_KINDS as readonly string[]).includes(v)) return v as PhoneKind;
        return code === 'emergency' ? 'urgent' : code === 'important' ? 'important' : 'normal';
    };
};

/** Sends in-app notifications to the people's phones (never throws: push is a bonus to in-app). */
export const pushNotifications = async (notes: { userId: string; title: string; body: string; link?: string | null; priority?: string }[]) => {
    try {
        const sa = serviceAccount();
        if (!sa || !notes.length) return;
        const userIds = [...new Set(notes.map((n) => n.userId))];
        const tokens = await db.deviceToken.findMany({ where: { userId: { in: userIds } }, select: { token: true, userId: true } });
        if (!tokens.length) return;
        const [bearer, kindOf, unread] = await Promise.all([
            accessToken(sa),
            phoneKinds(),
            // The number on the app's icon: what each person has not read yet.
            db.notification.groupBy({ by: ['userId'], where: { userId: { in: [...new Set(tokens.map((t) => t.userId))] }, readAt: null }, _count: { _all: true } }),
        ]);
        const unreadOf = new Map(unread.map((u) => [u.userId, u._count._all]));
        const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
        const gone: string[] = [];
        for (const n of notes) {
            const body = n.body.length > 180 ? `${n.body.slice(0, 177)}…` : n.body;
            const kind = kindOf(n.priority);
            for (const t of tokens.filter((x) => x.userId === n.userId)) {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
                    body: JSON.stringify({
                        message: {
                            token: t.token,
                            notification: { title: n.title, body },
                            // The app opens this page when the notification is tapped.
                            data: { link: n.link ?? '', kind },
                            android: {
                                priority: kind === 'urgent' || kind === 'important' ? 'HIGH' : 'NORMAL',
                                notification: {
                                    channel_id: `klytos_${kind}`,
                                    ...(kind === 'quiet' ? {} : { sound: 'default' }),
                                    color: '#1A365D',
                                    notification_count: unreadOf.get(n.userId) ?? 1,
                                    ...(kind === 'urgent' ? { notification_priority: 'PRIORITY_MAX', visibility: 'PUBLIC' } : {}),
                                },
                            },
                            apns: { payload: { aps: { ...(kind === 'quiet' ? {} : { sound: 'default' }), badge: unreadOf.get(n.userId) ?? 1, ...(kind === 'urgent' ? { 'interruption-level': 'time-sensitive' } : {}) } } },
                        },
                    }),
                });
                // Uninstalled app or a token that no longer exists: forget the phone.
                if (res.status === 404 || res.status === 400) {
                    const err = (await res.json().catch(() => ({}))) as { error?: { status?: string } };
                    if (res.status === 404 || err.error?.status === 'INVALID_ARGUMENT') gone.push(t.token);
                } else if (!res.ok) logger.warn('Push failed', { status: res.status });
            }
        }
        if (gone.length) await db.deviceToken.deleteMany({ where: { token: { in: gone } } });
    } catch (err) {
        logger.warn('Push failed', { error: (err as Error).message });
    }
};

/** What the app checks at start: the oldest version still allowed, and the newest. */
export const appInfo = () => ({
    minVersion: process.env.APP_MIN_VERSION || '1.0.0',
    latestVersion: process.env.APP_LATEST_VERSION || '1.0.0',
    android: process.env.APP_ANDROID_URL || null,
    ios: process.env.APP_IOS_URL || null,
    push: !!serviceAccount(),
});
