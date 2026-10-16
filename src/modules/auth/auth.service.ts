import crypto from 'crypto';
import type { User } from '@prisma/client';
import { db, withTransaction } from '../../core/db';
import { cache } from '../../core/cache';
import { getTenantId, setTenant } from '../../core/context';
import { AppError, badRequest, conflict, forbidden } from '../../core/errors';
import { ErrorCode } from '../../core/auth.types';
import { comparePassword, hashPassword } from '../../core/password';
import { encryptSecret, decryptSecret } from '../../core/encryption';
import { getSetting, getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { logger } from '../../core/logger';
import { generateAccessToken, generateMfaChallengeToken, verifyMfaChallengeToken } from '../../config/jwt';
import { findTenantById } from '../tenants';
import { ACCOUNTS, LOGIN, PASSWORDS, SECURITY } from './auth.settings';
import { findUserByIdentifier } from './identity';
import { assertPasswordAllowed } from './password-policy';
import { createSession, revokeSession, revokeUserSessions, rotateRefreshToken } from './session.service';
import { generateMfaSetup, verifyMfaToken } from './mfa.service';
import { PASSWORD_RESET_EMAIL } from './auth.emails';
import { sendTemplatedEmail } from '../email-templates/email-templates.service';
import { sendInBackground } from '../../core/mail';
import { avatarPath } from '../users/avatar';

// ─── Shared helpers ──────────────────────────────────────────────────────────

const invalidCredentials = () => new AppError('Invalid credentials', 401, ErrorCode.AUTH_INVALID_CREDENTIALS);
export const sessionEnded = () => new AppError('Your session has ended. Please sign in again.', 401, ErrorCode.AUTH_INVALID_TOKEN);
const locked = (until: Date) => {
    const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
    return new AppError(
        `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or reset your password.`,
        423,
        ErrorCode.AUTH_ACCOUNT_LOCKED
    );
};

/** Compared against when the user doesn't exist, so "no such user" takes as long as "wrong password". */
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex')));

const requireSchool = () => {
    const tenantId = getTenantId();
    if (!tenantId) throw new AppError('No school is set up for this address', 404, ErrorCode.NOT_FOUND);
    return tenantId;
};

export interface RequestMeta {
    ip?: string;
    userAgent?: string;
}

export const userSummary = (u: User) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    mobile: u.mobile,
    kind: u.kind,
    mfaEnabled: u.mfaEnabled,
    mustChangePassword: u.mustChangePassword,
    lastLoginAt: u.lastLoginAt,
    avatarUrl: avatarPath(u),
});

export interface SignedIn {
    accessToken: string;
    expiresIn: number;
    refreshToken: string;
    refreshExpiresAt: Date;
    user: ReturnType<typeof userSummary>;
    mustChangePassword: boolean;
}

export type LoginResult = { mfaRequired: true; mfaToken: string } | ({ mfaRequired: false } & SignedIn);

const issueAccessToken = async (user: User, sessionId: string) => {
    const { accessTokenMinutes } = await getSettings({ accessTokenMinutes: SECURITY.accessTokenMinutes });
    const expiresIn = accessTokenMinutes * 60;
    const accessToken = generateAccessToken({ userId: user.id, tenantId: user.tenantId, sessionId, pwdChange: user.mustChangePassword }, expiresIn);
    return { accessToken, expiresIn };
};

const completeSignIn = async (user: User, rememberMe: boolean, meta: RequestMeta): Promise<SignedIn> => {
    const { session, refreshToken } = await createSession(user.id, user.tenantId, rememberMe, meta);
    const updated = await db.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    });
    await recordAudit({ action: 'login', entity: 'user', entityId: user.id, userId: user.id });
    return {
        ...(await issueAccessToken(updated, session.id)),
        refreshToken,
        refreshExpiresAt: session.expiresAt,
        user: userSummary(updated),
        mustChangePassword: updated.mustChangePassword,
    };
};

/** Sets a new password: history, unlock, clears "must change", ends other sessions. */
const setPassword = async (user: User, newPassword: string, reason: 'password_changed' | 'password_reset', keepSessionId?: string) => {
    const passwordHash = await hashPassword(newPassword);
    const updated = await withTransaction(async (tx) => {
        await tx.passwordHistory.create({ data: { tenantId: user.tenantId, userId: user.id, passwordHash: user.passwordHash } });
        return tx.user.update({
            where: { id: user.id },
            data: { passwordHash, passwordChangedAt: new Date(), mustChangePassword: false, failedLoginCount: 0, lockedUntil: null },
        });
    });
    await revokeUserSessions(user.id, reason, keepSessionId);
    return updated;
};

// ─── Sign in ─────────────────────────────────────────────────────────────────

export const login = async (input: { identifier: string; password: string; rememberMe?: boolean }, meta: RequestMeta): Promise<LoginResult> => {
    requireSchool();
    const s = await getSettings({
        identifiers: LOGIN.identifiers,
        lockoutAttempts: SECURITY.lockoutAttempts,
        lockoutMinutes: SECURITY.lockoutMinutes,
        mfaPolicy: SECURITY.mfaPolicy,
        expiryDays: PASSWORDS.expiryDays,
    });
    const identifier = input.identifier.trim().slice(0, 200);
    const user = await findUserByIdentifier(identifier, s.identifiers);

    if (!user) {
        await comparePassword(input.password, await getDummyHash());
        await recordAudit({ action: 'login_failed', entity: 'user', userId: null, changes: { identifier, reason: 'unknown_user' } });
        throw invalidCredentials();
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        await recordAudit({ action: 'login_failed', entity: 'user', entityId: user.id, userId: user.id, changes: { reason: 'locked' } });
        throw locked(user.lockedUntil);
    }

    if (!(await comparePassword(input.password, user.passwordHash))) {
        const after = await db.user.update({ where: { id: user.id }, data: { failedLoginCount: { increment: 1 } } });
        if (after.failedLoginCount >= s.lockoutAttempts) {
            const until = new Date(Date.now() + s.lockoutMinutes * 60_000);
            await db.user.update({ where: { id: user.id }, data: { lockedUntil: until, failedLoginCount: 0 } });
            await recordAudit({ action: 'account_locked', entity: 'user', entityId: user.id, userId: user.id, changes: { minutes: s.lockoutMinutes } });
            throw locked(until);
        }
        await recordAudit({ action: 'login_failed', entity: 'user', entityId: user.id, userId: user.id, changes: { reason: 'wrong_password' } });
        throw invalidCredentials();
    }

    if (user.status !== 'active') {
        await recordAudit({ action: 'login_failed', entity: 'user', entityId: user.id, userId: user.id, changes: { reason: 'disabled' } });
        throw new AppError('This account is disabled. Please contact the school office.', 403, ErrorCode.AUTH_USER_DISABLED);
    }

    let current = user;
    if (s.expiryDays > 0 && !user.mustChangePassword) {
        const since = (user.passwordChangedAt ?? user.createdAt).getTime();
        if (Date.now() - since > s.expiryDays * 86_400_000) {
            current = await db.user.update({ where: { id: user.id }, data: { mustChangePassword: true } });
        }
    }

    if (current.mfaEnabled && current.mfaSecretEnc && s.mfaPolicy !== 'off') {
        return { mfaRequired: true, mfaToken: generateMfaChallengeToken(current.id, current.tenantId, input.rememberMe === true) };
    }
    return { mfaRequired: false, ...(await completeSignIn(current, input.rememberMe === true, meta)) };
};

export const verifyMfaLogin = async (input: { mfaToken: string; code: string }, meta: RequestMeta): Promise<SignedIn> => {
    let challenge: ReturnType<typeof verifyMfaChallengeToken>;
    try {
        challenge = verifyMfaChallengeToken(input.mfaToken);
    } catch {
        throw new AppError('This sign-in step has expired. Please sign in again.', 401, ErrorCode.AUTH_INVALID_TOKEN);
    }
    const host = getTenantId();
    if (host && host !== challenge.tenantId) throw sessionEnded();
    setTenant(challenge.tenantId);

    const attemptsKey = `mfa-attempts:${challenge.userId}`;
    if ((await cache.incr(attemptsKey, 5 * 60)) > 5) {
        throw new AppError('Too many wrong codes. Please sign in again in a few minutes.', 429, ErrorCode.TOO_MANY_REQUESTS);
    }

    const user = await db.user.findUnique({ where: { id: challenge.userId } });
    if (!user || user.status !== 'active' || !user.mfaEnabled || !user.mfaSecretEnc) throw sessionEnded();
    if (!verifyMfaToken(input.code.trim(), decryptSecret(user.mfaSecretEnc))) {
        await recordAudit({ action: 'login_failed', entity: 'user', entityId: user.id, userId: user.id, changes: { reason: 'wrong_mfa_code' } });
        throw new AppError('That code is not right. Check your authenticator app and try again.', 401, ErrorCode.AUTH_INVALID_CREDENTIALS);
    }
    await cache.del(attemptsKey);
    return completeSignIn(user, challenge.rememberMe, meta);
};

// ─── Staying signed in / signing out ─────────────────────────────────────────

export const refresh = async (presented: string | undefined, hostTenant?: { id: string; source: string } | null) => {
    if (!presented) throw sessionEnded();
    const r = await rotateRefreshToken(presented);
    if (!r.ok) {
        if (r.reason === 'race') throw conflict('Your session was just renewed in another tab. Try again.');
        throw sessionEnded();
    }
    const { session } = r;
    if (hostTenant?.source === 'domain' && hostTenant.id !== session.tenantId) throw sessionEnded();
    setTenant(session.tenantId);

    const tenant = await findTenantById(session.tenantId);
    if (!tenant || tenant.status !== 'active') throw forbidden('This school account is suspended');

    const user = await db.user.findUnique({ where: { id: session.userId } });
    if (!user || user.status !== 'active') {
        await revokeSession(session.id, 'admin');
        throw sessionEnded();
    }
    return {
        ...(await issueAccessToken(user, session.id)),
        refreshToken: r.refreshToken,
        refreshExpiresAt: session.expiresAt,
        user: userSummary(user),
        mustChangePassword: user.mustChangePassword,
    };
};

export const logout = async (sessionId: string) => {
    await revokeSession(sessionId, 'logout');
    await recordAudit({ action: 'logout', entity: 'user_session', entityId: sessionId });
};

export const logoutEverywhere = async (userId: string) => {
    const count = await revokeUserSessions(userId, 'logout_all');
    await recordAudit({ action: 'logout_all', entity: 'user', entityId: userId, changes: { sessions: count } });
    return count;
};

/** Who am I: the signed-in user, their roles and their school. */
export const me = async (userId: string) => {
    const user = await db.user.findUnique({
        where: { id: userId },
        include: { roles: { include: { role: { select: { slug: true, name: true, deletedAt: true } } } } },
    });
    if (!user) throw sessionEnded();
    const profile = await db.schoolProfile.findFirst({ include: { tenant: { select: { code: true } } } });
    return {
        user: userSummary(user),
        roles: user.roles.filter((r) => !r.role.deletedAt).map((r) => ({ slug: r.role.slug, name: r.role.name })),
        /** What My account lets this person change (System Settings → Accounts). */
        selfEdit: await getSetting(ACCOUNTS.selfEdit),
        school: profile
            ? {
                  code: profile.tenant.code,
                  name: profile.shortName ?? profile.legalName,
                  legalName: profile.legalName,
                  logoUrl: profile.logoFileId ? `public/school/logo?school=${profile.tenant.code}&v=${profile.logoFileId}` : null,
              }
            : null,
    };
};

// ─── Passwords ───────────────────────────────────────────────────────────────

export const changePassword = async (userId: string, sessionId: string, input: { currentPassword: string; newPassword: string }) => {
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) throw sessionEnded();
    if (!(await comparePassword(input.currentPassword, user.passwordHash))) {
        throw badRequest('Current password is not right', [{ field: 'currentPassword', message: 'is not right' }]);
    }
    await assertPasswordAllowed(input.newPassword, user);
    const updated = await setPassword(user, input.newPassword, 'password_changed', sessionId);
    await recordAudit({ action: 'password_change', entity: 'user', entityId: user.id });
    // The current device stays signed in, with the "must change password" flag cleared.
    return issueAccessToken(updated, sessionId);
};

const GENERIC_RESET_MESSAGE = 'If an account with an email address matches, a reset code has been sent to it.';
const codeHash = (userId: string, code: string) =>
    crypto.createHmac('sha256', process.env.MFA_ENCRYPTION_KEY || 'reset').update(`${userId}:${code}`).digest('hex');

export const forgotPassword = async (identifier: string, meta: RequestMeta) => {
    requireSchool();
    const s = await getSettings({ show: LOGIN.showForgotPassword, identifiers: LOGIN.identifiers, minutes: PASSWORDS.resetCodeMinutes });
    if (!s.show) throw forbidden('Password reset by email is turned off. Please ask the school office.');

    const user = await findUserByIdentifier(identifier, s.identifiers);
    if (!user || user.status !== 'active' || !user.email) return { message: GENERIC_RESET_MESSAGE };

    // One code a minute at most; the newest code replaces older ones.
    const recent = await db.passwordReset.findFirst({ where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 60_000) } } });
    if (recent) return { message: GENERIC_RESET_MESSAGE };

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await db.passwordReset.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
    await db.passwordReset.create({
        data: { tenantId: user.tenantId, userId: user.id, codeHash: codeHash(user.id, code), expiresAt: new Date(Date.now() + s.minutes * 60_000), requestedIp: meta.ip },
    });
    // In the background: the answer is the same and comes just as fast whether or not an account
    // matched (so nobody can tell which accounts exist); a failure shows in the Audit Trail.
    const to = user.email;
    await sendInBackground(
        () => sendTemplatedEmail(PASSWORD_RESET_EMAIL.key, to, { name: user.displayName, code, minutes: String(s.minutes) }),
        (err) => recordAudit({ action: 'email_failed', entity: 'user', entityId: user.id, userId: user.id, changes: { purpose: 'password_reset', reason: err.message.slice(0, 200) } })
    );
    await recordAudit({ action: 'password_reset_requested', entity: 'user', entityId: user.id, userId: user.id });
    return { message: GENERIC_RESET_MESSAGE };
};

export const resetPassword = async (input: { identifier: string; code: string; newPassword: string }) => {
    requireSchool();
    const wrong = () => badRequest('The code is wrong or has expired', [{ field: 'code', message: 'is wrong or has expired' }]);
    const { identifiers } = await getSettings({ identifiers: LOGIN.identifiers });
    const user = await findUserByIdentifier(input.identifier, identifiers);
    if (!user || user.status !== 'active') throw wrong();

    const reset = await db.passwordReset.findFirst({
        where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
    });
    if (!reset || reset.attempts >= 5) throw wrong();
    const expected = Buffer.from(reset.codeHash, 'hex');
    const given = Buffer.from(codeHash(user.id, input.code.trim()), 'hex');
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
        await db.passwordReset.update({ where: { id: reset.id }, data: { attempts: { increment: 1 } } });
        throw wrong();
    }

    await assertPasswordAllowed(input.newPassword, user);
    await db.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } });
    await setPassword(user, input.newPassword, 'password_reset');
    await recordAudit({ action: 'password_reset', entity: 'user', entityId: user.id, userId: user.id });
    return { message: 'Your password has been changed. Please sign in with it.' };
};

// ─── Two-step sign-in (authenticator app) ────────────────────────────────────

const mfaSetupKey = (userId: string) => `mfa-setup:${userId}`;

export const startMfaSetup = async (userId: string) => {
    const { mfaPolicy } = await getSettings({ mfaPolicy: SECURITY.mfaPolicy });
    if (mfaPolicy === 'off') throw forbidden('Two-step sign-in is turned off for this school');
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) throw sessionEnded();
    if (user.mfaEnabled) throw conflict('Two-step sign-in is already on');
    const profile = await db.schoolProfile.findFirst({ select: { shortName: true, legalName: true } });
    const setup = await generateMfaSetup(user.username, profile?.shortName ?? profile?.legalName ?? 'School ERP');
    await cache.set(mfaSetupKey(userId), encryptSecret(setup.secret), 10 * 60);
    return setup;
};

export const enableMfa = async (userId: string, code: string) => {
    const pending = await cache.get(mfaSetupKey(userId));
    if (!pending) throw badRequest('Start the setup again (it expires after 10 minutes)');
    if (!verifyMfaToken(code.trim(), decryptSecret(pending))) {
        throw badRequest('That code is not right', [{ field: 'code', message: 'is not right' }]);
    }
    await db.user.update({ where: { id: userId }, data: { mfaEnabled: true, mfaSecretEnc: pending } });
    await cache.del(mfaSetupKey(userId));
    await recordAudit({ action: 'mfa_enabled', entity: 'user', entityId: userId });
};

export const disableMfa = async (userId: string, input: { password: string; code: string }) => {
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) throw sessionEnded();
    if (!user.mfaEnabled || !user.mfaSecretEnc) throw conflict('Two-step sign-in is not on');
    if (!(await comparePassword(input.password, user.passwordHash))) {
        throw badRequest('Password is not right', [{ field: 'password', message: 'is not right' }]);
    }
    if (!verifyMfaToken(input.code.trim(), decryptSecret(user.mfaSecretEnc))) {
        throw badRequest('That code is not right', [{ field: 'code', message: 'is not right' }]);
    }
    await db.user.update({ where: { id: userId }, data: { mfaEnabled: false, mfaSecretEnc: null } });
    await recordAudit({ action: 'mfa_disabled', entity: 'user', entityId: userId });
};
