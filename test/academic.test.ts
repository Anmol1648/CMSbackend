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
import { makeTenant, makeUser, resetDatabase, tokenFor } from './helpers';

const ORIGIN = 'https://alpha.test.in';
const BETA = 'https://beta.test.in';
let alpha: Awaited<ReturnType<typeof makeTenant>>;
let superAdmin: string;
let office: string;
let teacher: string;
let teacherUser: { id: string };
let betaAdmin: string;

const as = (token: string, origin = ORIGIN) => ({
    get: (p: string) => request(app).get(p).set('Origin', origin).set('Authorization', token),
    post: (p: string, body: object = {}) => request(app).post(p).set('Origin', origin).set('Authorization', token).send(body),
    patch: (p: string, body: object) => request(app).patch(p).set('Origin', origin).set('Authorization', token).send(body),
    put: (p: string, body: object) => request(app).put(p).set('Origin', origin).set('Authorization', token).send(body),
    del: (p: string) => request(app).delete(p).set('Origin', origin).set('Authorization', token),
});

type Cls = { id: string; name: string; shortName: string; hasStreams: boolean; sections: { id: string; name: string; stream: { name: string } | null; classTeacher: { id: string } | null }[] };
const years = async () => (await as(superAdmin).get('/api/academic/years')).body.data as { id: string; name: string; isCurrent: boolean; status: string; startDate: string; endDate: string; sections: number }[];
const classes = async (yearId: string) => (await as(superAdmin).get(`/api/academic/classes?year=${yearId}`)).body.data as Cls[];
const classNamed = async (yearId: string, short: string) => (await classes(yearId)).find((c) => c.shortName === short)!;
const masterId = async (list: string, name: string) => ((await as(superAdmin).get(`/api/masters/${list}/options`)).body.data as { id: string; name: string }[]).find((o) => o.name === name)!.id;
let current: string;

beforeAll(async () => {
    useStorageForTests(localStorageAt(fs.mkdtempSync(path.join(os.tmpdir(), 'cms-academic-'))));
    await resetDatabase();
    alpha = await makeTenant('alpha', 'Alpha School', 'alpha.test.in', { starterData: true });
    superAdmin = tokenFor({ id: alpha.admin.id, tenantId: alpha.tenant.id });
    office = tokenFor(await makeUser(alpha.tenant.id, 'office.one', 'office-staff'));
    teacherUser = await makeUser(alpha.tenant.id, 'teacher.one', 'teacher');
    teacher = tokenFor(teacherUser);
    const beta = await makeTenant('beta', 'Beta School', 'beta.test.in');
    betaAdmin = tokenFor({ id: beta.admin.id, tenantId: beta.tenant.id });
}, 240_000);

describe('starter set-up', () => {
    it('gives a new school this year, Bal Vatika to XII, sections and CBSE subjects', async () => {
        const ys = await years();
        expect(ys).toHaveLength(1);
        expect(ys[0]).toMatchObject({ isCurrent: true, status: 'open', sections: 32 });
        current = ys[0].id;
        expect(ys[0].startDate.slice(5)).toBe('04-01');

        const cs = await classes(current);
        expect(cs.map((c) => c.shortName)).toEqual(['BV1', 'BV2', 'BV3', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']);
        const xi = cs.find((c) => c.shortName === 'XI')!;
        expect(xi.sections.map((s) => `${s.name}:${s.stream?.name}`)).toEqual(['A:Science', 'B:Commerce', 'C:Humanities']);

        const vi = cs.find((c) => c.shortName === 'VI')!;
        const subjects = (await as(superAdmin).get(`/api/academic/class-subjects?year=${current}&class=${vi.id}`)).body.data as { subject: { code: string } }[];
        expect(subjects.map((s) => s.subject.code)).toEqual(['ENG', 'HIN', 'SKT', 'MAT', 'SCI', 'SST', 'ART', 'WE', 'HPE']);
    });

    it('puts streams, class groups, subject types and houses in Masters', async () => {
        const groups = (await as(superAdmin).get('/api/masters')).body.data as { key: string; masters: { key: string }[] }[];
        expect(groups.find((g) => g.key === 'academic')!.masters.map((m) => m.key)).toEqual(['class_group', 'stream', 'subject_type', 'house']);
        // A stream in use can't be deleted.
        expect((await as(superAdmin).del(`/api/masters/stream/values/${await masterId('stream', 'Science')}`)).status).toBe(409);
    });
});

describe('academic years', () => {
    let next: string;

    it('suggests the next year and copies the set-up into it', async () => {
        const suggestion = (await as(superAdmin).get('/api/academic/years/suggest')).body.data;
        const cur = (await years())[0];
        expect(suggestion.startDate > cur.endDate).toBe(true);
        const created = await as(superAdmin).post('/api/academic/years', { ...suggestion, copyFromYearId: current });
        expect(created.status).toBe(201);
        expect(created.body.data).toMatchObject({ isCurrent: false, sections: 32 });
        next = created.body.data.id;
        const vi = await classNamed(next, 'VI');
        expect((await as(superAdmin).get(`/api/academic/class-subjects?year=${next}&class=${vi.id}`)).body.data).toHaveLength(9);
    });

    it('refuses overlapping dates and a year that ends before it starts', async () => {
        const overlap = await as(superAdmin).post('/api/academic/years', { name: 'Odd year', startDate: '2026-12-01', endDate: '2027-11-30' });
        expect(overlap.status).toBe(409);
        expect(overlap.body.error.message).toContain('overlap');
        const backwards = await as(superAdmin).post('/api/academic/years', { name: 'Backwards', startDate: '2040-04-01', endDate: '2040-03-01' });
        expect(backwards.body.error.details).toEqual([{ field: 'endDate', message: 'must be after the start date' }]);
    });

    it('has one current year; a closed year is locked', async () => {
        expect((await as(superAdmin).post(`/api/academic/years/${current}/close`)).status).toBe(409); // current
        await as(superAdmin).post(`/api/academic/years/${next}/current`);
        expect((await years()).filter((y) => y.isCurrent).map((y) => y.id)).toEqual([next]);

        expect((await as(superAdmin).post(`/api/academic/years/${current}/close`)).status).toBe(200);
        const vi = await classNamed(current, 'VI');
        const locked = await as(superAdmin).post('/api/academic/sections', { academicYearId: current, classId: vi.id, name: 'C' });
        expect(locked.status).toBe(409);
        expect(locked.body.error.message).toContain('closed');
        await as(superAdmin).post(`/api/academic/years/${current}/reopen`);
        await as(superAdmin).post(`/api/academic/years/${current}/current`);
    });

    it('deletes only an empty year', async () => {
        expect((await as(superAdmin).del(`/api/academic/years/${next}`)).status).toBe(409);
        const empty = await as(superAdmin).post('/api/academic/years', { name: '2040–41', startDate: '2040-04-01', endDate: '2041-03-31' });
        expect((await as(superAdmin).del(`/api/academic/years/${empty.body.data.id}`)).status).toBe(200);
    });
});

describe('classes and sections', () => {
    it('adds, renames and orders classes; refuses duplicates and deleting one in use', async () => {
        const added = await as(superAdmin).post('/api/academic/classes', { name: 'Pre-nursery', shortName: 'PN' });
        expect(added.status).toBe(201);
        expect((await as(superAdmin).post('/api/academic/classes', { name: 'pre-NURSERY' })).status).toBe(409);
        for (let i = 0; i < 15; i++) await as(superAdmin).post(`/api/academic/classes/${added.body.data.id}/move`, { direction: 'up' });
        expect((await classes(current))[0].shortName).toBe('PN');
        expect((await as(superAdmin).del(`/api/academic/classes/${added.body.data.id}`)).status).toBe(200);
        const vi = await classNamed(current, 'VI');
        expect((await as(superAdmin).del(`/api/academic/classes/${vi.id}`)).status).toBe(409);
    });

    it('needs a stream exactly for XI–XII sections', async () => {
        const xi = await classNamed(current, 'XI');
        const vi = await classNamed(current, 'VI');
        const noStream = await as(superAdmin).post('/api/academic/sections', { academicYearId: current, classId: xi.id, name: 'D' });
        expect(noStream.body.error.details).toEqual([{ field: 'streamId', message: 'choose a stream' }]);
        const science = await masterId('stream', 'Science');
        expect((await as(superAdmin).post('/api/academic/sections', { academicYearId: current, classId: vi.id, name: 'C', streamId: science })).status).toBe(400);
        const ok = await as(superAdmin).post('/api/academic/sections', { academicYearId: current, classId: xi.id, name: 'D', streamId: science, capacity: 40, room: 'Lab block 2' });
        expect(ok.status).toBe(201);
        expect(ok.body.data).toMatchObject({ name: 'D', stream: { name: 'Science' }, capacity: 40 });
        expect((await as(superAdmin).post('/api/academic/sections', { academicYearId: current, classId: xi.id, name: 'd', streamId: science })).status).toBe(409);
    });

    it('a class teacher is an active staff member, of one section a year (a setting)', async () => {
        const vi = await classNamed(current, 'VI');
        const [a, b] = vi.sections;
        expect((await as(superAdmin).patch(`/api/academic/sections/${a.id}`, { classTeacherId: teacherUser.id })).body.data.classTeacher).toMatchObject({ id: teacherUser.id });
        const twice = await as(superAdmin).patch(`/api/academic/sections/${b.id}`, { classTeacherId: teacherUser.id });
        expect(twice.status).toBe(409);
        expect(twice.body.error.message).toContain('already class teacher of Class VI A');
        await as(superAdmin).patch('/api/settings', { changes: { 'academic.one_section_per_class_teacher': false } });
        expect((await as(superAdmin).patch(`/api/academic/sections/${b.id}`, { classTeacherId: teacherUser.id })).status).toBe(200);
    });
});

describe('subjects', () => {
    it('adds subjects; codes are unique; a subject in use is made inactive, not deleted', async () => {
        const added = await as(superAdmin).post('/api/academic/subjects', { name: 'Music', code: 'MUS', assessment: 'co_scholastic', typeId: await masterId('subject_type', 'Activity') });
        expect(added.status).toBe(201);
        expect((await as(superAdmin).post('/api/academic/subjects', { name: 'Dance', code: 'mus' })).status).toBe(409);
        const english = ((await as(superAdmin).get('/api/academic/subjects')).body.data as { id: string; code: string; usedBy: number }[]).find((s) => s.code === 'ENG')!;
        expect(english.usedBy).toBeGreaterThan(0);
        expect((await as(superAdmin).del(`/api/academic/subjects/${english.id}`)).status).toBe(409);
        expect((await as(superAdmin).del(`/api/academic/subjects/${added.body.data.id}`)).status).toBe(200);
    });

    it("sets a class's subjects (with history) and keeps stream and common subjects apart", async () => {
        const iv = await classNamed(current, 'IV');
        const subs = (await as(superAdmin).get('/api/academic/subjects/options')).body.data as { id: string; code: string }[];
        const id = (code: string) => subs.find((s) => s.code === code)!.id;
        const saved = await as(superAdmin).put('/api/academic/class-subjects', {
            academicYearId: current,
            classId: iv.id,
            streamId: null,
            subjects: [{ subjectId: id('ENG'), isOptional: false }, { subjectId: id('MAT'), isOptional: false }, { subjectId: id('SKT'), isOptional: true }],
        });
        expect(saved.status).toBe(200);
        expect(saved.body.data.map((s: { subject: { code: string }; isOptional: boolean }) => `${s.subject.code}${s.isOptional ? '?' : ''}`)).toEqual(['ENG', 'MAT', 'SKT?']);
        const audit = await runAsTenant(alpha.tenant.id, () => db.auditLog.findFirst({ where: { action: 'subjects_change', entityId: iv.id } }));
        expect(audit?.changes).toMatchObject({ added: ['Sanskrit (optional)'] });

        const xi = await classNamed(current, 'XI');
        const clash = await as(superAdmin).put('/api/academic/class-subjects', { academicYearId: current, classId: xi.id, streamId: await masterId('stream', 'Science'), subjects: [{ subjectId: id('ENG'), isOptional: false }] });
        expect(clash.status).toBe(409);
        expect(clash.body.error.message).toContain('English is already set for every stream');
    });
});

describe('who may do what', () => {
    it('everyone signed in gets dropdown options; the screens and changes need permissions', async () => {
        expect((await as(teacher).get('/api/academic/classes/options')).status).toBe(200);
        expect((await as(teacher).get(`/api/academic/sections/options?year=${current}`)).body.data.map((s: { label: string }) => s.label)).toEqual(expect.arrayContaining(['VI-A', 'XI-A (Science)']));
        expect((await as(teacher).get('/api/academic/classes')).status).toBe(403);
        expect((await as(office).get('/api/academic/years')).status).toBe(200);
        expect((await as(office).post('/api/academic/subjects', { name: 'Yoga' })).status).toBe(403);
    });

    it("keeps each school's set-up apart", async () => {
        expect((await as(betaAdmin, BETA).get('/api/academic/years')).body.data).toEqual([]);
        expect((await as(betaAdmin, BETA).patch(`/api/academic/years/${current}`, { name: 'Taken' })).status).toBe(404);
    });
});

describe('Excel', () => {
    it('imports sections: updates existing ones and adds new ones', async () => {
        const file = new ExcelJS.Workbook();
        const ws = file.addWorksheet('Data');
        const name = (await years()).find((y) => y.id === current)!.name;
        ws.addRow(['Academic year *', 'Class *', 'Section *', 'Stream', 'Capacity', 'Room', 'Class teacher (username)']);
        ws.addRow([name, 'Class VII', 'A', '', 45, 'Room 7', '']);
        ws.addRow([name, 'Class VII', 'C', '', 40, '', '']);
        ws.addRow([name, 'Class XII', 'D', '', '', '', '']); // no stream: refused
        const check = await request(app).post('/api/imports/sections/check').set('Origin', ORIGIN).set('Authorization', superAdmin).attach('file', Buffer.from(await file.xlsx.writeBuffer()), 'sections.xlsx');
        expect(check.body.data.job).toMatchObject({ totalRows: 3, validRows: 2 });
        const run = await as(superAdmin).post(`/api/imports/jobs/${check.body.data.job.id}/run`);
        expect(run.body.data.results.map((r: { values: Record<string, string> }) => `${r.values.Section}:${r.values.Result}`)).toEqual(['A:Updated', 'C:Added']);
        const vii = await classNamed(current, 'VII');
        expect(vii.sections.map((s) => s.name)).toEqual(['A', 'B', 'C']);
    });
});
