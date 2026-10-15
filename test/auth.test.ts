import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { db } from '../src/core/db';
import { runAsTenant } from '../src/core/context';
import { testOutbox } from '../src/core/mail';
import { setSetting } from '../src/core/settings';
import { generateMfaChallengeToken } from '../src/config/jwt';
import { createLogin, SECURITY, ACCOUNTS, PASSWORDS } from '../src/modules/auth';
import { hashToken } from '../src/modules/auth/session.service';
import { currentMfaCode } from '../src/modules/auth/mfa.service';
import { makeTenant, makeUser, refreshCookieFrom, resetDatabase, resetRateLimits, setPasswordFor } from './helpers';

const ORIGIN = 'https://alpha.test.in';
const PASSWORD = 'Strong-pass-42';
let alpha: Awaited<ReturnType<typeof makeTenant>>;
let beta: Awaited<ReturnType<typeof makeTenant>>;
let teacher: { id: string; tenantId: string };

const api = () => ({
    post: (path: string) => request(app).post(path).set('Origin', ORIGIN),
    get: (path: string) => request(app).get(path).set('Origin', ORIGIN),
    del: (path: string) => request(app).delete(path).set('Origin', ORIGIN),
});
const login = (identifier: string, password: string, extra: object = {}) => api().post('/api/auth/login').send({ identifier, password, ...extra });
const bearer = (token: string) => `Bearer ${token}`;
const inAlpha = <T>(fn: () => Promise<T>) => runAsTenant(alpha.tenant.id, fn);

beforeAll(async () => {
    await resetDatabase();
    alpha = await makeTenant('alpha', 'Alpha School', 'alpha.test.in');
    beta = await makeTenant('beta', 'Beta School', 'beta.test.in');
    teacher = await makeUser(alpha.tenant.id, 'teacher.one', 'teacher');
    await inAlpha(() => db.user.update({ where: { id: teacher.id }, data: { email: 'teacher@alpha.test.in', mobile: '+919876543210' } }));
    await setPasswordFor(teacher, PASSWORD);
});

beforeEach(async () => {
    await resetRateLimits();
    // Each test starts with the teacher unlocked and no wrong attempts counted.
    await inAlpha(() => db.user.update({ where: { id: teacher.id }, data: { failedLoginCount: 0, lockedUntil: null, status: 'active' } }));
});

describe('first sign-in with the one-time password', () => {
    let token: string;

    it('signs in, sets the refresh cookie and flags the password change', async () => {
        const res = await login('admin', alpha.admin.temporaryPassword);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ mfaRequired: false, mustChangePassword: true, user: { username: 'admin', kind: 'admin' } });
        expect(res.body.data.refreshToken).toBeUndefined();
        const cookie = String(res.headers['set-cookie']);
        expect(cookie).toMatch(/cms_rt=.+; Path=\/api\/auth; Expires=.+; HttpOnly; SameSite=Lax/);
        token = res.body.data.accessToken;
    });

    it('only allows changing the password until it is changed', async () => {
        const blocked = await api().get('/api/school-profile').set('Authorization', bearer(token));
        expect(blocked.status).toBe(403);
        expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
        const me = await api().get('/api/auth/me').set('Authorization', bearer(token));
        expect(me.status).toBe(200);
        expect(me.body.data).toMatchObject({ mustChangePassword: true, roles: [{ slug: 'super-admin' }], school: { code: 'alpha' } });
    });

    it('checks the current password and the password rules', async () => {
        const wrong = await api().post('/api/auth/change-password').set('Authorization', bearer(token)).send({ currentPassword: 'nope', newPassword: PASSWORD });
        expect(wrong.status).toBe(400);
        expect(wrong.body.error.details).toEqual([{ field: 'currentPassword', message: 'is not right' }]);

        const weak = await api().post('/api/auth/change-password').set('Authorization', bearer(token)).send({ currentPassword: alpha.admin.temporaryPassword, newPassword: 'abc' });
        expect(weak.status).toBe(400);
        expect(weak.body.error.code).toBe('PASSWORD_POLICY');
        expect(weak.body.error.details.map((d: { message: string }) => d.message)).toEqual(
            expect.arrayContaining(['must be at least 8 characters', 'must contain a number'])
        );

        const same = await api().post('/api/auth/change-password').set('Authorization', bearer(token)).send({ currentPassword: alpha.admin.temporaryPassword, newPassword: alpha.admin.temporaryPassword });
        expect(same.status).toBe(400);
        expect(same.body.error.message).toContain("can't be one of your last");
    });

    it('changes the password and returns a token that works everywhere', async () => {
        const res = await api().post('/api/auth/change-password').set('Authorization', bearer(token)).send({ currentPassword: alpha.admin.temporaryPassword, newPassword: PASSWORD });
        expect(res.status).toBe(200);
        const fresh = res.body.data.accessToken;
        expect((await api().get('/api/school-profile').set('Authorization', bearer(fresh))).status).toBe(200);
        // The old one-time password no longer works.
        expect((await login('admin', alpha.admin.temporaryPassword)).status).toBe(401);
        expect((await login('admin', PASSWORD)).body.data.mustChangePassword).toBe(false);
    });
});

describe('identifiers', () => {
    it('accepts username (any case), email and mobile in any format', async () => {
        for (const id of ['TEACHER.ONE', 'Teacher@Alpha.test.in', '+91 98765-43210']) {
            const res = await login(id, PASSWORD);
            expect(res.status, id).toBe(200);
            expect(res.body.data.user.username).toBe('teacher.one');
        }
    });

    it('gives the same answer for an unknown user and a wrong password', async () => {
        const unknown = await login('nobody', PASSWORD);
        const wrong = await login('teacher.one', 'Wrong-pass-1');
        expect(unknown.status).toBe(401);
        expect(wrong.status).toBe(401);
        expect(unknown.body.error.message).toBe(wrong.body.error.message);
    });

    it('needs a school for the address', async () => {
        const res = await request(app).post('/api/auth/login').set('Origin', 'https://unknown.example').send({ identifier: 'admin', password: PASSWORD });
        expect(res.status).toBe(404);
    });

    it("signs in to the school of the page's address only", async () => {
        const res = await request(app).post('/api/auth/login').set('Origin', 'https://beta.test.in').send({ identifier: 'teacher.one', password: PASSWORD });
        expect(res.status).toBe(401);
    });

    it('records failed sign-ins in the audit log', async () => {
        const rows = await inAlpha(() => db.auditLog.findMany({ where: { action: 'login_failed' } }));
        expect(rows.length).toBeGreaterThanOrEqual(2);
        expect(rows.some((r) => (r.changes as { reason?: string })?.reason === 'unknown_user')).toBe(true);
    });
});

describe('lockout', () => {
    it('locks after the configured number of wrong passwords, even for the right one', async () => {
        await inAlpha(() => setSetting(SECURITY.lockoutAttempts, 3));
        try {
            expect((await login('teacher.one', 'Wrong-pass-1')).status).toBe(401);
            expect((await login('teacher.one', 'Wrong-pass-2')).status).toBe(401);
            const third = await login('teacher.one', 'Wrong-pass-3');
            expect(third.status).toBe(423);
            expect(third.body.error.code).toBe('AUTH_ACCOUNT_LOCKED');
            expect((await login('teacher.one', PASSWORD)).status).toBe(423);

            // When the lock runs out, the right password works and the counter is cleared.
            await inAlpha(() => db.user.update({ where: { id: teacher.id }, data: { lockedUntil: new Date(Date.now() - 1000) } }));
            expect((await login('teacher.one', PASSWORD)).status).toBe(200);
            const u = await inAlpha(() => db.user.findUniqueOrThrow({ where: { id: teacher.id } }));
            expect(u).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
        } finally {
            await inAlpha(() => setSetting(SECURITY.lockoutAttempts, undefined));
        }
    });

    it('a disabled account is told so (only with the right password)', async () => {
        await inAlpha(() => db.user.update({ where: { id: teacher.id }, data: { status: 'disabled' } }));
        try {
            expect((await login('teacher.one', 'Wrong-pass-1')).status).toBe(401);
            const res = await login('teacher.one', PASSWORD);
            expect(res.status).toBe(403);
            expect(res.body.error.code).toBe('AUTH_USER_DISABLED');
        } finally {
            await inAlpha(() => db.user.update({ where: { id: teacher.id }, data: { status: 'active' } }));
        }
    });
});

describe('staying signed in', () => {
    it('refresh swaps the cookie for a new one and issues a new access token', async () => {
        const first = await login('teacher.one', PASSWORD);
        const cookie1 = refreshCookieFrom(first)!;
        const res = await api().post('/api/auth/refresh').set('Cookie', `cms_rt=${cookie1}`);
        expect(res.status).toBe(200);
        const cookie2 = refreshCookieFrom(res)!;
        expect(cookie2).toBeTruthy();
        expect(cookie2).not.toBe(cookie1);
        expect((await api().get('/api/school-profile').set('Authorization', bearer(res.body.data.accessToken))).status).toBe(200);

        // Page load: one request brings the session, who I am and my sidebar.
        const full = await api().post('/api/auth/refresh?with=profile').set('Cookie', `cms_rt=${cookie2}`);
        expect(full.status).toBe(200);
        expect(full.body.data.me).toMatchObject({ user: { username: 'teacher.one' }, school: { code: 'alpha' }, mustChangePassword: false });
        expect(full.body.data.access.menu.flatMap((g: { items: { key: string }[] }) => g.items.map((i) => i.key))).toEqual(['home', 'school-profile']);
    });

    it('a copied (already used) refresh token ends the whole session', async () => {
        const first = await login('teacher.one', PASSWORD);
        const old = refreshCookieFrom(first)!;
        const access = first.body.data.accessToken;
        const renewed = await api().post('/api/auth/refresh').set('Cookie', `cms_rt=${old}`);
        const current = refreshCookieFrom(renewed)!;

        // Within a few seconds it's treated as two tabs refreshing together: refused, session kept.
        expect((await api().post('/api/auth/refresh').set('Cookie', `cms_rt=${old}`)).status).toBe(409);

        // Later, the old token showing up again means it was copied.
        await inAlpha(() => db.userSession.update({ where: { refreshTokenHash: hashToken(current) }, data: { lastUsedAt: new Date(Date.now() - 60_000) } }));
        expect((await api().post('/api/auth/refresh').set('Cookie', `cms_rt=${old}`)).status).toBe(401);
        expect((await api().post('/api/auth/refresh').set('Cookie', `cms_rt=${current}`)).status).toBe(401);
        expect((await api().get('/api/school-profile').set('Authorization', bearer(access))).status).toBe(401);
        const session = await inAlpha(() => db.userSession.findUniqueOrThrow({ where: { refreshTokenHash: hashToken(current) } }));
        expect(session.revokedReason).toBe('reuse_detected');
    });

    it('refresh without a cookie is a 401', async () => {
        expect((await api().post('/api/auth/refresh')).status).toBe(401);
    });

    it('other kinds of token are not accepted as a sign-in', async () => {
        const challenge = generateMfaChallengeToken(teacher.id, alpha.tenant.id);
        expect((await api().get('/api/school-profile').set('Authorization', bearer(challenge))).status).toBe(401);
        const first = await login('teacher.one', PASSWORD);
        expect((await api().get('/api/school-profile').set('Authorization', bearer(refreshCookieFrom(first)!))).status).toBe(401);
    });
});

describe('signing out', () => {
    it('logout ends this session at once (access token and refresh cookie)', async () => {
        const s = await login('teacher.one', PASSWORD);
        const access = s.body.data.accessToken;
        const out = await api().post('/api/auth/logout').set('Authorization', bearer(access));
        expect(out.status).toBe(200);
        expect(String(out.headers['set-cookie'])).toMatch(/cms_rt=;/);
        expect((await api().get('/api/school-profile').set('Authorization', bearer(access))).status).toBe(401);
        expect((await api().post('/api/auth/refresh').set('Cookie', `cms_rt=${refreshCookieFrom(s)}`)).status).toBe(401);
    });

    it('lists my devices and can sign one out; logout-all ends every session', async () => {
        const phone = await login('teacher.one', PASSWORD);
        const laptop = await login('teacher.one', PASSWORD);
        const laptopToken = laptop.body.data.accessToken;
        const list = await api().get('/api/auth/sessions').set('Authorization', bearer(laptopToken));
        expect(list.status).toBe(200);
        expect(list.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

        const phoneSession = list.body.data.find((s: { current: boolean }) => !s.current);
        expect((await api().del(`/api/auth/sessions/${phoneSession.id}`).set('Authorization', bearer(laptopToken))).status).toBe(200);

        // Someone else's session id is not found.
        const other = await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ identifier: 'admin', password: PASSWORD });
        const adminSessions = await api().get('/api/auth/sessions').set('Authorization', bearer(other.body.data.accessToken));
        const adminSessionId = adminSessions.body.data[0].id;
        expect((await api().del(`/api/auth/sessions/${adminSessionId}`).set('Authorization', bearer(laptopToken))).status).toBe(404);

        const all = await api().post('/api/auth/logout-all').set('Authorization', bearer(laptopToken));
        expect(all.status).toBe(200);
        expect((await api().get('/api/school-profile').set('Authorization', bearer(laptopToken))).status).toBe(401);
        expect((await api().get('/api/school-profile').set('Authorization', bearer(phone.body.data.accessToken))).status).toBe(401);
        expect((await api().get('/api/school-profile').set('Authorization', bearer(other.body.data.accessToken))).status).toBe(200);
    });
});

describe('forgot / reset password', () => {
    it('always answers the same, and emails a code only to a real account with an email', async () => {
        testOutbox.length = 0;
        const unknown = await api().post('/api/auth/forgot-password').send({ identifier: 'nobody@alpha.test.in' });
        const noEmail = await api().post('/api/auth/forgot-password').send({ identifier: 'admin' });
        const real = await api().post('/api/auth/forgot-password').send({ identifier: 'teacher.one' });
        for (const r of [unknown, noEmail, real]) {
            expect(r.status).toBe(200);
            expect(r.body.message).toBe(real.body.message);
        }
        expect(testOutbox).toHaveLength(1);
        expect(testOutbox[0]).toMatchObject({ to: 'teacher@alpha.test.in', fromName: 'Alpha School' });
        expect(testOutbox[0].text).toMatch(/\b\d{6}\b/);
    });

    it('resets with the right code once; wrong codes are refused', async () => {
        const code = testOutbox[0].text.match(/\b(\d{6})\b/)![1];
        const wrongCode = code === '000000' ? '111111' : '000000';
        const wrong = await api().post('/api/auth/reset-password').send({ identifier: 'teacher.one', code: wrongCode, newPassword: 'Brand-new-pass-7' });
        expect(wrong.status).toBe(400);
        const ok = await api().post('/api/auth/reset-password').send({ identifier: 'teacher.one', code, newPassword: 'Brand-new-pass-7' });
        expect(ok.status).toBe(200);
        expect((await login('teacher.one', 'Brand-new-pass-7')).status).toBe(200);
        expect((await login('teacher.one', PASSWORD)).status).toBe(401);
        const again = await api().post('/api/auth/reset-password').send({ identifier: 'teacher.one', code, newPassword: 'Another-pass-8' });
        expect(again.status).toBe(400);
        await setPasswordFor(teacher, PASSWORD);
    });
});

describe('two-step sign-in (authenticator app)', () => {
    it('can be turned on, then asks for the code at sign-in', async () => {
        const s = await login('teacher.one', PASSWORD);
        const token = s.body.data.accessToken;
        const setup = await api().post('/api/auth/mfa/setup').set('Authorization', bearer(token));
        expect(setup.status).toBe(200);
        expect(setup.body.data.otpauth).toContain('issuer=Alpha%20School');
        const secret = setup.body.data.secret;

        expect((await api().post('/api/auth/mfa/enable').set('Authorization', bearer(token)).send({ code: '000000' })).status).toBe(400);
        expect((await api().post('/api/auth/mfa/enable').set('Authorization', bearer(token)).send({ code: currentMfaCode(secret) })).status).toBe(200);

        const step1 = await login('teacher.one', PASSWORD, { rememberMe: true });
        expect(step1.body.data).toEqual({ mfaRequired: true, mfaToken: expect.any(String) });
        expect(refreshCookieFrom(step1)).toBeUndefined();

        const bad = await api().post('/api/auth/mfa/verify').send({ mfaToken: step1.body.data.mfaToken, code: '000000' });
        expect(bad.status).toBe(401);
        const good = await api().post('/api/auth/mfa/verify').send({ mfaToken: step1.body.data.mfaToken, code: currentMfaCode(secret) });
        expect(good.status).toBe(200);
        expect(refreshCookieFrom(good)).toBeTruthy();

        // Remember-me sessions last longer (30 days by default).
        const session = await inAlpha(() => db.userSession.findUniqueOrThrow({ where: { refreshTokenHash: hashToken(refreshCookieFrom(good)!) } }));
        expect(session.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);

        // Turning it off needs the password and a code.
        const t2 = good.body.data.accessToken;
        expect((await api().post('/api/auth/mfa/disable').set('Authorization', bearer(t2)).send({ password: 'wrong-pass-1', code: currentMfaCode(secret) })).status).toBe(400);
        expect((await api().post('/api/auth/mfa/disable').set('Authorization', bearer(t2)).send({ password: PASSWORD, code: currentMfaCode(secret) })).status).toBe(200);
        expect((await login('teacher.one', PASSWORD)).body.data.mfaRequired).toBe(false);
    });
});

describe('creating logins for people (account service)', () => {
    it('makes a unique username from the name, gives default roles and a one-time password', async () => {
        const [first, second] = await inAlpha(async () => [
            await createLogin({ kind: 'staff', displayName: 'Riya Sharma', email: 'Riya@Alpha.test.in' }),
            await createLogin({ kind: 'staff', displayName: 'Riya  Sharma' }),
        ]);
        expect(first.user.username).toBe('riya.sharma');
        expect(second.user.username).toBe('riya.sharma2');
        expect(first.user).toMatchObject({ email: 'riya@alpha.test.in', mustChangePassword: true });
        expect(first.welcome).toMatchObject({ to: 'riya@alpha.test.in' });
        expect(second.welcome).toBeNull();
        const roles = await inAlpha(() => db.userRole.findMany({ where: { userId: first.user.id }, include: { role: true } }));
        expect(roles.map((r) => r.role.slug)).toEqual(['teacher']);
        expect((await login('riya.sharma', first.temporaryPassword)).body.data.mustChangePassword).toBe(true);
    });

    it('prefers the given candidates (e.g. admission number) and refuses a taken email', async () => {
        await inAlpha(() => setSetting(ACCOUNTS.firstPassword, 'date_of_birth'));
        try {
            const s = await inAlpha(() =>
                createLogin({ kind: 'student', displayName: 'Aarav Kumar', usernameCandidates: ['ADM-2026-001'], dateOfBirth: new Date('2014-03-09') })
            );
            expect(s.user.username).toBe('adm-2026-001');
            expect(s.temporaryPassword).toBe('09032014');
            const roles = await inAlpha(() => db.userRole.findMany({ where: { userId: s.user.id }, include: { role: true } }));
            expect(roles.map((r) => r.role.slug)).toEqual(['student']);
        } finally {
            await inAlpha(() => setSetting(ACCOUNTS.firstPassword, undefined));
        }
        await expect(inAlpha(() => createLogin({ kind: 'staff', displayName: 'Dup', email: 'riya@alpha.test.in' }))).rejects.toMatchObject({ statusCode: 409 });
    });

    it('password rules follow System Settings', async () => {
        await inAlpha(() => setSetting(PASSWORDS.requireSymbol, true));
        try {
            const s = await login('teacher.one', PASSWORD);
            const res = await api()
                .post('/api/auth/change-password')
                .set('Authorization', bearer(s.body.data.accessToken))
                .send({ currentPassword: PASSWORD, newPassword: 'NoSymbols123' });
            expect(res.status).toBe(400);
            expect(res.body.error.details.map((d: { message: string }) => d.message)).toContain('must contain a symbol');
        } finally {
            await inAlpha(() => setSetting(PASSWORDS.requireSymbol, undefined));
        }
    });
});

describe('school separation at sign-in', () => {
    it('the same username in another school is a different account', async () => {
        const res = await request(app).post('/api/auth/login').set('Origin', 'https://beta.test.in').send({ identifier: 'admin', password: PASSWORD });
        expect(res.status).toBe(401);
        const ok = await request(app).post('/api/auth/login').set('Origin', 'https://beta.test.in').send({ identifier: 'admin', password: beta.admin.temporaryPassword });
        expect(ok.status).toBe(200);
        expect((await api().get('/api/auth/me').set('Authorization', bearer(ok.body.data.accessToken))).status).toBe(401);
    });
});
