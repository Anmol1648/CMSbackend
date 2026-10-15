import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { notFound, validationError } from '../../core/errors';
import { authenticated, authenticatedSelf, publicRoute } from '../../middlewares/access';
import { createRateLimiter } from '../../middlewares/rate-limit';
import * as auth from './auth.service';
import * as schemas from './auth.schemas';
import { listOpenSessions, revokeSession } from './session.service';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './auth.cookies';
import { myAccess } from '../rbac/my-access';

export const authRoutes = Router();

// Per network address. Schools put many students behind one address (a computer lab), so these are
// generous; each account is also locked after repeated wrong passwords (System Settings → Security).
const loginLimiter = createRateLimiter({ windowInMinutes: 15, maxAttempts: 60, keyPrefix: 'login' });
const mfaLimiter = createRateLimiter({ windowInMinutes: 15, maxAttempts: 30, keyPrefix: 'mfa' });
const forgotLimiter = createRateLimiter({ windowInMinutes: 60, maxAttempts: 10, keyPrefix: 'forgot-password' });
const resetLimiter = createRateLimiter({ windowInMinutes: 15, maxAttempts: 20, keyPrefix: 'reset-password' });
const passwordLimiter = createRateLimiter({ windowInMinutes: 15, maxAttempts: 10, keyPrefix: 'change-password' });

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) throw validationError(parsed.error);
    return parsed.data;
};
const meta = (req: Request) => ({ ip: req.ip, userAgent: req.header('user-agent')?.slice(0, 300) });

/** Sends tokens: access token in the body, refresh token in the httpOnly cookie. */
const signedIn = (res: Response, result: auth.SignedIn, message: string, extra: object = {}) => {
    setRefreshCookie(res, result.refreshToken, result.refreshExpiresAt);
    const { refreshToken: _r, refreshExpiresAt: _e, ...body } = result;
    return successResponse(res, { mfaRequired: false, ...body, ...extra }, message);
};

// ─── Sign in / out ───────────────────────────────────────────────────────────

authRoutes.post('/login', publicRoute, loginLimiter, asyncHandler(async (req: Request, res: Response) => {
    const input = parse(schemas.loginSchema, req.body);
    const result = await auth.login(input, meta(req));
    if (result.mfaRequired) return successResponse(res, { mfaRequired: true, mfaToken: result.mfaToken }, 'Enter the code from your authenticator app');
    return signedIn(res, result, 'Signed in');
}));

authRoutes.post('/mfa/verify', publicRoute, mfaLimiter, asyncHandler(async (req: Request, res: Response) => {
    const input = parse(schemas.mfaVerifySchema, req.body);
    return signedIn(res, await auth.verifyMfaLogin(input, meta(req)), 'Signed in');
}));

// ?with=profile also returns "who am I" and "my access": a page load restores everything in one request.
authRoutes.post('/refresh', publicRoute, asyncHandler(async (req: Request, res: Response) => {
    try {
        const result = await auth.refresh(readRefreshCookie(req), req.hostTenant);
        if (req.query.with !== 'profile') return signedIn(res, result, 'Session renewed');
        const [me, access] = await Promise.all([auth.me(result.user.id), result.mustChangePassword ? null : myAccess(result.user.id)]);
        return signedIn(res, result, 'Session renewed', { me: { ...me, mustChangePassword: result.mustChangePassword }, access });
    } catch (err) {
        if ((err as { statusCode?: number }).statusCode === 401) clearRefreshCookie(res);
        throw err;
    }
}));

authRoutes.post('/logout', authenticatedSelf, asyncHandler(async (req: Request, res: Response) => {
    await auth.logout(req.user!.sessionId);
    clearRefreshCookie(res);
    return successResponse(res, {}, 'Signed out');
}));

authRoutes.post('/logout-all', authenticatedSelf, asyncHandler(async (req: Request, res: Response) => {
    const sessions = await auth.logoutEverywhere(req.user!.userId);
    clearRefreshCookie(res);
    return successResponse(res, { sessions }, 'Signed out on every device');
}));

authRoutes.get('/me', authenticatedSelf, asyncHandler(async (req: Request, res: Response) => {
    return successResponse(res, { ...(await auth.me(req.user!.userId)), mustChangePassword: req.user!.pwdChange === true }, 'Signed-in user');
}));

// ─── Passwords ───────────────────────────────────────────────────────────────

authRoutes.post('/change-password', authenticatedSelf, passwordLimiter, asyncHandler(async (req: Request, res: Response) => {
    const input = parse(schemas.changePasswordSchema, req.body);
    const token = await auth.changePassword(req.user!.userId, req.user!.sessionId, input);
    return successResponse(res, token, 'Password changed. Your other devices have been signed out.');
}));

authRoutes.post('/forgot-password', publicRoute, forgotLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { identifier } = parse(schemas.forgotPasswordSchema, req.body);
    const result = await auth.forgotPassword(identifier, meta(req));
    return successResponse(res, result, result.message);
}));

authRoutes.post('/reset-password', publicRoute, resetLimiter, asyncHandler(async (req: Request, res: Response) => {
    const input = parse(schemas.resetPasswordSchema, req.body);
    const result = await auth.resetPassword(input);
    return successResponse(res, result, result.message);
}));

// ─── My devices ──────────────────────────────────────────────────────────────

authRoutes.get('/sessions', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const sessions = await listOpenSessions(req.user!.userId);
    return successResponse(res, sessions.map((s) => ({ ...s, current: s.id === req.user!.sessionId })), 'Your signed-in devices');
}));

authRoutes.delete('/sessions/:id', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const mine = (await listOpenSessions(req.user!.userId)).some((s) => s.id === req.params.id);
    if (!mine) throw notFound('Session not found');
    await revokeSession(req.params.id, 'logout');
    return successResponse(res, {}, 'That device has been signed out');
}));

// ─── Two-step sign-in ────────────────────────────────────────────────────────

authRoutes.post('/mfa/setup', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const setup = await auth.startMfaSetup(req.user!.userId);
    return successResponse(res, setup, 'Scan the QR code with your authenticator app');
}));

authRoutes.post('/mfa/enable', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const { code } = parse(schemas.mfaCodeSchema, req.body);
    await auth.enableMfa(req.user!.userId, code);
    return successResponse(res, {}, 'Two-step sign-in is on');
}));

authRoutes.post('/mfa/disable', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const input = parse(schemas.mfaDisableSchema, req.body);
    await auth.disableMfa(req.user!.userId, input);
    return successResponse(res, {}, 'Two-step sign-in is off');
}));
