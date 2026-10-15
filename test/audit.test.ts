import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { db } from '../src/core/db';
import { runAsTenant } from '../src/core/context';
import { purgeOldAuditRecords } from '../src/modules/audit/audit.service';
import { makeTenant, makeUser, resetDatabase, resetRateLimits, tokenFor } from './helpers';

const ORIGIN = 'https://alpha.test.in';
let alpha: Awaited<ReturnType<typeof makeTenant>>;
let beta: Awaited<ReturnType<typeof makeTenant>>;
let superAdmin: string;
let teacher: string;

const get = (token: string, path: string) => request(app).get(path).set('Origin', ORIGIN).set('Authorization', token);

beforeAll(async () => {
    await resetDatabase();
    alpha = await makeTenant('alpha', 'Alpha School', 'alpha.test.in');
    beta = await makeTenant('beta', 'Beta School', 'beta.test.in');
    superAdmin = tokenFor({ id: alpha.admin.id, tenantId: alpha.tenant.id });
    teacher = tokenFor(await makeUser(alpha.tenant.id, 'teacher.one', 'teacher'));
    await resetRateLimits();
    // Some events: a failed sign-in, a profile edit (automatic history) in alpha; one edit in beta.
    await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ identifier: 'nobody', password: 'x-1234567' });
    await request(app).patch('/api/school-profile').set('Origin', ORIGIN).set('Authorization', superAdmin).send({ city: 'Joshimath', board: 'CBSE' });
    await request(app)
        .patch('/api/school-profile')
        .set('Origin', 'https://beta.test.in')
        .set('Authorization', tokenFor({ id: beta.admin.id, tenantId: beta.tenant.id }))
        .send({ city: 'Elsewhere' });
});

describe('automatic change history', () => {
    it('records field-level old and new values with who did it', async () => {
        const res = await get(superAdmin, `/api/audit/history/school_profile/${alpha.tenant.id}`);
        expect(res.status).toBe(200);
        expect(res.body.data[0]).toMatchObject({
            action: 'update',
            entity: 'school_profile',
            entityId: alpha.tenant.id,
            changes: { city: [null, 'Joshimath'], board: [null, 'CBSE'] },
            user: { username: 'admin' },
        });
        expect(typeof res.body.data[0].id).toBe('string');
    });

    it('a save that changes nothing leaves no entry', async () => {
        await request(app).patch('/api/school-profile').set('Origin', ORIGIN).set('Authorization', superAdmin).send({ city: 'Joshimath' });
        const res = await get(superAdmin, `/api/audit/history/school_profile/${alpha.tenant.id}`);
        // The edit above, and the creation when the school was set up.
        expect(res.body.data.map((r: { action: string }) => r.action)).toEqual(['update', 'create']);
        expect(res.body.data[1].changes).toMatchObject({ legalName: [null, 'Alpha School'] });
    });
});

describe('audit trail', () => {
    it('lists newest first with filters, and only this school', async () => {
        const all = await get(superAdmin, '/api/audit');
        expect(all.status).toBe(200);
        const actions = all.body.data.items.map((r: { action: string }) => r.action);
        expect(actions).toEqual(expect.arrayContaining(['update', 'login_failed']));
        expect(all.body.data.items.some((r: { changes?: { city?: unknown[] } }) => r.changes?.city?.[1] === 'Elsewhere')).toBe(false);

        const failed = await get(superAdmin, '/api/audit?filter[action]=login_failed');
        expect(failed.body.data.items.every((r: { action: string }) => r.action === 'login_failed')).toBe(true);
        expect(failed.body.data.items[0].changes).toMatchObject({ identifier: 'nobody', reason: 'unknown_user' });

        const today = new Date().toISOString().slice(0, 10);
        expect((await get(superAdmin, `/api/audit?filter[from]=${today}&filter[to]=${today}`)).body.data.total).toBe(all.body.data.total);
        expect((await get(superAdmin, '/api/audit?filter[from]=2000-01-01&filter[to]=2000-01-02')).body.data.total).toBe(0);
        expect((await get(superAdmin, '/api/audit?filter[from]=yesterday')).status).toBe(400);
    });

    it('offers the actions, record types and people that appear in it', async () => {
        const res = await get(superAdmin, '/api/audit/facets');
        expect(res.body.data.actions.map((a: { value: string }) => a.value)).toEqual(expect.arrayContaining(['login_failed', 'update']));
        expect(res.body.data.entities.map((e: { value: string }) => e.value)).toEqual(expect.arrayContaining(['school_profile', 'user']));
        expect(res.body.data.users.map((u: { label: string }) => u.label)).toEqual(['Alpha School Admin']);
    });

    it('needs the audit permission', async () => {
        expect((await get(teacher, '/api/audit')).status).toBe(403);
        expect((await get(teacher, `/api/audit/history/school_profile/${alpha.tenant.id}`)).status).toBe(403);
    });

    it('removes records older than the retention period', async () => {
        await runAsTenant(alpha.tenant.id, () =>
            db.auditLog.create({ data: { tenantId: alpha.tenant.id, action: 'login', entity: 'user', at: new Date(Date.now() - 4 * 365 * 86_400_000) } })
        );
        const before = await runAsTenant(alpha.tenant.id, () => db.auditLog.count());
        expect(await purgeOldAuditRecords()).toBe(1);
        expect(await runAsTenant(alpha.tenant.id, () => db.auditLog.count())).toBe(before - 1);
    });
});
