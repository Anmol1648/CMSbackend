import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { app } from '../src/app';
import { db } from '../src/core/db';
import { runAsTenant } from '../src/core/context';
import { localStorageAt, useStorageForTests } from '../src/core/files/storage';
import { registerMasterUsage } from '../src/modules/masters/masters.registry';
import { seedMasters } from '../src/modules/masters/masters.service';
import { makeTenant, makeUser, resetDatabase, tokenFor } from './helpers';

const ORIGIN = 'https://alpha.test.in';
const BETA = 'https://beta.test.in';
let alpha: Awaited<ReturnType<typeof makeTenant>>;
let superAdmin: string;
let office: string;
let teacher: string;
let betaAdmin: string;

const as = (token: string, origin = ORIGIN) => ({
    get: (p: string) => request(app).get(p).set('Origin', origin).set('Authorization', token),
    post: (p: string, body: object = {}) => request(app).post(p).set('Origin', origin).set('Authorization', token).send(body),
    patch: (p: string, body: object) => request(app).patch(p).set('Origin', origin).set('Authorization', token).send(body),
    del: (p: string) => request(app).delete(p).set('Origin', origin).set('Authorization', token),
});

const optionsOf = async (key: string, query = '') => (await as(teacher).get(`/api/masters/${key}/options${query}`)).body.data as { id: string; name: string; code: string | null; isActive: boolean }[];
const idOf = async (key: string, name: string, query = '') => (await optionsOf(key, query)).find((o) => o.name === name)!.id;

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

beforeAll(async () => {
    useStorageForTests(localStorageAt(fs.mkdtempSync(path.join(os.tmpdir(), 'cms-masters-'))));
    await resetDatabase();
    alpha = await makeTenant('alpha', 'Alpha School', 'alpha.test.in', { starterData: true });
    superAdmin = tokenFor({ id: alpha.admin.id, tenantId: alpha.tenant.id });
    office = tokenFor(await makeUser(alpha.tenant.id, 'office.one', 'office-staff'));
    teacher = tokenFor(await makeUser(alpha.tenant.id, 'teacher.one', 'teacher'));
    const beta = await makeTenant('beta', 'Beta School', 'beta.test.in');
    betaAdmin = tokenFor({ id: beta.admin.id, tenantId: beta.tenant.id });
}, 180_000);

describe('starter lists', () => {
    it('gives a new school every state, district and its own towns', async () => {
        const catalogue = (await as(superAdmin).get('/api/masters')).body.data as { key: string; masters: { key: string; total: number }[] }[];
        expect(catalogue.map((g) => g.key)).toEqual(['academic', 'location', 'personal', 'family', 'finance']);
        const total = (key: string) => catalogue.flatMap((g) => g.masters).find((m) => m.key === key)!.total;
        expect(total('state')).toBe(36);
        expect(total('district')).toBe(786);
        expect(total('gender')).toBe(3);

        const uk = await idOf('state', 'Uttarakhand');
        expect((await optionsOf('district', `?parent=${uk}`)).length).toBe(13);
        const chamoli = await idOf('district', 'Chamoli', `?parent=${uk}`);
        expect((await optionsOf('city', `?parent=${chamoli}`)).map((c) => c.name)).toContain('Joshimath (Jyotirmath)');
        expect((await optionsOf('blood_group')).map((b) => b.name)).toEqual(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']);
    });

    it('never adds starter options again to a list the school has', async () => {
        expect(await runAsTenant(alpha.tenant.id, seedMasters)).toEqual({});
    });
});

describe('changing a list', () => {
    it('adds options, refusing duplicates (any case) but allowing the same town name in another district', async () => {
        const uk = await idOf('state', 'Uttarakhand');
        const chamoli = await idOf('district', 'Chamoli', `?parent=${uk}`);
        const almora = await idOf('district', 'Almora', `?parent=${uk}`);
        const added = await as(superAdmin).post('/api/masters/city/values', { name: '  Auli  ', parentId: chamoli });
        expect(added.status).toBe(201);
        expect(added.body.data).toMatchObject({ name: 'Auli', ancestors: [{ name: 'India' }, { name: 'Uttarakhand' }, { name: 'Chamoli' }] });
        expect((await as(superAdmin).post('/api/masters/city/values', { name: 'AULI', parentId: chamoli })).status).toBe(409);
        expect((await as(superAdmin).post('/api/masters/city/values', { name: 'Auli', parentId: almora })).status).toBe(201);
    });

    it('checks the parent, codes and extra fields', async () => {
        const uk = await idOf('state', 'Uttarakhand');
        const noParent = await as(superAdmin).post('/api/masters/city/values', { name: 'Nowhere' });
        expect(noParent.body.error.details).toEqual([{ field: 'parentId', message: 'choose the district' }]);
        const wrongList = await as(superAdmin).post('/api/masters/city/values', { name: 'Nowhere', parentId: uk });
        expect(wrongList.body.error.details).toEqual([{ field: 'parentId', message: 'is not a district' }]);
        expect((await as(superAdmin).post('/api/masters/state/values', { name: 'Utopia', code: 'uk', parentId: await idOf('country', 'India') })).status).toBe(409);

        const badIfsc = await as(superAdmin).post('/api/masters/bank/values', { name: 'Test Bank', extra: { ifscPrefix: 'TB1' } });
        expect(badIfsc.body.error.details[0]).toMatchObject({ field: 'extra.ifscPrefix' });
        const bank = await as(superAdmin).post('/api/masters/bank/values', { name: 'Test Bank', extra: { ifscPrefix: 'tbnk' } });
        expect(bank.body.data.extra).toEqual({ ifscPrefix: 'TBNK' });
    });

    it('edits with history, and an inactive option drops out of dropdowns', async () => {
        const id = await idOf('religion', 'Parsi');
        const saved = await as(superAdmin).patch(`/api/masters/religion/values/${id}`, { name: 'Parsi (Zoroastrian)', isActive: false });
        expect(saved.status).toBe(200);
        const history = await runAsTenant(alpha.tenant.id, () => db.auditLog.findFirst({ where: { entity: 'master_value', entityId: id, action: 'update' } }));
        expect(history?.changes).toMatchObject({ name: ['Parsi', 'Parsi (Zoroastrian)'], isActive: [true, false] });
        expect((await optionsOf('religion')).map((r) => r.name)).not.toContain('Parsi (Zoroastrian)');
        // A record that already has it still gets it.
        expect((await optionsOf('religion', `?include=${id}`)).map((r) => r.name)).toContain('Parsi (Zoroastrian)');
    });

    it('reorders lists sorted by hand', async () => {
        const id = await idOf('blood_group', 'O+');
        await as(superAdmin).post(`/api/masters/blood_group/values/${id}/move`, { direction: 'up' });
        await as(superAdmin).post(`/api/masters/blood_group/values/${id}/move`, { direction: 'up' });
        expect((await optionsOf('blood_group')).map((b) => b.name)).toEqual(['A+', 'A-', 'B+', 'B-', 'O+', 'AB+', 'AB-', 'O-']);
        expect((await as(superAdmin).post(`/api/masters/state/values/${await idOf('state', 'Goa')}/move`, { direction: 'up' })).status).toBe(400);
    });

    it("doesn't delete what is used: options under it, or records that chose it", async () => {
        const uk = await idOf('state', 'Uttarakhand');
        const hasDistricts = await as(superAdmin).del(`/api/masters/state/values/${uk}`);
        expect(hasDistricts.status).toBe(409);
        expect(hasDistricts.body.error.message).toContain('13 districts');

        const sikhId = await idOf('religion', 'Sikh');
        registerMasterUsage('religion', { label: 'students', count: async (ids) => (ids.includes(sikhId) ? 4 : 0) });
        expect((await as(superAdmin).del(`/api/masters/religion/values/${sikhId}`)).body.error.message).toContain('used by 4 students');

        const jain = await idOf('religion', 'Jain');
        expect((await as(superAdmin).del(`/api/masters/religion/values/${jain}`)).status).toBe(200);
        expect((await optionsOf('religion')).map((r) => r.name)).not.toContain('Jain');
    });
});

describe('who may do what', () => {
    it('everyone signed in gets dropdown options; the screen and changes need permissions', async () => {
        expect((await as(teacher).get('/api/masters/gender/options')).status).toBe(200);
        expect((await as(teacher).get('/api/masters')).status).toBe(403);
        expect((await as(office).get('/api/masters/gender/values')).status).toBe(200);
        expect((await as(office).post('/api/masters/gender/values', { name: 'Other' })).status).toBe(403);
        expect((await request(app).get('/api/masters/gender/options').set('Origin', ORIGIN)).status).toBe(401);
    });

    it("keeps each school's lists apart", async () => {
        const goa = await idOf('state', 'Goa');
        expect((await as(betaAdmin, BETA).get('/api/masters/state/options')).body.data).toEqual([]);
        expect((await as(betaAdmin, BETA).patch(`/api/masters/state/values/${goa}`, { name: 'Taken' })).status).toBe(404);
    });
});

describe('Excel', () => {
    it('imports: adds new options, updates existing ones, names repeated districts with their state', async () => {
        const template = await request(app).get('/api/imports/master-city/template').set('Origin', ORIGIN).set('Authorization', superAdmin).buffer(true).parse(binary);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(template.body as Buffer);
        const allowed: string[] = [];
        wb.getWorksheet('Allowed values')!.eachRow((r) => allowed.push(String(r.getCell(1).value)));
        expect(allowed).toEqual(expect.arrayContaining(['Bilaspur (Chhattisgarh)', 'Bilaspur (Himachal Pradesh)', 'Chamoli']));

        const file = new ExcelJS.Workbook();
        const ws = file.addWorksheet('Data');
        ws.addRow(['Name *', 'District *', 'Active']);
        ws.addRow(['Mana', 'Chamoli', '']);
        ws.addRow(['Tharali', 'Chamoli', 'No']); // already a starter town: updated
        ws.addRow(['Ratanpur', 'Bilaspur (Chhattisgarh)', '']);
        ws.addRow(['Nowhere', 'Atlantis', '']);
        const check = await request(app).post('/api/imports/master-city/check').set('Origin', ORIGIN).set('Authorization', superAdmin).attach('file', Buffer.from(await file.xlsx.writeBuffer()), 'cities.xlsx');
        expect(check.body.data.job).toMatchObject({ totalRows: 4, validRows: 3 });
        const run = await as(superAdmin).post(`/api/imports/jobs/${check.body.data.job.id}/run`);
        expect(run.body.data.results.map((r: { values: Record<string, string> }) => `${r.values.Name}:${r.values.Result}`)).toEqual(['Mana:Added', 'Tharali:Updated', 'Ratanpur:Added']);
        const chamoli = await idOf('district', 'Chamoli', `?parent=${await idOf('state', 'Uttarakhand')}`);
        expect((await optionsOf('city', `?parent=${chamoli}`)).map((c) => c.name)).toEqual(expect.arrayContaining(['Mana']));
        expect((await optionsOf('city', `?parent=${chamoli}`)).map((c) => c.name)).not.toContain('Tharali');
    });

    it('exports lists whose names Excel would not accept as a sheet name', async () => {
        const res = await request(app).get('/api/masters/city/export').set('Origin', ORIGIN).set('Authorization', superAdmin).buffer(true).parse(binary);
        expect(res.status).toBe(200);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(res.body as Buffer);
        expect(wb.worksheets[0].name).toBe('Cities - towns');
    });

    it('exports a list', async () => {
        const res = await request(app).get('/api/masters/bank/export').set('Origin', ORIGIN).set('Authorization', superAdmin).buffer(true).parse(binary);
        expect(res.status).toBe(200);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(res.body as Buffer);
        const rows: unknown[][] = [];
        wb.worksheets[0].eachRow((r) => rows.push((r.values as unknown[]).slice(1)));
        expect(rows[0]).toEqual(['Name', 'IFSC prefix', 'Active']);
        expect(rows).toEqual(expect.arrayContaining([['State Bank of India', 'SBIN', 'Yes']]));
    });
});
