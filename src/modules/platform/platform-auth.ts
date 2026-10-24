import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../core/db';
import { runAsSystem } from '../../core/context';
import { AppError } from '../../core/errors';
import { ErrorCode } from '../../core/auth.types';
import { comparePassword, hashPassword } from '../../core/password';
import { decryptSecret, encryptSecret } from '../../core/encryption';
import { tagAccess } from '../../core/http/route-guard';
import { generatePlatformMfaToken, generatePlatformToken, verifyPlatformMfaToken, verifyPlatformToken } from '../../config/jwt';
import { generateMfaSetup, verifyMfaToken } from '../auth/mfa.service';
import { platformLog } from './platform-log';

/**
 * Signing in to the platform console (Klytos staff, not a school): email and password, then an
 * authenticator code, always (set up at the first sign-in). Five wrong passwords lock the account
 * for 15 minutes. Owners can do everything; support staff can look and help (reset a school
 * admin's password), but not create, change, suspend or delete schools.
 */

export type PlatformRole = 'owner' | 'support';
export interface PlatformUserRef {
    id: string;
    email: string;
    name: string;
    role: PlatformRole;
    mustChangePassword: boolean;
}

declare global {
    namespace Express {
        interface Request {
            platformUser?: PlatformUserRef;
        }
    }
}

const fail = (message: string, status = 401) => new AppError(message, status, status === 401 ? ErrorCode.UNAUTHORIZED : ErrorCode.FORBIDDEN);
const sys = <T>(fn: () => Promise<T>) => runAsSystem(fn);
// Unknown emails take as long as known ones (no hint which emails exist).
let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= hashPassword('no-such-console-user'));
const ref = (u: { id: string; email: string; name: string; role: string; mustChangePassword: boolean }): PlatformUserRef => ({ id: u.id, email: u.email, name: u.name, role: u.role as PlatformRole, mustChangePassword: u.mustChangePassword });

export const loginSchema = z.strictObject({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) });
/** Step 1: the password. Then an authenticator code (or setting one up the first time). */
export const login = async (input: z.infer<typeof loginSchema>, ip?: string) => {
    const u = await sys(() => db.platformUser.findUnique({ where: { email: input.email } }));
    if (!u || u.status !== 'active') {
        await comparePassword(input.password, await dummyHash());
        throw fail('Wrong email or password');
    }
    if (u.lockedUntil && u.lockedUntil > new Date()) throw fail(`Too many wrong tries. Try again after ${u.lockedUntil.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', timeStyle: 'short' })}.`, 403);
    if (!(await comparePassword(input.password, u.passwordHash))) {
        const n = u.failedLogins + 1;
        await sys(() => db.platformUser.update({ where: { id: u.id }, data: n >= 5 ? { failedLogins: 0, lockedUntil: new Date(Date.now() + 15 * 60_000) } : { failedLogins: n } }));
        await platformLog(null, 'platform_login_failed', { details: { email: u.email }, ip });
        throw fail('Wrong email or password');
    }
    await sys(() => db.platformUser.update({ where: { id: u.id }, data: { failedLogins: 0, lockedUntil: null } }));
    const mfaToken = generatePlatformMfaToken(u.id);
    if (u.mfaEnabled && u.mfaSecretEnc) return { mfaRequired: true as const, mfaToken };
    // First sign-in: set up the authenticator app now (it is required).
    const setup = await generateMfaSetup(u.email, 'Klytos platform');
    await sys(() => db.platformUser.update({ where: { id: u.id }, data: { mfaSecretEnc: encryptSecret(setup.secret), mfaEnabled: false } }));
    return { mfaSetup: true as const, mfaToken, qrCodeDataUrl: setup.qrCodeDataUrl, secret: setup.secret };
};

export const verifySchema = z.strictObject({ mfaToken: z.string().min(10).max(4000), code: z.string().trim().regex(/^\d{6}$/, 'must be the 6-digit code') });
/** Step 2: the authenticator code: signed in (and the authenticator is now on). */
export const verify = async (input: z.infer<typeof verifySchema>, ip?: string) => {
    let id: string;
    try {
        id = verifyPlatformMfaToken(input.mfaToken);
    } catch {
        throw fail('That step has expired. Sign in again.');
    }
    const u = await sys(() => db.platformUser.findUnique({ where: { id } }));
    if (!u || u.status !== 'active' || !u.mfaSecretEnc) throw fail('Sign in again.');
    if (!verifyMfaToken(input.code, decryptSecret(u.mfaSecretEnc))) throw fail('Wrong code. Check the time on your phone and try again.');
    const done = await sys(() => db.platformUser.update({ where: { id }, data: { mfaEnabled: true, lastLoginAt: new Date() } }));
    await platformLog(id, 'platform_login', { ip });
    return { token: generatePlatformToken(id), user: ref(done) };
};

export const passwordSchema = z.strictObject({ current: z.string().min(1).max(200), next: z.string().min(10, 'use at least 10 characters').max(200) });
export const changePassword = async (userId: string, input: z.infer<typeof passwordSchema>) => {
    const u = await sys(() => db.platformUser.findUniqueOrThrow({ where: { id: userId } }));
    if (!(await comparePassword(input.current, u.passwordHash))) throw fail('The current password is wrong', 403);
    if (input.current === input.next) throw fail('Choose a different password', 403);
    const passwordHash = await hashPassword(input.next);
    await sys(() => db.platformUser.update({ where: { id: userId }, data: { passwordHash, mustChangePassword: false } }));
    await platformLog(userId, 'platform_password_changed', {});
    return { ok: true };
};

/**
 * The first handler of every console route: a valid console sign-in (and, with roles, one of them).
 * A console user who must change their password may only do that.
 */
export const platformOnly = (roles: PlatformRole[] = ['owner', 'support'], opts: { allowPasswordChange?: boolean } = {}) =>
    tagAccess(`platform:${roles.join('|')}`, async (req: Request, _res: Response, next: NextFunction) => {
        try {
            const h = req.headers.authorization;
            if (!h?.startsWith('Bearer ')) throw fail('Please sign in to the console');
            let id: string;
            try {
                id = verifyPlatformToken(h.slice(7));
            } catch {
                throw fail('Your console sign-in has expired');
            }
            const u = await sys(() => db.platformUser.findUnique({ where: { id } }));
            if (!u || u.status !== 'active' || !u.mfaEnabled) throw fail('Please sign in to the console');
            if (!roles.includes(u.role as PlatformRole)) throw fail('Only a platform owner can do this', 403);
            if (u.mustChangePassword && !opts.allowPasswordChange) throw fail('Choose a new password first', 403);
            req.platformUser = ref(u);
            next();
        } catch (err) {
            next(err);
        }
    });
