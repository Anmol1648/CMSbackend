import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { db } from '../src/core/db';
import { runAsTenant } from '../src/core/context';
import { makeTenant, makeUser, resetDatabase, setPasswordFor, tokenFor } from './helpers';

const ORIGIN = 'https://alpha.test.in';
// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

let alpha: Awaited<ReturnType<typeof makeTenant>>;
let superAdmin: string;
let teacher: string;
let teacherUser: { id: string; tenantId: string };

const as = (token: string) => ({
    get: (p: string) => request(app).get(p).set('Origin', ORIGIN).set('Authorization', token),
    patch: (p: string, body: object) => request(app).patch(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    upload: (p: string, data: Buffer) => request(app).post(p).set('Origin', ORIGIN).set('Authorization', token).attach('image', data, 'me.png'),
    del: (p: string) => request(app).delete(p).set('Origin', ORIGIN).set('Authorization', token),
});

beforeAll(async () => {
    await resetDatabase();
    alpha = await makeTenant('alpha', 'Alpha School', 'alpha.test.in');
    superAdmin = tokenFor({ id: alpha.admin.id, tenantId: alpha.tenant.id });
    teacherUser = await makeUser(alpha.tenant.id, 'teacher.one', 'teacher');
    teacher = tokenFor(teacherUser);
    await setPasswordFor(teacherUser, 'Teacher-pass-1');
});

describe('my details', () => {
    it('says what I may change (default: photo, email, mobile)', async () => {
        const res = await as(teacher).get('/api/auth/me');
        expect(res.body.data.selfEdit).toEqual(['photo', 'email', 'mobile']);
        expect(res.body.data.user.avatarUrl).toBeNull();
    });

    it('changes email and mobile only with the current password', async () => {
        const noPassword = await as(teacher).patch('/api/auth/me', { email: 'Teacher@Alpha.test.in' });
        expect(noPassword.status).toBe(400);
        expect(noPassword.body.error.details).toEqual([{ field: 'currentPassword', message: 'is required' }]);
        const wrong = await as(teacher).patch('/api/auth/me', { email: 'teacher@alpha.test.in', currentPassword: 'nope' });
        expect(wrong.status).toBe(400);

        const ok = await as(teacher).patch('/api/auth/me', { email: 'Teacher@Alpha.test.in', mobile: '98765 43210', currentPassword: 'Teacher-pass-1' });
        expect(ok.status).toBe(200);
        expect(ok.body.data).toMatchObject({ email: 'teacher@alpha.test.in' });
        const audit = await runAsTenant(alpha.tenant.id, () => db.auditLog.findFirst({ where: { entity: 'user', entityId: teacherUser.id, action: 'update' } }));
        expect(audit?.changes).toMatchObject({ email: [null, 'teacher@alpha.test.in'] });
    });

    it("refuses another person's email", async () => {
        await runAsTenant(alpha.tenant.id, () => db.user.update({ where: { id: alpha.admin.id }, data: { email: 'admin@alpha.test.in' } }));
        const res = await as(teacher).patch('/api/auth/me', { email: 'admin@alpha.test.in', currentPassword: 'Teacher-pass-1' });
        expect(res.status).toBe(409);
    });

    it('follows the school setting', async () => {
        expect((await as(teacher).patch('/api/auth/me', { displayName: 'Teacher Renamed' })).status).toBe(403);
        await as(superAdmin).patch('/api/settings', { changes: { 'accounts.self_edit': ['photo', 'name'] } });
        const renamed = await as(teacher).patch('/api/auth/me', { displayName: 'Teacher Renamed' });
        expect(renamed.status).toBe(200);
        expect(renamed.body.data.displayName).toBe('Teacher Renamed');
        expect((await as(teacher).patch('/api/auth/me', { mobile: '', currentPassword: 'Teacher-pass-1' })).status).toBe(403);
    });

    it('sets, shows and removes my photo', async () => {
        const up = await as(teacher).upload('/api/auth/me/avatar', PNG);
        expect(up.status).toBe(200);
        expect(up.body.data.avatarUrl).toMatch(new RegExp(`^users/${teacherUser.id}/avatar\\?v=`));
        const img = await as(superAdmin).get(`/api/users/${teacherUser.id}/avatar`);
        expect(img.status).toBe(200);
        expect(img.headers['content-type']).toBe('image/png');
        expect((await request(app).get(`/api/users/${teacherUser.id}/avatar`).set('Origin', ORIGIN)).status).toBe(401);
        expect((await as(teacher).upload('/api/auth/me/avatar', Buffer.from('not an image'))).status).toBe(400);
        expect((await as(teacher).del('/api/auth/me/avatar')).body.data.avatarUrl).toBeNull();
        expect((await as(superAdmin).get(`/api/users/${teacherUser.id}/avatar`)).status).toBe(404);

        await as(superAdmin).patch('/api/settings', { changes: { 'accounts.self_edit': [] } });
        expect((await as(teacher).upload('/api/auth/me/avatar', PNG)).status).toBe(403);
    });

    it("lets the school office set someone's photo (user.update)", async () => {
        const up = await as(superAdmin).upload(`/api/users/${teacherUser.id}/avatar`, PNG);
        expect(up.status).toBe(200);
        expect((await as(superAdmin).get(`/api/users/${teacherUser.id}`)).body.data.avatarUrl).toBe(up.body.data.avatarUrl);
        expect((await as(teacher).upload(`/api/users/${alpha.admin.id}/avatar`, PNG)).status).toBe(403);
    });
});
