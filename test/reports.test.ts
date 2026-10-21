import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { closePdfBrowser } from '../src/core/pdf';
import { jasperHealth } from '../src/core/jasper';
import { makeTenant, makeUser, resetDatabase, tokenFor } from './helpers';

// Run with JASPER_TEST_URL=http://127.0.0.1:8090 (and `npm run jasper`) to test the Jasper engine too.

const ORIGIN = 'https://alpha.test.in';
let alpha: Awaited<ReturnType<typeof makeTenant>>;
let admin: string;
let jasper = false;

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
const REGISTER = '/api/reports/fee_collection_register';
const PERIOD = 'from=2026-04-01&to=2026-10-21';

beforeAll(async () => {
    await resetDatabase();
    alpha = await makeTenant('alpha', 'Alpha School', 'alpha.test.in');
    admin = tokenFor({ id: alpha.admin.id, tenantId: alpha.tenant.id });
    jasper = (await jasperHealth()).running;
}, 240_000);
afterAll(() => closePdfBrowser());

describe('report center', () => {
    it('lists the reports a person may run, with their filters and defaults', async () => {
        const list = (await as(admin).get('/api/reports')).body.data;
        expect(list.canDesign).toBe(true);
        expect(list.reports.map((r: { key: string }) => r.key)).toEqual(expect.arrayContaining(['fee_collection_register', 'fee_defaulters', 'fee_class_summary', 'enquiry_register']));
        const r = (await as(admin).get(REGISTER)).body.data;
        expect(r.filters.find((f: { key: string }) => f.key === 'to').value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(r.filters.find((f: { key: string }) => f.key === 'groupBy').value).toBe('date');
    });

    it('runs a report on screen and checks its filters', async () => {
        const run = await as(admin).get(`${REGISTER}/run?${PERIOD}`);
        expect(run.status).toBe(200);
        expect(run.body.data).toMatchObject({ rows: [], count: 0, totals: { amount: 0 }, groupedBy: 'Day' });
        expect((await as(admin).get(`${REGISTER}/run?from=2026-10-21&to=2026-04-01`)).status).toBe(400);
        expect((await as(admin).get(`${REGISTER}/run?${PERIOD}&groupBy=nonsense`)).status).toBe(400);
    });

    it('makes PDF and Excel files (built-in layout when Jasper is not there), and Word only with Jasper', async () => {
        const pdf = await as(admin).file(`${REGISTER}/file?${PERIOD}&format=pdf`);
        expect(pdf.status).toBe(200);
        expect(pdf.headers['content-type']).toBe('application/pdf');
        expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
        const xlsx = await as(admin).file(`${REGISTER}/file?${PERIOD}&format=xlsx`);
        expect(xlsx.status).toBe(200);
        expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
        const engine = decodeURIComponent(pdf.headers['x-report-engine']);
        if (jasper) expect(engine).toBe('Jasper · built-in design');
        else {
            expect(engine).toBe('Built-in table layout');
            expect(decodeURIComponent(pdf.headers['x-report-note'])).toMatch(/not running/);
            expect((await as(admin).file(`${REGISTER}/file?${PERIOD}&format=docx`)).status).toBe(400);
        }
        // A report without a Jasper design: always the table layout.
        const summary = await as(admin).file('/api/reports/fee_head_collection/file?from=2026-04-01&to=2026-10-21&format=pdf');
        expect(summary.status).toBe(200);
        expect(decodeURIComponent(summary.headers['x-report-engine'])).toBe('Built-in table layout');
    }, 120_000);

    it('keeps the school’s Jasper designs as versions: check, use, go back, delete', async () => {
        const d = (await as(admin).get(`${REGISTER}/designs`)).body.data;
        expect(d).toMatchObject({ engine: 'auto', hasBuiltInDesign: true, versions: [] });
        expect(d.fields.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(['amount', 'groupLabel']));
        const builtIn = fs.readFileSync(path.join(__dirname, '..', 'reports', 'jasper', 'fee-collection-register.jrxml'), 'utf8');
        expect((await as(admin).get(`${REGISTER}/designs/builtin/download`)).text).toBe(builtIn);
        expect((await as(admin).xml(`${REGISTER}/designs?fileName=x.jrxml`, '<html>not a design</html>')).status).toBe(400);
        if (!jasper) {
            // Designs are checked by the report service: without it, uploads are refused.
            const r = await as(admin).xml(`${REGISTER}/designs?fileName=mine.jrxml`, builtIn);
            expect(r.status).toBe(400);
            expect(r.body.error.message).toMatch(/Start the report service/);
            return;
        }
        const unknown = await as(admin).xml(`${REGISTER}/designs?fileName=bad.jrxml`, builtIn.replace('<field name="mode" class="java.lang.String"/>', '<field name="mode" class="java.lang.String"/><field name="secret" class="java.lang.String"/>'));
        expect(unknown.status).toBe(400);
        expect(unknown.body.error.message).toMatch(/secret/);
        const broken = await as(admin).xml(`${REGISTER}/designs?fileName=broken.jrxml`, builtIn.replace('$F{receiptNo}]]></expression>', '$F{receiptNo}.nope()]]></expression>'));
        expect(broken.status).toBe(400);
        const up = await as(admin).xml(`${REGISTER}/designs?fileName=mine.jrxml&note=Our%20format`, builtIn.replace('Grand total', 'Total collected'));
        expect(up.status).toBe(201);
        expect(up.body.data.version).toBe(1);
        const used = (await as(admin).post(`${REGISTER}/designs/${up.body.data.id}/activate`)).body.data;
        expect(used.versions[0]).toMatchObject({ version: 1, isActive: true, note: 'Our format', fileName: 'mine.jrxml' });
        const pdf = await as(admin).file(`${REGISTER}/file?${PERIOD}&format=pdf`);
        expect(decodeURIComponent(pdf.headers['x-report-engine'])).toBe('Jasper · the school’s version 1');
        expect((await as(admin).file(`${REGISTER}/file?${PERIOD}&format=docx`)).status).toBe(200);
        expect((await as(admin).delete(`${REGISTER}/designs/${up.body.data.id}`)).status).toBe(400);
        await as(admin).post(`${REGISTER}/designs/reset`);
        expect((await as(admin).delete(`${REGISTER}/designs/${up.body.data.id}`)).body.data.versions).toEqual([]);
        // The built-in table layout when the school chooses it.
        await as(admin).put(`${REGISTER}/engine`, { engine: 'builtin' });
        expect(decodeURIComponent((await as(admin).file(`${REGISTER}/file?${PERIOD}&format=pdf`)).headers['x-report-engine'])).toBe('Built-in table layout');
        await as(admin).put(`${REGISTER}/engine`, { engine: 'auto' });
    }, 120_000);

    it('lets each person run only their reports, and only super admins change designs', async () => {
        const accountant = tokenFor(await makeUser(alpha.tenant.id, 'acct1', 'accountant'));
        const list = (await as(accountant).get('/api/reports')).body.data;
        expect(list.canDesign).toBe(false);
        const keys = list.reports.map((r: { key: string }) => r.key);
        expect(keys).toContain('fee_collection_register');
        expect(keys).not.toContain('enquiry_register');
        expect((await as(accountant).get('/api/reports/enquiry_register/run')).status).toBe(403);
        expect((await as(accountant).get(`${REGISTER}/designs`)).status).toBe(403);
        const teacher = tokenFor(await makeUser(alpha.tenant.id, 'teach1', 'teacher'));
        expect((await as(teacher).get('/api/reports')).status).toBe(403);
    });
});
