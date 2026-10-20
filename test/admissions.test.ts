import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { db } from '../src/core/db';
import { runAsTenant } from '../src/core/context';
import { makeStaff, makeTenant, makeUser, resetDatabase, resetRateLimits, tokenFor } from './helpers';

const ORIGIN = 'https://alpha.test.in';
let alpha: Awaited<ReturnType<typeof makeTenant>>;
let admin: string;
let year: string;
let classVI: string;

const as = (token: string) => ({
    get: (p: string) => request(app).get(p).set('Origin', ORIGIN).set('Authorization', token),
    post: (p: string, body: object = {}) => request(app).post(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    patch: (p: string, body: object) => request(app).patch(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    put: (p: string, body: object) => request(app).put(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    delete: (p: string) => request(app).delete(p).set('Origin', ORIGIN).set('Authorization', token),
});
const settings = (changes: object) => as(admin).patch('/api/settings', { changes });
const option = async (list: string, name: string) => ((await as(admin).get(`/api/masters/${list}/options`)).body.data as { id: string; name: string }[]).find((o) => o.name === name)!.id;
const sectionId = async (label: string) => ((await as(admin).get(`/api/academic/sections/options?year=${year}`)).body.data as { id: string; label: string }[]).find((s) => s.label.startsWith(label))!.id;
const thisYear = new Date().getUTCFullYear();

const enquire = (body: object = {}) =>
    as(admin).post('/api/admissions/enquiries', { classId: classVI, studentFirstName: 'Riya', studentLastName: 'Rawat', parentName: 'Mohan Rawat', mobile: `97${Math.floor(10000000 + Math.random() * 89999999)}`, ...body });

beforeAll(async () => {
    await resetDatabase();
    alpha = await makeTenant('alpha', 'Alpha School', 'alpha.test.in', { starterData: true });
    admin = tokenFor({ id: alpha.admin.id, tenantId: alpha.tenant.id });
    year = ((await as(admin).get('/api/academic/years')).body.data as { id: string }[])[0].id;
    classVI = ((await as(admin).get('/api/academic/classes/options')).body.data as { id: string; shortName: string }[]).find((c) => c.shortName === 'VI')!.id;
}, 480_000);

describe('enquiries', () => {
    it('numbers a new enquiry, starts it at the first open stage and suggests the next follow-up', async () => {
        const r = await enquire({ sourceId: await option('enquiry_source', 'Walk-in') });
        expect(r.status).toBe(201);
        const e = r.body.data.enquiry;
        expect(e).toMatchObject({ enquiryNo: `ENQ/${thisYear}/0001`, studentName: 'Riya Rawat', stage: { name: 'New enquiry' }, status: 'open', academicYear: { id: year }, source: { name: 'Walk-in' } });
        const in3 = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
        expect(e.nextFollowUp).toBe(in3);
        expect((await enquire()).body.data.enquiry.enquiryNo).toBe(`ENQ/${thisYear}/0002`);
    });

    it('warns about (or blocks, by setting) a second open enquiry from the same mobile for the class', async () => {
        const first = await enquire({ mobile: '9876500001' });
        const again = await enquire({ mobile: '+91 98765 00001', studentFirstName: 'Sibling' });
        expect(again.status).toBe(201);
        expect(again.body.data.warning).toContain(first.body.data.enquiry.enquiryNo);
        await settings({ 'admissions.duplicate_check': 'block' });
        expect((await enquire({ mobile: '9876500001' })).status).toBe(409);
        await settings({ 'admissions.duplicate_check': 'warn' });
    });

    it('checks options belong to their lists', async () => {
        const r = await enquire({ sourceId: await option('gender', 'Male') });
        expect(r.status).toBe(400);
        expect(r.body.error.details).toEqual([{ field: 'sourceId', message: 'is not an option of its list' }]);
    });

    it('records follow-ups, moves the stage and needs a reason to close as lost', async () => {
        const e = (await enquire()).body.data.enquiry;
        const contacted = await option('enquiry_stage', 'Contacted');
        const next = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
        const f = await as(admin).post(`/api/admissions/enquiries/${e.id}/follow-ups`, { outcomeId: await option('follow_up_outcome', 'Interested'), note: 'Will visit Saturday', nextDate: next, stageId: contacted });
        expect(f.status).toBe(201);
        expect(f.body.data).toMatchObject({ stage: { name: 'Contacted' }, nextFollowUp: next, followUps: [{ note: 'Will visit Saturday', outcome: { name: 'Interested' }, nextDate: next }] });

        const lost = await option('enquiry_stage', 'Lost');
        expect((await as(admin).post(`/api/admissions/enquiries/${e.id}/stage`, { stageId: lost })).body.error.details).toEqual([{ field: 'lostReasonId', message: 'is required' }]);
        const closed = await as(admin).post(`/api/admissions/enquiries/${e.id}/stage`, { stageId: lost, lostReasonId: await option('enquiry_lost_reason', 'Fees too high') });
        expect(closed.body.data).toMatchObject({ status: 'lost', lostReason: { name: 'Fees too high' }, nextFollowUp: null });
        // "Won" only comes from converting into an admission.
        expect((await as(admin).post(`/api/admissions/enquiries/${e.id}/stage`, { stageId: await option('enquiry_stage', 'Admitted') })).status).toBe(400);
    });

    it('registers with a registration number, records the test, and can be switched off', async () => {
        const e = (await enquire()).body.data.enquiry;
        const reg = await as(admin).post(`/api/admissions/enquiries/${e.id}/register`, { stageId: await option('enquiry_stage', 'Registered') });
        expect(reg.body.data).toMatchObject({ registrationNo: `REG/${thisYear}/0001`, stage: { name: 'Registered' } });
        expect((await as(admin).post(`/api/admissions/enquiries/${e.id}/register`, {})).status).toBe(409);
        const t = await as(admin).put(`/api/admissions/enquiries/${e.id}/test`, { testResult: 'passed', testScore: '42/50' });
        expect(t.body.data).toMatchObject({ testResult: 'passed', testScore: '42/50' });
        await settings({ 'admissions.registration_enabled': false });
        expect((await as(admin).post(`/api/admissions/enquiries/${(await enquire()).body.data.enquiry.id}/register`, {})).status).toBe(400);
        await settings({ 'admissions.registration_enabled': true });
    });

    it('lists with filters and a summary per stage', async () => {
        const list = (await as(admin).get('/api/admissions/enquiries?filter[status]=lost')).body.data;
        expect(list.items.map((e: { status: string }) => e.status)).toEqual(['lost']);
        const summary = (await as(admin).get(`/api/admissions/enquiries/summary?year=${year}`)).body.data;
        expect(summary.lost).toBe(1);
        expect(summary.total).toBe(summary.open + summary.won + summary.lost);
        expect(summary.stages.find((s: { name: string }) => s.name === 'New enquiry').count).toBeGreaterThan(0);
        expect((await as(admin).get('/api/admissions/enquiries?search=Sibling')).body.data.items).toHaveLength(1);
    });
});

describe('converting into an admission', () => {
    it('prefills the admission form and marks the enquiry admitted when the student is admitted', async () => {
        const e = (await enquire({ studentFirstName: 'Kabir', dateOfBirth: '2014-05-01', genderId: await option('gender', 'Male'), relationId: await option('relation', 'Father') })).body.data.enquiry;
        const pre = (await as(admin).get(`/api/admissions/enquiries/${e.id}/admission`)).body.data;
        expect(pre).toMatchObject({ classId: classVI, student: { firstName: 'Kabir', dateOfBirth: '2014-05-01' }, guardian: { name: 'Mohan Rawat' } });

        const admitted = await as(admin).post('/api/students', {
            student: { ...pre.student, previousSchool: null },
            guardians: [{ name: pre.guardian.name, relationId: pre.guardian.relationId, mobile: pre.guardian.mobile, isPrimary: true }],
            enrolment: { academicYearId: year, sectionId: await sectionId('VI-A') },
            enquiryId: e.id,
        });
        expect(admitted.status).toBe(201);
        const after = (await as(admin).get(`/api/admissions/enquiries/${e.id}`)).body.data;
        expect(after).toMatchObject({ status: 'won', stage: { name: 'Admitted' }, student: { id: admitted.body.data.student.id }, nextFollowUp: null });
        // Once admitted it can't be admitted again, deleted or moved.
        expect((await as(admin).get(`/api/admissions/enquiries/${e.id}/admission`)).status).toBe(409);
        expect((await as(admin).delete(`/api/admissions/enquiries/${e.id}`)).status).toBe(409);
        expect((await as(admin).post(`/api/admissions/enquiries/${e.id}/stage`, { stageId: await option('enquiry_stage', 'Contacted') })).status).toBe(409);

        const report = (await as(admin).get(`/api/admissions/reports?year=${year}`)).body.data;
        expect(report.total.won).toBe(1);
        expect(report.byClass.find((c: { id: string }) => c.id === classVI)).toMatchObject({ won: 1, enrolled: 1 });
        expect(report.lostReasons).toEqual([expect.objectContaining({ name: 'Fees too high', count: 1 })]);
    });

    it('needs enquiry.convert to admit from an enquiry', async () => {
        const office = await makeUser(alpha.tenant.id, 'office1', 'office-staff');
        await runAsTenant(alpha.tenant.id, async () => {
            const role = await db.role.findFirstOrThrow({ where: { slug: 'office-staff' } });
            await db.rolePermission.deleteMany({ where: { roleId: role.id, permissionKey: 'enquiry.convert' } });
        });
        const e = (await enquire()).body.data.enquiry;
        const r = await as(tokenFor(office)).post('/api/students', {
            student: { firstName: 'Nope', dateOfBirth: '2014-01-01', genderId: await option('gender', 'Female') },
            guardians: [{ name: 'Parent' }],
            enrolment: { academicYearId: year, sectionId: await sectionId('VI-A') },
            enquiryId: e.id,
        });
        expect(r.status).toBe(403);
    });
});

describe('who sees which enquiries', () => {
    it('"own" shows only the enquiries the staff member follows up', async () => {
        const user = await makeUser(alpha.tenant.id, 'counsellor', 'teacher');
        const staff = await makeStaff(alpha.tenant.id, 'Counsellor', user.id);
        await runAsTenant(alpha.tenant.id, async () => {
            const role = await db.role.findFirstOrThrow({ where: { slug: 'teacher' } });
            await db.rolePermission.createMany({
                data: [
                    { tenantId: alpha.tenant.id, roleId: role.id, permissionKey: 'enquiry.view', scope: 'own' },
                    { tenantId: alpha.tenant.id, roleId: role.id, permissionKey: 'enquiry.manage', scope: 'all' },
                ],
            });
        });
        const mine = (await enquire({ studentFirstName: 'Assigned', assignedToId: staff.id })).body.data.enquiry;
        const other = (await enquire({ studentFirstName: 'Other' })).body.data.enquiry;
        const me = as(tokenFor(user));
        expect((await me.get('/api/admissions/enquiries')).body.data.items.map((e: { id: string }) => e.id)).toEqual([mine.id]);
        expect((await me.get(`/api/admissions/enquiries/${other.id}`)).status).toBe(404);
        // What they add is theirs to follow up.
        const added = await me.post('/api/admissions/enquiries', { classId: classVI, studentFirstName: 'Self', parentName: 'P', mobile: '9811122233' });
        expect(added.body.data.enquiry.assignedTo).toMatchObject({ id: staff.id });
    });
});

describe('website enquiry form', () => {
    it('takes an enquiry without login, with the website source, and ignores bots', async () => {
        await resetRateLimits();
        const info = (await request(app).get('/api/public/enquiry').set('Origin', ORIGIN)).body.data;
        expect(info.enabled).toBe(true);
        expect(info.classes.length).toBeGreaterThan(0);
        const r = await request(app).post('/api/public/enquiry').set('Origin', ORIGIN).send({ classId: classVI, studentFirstName: 'Online', parentName: 'Web Parent', mobile: '9822233344', message: 'Seats in VI?' });
        expect(r.status).toBe(201);
        const e = (await as(admin).get(`/api/admissions/enquiries?search=Online`)).body.data.items[0];
        expect(e).toMatchObject({ online: true, source: { name: 'Website' }, enquiryNo: r.body.data.enquiryNo });
        const bot = await request(app).post('/api/public/enquiry').set('Origin', ORIGIN).send({ classId: classVI, studentFirstName: 'Bot', parentName: 'Bot', mobile: '9822233355', website: 'http://spam' });
        expect(bot.status).toBe(201);
        expect((await as(admin).get('/api/admissions/enquiries?search=Bot')).body.data.items).toHaveLength(0);
        await settings({ 'admissions.public_form': false });
        expect((await request(app).post('/api/public/enquiry').set('Origin', ORIGIN).send({ classId: classVI, studentFirstName: 'X', parentName: 'Y', mobile: '9822233366' })).status).toBe(404);
        await settings({ 'admissions.public_form': true });
    });
});
