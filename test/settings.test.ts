import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { db } from '../src/core/db';
import { runAsTenant } from '../src/core/context';
import { getSetting } from '../src/core/settings';
import { SECURITY } from '../src/modules/auth';
import { makeTenant, makeUser, resetDatabase, tokenFor } from './helpers';

const ORIGIN = 'https://alpha.test.in';
let alpha: Awaited<ReturnType<typeof makeTenant>>;
let beta: Awaited<ReturnType<typeof makeTenant>>;
let superAdmin: string;
let schoolAdmin: string;

const get = (token: string) => request(app).get('/api/settings').set('Origin', ORIGIN).set('Authorization', token);
const save = (token: string, changes: object) => request(app).patch('/api/settings').set('Origin', ORIGIN).set('Authorization', token).send({ changes });

type Item = { key: string; value: unknown; isDefault: boolean; default: unknown; min?: number | null; max?: number | null; type: string };
const find = (body: { data: { group: string; settings: Item[] }[] }, key: string) => body.data.flatMap((g) => g.settings).find((s) => s.key === key)!;

beforeAll(async () => {
    await resetDatabase();
    alpha = await makeTenant('alpha', 'Alpha School', 'alpha.test.in');
    beta = await makeTenant('beta', 'Beta School', 'beta.test.in');
    superAdmin = tokenFor({ id: alpha.admin.id, tenantId: alpha.tenant.id });
    schoolAdmin = tokenFor(await makeUser(alpha.tenant.id, 'office.admin', 'school-admin'));
});

describe('System Settings', () => {
    it('lists every setting by group with its default and limits', async () => {
        const res = await get(superAdmin);
        expect(res.status).toBe(200);
        expect(res.body.data.map((g: { group: string }) => g.group)).toEqual(['Login', 'Security', 'Passwords', 'Accounts']);
        expect(find(res.body, 'security.lockout_attempts')).toMatchObject({ type: 'number', value: 5, default: 5, isDefault: true, min: 3, max: 20 });
        expect(find(res.body, 'login.identifiers')).toMatchObject({ type: 'multiselect', value: ['email', 'username', 'mobile'] });
    });

    it('saves changes, records old and new values, and the new value is used at once', async () => {
        const res = await save(superAdmin, { 'security.lockout_attempts': 3, 'passwords.min_length': 10 });
        expect(res.status).toBe(200);
        expect(find(res.body, 'security.lockout_attempts')).toMatchObject({ value: 3, isDefault: false });
        expect(await runAsTenant(alpha.tenant.id, () => getSetting(SECURITY.lockoutAttempts))).toBe(3);

        const audit = await runAsTenant(alpha.tenant.id, () => db.auditLog.findFirst({ where: { action: 'setting_change' }, orderBy: { at: 'desc' } }));
        expect(audit?.changes).toEqual({ 'security.lockout_attempts': [5, 3], 'passwords.min_length': [8, 10] });
    });

    it('refuses invalid values and unknown keys, and saves nothing if any change is invalid', async () => {
        const res = await save(superAdmin, { 'security.lockout_attempts': 4, 'security.lockout_minutes': 0, 'security.fly': true });
        expect(res.status).toBe(400);
        expect(res.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['security.fly', 'security.lockout_minutes']);
        expect(await runAsTenant(alpha.tenant.id, () => getSetting(SECURITY.lockoutAttempts))).toBe(3);
        expect((await save(superAdmin, { 'login.identifiers': [] })).status).toBe(400);
    });

    it('null (or the default value) resets a setting', async () => {
        const res = await save(superAdmin, { 'security.lockout_attempts': null, 'passwords.min_length': 8 });
        expect(find(res.body, 'security.lockout_attempts')).toMatchObject({ value: 5, isDefault: true });
        expect(find(res.body, 'passwords.min_length')).toMatchObject({ value: 8, isDefault: true });
        expect(await runAsTenant(alpha.tenant.id, () => db.tenantSetting.count())).toBe(0);
    });

    it('needs settings permissions; view and change are separate', async () => {
        expect((await get(schoolAdmin)).status).toBe(403);
        const role = await runAsTenant(alpha.tenant.id, () => db.role.findFirstOrThrow({ where: { slug: 'school-admin' } }));
        await request(app)
            .put(`/api/roles/${role.id}/permissions`)
            .set('Origin', ORIGIN)
            .set('Authorization', superAdmin)
            .send({ permissions: [{ key: 'settings.view', scope: 'all' }, { key: 'user.view', scope: 'all' }] });
        expect((await get(schoolAdmin)).status).toBe(200);
        expect((await save(schoolAdmin, { 'security.lockout_attempts': 4 })).status).toBe(403);
    });

    it("one school's settings never affect another", async () => {
        await save(superAdmin, { 'security.session_days': 3 });
        expect(await runAsTenant(beta.tenant.id, () => getSetting(SECURITY.sessionDays))).toBe(7);
        expect(await runAsTenant(alpha.tenant.id, () => getSetting(SECURITY.sessionDays))).toBe(3);
    });
});
