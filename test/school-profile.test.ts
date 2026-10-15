import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { makeTenant, makeUser, resetDatabase, suspendTenant, tokenFor } from './helpers';

let alphaAdmin: string;
let alphaTeacher: string;
let betaAdmin: string;
let betaTenantId: string;

beforeAll(async () => {
    await resetDatabase();
    const a = await makeTenant('alpha', 'Alpha School', 'alpha.test.in');
    const b = await makeTenant('beta', 'Beta School', 'beta.test.in');
    betaTenantId = b.tenant.id;
    alphaAdmin = tokenFor({ id: a.admin.id, tenantId: a.tenant.id });
    betaAdmin = tokenFor({ id: b.admin.id, tenantId: b.tenant.id });
    const teacher = await makeUser(a.tenant.id, 'teacher.one', 'teacher');
    alphaTeacher = tokenFor(teacher);
});

describe('GET /api/school-profile', () => {
    it('needs a sign-in', async () => {
        expect((await request(app).get('/api/school-profile')).status).toBe(401);
    });

    it("returns the signed-in user's own school", async () => {
        const res = await request(app).get('/api/school-profile').set('Authorization', alphaAdmin);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ legalName: 'Alpha School', tenant: { code: 'alpha' } });

        const beta = await request(app).get('/api/school-profile').set('Authorization', betaAdmin);
        expect(beta.body.data).toMatchObject({ legalName: 'Beta School', tenant: { code: 'beta' } });
    });

    it('any signed-in user may read it', async () => {
        expect((await request(app).get('/api/school-profile').set('Authorization', alphaTeacher)).status).toBe(200);
    });

    it("rejects a token used from another school's address", async () => {
        const res = await request(app).get('/api/school-profile').set('Authorization', betaAdmin).set('Origin', 'https://alpha.test.in');
        expect(res.status).toBe(401);
        expect(res.body.error.message).toBe('This sign-in belongs to another school');
    });
});

describe('PATCH /api/school-profile', () => {
    it('Super Admin can update; text is cleaned up', async () => {
        const res = await request(app)
            .patch('/api/school-profile')
            .set('Authorization', alphaAdmin)
            .send({ shortName: 'Alpha', email: 'Office@Alpha.Test.in', city: 'Dehradun', board: '', academicYearStartMonth: 4, establishedYear: 1998 });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ shortName: 'Alpha', email: 'office@alpha.test.in', city: 'Dehradun', board: null, establishedYear: 1998 });
    });

    it('an empty string clears an optional field', async () => {
        const res = await request(app).patch('/api/school-profile').set('Authorization', alphaAdmin).send({ city: '' });
        expect(res.body.data.city).toBeNull();
    });

    it('a teacher without the permission is refused', async () => {
        const res = await request(app).patch('/api/school-profile').set('Authorization', alphaTeacher).send({ shortName: 'X' });
        expect(res.status).toBe(403);
    });

    it('lists every bad field', async () => {
        const res = await request(app)
            .patch('/api/school-profile')
            .set('Authorization', alphaAdmin)
            .send({ email: 'nope', timeZone: 'Mars/Base', academicYearStartMonth: 13, currency: 'rupees' });
        expect(res.status).toBe(400);
        const fields = res.body.error.details.map((d: { field: string }) => d.field);
        expect(fields).toEqual(expect.arrayContaining(['email', 'timeZone', 'academicYearStartMonth', 'currency']));
    });

    it('rejects unknown fields such as tenantId', async () => {
        const res = await request(app).patch('/api/school-profile').set('Authorization', alphaAdmin).send({ tenantId: betaTenantId, city: 'X' });
        expect(res.status).toBe(400);
    });

    it('refuses an empty update', async () => {
        const res = await request(app).patch('/api/school-profile').set('Authorization', alphaAdmin).send({});
        expect(res.status).toBe(400);
        expect(res.body.error.message).toContain('Nothing to update');
    });

    it('refuses to overwrite a newer change (409)', async () => {
        const current = await request(app).get('/api/school-profile').set('Authorization', alphaAdmin);
        const loadedAt = current.body.data.updatedAt;
        await request(app).patch('/api/school-profile').set('Authorization', alphaAdmin).send({ phone: '+91 135 2700000', updatedAt: loadedAt });
        const stale = await request(app).patch('/api/school-profile').set('Authorization', alphaAdmin).send({ phone: '0000000', updatedAt: loadedAt });
        expect(stale.status).toBe(409);
        expect(stale.body.error.code).toBe('CONFLICT');
    });

    it("one school's edits never reach another", async () => {
        const beta = await request(app).get('/api/school-profile').set('Authorization', betaAdmin);
        expect(beta.body.data).toMatchObject({ shortName: null, phone: null, establishedYear: null });
    });
});

describe('GET /api/public/school (sign-in page branding)', () => {
    it("shows the school matching the page's address", async () => {
        const res = await request(app).get('/api/public/school').set('Origin', 'https://alpha.test.in');
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
            code: 'alpha',
            name: 'Alpha',
            legalName: 'Alpha School',
            logoUrl: null,
            dateFormat: 'DD-MM-YYYY',
            timeZone: 'Asia/Kolkata',
            login: { backgroundUrl: null, backgroundFocus: 'center', overlay: 60, quote: null, quoteAuthor: null },
        });
    });

    it('is 404 when no school matches and no default is set', async () => {
        expect((await request(app).get('/api/public/school').set('Origin', 'https://unknown.example')).status).toBe(404);
    });
});

describe('suspended school', () => {
    it("blocks the school's users", async () => {
        await suspendTenant(betaTenantId);
        const res = await request(app).get('/api/school-profile').set('Authorization', betaAdmin);
        expect(res.status).toBe(403);
        expect(res.body.error.message).toBe('This school account is suspended');
        expect((await request(app).get('/api/public/school').set('Origin', 'https://beta.test.in')).status).toBe(404);
    });
});
