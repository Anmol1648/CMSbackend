import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { db } from '../src/core/db';
import { runAsTenant } from '../src/core/context';
import { generateTimetable, GenLesson, GenRule } from '../src/modules/timetable/generator';
import { makeStaff, makeTenant, makeUser, resetDatabase, tokenFor } from './helpers';

const rule = (maxPerDay = 8, maxPerWeek = 48, unavailable: string[] = []): GenRule => ({ maxPerDay, maxPerWeek, unavailable: new Set(unavailable) });
const days = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, periods: 6, breakAfter: [3] }));
const lesson = (key: string, sectionId: string, perWeek: number, subjects: [string, string | null, string | null?][], doubles = 0): GenLesson => ({
    key,
    sectionId,
    perWeek,
    doubles,
    classTeacher: false,
    subjects: subjects.map(([subjectId, staffId, roomId]) => ({ subjectId, staffId, roomId: roomId ?? null })),
});
const opts = { attempts: 10, classTeacherFirst: false, maxSamePerDay: 2, seed: 1 };

describe('the generator', () => {
    it('places every period with no teacher, room or section in two places at once', () => {
        const lessons = ['A', 'B', 'C'].flatMap((sec) => [
            lesson(`${sec}-mat`, sec, 6, [['MAT', 'T1']]),
            lesson(`${sec}-eng`, sec, 6, [['ENG', 'T2']]),
            lesson(`${sec}-sci`, sec, 4, [['SCI', `T3${sec}`, 'LAB']], 1),
        ]);
        const r = generateTimetable({ days, lessons, rules: new Map(), fallback: rule(), locked: [], options: opts });
        expect(r.unplaced).toEqual([]);
        expect(r.placed).toBe(r.wanted);
        const seen = new Set<string>();
        for (const e of r.entries) {
            for (const k of [`s|${e.sectionId}|${e.weekday}|${e.periodNo}`, e.staffId && `t|${e.staffId}|${e.weekday}|${e.periodNo}`, e.roomId && `r|${e.roomId}|${e.weekday}|${e.periodNo}`]) {
                if (!k) continue;
                expect(seen.has(k)).toBe(false);
                seen.add(k);
            }
        }
        // The double period is two periods in a row, not across the break after period 3.
        for (const sec of ['A', 'B', 'C']) {
            const sci = r.entries.filter((e) => e.sectionId === sec && e.subjectId === 'SCI');
            const byDay = new Map<number, number[]>();
            for (const e of sci) byDay.set(e.weekday, [...(byDay.get(e.weekday) ?? []), e.periodNo]);
            const double = [...byDay.values()].find((p) => p.length === 2)!.sort();
            expect(double[1] - double[0]).toBe(1);
            expect(double[0]).not.toBe(3);
        }
    });

    it('keeps teachers’ limits and unavailable periods, and says what it could not place', () => {
        const lessons = [lesson('A-mat', 'A', 6, [['MAT', 'T1']]), lesson('B-mat', 'B', 6, [['MAT', 'T1']])];
        const r = generateTimetable({ days, lessons, rules: new Map([['T1', rule(2, 8, ['1:1'])]]), fallback: rule(), locked: [], options: opts });
        const t1 = r.entries.filter((e) => e.staffId === 'T1');
        expect(t1).toHaveLength(8);
        expect(t1.some((e) => e.weekday === 1 && e.periodNo === 1)).toBe(false);
        for (const d of [1, 2, 3, 4, 5]) expect(t1.filter((e) => e.weekday === d).length).toBeLessThanOrEqual(2);
        expect(r.unplaced.reduce((a, u) => a + u.missing, 0)).toBe(4);
        expect(r.unplaced[0].reason).toContain('limit');
    });

    it('puts a parallel group in the same periods, and keeps locked periods', () => {
        const lessons = [lesson('A-lang', 'A', 4, [['HIN', 'T1'], ['SKT', 'T2']]), lesson('A-mat', 'A', 3, [['MAT', 'T3']])];
        const locked = [{ sectionId: 'A', weekday: 2, periodNo: 1, subjectId: 'MAT', staffId: 'T3', roomId: null, locked: true }];
        const r = generateTimetable({ days, lessons, rules: new Map(), fallback: rule(), locked, options: opts });
        const hin = r.entries.filter((e) => e.subjectId === 'HIN').map((e) => `${e.weekday}:${e.periodNo}`).sort();
        const skt = r.entries.filter((e) => e.subjectId === 'SKT').map((e) => `${e.weekday}:${e.periodNo}`).sort();
        expect(hin).toEqual(skt);
        expect(hin).toHaveLength(4);
        expect(r.entries.filter((e) => e.subjectId === 'MAT')).toHaveLength(3);
        expect(r.entries).toContainEqual(expect.objectContaining({ weekday: 2, periodNo: 1, subjectId: 'MAT', locked: true }));
    });
});

const ORIGIN = 'https://alpha.test.in';
let alpha: Awaited<ReturnType<typeof makeTenant>>;
let admin: string;
let year: string;
let viA: string;
let viB: string;
let mat: string;
let teacherId: string;
let teacherLogin: string;

const as = (token: string) => ({
    get: (p: string) => request(app).get(p).set('Origin', ORIGIN).set('Authorization', token),
    post: (p: string, body: object = {}) => request(app).post(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    put: (p: string, body: object) => request(app).put(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
});

beforeAll(async () => {
    await resetDatabase();
    alpha = await makeTenant('alpha', 'Alpha School', 'alpha.test.in', { starterData: true });
    admin = tokenFor({ id: alpha.admin.id, tenantId: alpha.tenant.id });
    year = ((await as(admin).get('/api/academic/years')).body.data as { id: string; isCurrent: boolean }[]).find((y) => y.isCurrent)!.id;
    const sections = (await as(admin).get(`/api/academic/sections/options?year=${year}`)).body.data as { id: string; label: string }[];
    viA = sections.find((s) => s.label.startsWith('VI-A'))!.id;
    viB = sections.find((s) => s.label.startsWith('VI-B'))!.id;
    mat = ((await as(admin).get('/api/academic/subjects/options')).body.data as { id: string; code: string }[]).find((s) => s.code === 'MAT')!.id;
    // A maths teacher (with a login) for both VI sections.
    const user = await makeUser(alpha.tenant.id, 'mathsir', 'teacher');
    const staff = await makeStaff(alpha.tenant.id, 'Maths', user.id);
    teacherId = staff.id;
    teacherLogin = tokenFor({ id: user.id, tenantId: alpha.tenant.id });
    await runAsTenant(alpha.tenant.id, () =>
        db.teachingAssignment.createMany({ data: [viA, viB].map((sectionId) => ({ tenantId: alpha.tenant.id, academicYearId: year, sectionId, subjectId: mat, staffId: staff.id })) })
    );
}, 480_000);

describe('timetable set-up and generating', () => {
    let tt: string;

    it('starts the year with the defaults: 8 periods, Monday to Saturday, periods for every subject', async () => {
        const r = await as(admin).post(`/api/timetable/setup/start?year=${year}`);
        expect(r.body.data.schedules).toBe(1);
        const week = (await as(admin).get(`/api/timetable/setup/week?year=${year}`)).body.data;
        expect(week.map((d: { name: string }) => d.name)).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
        expect(week[0].periods).toHaveLength(8);
        expect(week[0].breakAfter).toEqual([4]);
        const loads = (await as(admin).get(`/api/timetable/setup/loads?year=${year}`)).body.data;
        expect(loads.periodsInWeek).toBe(48);
        expect(loads.classes.every((c: { periods: number }) => c.periods > 0)).toBe(true);
        const teachers = (await as(admin).get(`/api/timetable/setup/teachers?year=${year}`)).body.data;
        void teachers;
    });

    it('checks the periods of a class (a parallel group must match)', async () => {
        const classVI = ((await as(admin).get('/api/academic/classes/options')).body.data as { id: string; shortName: string }[]).find((c) => c.shortName === 'VI')!.id;
        const current = (await as(admin).get(`/api/timetable/setup/loads/${classVI}?year=${year}`)).body.data;
        const rows = current.rows.map((r: { subject: { id: string }; stream: { id: string } | null; perWeek: number }) => ({ subjectId: r.subject.id, streamId: r.stream?.id ?? null, perWeek: r.subject.id === mat ? 7 : r.perWeek, doubles: 0, parallelGroup: null }));
        const bad = await as(admin).put(`/api/timetable/setup/loads/${classVI}?year=${year}`, { rows: rows.map((r: { subjectId: string }, i: number) => (i < 2 ? { ...r, parallelGroup: 'X', perWeek: 4 + i } : r)) });
        expect(bad.status).toBe(400);
        const ok = await as(admin).put(`/api/timetable/setup/loads/${classVI}?year=${year}`, { rows });
        expect(ok.status).toBe(200);
        expect(ok.body.data.rows.find((r: { subject: { id: string } }) => r.subject.id === mat).perWeek).toBe(7);
    });

    it('generates a draft with no teacher clash, and the teacher’s week shows both sections', async () => {
        const g = await as(admin).post(`/api/timetable/generate?year=${year}`, { name: 'Term 1' });
        expect(g.status).toBe(201);
        tt = g.body.data.timetableId;
        expect(g.body.data.placed).toBe(g.body.data.wanted);
        const mine = (await as(admin).get(`/api/timetable/${tt}/grid?teacher=${teacherId}`)).body.data.entries as { weekday: number; periodNo: number; section: { id: string } }[];
        expect(mine).toHaveLength(14);
        expect(new Set(mine.map((e) => `${e.weekday}:${e.periodNo}`)).size).toBe(14);
        expect(new Set(mine.map((e) => e.section.id))).toEqual(new Set([viA, viB]));
    });

    it('refuses a manual change that would put the teacher in two classes, and swaps periods', async () => {
        const b = (await as(admin).get(`/api/timetable/${tt}/grid?section=${viB}`)).body.data.entries as { weekday: number; periodNo: number; subject: { id: string } }[];
        const bMath = b.find((e) => e.subject.id === mat)!;
        const clash = await as(admin).put(`/api/timetable/${tt}/cell`, { sectionId: viA, weekday: bMath.weekday, periodNo: bMath.periodNo, lessons: [{ subjectId: mat, staffId: teacherId }] });
        expect(clash.status).toBe(409);
        expect(clash.body.error.message).toContain('Maths');
        const a = (await as(admin).get(`/api/timetable/${tt}/grid?section=${viA}`)).body.data.entries as { weekday: number; periodNo: number; subject: { id: string } }[];
        // Two filled periods with one subject each and different subjects.
        const single = a.filter((e) => a.filter((x) => x.weekday === e.weekday && x.periodNo === e.periodNo).length === 1);
        const first = single[0];
        const other = single.find((e) => e.subject.id !== first.subject.id && e.subject.id !== mat && first.subject.id !== mat)!;
        const at = (e: { weekday: number; periodNo: number }) => ({ weekday: e.weekday, periodNo: e.periodNo });
        const swapped = await as(admin).post(`/api/timetable/${tt}/swap`, { sectionId: viA, a: at(first), b: at(other) });
        expect(swapped.status).toBe(200);
        const after = swapped.body.data.entries as { weekday: number; periodNo: number; subject: { id: string }; locked: boolean }[];
        expect(after.find((e) => e.weekday === first.weekday && e.periodNo === first.periodNo)!.subject.id).toBe(other.subject.id);
        expect(after.find((e) => e.weekday === other.weekday && e.periodNo === other.periodNo)).toMatchObject({ subject: { id: first.subject.id }, locked: true });
    });

    it('publishes; the teacher sees their week; a published timetable is not edited', async () => {
        expect((await as(teacherLogin).get('/api/my-timetable')).body.data.published).toBe(false);
        const p = await as(admin).post(`/api/timetable/${tt}/publish`);
        expect(p.body.data.status).toBe('published');
        const mine = (await as(teacherLogin).get('/api/my-timetable')).body.data;
        expect(mine.views[0]).toMatchObject({ kind: 'teacher' });
        expect(mine.views[0].entries).toHaveLength(14);
        expect((await as(admin).put(`/api/timetable/${tt}/cell`, { sectionId: viA, weekday: 1, periodNo: 1, lessons: [] })).status).toBe(409);
        expect((await as(teacherLogin).post(`/api/timetable/generate?year=${year}`, {})).status).toBe(403);
    });

    it('arranges substitutes for an absent teacher, never one who is busy', async () => {
        // A Monday (weekday 1) in the year.
        const monday = (() => {
            const d = new Date();
            d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
            return d.toISOString().slice(0, 10);
        })();
        const other = await makeStaff(alpha.tenant.id, 'Other');
        await runAsTenant(alpha.tenant.id, async () => {
            const type = await db.masterValue.findFirstOrThrow({ where: { master: 'staff_type', name: 'Teaching' } });
            await db.staff.updateMany({ data: { staffTypeId: type.id } });
        });
        const day = await as(admin).post('/api/timetable-subs/absent', { date: monday, staffId: teacherId });
        expect(day.status).toBe(201);
        const periods = day.body.data.absent[0].periods as { id: string; suggestions: { id: string }[] }[];
        expect(periods.length).toBeGreaterThan(0);
        expect(periods[0].suggestions.map((s) => s.id)).toContain(other.id);
        expect(periods[0].suggestions.map((s) => s.id)).not.toContain(teacherId);
        const set = await as(admin).put(`/api/timetable-subs/${periods[0].id}`, { substituteStaffId: other.id });
        expect(set.body.data.open).toBe(periods.length - 1);
        expect((await as(admin).put(`/api/timetable-subs/${periods[0].id}`, { substituteStaffId: teacherId })).status).toBe(400);
        const report = (await as(admin).get(`/api/timetable-subs/report?month=${monday.slice(0, 7)}`)).body.data;
        expect(report.teachers.find((t: { id: string }) => t.id === other.id).taken).toBe(1);
    });
});
