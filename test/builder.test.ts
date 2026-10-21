import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { db } from '../src/core/db';
import { runAsTenant } from '../src/core/context';
import { closePdfBrowser } from '../src/core/pdf';
import { jasperHealth } from '../src/core/jasper';
import { makeStaff, makeTenant, makeUser, resetDatabase, tokenFor } from './helpers';

const ORIGIN = 'https://alpha.test.in';
let alpha: Awaited<ReturnType<typeof makeTenant>>;
let admin: string;

const binary = (req: request.Test) =>
    req.buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
const as = (token: string) => ({
    get: (p: string) => request(app).get(p).set('Origin', ORIGIN).set('Authorization', token),
    file: (p: string) => binary(request(app).get(p).set('Origin', ORIGIN).set('Authorization', token)),
    post: (p: string, body: object = {}) => request(app).post(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    xml: (p: string, xml: string) => request(app).post(p).set('Origin', ORIGIN).set('Authorization', token).set('Content-Type', 'application/xml').send(xml),
    put: (p: string, body: object) => request(app).put(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    delete: (p: string) => request(app).delete(p).set('Origin', ORIGIN).set('Authorization', token),
});

/** Staff whose name has "a" in it, asked again at run time, by joining date (with Aadhaar, a sensitive column). */
const staffReport = {
    source: 'staff',
    columns: [{ field: 'employeeCode' }, { field: 'name', label: 'Teacher' }, { field: 'joiningDate' }, { field: 'yearsOfService' }, { field: 'aadhaar' }],
    filters: [
        { field: 'name', op: 'contains', value: 'a', ask: true },
        { field: 'status', op: 'eq', value: 'Working' },
    ],
    sort: [{ field: 'name', dir: 'desc' }],
    totals: ['yearsOfService'],
};

beforeAll(async () => {
    await resetDatabase();
    alpha = await makeTenant('alpha', 'Alpha School', 'alpha.test.in');
    admin = tokenFor({ id: alpha.admin.id, tenantId: alpha.tenant.id });
    for (const n of ['Asha', 'Ravi', 'Meena', 'Kiran']) await makeStaff(alpha.tenant.id, n);
    await runAsTenant(alpha.tenant.id, () => db.staff.updateMany({ where: { firstName: 'Asha' }, data: { aadhaar: '123412341234' } }));
}, 240_000);
afterAll(() => closePdfBrowser());

describe('report builder', () => {
    it('lists the data sources with their fields and conditions', async () => {
        const sources = (await as(admin).get('/api/reports/builder/sources')).body.data as { key: string; fields: { key: string; ops: string[] }[] }[];
        expect(sources.map((s) => s.key)).toEqual(expect.arrayContaining(['students', 'staff', 'fee_dues', 'fee_receipts', 'enquiries', 'timetable_load']));
        const staff = sources.find((s) => s.key === 'staff')!;
        expect(staff.fields.find((f) => f.key === 'name')!.ops).toContain('contains');
        expect(staff.fields.find((f) => f.key === 'aadhaar')!.ops).toEqual([]); // shown, never filtered on
    });

    it('previews a definition and refuses mistakes', async () => {
        const r = await as(admin).post('/api/reports/builder/preview', { definition: staffReport });
        expect(r.status).toBe(200);
        expect(r.body.data.rows.map((x: { name: string }) => x.name)).toEqual(['Ravi', 'Meena', 'Kiran', 'Asha']);
        expect(r.body.data.columns.find((c: { key: string }) => c.key === 'name').label).toBe('Teacher');
        expect(r.body.data.totals.yearsOfService).toBeGreaterThan(0);
        expect(r.body.data.asks.map((a: { key: string }) => a.key)).toEqual(['q0']);
        const bad = (d: object) => as(admin).post('/api/reports/builder/preview', { definition: { ...staffReport, ...d } });
        expect((await bad({ columns: [{ field: 'nope' }] })).status).toBe(400);
        expect((await bad({ filters: [{ field: 'aadhaar', op: 'eq', value: '1' }] })).status).toBe(400);
        expect((await bad({ filters: [{ field: 'joiningDate', op: 'contains', value: 'x' }] })).status).toBe(400);
        expect((await bad({ totals: ['name'] })).status).toBe(400);
        expect((await bad({ filters: [{ field: 'yearsOfService', op: 'gt', value: 'many' }] })).status).toBe(400);
    });

    it('saves a report that runs in the Report Center, asks its filters and groups', async () => {
        const saved = await as(admin).post('/api/reports/builder/reports', { name: 'Staff with A', category: 'Staff', definition: { ...staffReport, groupBy: 'status' } });
        expect(saved.status).toBe(201);
        const key = saved.body.data.key as string;
        const list = (await as(admin).get('/api/reports')).body.data;
        expect(list.reports.find((r: { key: string }) => r.key === key)).toMatchObject({ label: 'Staff with A', category: 'Staff', custom: true });
        const info = (await as(admin).get(`/api/reports/${key}`)).body.data;
        expect(info.filters.map((f: { key: string }) => f.key)).toEqual(['q0']);
        expect(info.customId).toBe(saved.body.data.id);
        const run = (await as(admin).get(`/api/reports/${key}/run?q0=ee`)).body.data;
        expect(run.rows.map((x: { name: string }) => x.name)).toEqual(['Meena']);
        expect(run).toMatchObject({ groupedBy: 'Status', count: 1 });
        expect(run.rows[0].groupLabel).toBe('Working');
        const blank = (await as(admin).get(`/api/reports/${key}/run?q0=`)).body.data; // the saved "a" is the default
        expect(blank.count).toBe(4);
        const pdf = await as(admin).file(`/api/reports/${key}/file?format=pdf`);
        expect(pdf.status).toBe(200);
        expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
        const design = await as(admin).get(`/api/reports/${key}/designs/generated/download`);
        expect(design.status).toBe(200);
        expect(design.text).toContain('<field name="yearsOfService" class="java.math.BigDecimal">');
        expect(design.text).toContain('$V{total_yearsOfService}');
        // With the report service (JASPER_TEST_URL): the made design compiles, and can be uploaded and used.
        if ((await jasperHealth()).running) {
            const up = await as(admin).xml(`/api/reports/${key}/designs?fileName=generated.jrxml`, design.text);
            expect(up.status).toBe(201);
            await as(admin).post(`/api/reports/${key}/designs/${up.body.data.id}/activate`);
            const j = await as(admin).file(`/api/reports/${key}/file?format=pdf`);
            expect(decodeURIComponent(j.headers['x-report-engine'])).toBe('Jasper · the school’s version 1');
        }
    }, 120_000);

    it('shares a report with roles; sensitive columns stay with those allowed', async () => {
        const roles = (await as(admin).get('/api/reports/builder/roles')).body.data as { id: string; name: string }[];
        const office = await runAsTenant(alpha.tenant.id, () => db.role.findFirstOrThrow({ where: { slug: 'office-staff' } }));
        expect(roles.map((r) => r.id)).toContain(office.id);
        const saved = (await as(admin).post('/api/reports/builder/reports', { name: 'Staff list', definition: staffReport })).body.data;
        const clerk = tokenFor(await makeUser(alpha.tenant.id, 'clerk1', 'office-staff'));
        expect((await as(clerk).get(`/api/reports/${saved.key}/run`)).status).toBe(403);
        expect((await as(clerk).get('/api/reports')).body.data.reports.map((r: { key: string }) => r.key)).not.toContain(saved.key);
        await as(admin).put(`/api/reports/builder/reports/${saved.id}`, { name: 'Staff list', roleIds: [office.id], definition: staffReport });
        const run = await as(clerk).get(`/api/reports/${saved.key}/run`);
        expect(run.status).toBe(200);
        expect(run.body.data.columns.map((c: { key: string }) => c.key)).not.toContain('aadhaar');
        expect(run.body.data.rows[0]).not.toHaveProperty('aadhaar');
        const mine = (await as(admin).get(`/api/reports/${saved.key}/run`)).body.data;
        expect(mine.rows.find((x: { name: string }) => x.name === 'Asha').aadhaar).toBe('123412341234');
        // The clerk can run it but not change or build reports.
        expect((await as(clerk).put(`/api/reports/builder/reports/${saved.id}`, { name: 'x', definition: staffReport })).status).toBe(403);
        expect((await as(clerk).get('/api/reports/builder/sources')).status).toBe(403);
        // Shared with a role that can't see staff: still not visible.
        const accountant = await runAsTenant(alpha.tenant.id, () => db.role.findFirstOrThrow({ where: { slug: 'accountant' } }));
        await as(admin).put(`/api/reports/builder/reports/${saved.id}`, { name: 'Staff list', roleIds: [office.id, accountant.id], definition: staffReport });
        const acct = tokenFor(await makeUser(alpha.tenant.id, 'acct1', 'accountant'));
        expect((await as(acct).get(`/api/reports/${saved.key}/run`)).status).toBe(403);
        expect((await as(admin).delete(`/api/reports/builder/reports/${saved.id}`)).status).toBe(200);
        expect((await as(admin).get(`/api/reports/${saved.key}/run`)).status).toBe(404);
    }, 120_000);
});
