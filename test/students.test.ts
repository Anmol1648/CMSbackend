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
let alpha: Awaited<ReturnType<typeof makeTenant>>;
let admin: string;
let office: string;
let classTeacher: string;
let classTeacherUser: { id: string };
let year: string;

const as = (token: string) => ({
    get: (p: string) => request(app).get(p).set('Origin', ORIGIN).set('Authorization', token),
    post: (p: string, body: object = {}) => request(app).post(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    patch: (p: string, body: object) => request(app).patch(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    put: (p: string, body: object) => request(app).put(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
});
const settings = (changes: object) => as(admin).patch('/api/settings', { changes });
const option = async (list: string, name: string, parent?: string) =>
    ((await as(admin).get(`/api/masters/${list}/options${parent ? `?parent=${parent}` : ''}`)).body.data as { id: string; name: string }[]).find((o) => o.name === name)!.id;
const section = async (short: string, name: string) =>
    ((await as(admin).get(`/api/academic/sections/options?year=${year}`)).body.data as { id: string; label: string }[]).find((s) => s.label.startsWith(`${short}-${name}`))!.id;

let female: string;
let male: string;
let father: string;
let mother: string;

const admit = (student: object, extra: object = {}, sectionId?: string) =>
    as(admin).post('/api/students', {
        student: { dateOfBirth: '2014-05-10', genderId: male, ...student },
        guardians: [{ name: 'Suresh Negi', mobile: '9876500001', relationId: father }],
        enrolment: { academicYearId: year, sectionId },
        ...extra,
    });

beforeAll(async () => {
    useStorageForTests(localStorageAt(fs.mkdtempSync(path.join(os.tmpdir(), 'cms-students-'))));
    await resetDatabase();
    alpha = await makeTenant('alpha', 'Alpha School', 'alpha.test.in', { starterData: true });
    admin = tokenFor({ id: alpha.admin.id, tenantId: alpha.tenant.id });
    office = tokenFor(await makeUser(alpha.tenant.id, 'office.one', 'office-staff'));
    classTeacherUser = await makeUser(alpha.tenant.id, 'ct.one', 'class-teacher');
    classTeacher = tokenFor(classTeacherUser);
    year = ((await as(admin).get('/api/academic/years')).body.data as { id: string }[])[0].id;
    [female, male, father, mother] = await Promise.all([option('gender', 'Female'), option('gender', 'Male'), option('relation', 'Father'), option('relation', 'Mother')]);
}, 240_000);

describe('admission', () => {
    it('gives an admission number by the pattern, a roll number and a student login', async () => {
        const vi = await section('VI', 'A');
        const preview = (await as(admin).get(`/api/students/next-admission-number?section=${vi}`)).body.data;
        expect(preview.next).toMatch(/^\d{4}\/0001$/);
        const res = await admit({ firstName: 'Aarav', lastName: 'Negi' }, {}, vi);
        expect(res.status).toBe(201);
        expect(res.body.data.student).toMatchObject({ admissionNo: preview.next, name: 'Aarav Negi', enrolments: [{ rollNumber: 1, section: { label: 'VI-A' } }] });
        expect(res.body.data.student.family.guardians[0]).toMatchObject({ name: 'Suresh Negi', isPrimary: true, relation: { name: 'Father' } });
        expect(res.body.data.logins).toEqual([expect.objectContaining({ username: preview.next.replace('/', ''), for: 'Aarav Negi' })]);
        const second = await admit({ firstName: 'Bina', lastName: 'Rawat', genderId: female }, { guardians: [{ name: 'Kamla Rawat', mobile: '9876500002', relationId: mother }] }, vi);
        expect(second.body.data.student.enrolments[0].rollNumber).toBe(2);
    });

    it('follows the school’s own pattern, per-class counters and typed numbers', async () => {
        await settings({ 'students.admission_number_pattern': 'KVJ/{CLASS}/{SEQ:3}', 'students.admission_number_reset': 'class', 'students.admission_number_start': 51 });
        const vii = await section('VII', 'A');
        const a = await admit({ firstName: 'Chirag', lastName: 'Bisht' }, { guardians: [{ name: 'Mohan Bisht', mobile: '9876500003' }] }, vii);
        expect(a.body.data.student.admissionNo).toBe('KVJ/VII/051');
        const typed = await admit({ firstName: 'Diya', admissionNo: 'OLD-1234' }, { guardians: [{ name: 'Ravi Joshi', mobile: '9876500004' }] }, vii);
        expect(typed.body.data.student.admissionNo).toBe('OLD-1234');
        expect((await admit({ firstName: 'Copy', admissionNo: 'old-1234' }, { guardians: [{ name: 'X Y' }] }, vii)).status).toBe(409);
        expect((await settings({ 'students.admission_number_pattern': 'no running number' })).status).toBe(400);
        await settings({ 'students.admission_number_pattern': '{YYYY}/{SEQ:4}', 'students.admission_number_reset': 'never' });
    });

    it('checks required fields (a setting), places and their lists', async () => {
        const vi = await section('VI', 'A');
        await settings({ 'students.required_fields': ['dateOfBirth', 'genderId', 'guardian', 'aadhaar'] });
        const missing = await admit({ firstName: 'Esha' }, {}, vi);
        expect(missing.status).toBe(400);
        expect(missing.body.error.details).toEqual([{ field: 'aadhaar', message: 'is required' }]);
        await settings({ 'students.required_fields': ['dateOfBirth', 'genderId', 'guardian'] });

        const uk = await option('state', 'Uttarakhand');
        const goa = await option('state', 'Goa');
        const chamoli = await option('district', 'Chamoli', uk);
        const wrongPlace = await admit({ firstName: 'Esha', stateId: goa, districtId: chamoli }, {}, vi);
        expect(wrongPlace.body.error.details).toEqual([{ field: 'districtId', message: 'is not in the chosen state' }]);
        const noParent = await as(admin).post('/api/students', { student: { firstName: 'Lonely', dateOfBirth: '2014-01-01', genderId: male }, enrolment: { academicYearId: year, sectionId: vi } });
        expect(noParent.body.error.details).toEqual([{ field: 'guardians', message: 'add at least one parent or guardian' }]);
    });

    it('links a sibling to the same family (found by the parent’s mobile)', async () => {
        const found = (await as(admin).get('/api/students/families?q=98765000')).body.data as { id: string; guardians: { name: string }[]; students: { name: string }[] }[];
        const negi = found.find((f) => f.guardians.some((g) => g.name === 'Suresh Negi'))!;
        expect(negi.students.map((s) => s.name)).toEqual(['Aarav Negi']);
        const sib = await as(admin).post('/api/students', { student: { firstName: 'Ishaan', lastName: 'Negi', dateOfBirth: '2017-03-03', genderId: male }, familyId: negi.id, enrolment: { academicYearId: year, sectionId: await section('III', 'A') } });
        expect(sib.status).toBe(201);
        expect(sib.body.data.student.family.siblings.map((s: { name: string }) => s.name)).toEqual(['Aarav Negi']);
        expect(sib.body.data.student.family.guardians.map((g: { name: string }) => g.name)).toEqual(['Suresh Negi']);
    });

    it('a full section can be refused (a setting)', async () => {
        const vb = await section('V', 'B');
        await as(admin).patch(`/api/academic/sections/${vb}`, { capacity: 1 });
        await admit({ firstName: 'Fatima' }, { guardians: [{ name: 'Imran Khan' }] }, vb);
        const warn = await admit({ firstName: 'Gopal' }, { guardians: [{ name: 'Hari Prasad' }] }, vb);
        expect(warn.body.data.warning).toContain('is full');
        await settings({ 'students.section_capacity': 'block' });
        expect((await admit({ firstName: 'Hema' }, { guardians: [{ name: 'Jagdish' }] }, vb)).status).toBe(409);
        await settings({ 'students.section_capacity': 'warn' });
    });
});

describe('roll numbers and sections', () => {
    it('renumbers a section in the chosen order (girls first)', async () => {
        const vi = await section('VI', 'A');
        await admit({ firstName: 'Zoya', genderId: female }, { guardians: [{ name: 'Z parent' }] }, vi);
        await settings({ 'students.roll_number_order': 'girls_first' });
        expect((await as(admin).post(`/api/students/sections/${vi}/renumber`)).status).toBe(200);
        const list = (await as(admin).get(`/api/students?filter[section]=${vi}&sort=roll`)).body.data.items as { name: string; rollNumber: number }[];
        expect(list.map((s) => `${s.rollNumber}:${s.name}`)).toEqual(['1:Bina Rawat', '2:Zoya', '3:Aarav Negi']);
    });

    it('moves a student and checks optional subjects', async () => {
        const list = (await as(admin).get(`/api/students?filter[section]=${await section('VI', 'A')}`)).body.data.items as { id: string; name: string }[];
        const aarav = list.find((s) => s.name === 'Aarav Negi')!;
        const ix = await section('IX', 'A');
        const subjects = (await as(admin).get('/api/academic/subjects/options')).body.data as { id: string; code: string }[];
        const bad = await as(admin).put(`/api/students/${aarav.id}/enrolment`, { academicYearId: year, sectionId: ix, optionalSubjectIds: [subjects.find((s) => s.code === 'ENG')!.id] });
        expect(bad.status).toBe(400);
        const ok = await as(admin).put(`/api/students/${aarav.id}/enrolment`, { academicYearId: year, sectionId: ix, optionalSubjectIds: [subjects.find((s) => s.code === 'SKT')!.id] });
        expect(ok.status).toBe(200);
        expect(ok.body.data.student.enrolments[0]).toMatchObject({ section: { label: 'IX-A' }, rollNumber: 1 });
    });
});

describe('who sees what', () => {
    it('a class teacher sees only the students of their own section', async () => {
        const vi = await section('VI', 'A');
        await as(admin).patch(`/api/academic/sections/${vi}`, { classTeacherId: classTeacherUser.id });
        const seen = (await as(classTeacher).get('/api/students')).body.data.items as { section: { label: string } }[];
        expect(seen.length).toBeGreaterThan(0);
        expect(new Set(seen.map((s) => s.section.label))).toEqual(new Set(['VI-A']));
        const other = (await as(admin).get(`/api/students?filter[section]=${await section('IX', 'A')}`)).body.data.items[0];
        expect((await as(classTeacher).get(`/api/students/${other.id}`)).status).toBe(404);
    });

    it('Aadhaar is masked for people without the sensitive permission', async () => {
        const vi = await section('VI', 'B');
        const res = await admit({ firstName: 'Kiran', aadhaar: '1234 5678 9012' }, { guardians: [{ name: 'K parent' }] }, vi);
        expect(res.body.data.student.aadhaar).toBe('123456789012');
        expect((await as(office).get(`/api/students/${res.body.data.student.id}`)).body.data.aadhaar).toBe('••••9012');
    });

    it('a student who leaves loses their login until they come back', async () => {
        const kiran = ((await as(admin).get('/api/students?search=Kiran')).body.data.items as { id: string }[])[0];
        const reason = await option('leaving_reason', "Parent's transfer");
        const left = await as(admin).post(`/api/students/${kiran.id}/status`, { status: 'left', date: '2026-09-30', leavingReasonId: reason });
        expect(left.body.data).toMatchObject({ status: 'left', leavingReason: { name: "Parent's transfer" } });
        const user = await runAsTenant(alpha.tenant.id, () => db.user.findFirst({ where: { id: left.body.data.login.id } }));
        expect(user?.status).toBe('disabled');
        expect((await as(admin).get('/api/students?search=Kiran')).body.data.items).toHaveLength(0);
        expect((await as(admin).get('/api/students?search=Kiran&filter[status]=left')).body.data.items).toHaveLength(1);
    });
});

describe('Excel import', () => {
    it('admits students and links siblings by parent mobile', async () => {
        const file = new ExcelJS.Workbook();
        const ws = file.addWorksheet('Data');
        ws.addRow(['First name *', 'Last name', 'Gender', 'Date of birth', 'Class *', 'Section *', 'Father name', 'Father mobile', 'State', 'District']);
        ws.addRow(['Lata', 'Bhandari', 'Female', '12-04-2013', 'Class VII', 'B', 'Pratap Bhandari', '9811100001', 'Uttarakhand', 'Chamoli']);
        ws.addRow(['Manav', 'Bhandari', 'Male', '01-02-2016', 'Class IV', 'A', 'Pratap Bhandari', '9811100001', 'Uttarakhand', 'Chamoli']);
        ws.addRow(['Nobody', '', 'Male', '01-02-2016', 'Class IV', 'Z', 'Someone', '', '', '']);
        const check = await request(app).post('/api/imports/students/check').set('Origin', ORIGIN).set('Authorization', admin).attach('file', Buffer.from(await file.xlsx.writeBuffer()), 'students.xlsx');
        expect(check.body.data.job).toMatchObject({ totalRows: 3, validRows: 2 });
        const run = await as(admin).post(`/api/imports/jobs/${check.body.data.job.id}/run`);
        const rows = run.body.data.results.map((r: { values: Record<string, string> }) => r.values);
        expect(rows.map((r: Record<string, string>) => `${r.Name}|${r.Section}|${r.Sibling}`)).toEqual(['Lata Bhandari|VII-B|', 'Manav Bhandari|IV-A|Linked to existing family']);
        expect(rows[0].Username).not.toBe('');
        const manav = ((await as(admin).get('/api/students?search=Manav')).body.data.items as { id: string }[])[0];
        expect((await as(admin).get(`/api/students/${manav.id}`)).body.data.family.siblings.map((s: { name: string }) => s.name)).toEqual(['Lata Bhandari']);
    });
});
