import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { closePdfBrowser } from '../src/core/pdf';
import { makeTenant, makeUser, resetDatabase, tokenFor } from './helpers';

const ORIGIN = 'https://alpha.test.in';
let alpha: Awaited<ReturnType<typeof makeTenant>>;
let admin: string;

const as = (token: string) => ({
    get: (p: string) => request(app).get(p).set('Origin', ORIGIN).set('Authorization', token),
    post: (p: string, body: object = {}) => request(app).post(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    put: (p: string, body: object) => request(app).put(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    delete: (p: string) => request(app).delete(p).set('Origin', ORIGIN).set('Authorization', token),
});
const pdfBody = (r: request.Response) => Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.text ?? '', 'binary');

beforeAll(async () => {
    await resetDatabase();
    alpha = await makeTenant('alpha', 'Alpha School', 'alpha.test.in');
    admin = tokenFor({ id: alpha.admin.id, tenantId: alpha.tenant.id });
}, 240_000);
afterAll(() => closePdfBrowser());

describe('document templates', () => {
    it('lists the documents and previews a template as a PDF', async () => {
        const list = (await as(admin).get('/api/documents')).body.data as { key: string; custom: boolean }[];
        expect(list.map((d) => d.key)).toEqual(expect.arrayContaining(['fee_receipt', 'fee_due_slip']));
        const r = await as(admin).post('/api/documents/fee_receipt/preview').buffer(true).parse((res, cb) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toBe('application/pdf');
        expect(pdfBody(r).subarray(0, 4).toString()).toBe('%PDF');
    }, 120_000);

    it('refuses a template with a mistake, saves the school’s own, and goes back to the built-in one', async () => {
        const t = (await as(admin).get('/api/documents/fee_due_slip/template')).body.data;
        expect(t.custom).toBe(false);
        expect(t.fields.length).toBeGreaterThan(5);
        const bad = await as(admin).put('/api/documents/fee_due_slip/template', { html: '{{#each instalments}}<p>', css: '', paper: t.paper });
        expect(bad.status).toBe(400);
        const saved = await as(admin).put('/api/documents/fee_due_slip/template', { html: '<h1>Pay {{rupees totals.balance}} please</h1>', css: 'h1{color:red}', paper: { ...t.paper, size: 'A4' } });
        expect(saved.body.data).toMatchObject({ custom: true, paper: { size: 'A4' } });
        const reset = await as(admin).delete('/api/documents/fee_due_slip/template');
        expect(reset.body.data.custom).toBe(false);
    });

    it('only document managers change templates', async () => {
        const teacher = await makeUser(alpha.tenant.id, 'teach1', 'teacher');
        expect((await as(tokenFor(teacher)).get('/api/documents')).status).toBe(403);
    });
});
