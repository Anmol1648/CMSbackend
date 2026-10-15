import crypto from 'crypto';
import type { UserSession } from '@prisma/client';
import { db } from '../../core/db';
import { cache } from '../../core/cache';
import { runAsSystem } from '../../core/context';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { SECURITY } from './auth.settings';

/**
 * Signed-in devices. The refresh token is a random value; only its SHA-256 hash is stored.
 * Each refresh swaps it for a new one (rotation). Presenting a token that was already swapped means
 * it was copied: the whole session is revoked — except within a short grace window, so two browser
 * tabs refreshing at the same moment don't sign the user out.
 */

const REUSE_GRACE_MS = 20_000;

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

const revokedKey = (sessionId: string) => `revoked-session:${sessionId}`;

/** Remember the revocation long enough for every access token of that session to expire. */
const markRevoked = async (sessionIds: string[]) => {
    const { accessTokenMinutes } = await getSettings({ accessTokenMinutes: SECURITY.accessTokenMinutes });
    await Promise.all(sessionIds.map((id) => cache.set(revokedKey(id), '1', accessTokenMinutes * 60 + 60)));
};

export const isSessionRevoked = async (sessionId: string) => (await cache.get(revokedKey(sessionId))) === '1';

export interface CreatedSession {
    session: UserSession;
    refreshToken: string;
}

/** Starts a session for a user of the current school. */
export const createSession = async (userId: string, tenantId: string, rememberMe: boolean, meta: { ip?: string; userAgent?: string }): Promise<CreatedSession> => {
    const s = await getSettings({ sessionDays: SECURITY.sessionDays, rememberMeDays: SECURITY.rememberMeDays });
    const days = rememberMe ? s.rememberMeDays : s.sessionDays;
    const refreshToken = newToken();
    const session = await db.userSession.create({
        data: {
            tenantId,
            userId,
            refreshTokenHash: hashToken(refreshToken),
            ip: meta.ip,
            userAgent: meta.userAgent,
            expiresAt: new Date(Date.now() + days * 86_400_000),
        },
    });
    return { session, refreshToken };
};

export type RotateResult =
    | { ok: true; session: UserSession; refreshToken: string }
    | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'reused' | 'race' };

/** Swaps a refresh token for a new one. Looks across schools (the token identifies its session). */
export const rotateRefreshToken = (presented: string): Promise<RotateResult> =>
    runAsSystem(async () => {
        const hash = hashToken(presented);
        const session = await db.userSession.findUnique({ where: { refreshTokenHash: hash } });

        if (!session) {
            const replaced = await db.userSession.findUnique({ where: { previousTokenHash: hash } });
            if (!replaced) return { ok: false, reason: 'unknown' };
            if (replaced.revokedAt) return { ok: false, reason: 'revoked' };
            if (Date.now() - replaced.lastUsedAt.getTime() < REUSE_GRACE_MS) return { ok: false, reason: 'race' };
            await db.userSession.update({ where: { id: replaced.id }, data: { revokedAt: new Date(), revokedReason: 'reuse_detected' } });
            await markRevoked([replaced.id]);
            await recordAudit({ tenantId: replaced.tenantId, userId: replaced.userId, action: 'session_reuse_detected', entity: 'user_session', entityId: replaced.id });
            return { ok: false, reason: 'reused' };
        }

        if (session.revokedAt) return { ok: false, reason: 'revoked' };
        if (session.expiresAt.getTime() <= Date.now()) {
            await db.userSession.update({ where: { id: session.id }, data: { revokedAt: new Date(), revokedReason: 'expired' } });
            return { ok: false, reason: 'expired' };
        }

        const refreshToken = newToken();
        // Conditional update: if two refreshes race, only one wins.
        const updated = await db.userSession.updateMany({
            where: { id: session.id, refreshTokenHash: hash, revokedAt: null },
            data: { refreshTokenHash: hashToken(refreshToken), previousTokenHash: hash, lastUsedAt: new Date() },
        });
        if (updated.count !== 1) return { ok: false, reason: 'race' };
        return { ok: true, session: { ...session, lastUsedAt: new Date() }, refreshToken };
    });

/** Ends one session of the current school. */
export const revokeSession = async (sessionId: string, reason: string) => {
    const res = await db.userSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
    await markRevoked([sessionId]);
    return res.count > 0;
};

/** Ends every session of a user (optionally keeping one, e.g. the device that changed the password). */
export const revokeUserSessions = async (userId: string, reason: string, exceptSessionId?: string) => {
    const open = await db.userSession.findMany({
        where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
        select: { id: true },
    });
    if (!open.length) return 0;
    await db.userSession.updateMany({ where: { id: { in: open.map((s) => s.id) } }, data: { revokedAt: new Date(), revokedReason: reason } });
    await markRevoked(open.map((s) => s.id));
    return open.length;
};

/** A user's open sessions, newest first (for "my devices"). */
export const listOpenSessions = (userId: string) =>
    db.userSession.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { lastUsedAt: 'desc' },
        select: { id: true, ip: true, userAgent: true, createdAt: true, lastUsedAt: true, expiresAt: true },
    });
