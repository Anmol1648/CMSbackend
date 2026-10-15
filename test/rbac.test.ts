import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { db } from '../src/core/db';
import { runAsTenant } from '../src/core/context';
import { listPermissionDefs } from '../src/core/registry/permissions';
import { makeTenant, makeUser, resetDatabase, resetRateLimits, setPasswordFor, tokenFor } from './helpers';

const ORIGIN = 'https://alpha.test.in';
let alpha: Awaited<ReturnType<typeof makeTenant>>;
let beta: Awaited<ReturnType<typeof makeTenant>>;
let superAdmin: string;
let schoolAdmin: string;
let teacher: string;
let teacherUser: { id: string; tenantId: string };
const roleId: Record<string, string> = {};

const as = (token: string) => ({
    get: (p: string) => request(app).get(p).set('Origin', ORIGIN).set('Authorization', token),
    post: (p: string, body?: object) => request(app).post(p).set('Origin', ORIGIN).set('Authorization', token).send(body ?? {}),
    patch: (p: string, body: object) => request(app).patch(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    put: (p: string, body: object) => request(app).put(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    del: (p: string) => request(app).delete(p).set('Origin', ORIGIN).set('Authorization', token),
});

beforeAll(async () => {
    await resetDatabase();
    alpha = await makeTenant('alpha', 'Alpha School', 'alpha.test.in');
    beta = await makeTenant('beta', 'Beta School', 'beta.test.in');
    superAdmin = tokenFor({ id: alpha.admin.id, tenantId: alpha.tenant.id });
    schoolAdmin = tokenFor(await makeUser(alpha.tenant.id, 'office.admin', 'school-admin'));
    teacherUser = await makeUser(alpha.tenant.id, 'teacher.one', 'teacher');
    teacher = tokenFor(teacherUser);
    for (const r of await runAsTenant(alpha.tenant.id, () => db.role.findMany())) roleId[r.slug] = r.id;
});

describe('permission registry', () => {
    it('is synced to the database and grants defaults to new schools', async () => {
        const keys = (await db.permission.findMany()).map((p) => p.key).sort();
        expect(keys).toEqual(listPermissionDefs().map((p) => p.key).sort());
        expect(keys).toEqual(expect.arrayContaining(['user.view', 'user.create', 'role.manage', 'school_profile.update']));
        const grants = await runAsTenant(alpha.tenant.id, () => db.rolePermission.findMany({ where: { roleId: roleId['school-admin'] } }));
        expect(grants.map((g) => g.permissionKey).sort()).toEqual(['role.view', 'school_profile.update', 'user.create', 'user.reset_password', 'user.update', 'user.view']);
    });
});

describe('my access and sidebar', () => {
    const menuKeys = (body: { data: { menu: { items: { key: string }[] }[] } }) => body.data.menu.flatMap((g) => g.items.map((i) => i.key));

    it('Super Admin has everything', async () => {
        const res = await as(superAdmin).get('/api/me/access');
        expect(res.status).toBe(200);
        expect(res.body.data.isSuperAdmin).toBe(true);
        expect(Object.keys(res.body.data.permissions).length).toBe(listPermissionDefs().length);
        expect(menuKeys(res.body)).toEqual(['home', 'school-profile', 'users', 'roles', 'system-settings', 'audit']);
    });

    it('a teacher sees only what everyone sees', async () => {
        const res = await as(teacher).get('/api/me/access');
        expect(res.body.data).toMatchObject({ isSuperAdmin: false, permissions: {} });
        expect(menuKeys(res.body)).toEqual(['home', 'school-profile']);
    });

    it('School Admin gets the users screen but cannot manage roles', async () => {
        const res = await as(schoolAdmin).get('/api/me/access');
        expect(res.body.data.permissions).toMatchObject({ 'user.view': 'all', 'role.view': 'all' });
        expect(res.body.data.permissions['role.manage']).toBeUndefined();
        expect(menuKeys(res.body)).toEqual(['home', 'school-profile', 'users', 'roles']);
    });

    it('a school can hide or rename sidebar items', async () => {
        await runAsTenant(alpha.tenant.id, () =>
            db.menuCustomization.createMany({ data: [{ tenantId: alpha.tenant.id, menuKey: 'school-profile', label: 'Our School' }, { tenantId: alpha.tenant.id, menuKey: 'roles', hidden: true }] })
        );
        const res = await as(schoolAdmin).get('/api/me/access');
        const items = res.body.data.menu.flatMap((g: { items: { key: string; label: string }[] }) => g.items);
        expect(items.find((i: { key: string }) => i.key === 'school-profile').label).toBe('Our School');
        expect(items.some((i: { key: string }) => i.key === 'roles')).toBe(false);
        await runAsTenant(alpha.tenant.id, () => db.menuCustomization.deleteMany());
    });
});

describe('roles', () => {
    let custom: string;

    it('lists roles with counts; Super Admin shows every permission', async () => {
        const res = await as(schoolAdmin).get('/api/roles');
        expect(res.status).toBe(200);
        const sa = res.body.data.find((r: { slug: string }) => r.slug === 'super-admin');
        expect(sa).toMatchObject({ isSystem: true, userCount: 1, permissionCount: listPermissionDefs().length });
        const cat = await as(schoolAdmin).get('/api/roles/permissions');
        expect(cat.body.data.map((m: { module: string }) => m.module)).toEqual(['school', 'settings', 'access', 'audit']);
    });

    it('only role managers may create or change roles', async () => {
        expect((await as(schoolAdmin).post('/api/roles', { name: 'Librarian' })).status).toBe(403);
        expect((await as(teacher).get('/api/roles')).status).toBe(403);
    });

    it('creates a role (optionally copying another) and sets its permissions with scopes', async () => {
        const res = await as(superAdmin).post('/api/roles', { name: 'Front Desk', description: 'Reception', copyFromRoleId: roleId['principal'] });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ slug: 'front-desk', name: 'Front Desk' });
        expect(res.body.data.permissions.map((p: { key: string }) => p.key).sort()).toEqual(['role.view', 'user.view']);
        custom = res.body.data.id;

        expect((await as(superAdmin).post('/api/roles', { name: 'front desk' })).status).toBe(409);

        const set = await as(superAdmin).put(`/api/roles/${custom}/permissions`, { permissions: [{ key: 'user.view', scope: 'all' }, { key: 'user.create', scope: 'all' }] });
        expect(set.status).toBe(200);
        expect(set.body.data.permissions).toHaveLength(2);
        const audit = await runAsTenant(alpha.tenant.id, () => db.auditLog.findFirst({ where: { action: 'permission_change', entityId: custom } }));
        expect(audit?.changes).toMatchObject({ added: ['user.create:all'], removed: ['role.view'] });
    });

    it('rejects unknown permissions and scopes the permission does not support', async () => {
        const bad = await as(superAdmin).put(`/api/roles/${custom}/permissions`, { permissions: [{ key: 'user.fly', scope: 'all' }, { key: 'user.view', scope: 'own' }] });
        expect(bad.status).toBe(400);
        expect(bad.body.error.details.map((d: { field: string }) => d.field)).toEqual(['user.fly', 'user.view']);
    });

    it('Super Admin cannot be edited or deleted', async () => {
        expect((await as(superAdmin).put(`/api/roles/${roleId['super-admin']}/permissions`, { permissions: [] })).status).toBe(400);
        expect((await as(superAdmin).del(`/api/roles/${roleId['super-admin']}`)).status).toBe(400);
    });

    it('a role with users cannot be deleted; an empty one can', async () => {
        expect((await as(superAdmin).del(`/api/roles/${roleId['teacher']}`)).status).toBe(409);
        expect((await as(superAdmin).del(`/api/roles/${custom}`)).status).toBe(200);
        expect((await as(superAdmin).get(`/api/roles/${custom}`)).status).toBe(404);
    });

    it("another school's role is not found", async () => {
        const betaRole = await runAsTenant(beta.tenant.id, () => db.role.findFirstOrThrow({ where: { slug: 'teacher' } }));
        expect((await as(superAdmin).get(`/api/roles/${betaRole.id}`)).status).toBe(404);
    });
});

describe('no promoting yourself through a role', () => {
    it("a role manager who isn't Super Admin can only grant what they hold", async () => {
        // A "Role Manager" with role.manage + user.view only.
        const res = await as(superAdmin).post('/api/roles', { name: 'Role Manager' });
        const rm = res.body.data.id;
        await as(superAdmin).put(`/api/roles/${rm}/permissions`, { permissions: [{ key: 'role.manage', scope: 'all' }, { key: 'role.view', scope: 'all' }, { key: 'user.view', scope: 'all' }] });
        const manager = await makeUser(alpha.tenant.id, 'role.manager', 'teacher');
        await runAsTenant(alpha.tenant.id, () => db.userRole.create({ data: { tenantId: alpha.tenant.id, userId: manager.id, roleId: rm } }));
        const token = tokenFor(manager);

        const escalate = await as(token).put(`/api/roles/${roleId['teacher']}/permissions`, { permissions: [{ key: 'user.create', scope: 'all' }] });
        expect(escalate.status).toBe(403);
        const ok = await as(token).put(`/api/roles/${roleId['teacher']}/permissions`, { permissions: [{ key: 'user.view', scope: 'all' }] });
        expect(ok.status).toBe(200);
    });

    it('a changed role takes effect at once (no stale cache)', async () => {
        // teacher.one now holds user.view through the Teacher role.
        expect((await as(teacher).get('/api/users')).status).toBe(200);
        await as(superAdmin).put(`/api/roles/${roleId['teacher']}/permissions`, { permissions: [] });
        expect((await as(teacher).get('/api/users')).status).toBe(403);
    });
});

describe('users', () => {
    let created: { id: string; username: string };

    it('lists, searches and filters', async () => {
        const all = await as(schoolAdmin).get('/api/users?sort=username');
        expect(all.status).toBe(200);
        expect(all.body.data.items.map((u: { username: string }) => u.username)).toEqual(['admin', 'office.admin', 'role.manager', 'teacher.one']);
        const search = await as(schoolAdmin).get('/api/users?search=TEACH');
        expect(search.body.data.total).toBe(1);
        const byRole = await as(schoolAdmin).get('/api/users?filter[role]=super-admin');
        expect(byRole.body.data.items.map((u: { username: string }) => u.username)).toEqual(['admin']);
        expect((await as(schoolAdmin).get('/api/users?sort=passwordHash')).status).toBe(400);
    });

    it('creates a user with roles and returns the one-time password once', async () => {
        const res = await as(schoolAdmin).post('/api/users', { kind: 'staff', displayName: 'Meena Rawat', email: 'meena@alpha.test.in', roleIds: [roleId['office-staff']] });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ user: { username: 'meena.rawat', mustChangePassword: true, roles: [{ slug: 'office-staff' }] }, emailed: true });
        expect(res.body.data.temporaryPassword).toMatch(/^[a-z]{4}-\d{4}-[a-z]{4}$/);
        created = res.body.data.user;
        const login = await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ identifier: 'meena.rawat', password: res.body.data.temporaryPassword });
        expect(login.body.data.mustChangePassword).toBe(true);

        expect((await as(schoolAdmin).post('/api/users', { kind: 'staff', displayName: 'Copy', email: 'MEENA@alpha.test.in' })).status).toBe(409);
        expect((await as(schoolAdmin).post('/api/users', { kind: 'staff', displayName: 'Another Meena', username: 'meena.rawat' })).status).toBe(409);
        const bad = await as(schoolAdmin).post('/api/users', { kind: 'robot', displayName: '' });
        expect(bad.body.error.details.map((d: { field: string }) => d.field)).toEqual(expect.arrayContaining(['kind', 'displayName']));
    });

    it('only a Super Admin can make someone Super Admin or change a Super Admin', async () => {
        expect((await as(schoolAdmin).patch(`/api/users/${created.id}`, { roleIds: [roleId['super-admin']] })).status).toBe(403);
        expect((await as(schoolAdmin).post('/api/users', { kind: 'admin', displayName: 'Sneaky', roleIds: [roleId['super-admin']] })).status).toBe(403);
        expect((await as(schoolAdmin).patch(`/api/users/${alpha.admin.id}`, { displayName: 'Changed' })).status).toBe(403);
        expect((await as(schoolAdmin).post(`/api/users/${alpha.admin.id}/reset-password`)).status).toBe(403);
    });

    it('protects the last active Super Admin and your own account', async () => {
        expect((await as(superAdmin).patch(`/api/users/${alpha.admin.id}`, { status: 'disabled' })).status).toBe(400);
        const demote = await as(superAdmin).patch(`/api/users/${alpha.admin.id}`, { roleIds: [roleId['school-admin']] });
        expect(demote.status).toBe(409);
        expect(demote.body.error.message).toContain('only active Super Admin');
        // With a second Super Admin, the first may step down.
        const second = await as(superAdmin).post('/api/users', { kind: 'admin', displayName: 'Deputy Admin', roleIds: [roleId['super-admin']] });
        expect(second.status).toBe(201);
        expect((await as(superAdmin).patch(`/api/users/${alpha.admin.id}`, { roleIds: [roleId['super-admin'], roleId['principal']] })).status).toBe(200);
    });

    it('disabling a user signs them out at once and stops sign-in', async () => {
        await setPasswordFor(teacherUser, 'Teacher-pass-1');
        await resetRateLimits();
        const login = await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ identifier: 'teacher.one', password: 'Teacher-pass-1' });
        const token = `Bearer ${login.body.data.accessToken}`;
        expect((await as(token).get('/api/school-profile')).status).toBe(200);

        expect((await as(schoolAdmin).patch(`/api/users/${teacherUser.id}`, { status: 'disabled' })).status).toBe(200);
        expect((await as(token).get('/api/school-profile')).status).toBe(401);
        const again = await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ identifier: 'teacher.one', password: 'Teacher-pass-1' });
        expect(again.status).toBe(403);
        await as(schoolAdmin).patch(`/api/users/${teacherUser.id}`, { status: 'active' });
    });

    it('resets a password, unlocks, and refuses to reset two-step sign-in that is off', async () => {
        const reset = await as(schoolAdmin).post(`/api/users/${created.id}/reset-password`);
        expect(reset.status).toBe(200);
        await resetRateLimits();
        const login = await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ identifier: 'meena.rawat', password: reset.body.data.temporaryPassword });
        expect(login.status).toBe(200);

        await runAsTenant(alpha.tenant.id, () => db.user.update({ where: { id: created.id }, data: { lockedUntil: new Date(Date.now() + 600_000) } }));
        expect((await as(schoolAdmin).get(`/api/users/${created.id}`)).body.data.locked).toBe(true);
        expect((await as(schoolAdmin).post(`/api/users/${created.id}/unlock`)).body.data.locked).toBe(false);
        expect((await as(schoolAdmin).post(`/api/users/${created.id}/reset-mfa`)).status).toBe(409);
    });

    it("another school's user is not found", async () => {
        expect((await as(schoolAdmin).get(`/api/users/${beta.admin.id}`)).status).toBe(404);
        expect((await as(schoolAdmin).patch(`/api/users/${beta.admin.id}`, { displayName: 'Renamed' })).status).toBe(404);
    });
});
