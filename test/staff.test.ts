import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { app } from '../src/app';
import { db } from '../src/core/db';
import { runAsTenant } from '../src/core/context';
import { localStorageAt, useStorageForTests } from '../src/core/files/storage';
import { makeTenant, resetDatabase, tokenFor } from './helpers';

const ORIGIN = 'https://alpha.test.in';
let alpha: Awaited<ReturnType<typeof makeTenant>>;
let admin: string;
let year: string;

const as = (token: string) => ({
    get: (p: string) => request(app).get(p).set('Origin', ORIGIN).set('Authorization', token),
    post: (p: string, body: object = {}) => request(app).post(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    patch: (p: string, body: object) => request(app).patch(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    put: (p: string, body: object) => request(app).put(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
});
const settings = (changes: object) => as(admin).patch('/api/settings', { changes });
const option = async (list: string, name: string) => ((await as(admin).get(`/api/masters/${list}/options`)).body.data as { id: string; name: string }[]).find((o) => o.name === name)!.id;
const sectionId = async (label: string) => ((await as(admin).get(`/api/academic/sections/options?year=${year}`)).body.data as { id: string; label: string }[]).find((s) => s.label.startsWith(label))!.id;
const subjectId = async (code: string) => ((await as(admin).get('/api/academic/subjects/options')).body.data as { id: string; code: string }[]).find((s) => s.code === code)!.id;

let teaching: string;
let nonTeaching: string;
let male: string;
let tgt: string;

const addStaff = (staff: object, extra: object = {}) =>
    as(admin).post('/api/staff', { staff: { genderId: male, mobile: `98${Math.floor(10000000 + Math.random() * 89999999)}`, designationId: tgt, staffTypeId: teaching, ...staff }, ...extra });

beforeAll(async () => {
    useStorageForTests(localStorageAt(fs.mkdtempSync(path.join(os.tmpdir(), 'cms-staff-'))));
    await resetDatabase();
    alpha = await makeTenant('alpha', 'Alpha School', 'alpha.test.in', { starterData: true });
    admin = tokenFor({ id: alpha.admin.id, tenantId: alpha.tenant.id });
    year = ((await as(admin).get('/api/academic/years')).body.data as { id: string }[])[0].id;
    [teaching, nonTeaching, male, tgt] = await Promise.all([option('staff_type', 'Teaching'), option('staff_type', 'Non-teaching'), option('gender', 'Male'), option('designation', 'TGT')]);
}, 480_000);

describe('adding staff', () => {
    it('gives an employee code by the pattern, and a login when asked', async () => {
        const preview = (await as(admin).get('/api/staff/next-code')).body.data;
        expect(preview.next).toBe('EMP/001');
        const r = await addStaff({ firstName: 'Anita', lastName: 'Negi' }, { login: { enabled: true }, qualifications: [{ qualificationId: await option('qualification', 'B.Ed'), year: 2010 }] });
        expect(r.status).toBe(201);
        expect(r.body.data.staff).toMatchObject({ employeeCode: 'EMP/001', name: 'Anita Negi', staffType: { name: 'Teaching', teaching: true }, qualifications: [{ qualification: { name: 'B.Ed' }, year: 2010 }] });
        expect(r.body.data.login).toMatchObject({ username: 'anita.negi' });
        const typed = await addStaff({ firstName: 'Kamal', employeeCode: 'KV-12345', staffTypeId: nonTeaching });
        expect(typed.body.data.staff.employeeCode).toBe('KV-12345');
        expect(typed.body.data.login).toBeNull();
        expect((await addStaff({ firstName: 'Copy', employeeCode: 'kv-12345' })).status).toBe(409);
    });

    it('checks required fields (a setting), IFSC against the bank and PAN', async () => {
        const missing = await as(admin).post('/api/staff', { staff: { firstName: 'Nobody' } });
        expect(missing.body.error.details.map((d: { field: string }) => d.field)).toEqual(['genderId', 'mobile', 'designationId']);
        const sbi = await option('bank', 'State Bank of India');
        const wrongIfsc = await addStaff({ firstName: 'Ravi', bankId: sbi, bankAccountNo: '123456789012', ifsc: 'HDFC0001234' });
        expect(wrongIfsc.body.error.details).toEqual([{ field: 'ifsc', message: 'should start with SBIN for this bank' }]);
        const badPan = await addStaff({ firstName: 'Ravi', pan: '1234' });
        expect(badPan.body.error.details[0]).toMatchObject({ field: 'staff.pan' });
        const ok = await addStaff({ firstName: 'Ravi', bankId: sbi, bankAccountNo: '123456789012', ifsc: 'sbin0001234', pan: 'abcde1234f' });
        expect(ok.body.data.staff).toMatchObject({ ifsc: 'SBIN0001234', pan: 'ABCDE1234F' });
    });
});

describe('own record and leaving', () => {
    it('staff see only their own record and may change what the setting allows', async () => {
        const anita = ((await as(admin).get('/api/staff?search=Anita')).body.data.items as { id: string }[])[0];
        const login = (await as(admin).get(`/api/staff/${anita.id}`)).body.data.login;
        const me = tokenFor({ id: login.id, tenantId: alpha.tenant.id });
        expect((await as(me).get('/api/staff')).body.data.items.map((s: { name: string }) => s.name)).toEqual(['Anita Negi']);
        const mine = await as(me).patch('/api/staff/me', { mobile: '9811100099' });
        expect(mine.status).toBe(200);
        expect(mine.body.data.record.mobile).toBe('9811100099');
        expect((await as(me).patch('/api/staff/me', { designationId: tgt })).status).toBe(403);
    });

    it('a relieved staff member can no longer sign in', async () => {
        const anita = ((await as(admin).get('/api/staff?search=Anita')).body.data.items as { id: string }[])[0];
        const r = await as(admin).post(`/api/staff/${anita.id}/status`, { status: 'relieved', relievingReasonId: await option('relieving_reason', 'Transfer') });
        expect(r.body.data).toMatchObject({ status: 'relieved', relievingReason: { name: 'Transfer' } });
        const user = await runAsTenant(alpha.tenant.id, () => db.user.findUnique({ where: { id: r.body.data.login.id } }));
        expect(user?.status).toBe('disabled');
        expect((await as(admin).get('/api/staff?search=Anita')).body.data.items).toHaveLength(0);
        await as(admin).post(`/api/staff/${anita.id}/status`, { status: 'working' });
    });
});

describe('class and subject teachers', () => {
    it('assigns subject teachers only for subjects the section studies', async () => {
        const anita = ((await as(admin).get('/api/staff?search=Anita')).body.data.items as { id: string }[])[0];
        const vi = await sectionId('VI-A');
        const viClass = ((await as(admin).get('/api/academic/classes/options')).body.data as { id: string; shortName: string }[]).find((c) => c.shortName === 'VI')!.id;
        const set = await as(admin).put('/api/staff/teaching', { sectionId: vi, subjectId: await subjectId('MAT'), staffId: anita.id });
        expect(set.status).toBe(200);
        expect(set.body.data.cells).toEqual([expect.objectContaining({ sectionId: vi, staff: expect.objectContaining({ name: 'Anita Negi' }) })]);
        expect((await as(admin).put('/api/staff/teaching', { sectionId: vi, subjectId: await subjectId('PHY'), staffId: anita.id })).status).toBe(400);
        const grid = (await as(admin).get(`/api/staff/teaching/grid?year=${year}&class=${viClass}`)).body.data;
        expect(grid.subjects.map((s: { code: string }) => s.code)).toContain('MAT');
    });

    it('a subject teacher sees the students of the sections they teach', async () => {
        const vi = await sectionId('VI-A');
        await as(admin).post('/api/students', {
            student: { firstName: 'Pupil', dateOfBirth: '2014-01-01', genderId: male },
            guardians: [{ name: 'Parent' }],
            enrolment: { academicYearId: year, sectionId: vi },
        });
        const anita = ((await as(admin).get('/api/staff?search=Anita')).body.data.items as { id: string }[])[0];
        const login = (await as(admin).get(`/api/staff/${anita.id}`)).body.data.login;
        const me = tokenFor({ id: login.id, tenantId: alpha.tenant.id });
        const seen = (await as(me).get('/api/students')).body.data.items as { name: string; section: { label: string } }[];
        expect(seen.map((s) => `${s.name}:${s.section.label}`)).toEqual(['Pupil:VI-A']);
        const mine = (await as(me).get('/api/staff/me/teaching')).body.data;
        expect(mine.teaches).toEqual([expect.objectContaining({ section: expect.objectContaining({ label: 'VI-A' }), subject: expect.objectContaining({ name: 'Mathematics' }) })]);
    });

    it('a class teacher is chosen from working staff', async () => {
        const kamal = ((await as(admin).get('/api/staff?search=Kamal')).body.data.items as { id: string }[])[0];
        const vib = await sectionId('VI-B');
        const r = await as(admin).patch(`/api/academic/sections/${vib}`, { classTeacherId: kamal.id });
        expect(r.body.data.classTeacher).toMatchObject({ name: 'Kamal', code: 'KV-12345' });
        expect((await as(admin).get(`/api/staff/${kamal.id}`)).body.data.thisYear.classTeacherOf).toEqual([expect.objectContaining({ label: 'VI-B' })]);
        await settings({ 'staff.code_pattern': 'KVJ/{YYYY}/{SEQ:2}' });
        // EMP/001 (Anita) and EMP/002 (Ravi) took the first two numbers.
        expect((await as(admin).get('/api/staff/next-code')).body.data.next).toMatch(/^KVJ\/\d{4}\/03$/);
    });
});
