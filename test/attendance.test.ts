import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { db } from '../src/core/db';
import { runAsTenant } from '../src/core/context';
import { todayIST } from '../src/modules/attendance/attendance.settings';
import { makeStaff, makeTenant, makeUser, resetDatabase, tokenFor } from './helpers';

const ORIGIN = 'https://alpha.test.in';
let alpha: Awaited<ReturnType<typeof makeTenant>>;
let admin: string;
let teacher: string;
let clerk: string;
let viA: string;
let viB: string;
const kids: string[] = [];

const as = (token: string) => ({
    get: (p: string) => request(app).get(p).set('Origin', ORIGIN).set('Authorization', token),
    post: (p: string, body: object = {}) => request(app).post(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    put: (p: string, body: object) => request(app).put(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    delete: (p: string) => request(app).delete(p).set('Origin', ORIGIN).set('Authorization', token),
});
const daysAgo = (n: number) => new Date(new Date(`${todayIST()}T00:00:00Z`).getTime() - n * 86_400_000).toISOString().slice(0, 10);
/** The latest day on or before `n` days ago that isn't a Sunday (the default weekly off). */
const schoolDay = (n: number) => {
    let d = daysAgo(n);
    while (new Date(`${d}T00:00:00Z`).getUTCDay() === 0) d = daysAgo(++n);
    return d;
};
const lastSunday = () => {
    let n = 0;
    while (new Date(`${daysAgo(n)}T00:00:00Z`).getUTCDay() !== 0) n++;
    return daysAgo(n);
};
type Register = { students: { id: string; statusId: string | null }[]; statuses: { id: string; code: string }[]; defaultStatusId: string; editable: boolean; reason: string | null; dayOff: string | null };
const marksFor = (r: Register, absent: string[] = []) =>
    r.students.map((s) => ({ studentId: s.id, statusId: absent.includes(s.id) ? r.statuses.find((x) => x.code === 'A')!.id : r.defaultStatusId }));

beforeAll(async () => {
    await resetDatabase();
    alpha = await makeTenant('alpha', 'Alpha School', 'alpha.test.in', { starterData: true });
    admin = tokenFor({ id: alpha.admin.id, tenantId: alpha.tenant.id });
    const year = ((await as(admin).get('/api/academic/years')).body.data as { id: string; isCurrent: boolean }[]).find((y) => y.isCurrent)!.id;
    const sections = (await as(admin).get(`/api/academic/sections/options?year=${year}`)).body.data as { id: string; label: string }[];
    viA = sections.find((s) => s.label.startsWith('VI-A'))!.id;
    viB = sections.find((s) => s.label.startsWith('VI-B'))!.id;
    // A class teacher of VI-A (with a login), an office clerk, and three students in VI-A.
    const user = await makeUser(alpha.tenant.id, 'ctvia', 'class-teacher');
    const staff = await makeStaff(alpha.tenant.id, 'Geeta', user.id);
    teacher = tokenFor({ id: user.id, tenantId: alpha.tenant.id });
    clerk = tokenFor(await makeUser(alpha.tenant.id, 'clerk1', 'office-staff'));
    await runAsTenant(alpha.tenant.id, async () => {
        await db.section.update({ where: { id: viA }, data: { classTeacherId: staff.id } });
        for (const [i, name] of ['Aarav', 'Bina', 'Chetan'].entries()) {
            const s = await db.student.create({ data: { tenantId: alpha.tenant.id, admissionNo: `A-${i + 1}`, admissionDate: new Date('2026-04-01'), firstName: name } });
            await db.enrolment.create({ data: { tenantId: alpha.tenant.id, studentId: s.id, academicYearId: year, sectionId: viA, rollNumber: i + 1 } });
            kids.push(s.id);
        }
    });
}, 480_000);

describe('student attendance', () => {
    it('gives the class teacher their own section, ready with everyone present', async () => {
        const sections = (await as(teacher).get('/api/attendance/sections')).body.data;
        expect(sections.map((s: { id: string }) => s.id)).toEqual([viA]);
        const r: Register = (await as(teacher).get(`/api/attendance/register?section=${viA}&date=${schoolDay(0)}`)).body.data;
        expect(r.students).toHaveLength(3);
        expect(r.students.every((s) => s.statusId === null)).toBe(true);
        expect(r.statuses.map((s) => s.code)).toEqual(['P', 'A', 'LT', 'HD', 'LV', 'ML']);
        expect(r.statuses.find((s) => s.id === r.defaultStatusId)!.code).toBe('P');
        expect(r.editable).toBe(true);
    });

    it('saves a whole register, and only for the teacher’s own section and recent days', async () => {
        const day = schoolDay(0);
        const r: Register = (await as(teacher).get(`/api/attendance/register?section=${viA}&date=${day}`)).body.data;
        const saved = await as(teacher).put('/api/attendance/register', { section: viA, date: day, marks: marksFor(r, [kids[1]]) });
        expect(saved.status).toBe(200);
        expect(saved.body.data.students.find((s: { id: string }) => s.id === kids[1]).statusId).toBe(r.statuses.find((x) => x.code === 'A')!.id);
        expect(saved.body.data.marked.by).toBe('ctvia');
        // Not everyone marked; another section; too long ago; a future day.
        expect((await as(teacher).put('/api/attendance/register', { section: viA, date: day, marks: marksFor(r).slice(1) })).status).toBe(400);
        expect((await as(teacher).put('/api/attendance/register', { section: viB, date: day, marks: [] })).status).toBe(403);
        const old = schoolDay(6);
        const oldReg: Register = (await as(teacher).get(`/api/attendance/register?section=${viA}&date=${old}`)).body.data;
        expect(oldReg.editable).toBe(false);
        expect((await as(teacher).put('/api/attendance/register', { section: viA, date: old, marks: marksFor(oldReg) })).status).toBe(403);
        // The office may mark any section on any day.
        expect((await as(clerk).put('/api/attendance/register', { section: viA, date: old, marks: marksFor(oldReg) })).status).toBe(200);
        const future = (await as(clerk).put('/api/attendance/register', { section: viA, date: daysAgo(-3), marks: marksFor(oldReg) })).status;
        expect([400, 403]).toContain(future);
    });

    it('blocks weekly offs and holidays', async () => {
        const sunday = lastSunday();
        const r: Register = (await as(clerk).get(`/api/attendance/register?section=${viA}&date=${sunday}`)).body.data;
        expect(r.dayOff).toMatch(/Weekly off/);
        expect((await as(clerk).put('/api/attendance/register', { section: viA, date: sunday, marks: marksFor(r) })).status).toBe(400);
        const h = schoolDay(2);
        expect((await as(clerk).post('/api/attendance/holidays', { from: h, name: 'Founders Day' })).status).toBe(201);
        expect((await as(teacher).get(`/api/attendance/register?section=${viA}&date=${h}`)).body.data.dayOff).toBe('Founders Day');
        const list = (await as(teacher).get('/api/attendance/holidays')).body.data;
        const mine = list.holidays.find((x: { date: string }) => x.date === h);
        expect(mine.name).toBe('Founders Day');
        expect((await as(teacher).post('/api/attendance/holidays', { from: h, name: 'x' })).status).toBe(403);
        expect((await as(clerk).delete(`/api/attendance/holidays/${mine.id}`)).status).toBe(200);
    });

    it('shows the day for the office and works out the attendance %', async () => {
        const o = (await as(clerk).get(`/api/attendance/overview?date=${schoolDay(0)}`)).body.data;
        const a = o.sections.find((s: { id: string }) => s.id === viA);
        expect(a.slots[0]).toMatchObject({ marked: true, present: 2, absent: 1 });
        expect(o.totals.notMarked).toBe(o.totals.sections - 1);
        const pct = (await as(clerk).get(`/api/reports/attendance_percentage/run?from=${schoolDay(8)}&to=${todayIST()}`)).body.data;
        const bina = pct.rows.find((r: { student: string }) => r.student === 'Bina');
        expect(bina).toMatchObject({ days: 2, present: 1, absent: 1, percent: 50 });
        const absentees = (await as(clerk).get(`/api/reports/attendance_absentees/run?date=${schoolDay(0)}`)).body.data;
        expect(absentees.rows.map((r: { student: string }) => r.student)).toEqual(['Bina']);
        const grid = await as(clerk).get(`/api/reports/attendance_monthly_register/run?section=${viA}&class=${(await runAsTenant(alpha.tenant.id, () => db.section.findUniqueOrThrow({ where: { id: viA } }))).classId}&month=${todayIST()}`);
        expect(grid.status).toBe(200);
        expect(grid.body.data.rows[1][`d${Number(schoolDay(0).slice(8))}`]).toBe(schoolDay(0).slice(0, 7) === todayIST().slice(0, 7) ? 'A' : undefined);
        // The teacher (assigned) sees only their section.
        const t = (await as(teacher).get('/api/attendance/overview')).body.data;
        expect(t.sections.map((s: { id: string }) => s.id)).toEqual([viA]);
    });
});

describe('staff attendance', () => {
    it('lets a teacher check in and out once, and the office correct a day', async () => {
        const me = (await as(teacher).get('/api/attendance/staff/me')).body.data;
        expect(me.staff.name).toBe('Geeta');
        if (me.reason) return; // today is not a working day where the tests run
        const inn = await as(teacher).post('/api/attendance/staff/check-in');
        expect(inn.status).toBe(200);
        expect(inn.body.data.day.checkIn).toMatch(/^\d{2}:\d{2}$/);
        expect(['P', 'LT', 'HD']).toContain(inn.body.data.day.status.code);
        expect((await as(teacher).post('/api/attendance/staff/check-in')).status).toBe(409);
        const out = await as(teacher).post('/api/attendance/staff/check-out');
        expect(out.body.data.day.checkOut).toMatch(/^\d{2}:\d{2}$/);
        const day = (await as(clerk).get('/api/attendance/staff/day')).body.data;
        const geeta = day.staff.find((s: { name: string }) => s.name === 'Geeta');
        expect(geeta.record.checkIn).toBe(inn.body.data.day.checkIn);
        // Yesterday she forgot: the office puts it right.
        const fixed = await as(clerk).put(`/api/attendance/staff/${geeta.id}`, { date: schoolDay(1), checkIn: '08:25', checkOut: '14:40', note: 'Forgot to check in' });
        expect(fixed.status).toBe(200);
        expect(fixed.body.data.staff.find((s: { name: string }) => s.name === 'Geeta').record).toMatchObject({ checkIn: '08:25', checkOut: '14:40', late: true, source: 'admin' });
        expect((await as(teacher).put(`/api/attendance/staff/${geeta.id}`, { date: schoolDay(1), checkIn: '07:50' })).status).toBe(403);
    });
});
