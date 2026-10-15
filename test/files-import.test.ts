import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { app } from '../src/app';
import { db } from '../src/core/db';
import { runAsTenant } from '../src/core/context';
import { detectKind } from '../src/core/files';
import { localStorageAt, useStorageForTests } from '../src/core/files/storage';
import { buildWorkbook } from '../src/core/excel';
import { makeTenant, makeUser, resetDatabase, tokenFor } from './helpers';

const ORIGIN = 'https://alpha.test.in';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-files-'));
let alpha: Awaited<ReturnType<typeof makeTenant>>;
let superAdmin: string;
let schoolAdmin: string;
let teacher: string;

// A real 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const xlsx = async (header: string[], rows: (string | number | null)[][]) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Data');
    ws.addRow(header);
    for (const r of rows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
};
const readSheet = async (data: Buffer, name: string) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(data as unknown as ExcelJS.Buffer);
    const ws = wb.getWorksheet(name)!;
    const out: unknown[][] = [];
    ws.eachRow((row) => out.push((row.values as unknown[]).slice(1)));
    return out;
};
const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

beforeAll(async () => {
    useStorageForTests(localStorageAt(tmp));
    await resetDatabase();
    alpha = await makeTenant('alpha', 'Alpha School', 'alpha.test.in');
    superAdmin = tokenFor({ id: alpha.admin.id, tenantId: alpha.tenant.id });
    schoolAdmin = tokenFor(await makeUser(alpha.tenant.id, 'office.admin', 'school-admin'));
    teacher = tokenFor(await makeUser(alpha.tenant.id, 'teacher.one', 'teacher'));
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('file type checks', () => {
    it('trusts the bytes, not the name', async () => {
        expect(detectKind(PNG)).toBe('png');
        expect(detectKind(await buildWorkbook('x', [{ header: 'a', value: () => 1 }], [{}]))).toBe('xlsx');
        expect(detectKind(Buffer.from('<script>alert(1)</script>'))).toBeNull();
    });
});

describe('school logo', () => {
    it('uploads, shows publicly for the sign-in page, and can be removed', async () => {
        const up = await request(app).post('/api/school-profile/logo').set('Origin', ORIGIN).set('Authorization', superAdmin).attach('logo', PNG, 'crest.png');
        expect(up.status).toBe(200);
        expect(up.body.data.logoFileId).toBeTruthy();

        const branding = await request(app).get('/api/public/school').set('Origin', ORIGIN);
        expect(branding.body.data.logoUrl).toBe(`public/school/logo?school=alpha&v=${up.body.data.logoFileId}`);
        // An <img> request has no Origin; the school code in the URL is enough.
        expect((await request(app).get('/api/public/school/logo?school=alpha')).status).toBe(200);
        const img = await request(app).get('/api/public/school/logo').set('Origin', ORIGIN).buffer(true).parse(binary);
        expect(img.status).toBe(200);
        expect(img.headers['content-type']).toBe('image/png');
        expect(Buffer.compare(img.body as Buffer, PNG)).toBe(0);

        const removed = await request(app).delete('/api/school-profile/logo').set('Origin', ORIGIN).set('Authorization', superAdmin);
        expect(removed.body.data.logoFileId).toBeNull();
        expect((await request(app).get('/api/public/school/logo').set('Origin', ORIGIN)).status).toBe(404);
    });

    it('refuses files that are not images, whatever their name', async () => {
        const res = await request(app).post('/api/school-profile/logo').set('Origin', ORIGIN).set('Authorization', superAdmin).attach('logo', Buffer.from('not an image'), 'fake.png');
        expect(res.status).toBe(400);
        expect(res.body.error.message).toContain('not accepted');
    });

    it('needs permission to change', async () => {
        expect((await request(app).post('/api/school-profile/logo').set('Origin', ORIGIN).set('Authorization', teacher).attach('logo', PNG, 'x.png')).status).toBe(403);
    });
});

describe('importing users from Excel', () => {
    let jobId: string;

    it('gives a template with required columns, dropdowns and instructions', async () => {
        const res = await request(app).get('/api/imports/users/template').set('Origin', ORIGIN).set('Authorization', schoolAdmin).buffer(true).parse(binary);
        expect(res.status).toBe(200);
        expect(res.headers['content-disposition']).toContain('users-import-template.xlsx');
        const data = await readSheet(res.body as Buffer, 'Data');
        expect(data[0]).toEqual(['Name *', 'Type *', 'Email', 'Mobile', 'Username', 'Roles']);
        const help = await readSheet(res.body as Buffer, 'Instructions');
        expect(help.some((r) => r[0] === 'Type' && String(r[2]).includes('Staff'))).toBe(true);
        expect((await request(app).get('/api/imports/users/template').set('Origin', ORIGIN).set('Authorization', teacher)).status).toBe(403);
    });

    it('checks every row without saving, and explains each problem', async () => {
        const file = await xlsx(
            ['Name *', 'Type *', 'Email', 'Mobile', 'Username', 'Roles'],
            [
                ['Riya Sharma', 'Staff', 'riya@alpha.test.in', '9876500001', '', 'Teacher, Class Teacher'],
                ['Aman Verma', 'staff', '', '', 'aman.v', ''],
                ['', 'Staff', '', '', '', ''],
                ['Bad Email', 'Staff', 'not-an-email', '', '', ''],
                ['Same Email', 'Staff', 'RIYA@alpha.test.in', '', '', ''],
                ['Taken Name', 'Staff', '', '', 'teacher.one', ''],
                ['Wants Power', 'Administrator', '', '', '', 'Super Admin'],
                ['Bad Role', 'Staff', '', '', '', 'Wizard'],
            ]
        );
        const res = await request(app).post('/api/imports/users/check').set('Origin', ORIGIN).set('Authorization', schoolAdmin).attach('file', file, 'staff.xlsx');
        expect(res.status).toBe(200);
        expect(res.body.data.job).toMatchObject({ status: 'validated', totalRows: 8, validRows: 2 });
        const byRow = Object.fromEntries(res.body.data.rows.map((r: { row: number; issues: { field: string; message: string }[] }) => [r.row, r.issues.map((i) => `${i.field}: ${i.message}`)]));
        expect(byRow[2]).toEqual([]);
        expect(byRow[3]).toEqual([]);
        expect(byRow[4]).toEqual(['Name: is required']);
        expect(byRow[5]).toEqual(['Email: is not a valid email']);
        expect(byRow[6]).toEqual(['Email: is the same as row 2']);
        expect(byRow[7]).toEqual(['Username: is taken']);
        expect(byRow[8]).toEqual(['Roles: only a Super Admin can give the Super Admin role']);
        expect(byRow[9][0]).toContain('"Wizard" is not one of');
        expect(await runAsTenant(alpha.tenant.id, () => db.user.count())).toBe(3);
        jobId = res.body.data.job.id;
    });

    it('imports only the good rows and returns their one-time passwords', async () => {
        const res = await request(app).post(`/api/imports/jobs/${jobId}/run`).set('Origin', ORIGIN).set('Authorization', schoolAdmin);
        expect(res.status).toBe(200);
        expect(res.body.data.job).toMatchObject({ status: 'done', importedRows: 2, problemCount: 6 });
        expect(res.body.data.results.map((r: { values: Record<string, string> }) => r.values.Username)).toEqual(['riya.sharma', 'aman.v']);
        expect(res.body.data.results[0].values['One-time password']).toMatch(/^[a-z]{4}-\d{4}-[a-z]{4}$/);
        const riya = await runAsTenant(alpha.tenant.id, () => db.user.findFirstOrThrow({ where: { username: 'riya.sharma' }, include: { roles: { include: { role: true } } } }));
        expect(riya.roles.map((r) => r.role.slug).sort()).toEqual(['class-teacher', 'teacher']);
        const aman = await runAsTenant(alpha.tenant.id, () => db.user.findFirstOrThrow({ where: { username: 'aman.v' }, include: { roles: { include: { role: true } } } }));
        expect(aman.roles.map((r) => r.role.slug)).toEqual(['teacher']); // default role for staff

        expect((await request(app).post(`/api/imports/jobs/${jobId}/run`).set('Origin', ORIGIN).set('Authorization', schoolAdmin)).status).toBe(409);
        const report = await request(app).get(`/api/imports/jobs/${jobId}/problems`).set('Origin', ORIGIN).set('Authorization', schoolAdmin).buffer(true).parse(binary);
        const rows = await readSheet(report.body as Buffer, 'Problems');
        expect(rows[0]).toEqual(['Row', 'Column', 'Problem']);
        expect(rows).toHaveLength(7);
    });

    it('refuses a file without the required columns, or that is not Excel', async () => {
        const wrong = await xlsx(['Full name', 'Email'], [['X Y', 'x@y.in']]);
        const res = await request(app).post('/api/imports/users/check').set('Origin', ORIGIN).set('Authorization', schoolAdmin).attach('file', wrong, 'wrong.xlsx');
        expect(res.body.data.job.status).toBe('failed');
        expect(res.body.data.problems[0]).toContain('Required columns are missing: Name, Type');
        const notExcel = await request(app).post('/api/imports/users/check').set('Origin', ORIGIN).set('Authorization', schoolAdmin).attach('file', Buffer.from('a,b\n1,2'), 'list.csv');
        expect(notExcel.status).toBe(400);
    });

    it('lists recent imports', async () => {
        const res = await request(app).get('/api/imports/jobs?kind=users').set('Origin', ORIGIN).set('Authorization', schoolAdmin);
        expect(res.body.data.map((j: { status: string }) => j.status)).toEqual(['failed', 'done']);
    });
});

describe('exporting users', () => {
    it('exports the filtered list as Excel', async () => {
        const res = await request(app).get('/api/users/export?filter[kind]=staff&sort=username').set('Origin', ORIGIN).set('Authorization', schoolAdmin).buffer(true).parse(binary);
        expect(res.status).toBe(200);
        const rows = await readSheet(res.body as Buffer, 'Users');
        expect(rows[0].slice(0, 3)).toEqual(['Name', 'Username', 'Type']);
        expect(rows.slice(1).map((r) => r[1])).toEqual(['aman.v', 'office.admin', 'riya.sharma', 'teacher.one']);
    });
});
