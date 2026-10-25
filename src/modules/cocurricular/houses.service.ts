import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { sectionLabel } from '../timetable/tt-setup.service';
import { dayDate, isoOf } from '../attendance/attendance.settings';
import { COCURRICULAR } from './cocurricular.settings';
import { houseList, housesOn, masterNames, need, staffNames, studentInfo, thisYear } from './cocurricular.common';

/**
 * Houses: the standings (points this year), strength by class, house masters and captains, points
 * given by hand, and allocating students to houses automatically (balanced per section, boys and
 * girls, brothers and sisters together). Houses are Masters → Houses; a student's house is on their
 * enrolment of the year.
 */

export const ROLES: Record<string, { label: string; staff: boolean }> = {
    master: { label: 'House master', staff: true },
    assistant_master: { label: 'Assistant house master', staff: true },
    captain: { label: 'Captain', staff: false },
    vice_captain: { label: 'Vice-captain', staff: false },
    prefect: { label: 'Prefect', staff: false },
};

const ensureOn = async () => {
    if (!(await housesOn())) throw badRequest('Houses are switched off (System Settings → Academic → Houses)');
};

/** Points of each house this year (highest first), with their rank. */
export const standings = async (yearId: string) => {
    const [houses, sums] = await Promise.all([houseList(), db.housePoint.groupBy({ by: ['houseId'], where: { academicYearId: yearId }, _sum: { points: true } })]);
    const rows = houses.map((h) => ({ ...h, points: sums.find((s) => s.houseId === h.id)?._sum.points ?? 0 })).sort((a, b) => b.points - a.points);
    return rows.map((r) => ({ ...r, rank: rows.findIndex((x) => x.points === r.points) + 1 }));
};

/** The Houses page: standings, strength, officials, recent points. */
export const overview = async (userId: string) => {
    const p = await need(userId, ['cocurricular.view', 'house.manage', 'house.points']);
    const on = await housesOn();
    if (!on) return { on: false as const };
    const year = await thisYear();
    const [table, counts, unassigned, officials, recent] = await Promise.all([
        standings(year.id),
        db.enrolment.groupBy({ by: ['houseId'], where: { academicYearId: year.id, student: { status: 'active' } }, _count: { _all: true } }),
        db.enrolment.count({ where: { academicYearId: year.id, houseId: null, student: { status: 'active' } } }),
        db.houseOfficial.findMany({ where: { academicYearId: year.id }, orderBy: { createdAt: 'asc' } }),
        db.housePoint.findMany({ where: { academicYearId: year.id }, orderBy: [{ givenOn: 'desc' }, { createdAt: 'desc' }], take: 15 }),
    ]);
    const [staff, students, givers] = await Promise.all([
        staffNames(officials.map((o) => o.staffId)),
        studentInfo([...officials.map((o) => o.studentId), ...recent.map((r) => r.studentId)].filter((x): x is string => !!x), year.id),
        db.user.findMany({ where: { id: { in: recent.map((r) => r.givenBy!).filter(Boolean) } }, select: { id: true, displayName: true } }),
    ]);
    return {
        on: true as const,
        year: year.name,
        houses: table.map((h) => ({
            ...h,
            students: counts.find((c) => c.houseId === h.id)?._count._all ?? 0,
            officials: officials
                .filter((o) => o.houseId === h.id)
                .sort((a, b) => Object.keys(ROLES).indexOf(a.role) - Object.keys(ROLES).indexOf(b.role))
                .map((o) => ({ id: o.id, role: o.role, roleLabel: ROLES[o.role]?.label ?? o.role, staffId: o.staffId, studentId: o.studentId, name: o.staffId ? (staff.get(o.staffId) ?? '') : (students.get(o.studentId ?? '')?.name ?? ''), section: o.studentId ? (students.get(o.studentId)?.section ?? '') : '' })),
        })),
        unassigned,
        recent: recent.map((r) => ({ id: r.id, houseId: r.houseId, points: r.points, reason: r.reason, student: r.studentId ? (students.get(r.studentId)?.name ?? null) : null, date: isoOf(r.givenOn), by: givers.find((g) => g.id === r.givenBy)?.displayName ?? null, fromResult: !!(r.competitionId || r.achievementId) })),
        roles: Object.entries(ROLES).map(([value, r]) => ({ value, label: r.label, staff: r.staff })),
        can: { manage: !!p['house.manage'], points: !!p['house.points'] },
    };
};

/** Students per house in each section this year. */
export const strength = async (yearId: string) => {
    const [houses, rows] = await Promise.all([houseList(), db.enrolment.groupBy({ by: ['sectionId', 'houseId'], where: { academicYearId: yearId, student: { status: 'active' } }, _count: { _all: true } })]);
    const sections = await db.section.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.sectionId))] } }, select: { id: true, name: true, sortOrder: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } } });
    return {
        houses,
        rows: sections
            .sort((a, b) => a.schoolClass.sortOrder - b.schoolClass.sortOrder || a.sortOrder - b.sortOrder)
            .map((s) => {
                const of = (h: string | null) => rows.find((r) => r.sectionId === s.id && r.houseId === h)?._count._all ?? 0;
                return { sectionId: s.id, section: sectionLabel(s), counts: Object.fromEntries(houses.map((h) => [h.id, of(h.id)])), none: of(null) };
            }),
    };
};

export const strengthFor = async (userId: string) => {
    await need(userId, ['cocurricular.view', 'house.manage']);
    await ensureOn();
    return strength((await thisYear()).id);
};

/** The students of a house (optionally of one section). */
export const houseStudents = async (houseId: string, sectionId: string | undefined, userId: string) => {
    await need(userId, ['cocurricular.view', 'house.manage']);
    const year = await thisYear();
    const rows = await db.enrolment.findMany({ where: { academicYearId: year.id, houseId: houseId === 'none' ? null : houseId, ...(sectionId ? { sectionId } : {}), student: { status: 'active' } }, select: { studentId: true } });
    const info = await studentInfo(rows.map((r) => r.studentId), year.id);
    return [...info.values()].sort((a, b) => a.section.localeCompare(b.section, 'en', { numeric: true }) || a.name.localeCompare(b.name));
};

// ─── Allocation ──────────────────────────────────────────────────────────────

export const allocateSchema = z.strictObject({
    /** unassigned = only students without a house; all = everyone again. */
    which: z.enum(['unassigned', 'all']).default('unassigned'),
    classIds: z.array(z.uuid()).max(100).default([]),
    /** true = only show what would happen. */
    preview: z.boolean().default(true),
});

/**
 * Puts students in houses: in each section, each student goes to the house with the fewest students
 * of that section (then of their gender there, then in the whole school); brothers and sisters follow
 * the house one of them already has.
 */
export const allocate = async (input: z.infer<typeof allocateSchema>, userId: string) => {
    await need(userId, ['house.manage']);
    await ensureOn();
    const year = await thisYear();
    const houses = await houseList();
    if (houses.length < 2) throw badRequest('Add at least two houses first (Masters → Houses)');
    const s = await getSettings({ siblings: COCURRICULAR.siblingsTogether, gender: COCURRICULAR.balanceGender });
    const all = await db.enrolment.findMany({ where: { academicYearId: year.id, student: { status: 'active' } }, select: { id: true, studentId: true, sectionId: true, houseId: true, section: { select: { classId: true } }, student: { select: { admissionNo: true, genderId: true, familyId: true } } } });
    const valid = new Set(houses.map((h) => h.id));
    const chosen = (e: (typeof all)[number]) => (!input.classIds.length || input.classIds.includes(e.section.classId)) && (input.which === 'all' || !e.houseId || !valid.has(e.houseId));
    const todo = all.filter(chosen).sort((a, b) => a.student.admissionNo.localeCompare(b.student.admissionNo, 'en', { numeric: true }));
    const kept = all.filter((e) => !chosen(e) && e.houseId && valid.has(e.houseId));
    // Running counts: per section+house, per section+gender+house, per house.
    const bySection = new Map<string, number>();
    const byGender = new Map<string, number>();
    const total = new Map<string, number>();
    const add = (e: { sectionId: string; student: { genderId: string | null } }, h: string) => {
        bySection.set(`${e.sectionId}|${h}`, (bySection.get(`${e.sectionId}|${h}`) ?? 0) + 1);
        byGender.set(`${e.sectionId}|${e.student.genderId}|${h}`, (byGender.get(`${e.sectionId}|${e.student.genderId}|${h}`) ?? 0) + 1);
        total.set(h, (total.get(h) ?? 0) + 1);
    };
    const family = new Map<string, string>();
    for (const e of kept) {
        add(e, e.houseId!);
        if (e.student.familyId) family.set(e.student.familyId, e.houseId!);
    }
    const plan = new Map<string, string>();
    for (const e of todo) {
        let h = s.siblings && e.student.familyId ? family.get(e.student.familyId) : undefined;
        if (!h) {
            h = [...houses]
                .sort((a, b) => (bySection.get(`${e.sectionId}|${a.id}`) ?? 0) - (bySection.get(`${e.sectionId}|${b.id}`) ?? 0) || (s.gender ? (byGender.get(`${e.sectionId}|${e.student.genderId}|${a.id}`) ?? 0) - (byGender.get(`${e.sectionId}|${e.student.genderId}|${b.id}`) ?? 0) : 0) || (total.get(a.id) ?? 0) - (total.get(b.id) ?? 0))[0].id;
        }
        plan.set(e.id, h);
        add(e, h);
        if (e.student.familyId && !family.has(e.student.familyId)) family.set(e.student.familyId, h);
    }
    const result = houses.map((h) => ({ houseId: h.id, name: h.name, colour: h.colour, adding: [...plan.values()].filter((x) => x === h.id).length, total: total.get(h.id) ?? 0 }));
    if (input.preview) return { students: todo.length, houses: result, done: false };
    for (const h of houses) {
        const ids = [...plan.entries()].filter(([, x]) => x === h.id).map(([id]) => id);
        for (let i = 0; i < ids.length; i += 500) await db.enrolment.updateMany({ where: { id: { in: ids.slice(i, i + 500) } }, data: { houseId: h.id } });
    }
    await recordAudit({ action: 'houses_allocated', entity: 'house', entityId: null, changes: { students: todo.length, which: input.which, classes: input.classIds.length || 'all' } });
    return { students: todo.length, houses: result, done: true };
};

/** One student's house this year (house managers, from the student list). */
export const setStudentHouse = async (studentId: string, houseId: string | null, userId: string) => {
    await need(userId, ['house.manage']);
    await ensureOn();
    const year = await thisYear();
    if (houseId && !(await houseList()).some((h) => h.id === houseId)) throw badRequest('Choose a house');
    const r = await db.enrolment.updateMany({ where: { academicYearId: year.id, studentId }, data: { houseId } });
    if (!r.count) throw notFound('The student isn’t enrolled this year');
    return { houseId };
};

// ─── Officials ───────────────────────────────────────────────────────────────

export const officialsSchema = z.strictObject({
    officials: z.array(z.strictObject({ role: z.enum(Object.keys(ROLES) as [string, ...string[]]), staffId: z.uuid().nullable().optional(), studentId: z.uuid().nullable().optional() })).max(30),
});

/** Replaces a house's masters and captains for this year. */
export const setOfficials = async (houseId: string, input: z.infer<typeof officialsSchema>, userId: string) => {
    await need(userId, ['house.manage']);
    await ensureOn();
    const year = await thisYear();
    const house = (await houseList()).find((h) => h.id === houseId);
    if (!house) throw notFound('House not found');
    const info = await studentInfo(input.officials.map((o) => o.studentId!).filter(Boolean), year.id);
    for (const o of input.officials) {
        if (ROLES[o.role].staff ? !o.staffId : !o.studentId) throw badRequest(`Choose the ${ROLES[o.role].staff ? 'teacher' : 'student'} for ${ROLES[o.role].label}`);
        if (o.studentId && info.get(o.studentId)?.houseId !== houseId) throw badRequest(`${info.get(o.studentId)?.name ?? 'That student'} isn’t in ${house.name}`);
    }
    await db.$transaction([
        db.houseOfficial.deleteMany({ where: { academicYearId: year.id, houseId } }),
        db.houseOfficial.createMany({ data: input.officials.map((o) => ({ tenantId: getTenantId()!, academicYearId: year.id, houseId, role: o.role, staffId: ROLES[o.role].staff ? o.staffId! : null, studentId: ROLES[o.role].staff ? null : o.studentId! })) }),
    ]);
    await recordAudit({ action: 'house_officials_set', entity: 'house', entityId: houseId, changes: { house: house.name, officials: input.officials.length } });
    return overview(userId);
};

// ─── Points ──────────────────────────────────────────────────────────────────

export const pointsSchema = z.strictObject({
    houseId: z.uuid(),
    points: z.number().int().min(-1000).max(1000).refine((n) => n !== 0, 'can’t be 0'),
    reason: z.string().trim().min(2, 'is required').max(200),
    studentId: z.uuid().nullable().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const givePoints = async (input: z.infer<typeof pointsSchema>, userId: string) => {
    await need(userId, ['house.points']);
    await ensureOn();
    const year = await thisYear();
    if (!(await houseList()).some((h) => h.id === input.houseId)) throw badRequest('Choose a house');
    await db.housePoint.create({ data: { tenantId: getTenantId()!, academicYearId: year.id, houseId: input.houseId, points: input.points, reason: input.reason, studentId: input.studentId ?? null, givenBy: userId, givenOn: dayDate(input.date ?? isoOf(new Date(Date.now() + 5.5 * 3_600_000))) } });
    await recordAudit({ action: 'house_points', entity: 'house', entityId: input.houseId, changes: { points: input.points, reason: input.reason } });
    return overview(userId);
};

/** Removes points given by hand (points from results change with the results). */
export const removePoints = async (id: string, userId: string) => {
    await need(userId, ['house.points']);
    const r = await db.housePoint.findFirst({ where: { id } });
    if (!r) throw notFound('Not found');
    if (r.competitionId || r.achievementId) throw badRequest('These points come from a result: change the result instead');
    await db.housePoint.delete({ where: { id } });
    await recordAudit({ action: 'house_points_removed', entity: 'house', entityId: r.houseId, changes: { points: r.points, reason: r.reason } });
    return overview(userId);
};

export const pointsQuery = z.object({ house: z.uuid().optional(), page: z.coerce.number().int().min(1).default(1) });
/** Every point of the year, newest first. */
export const pointsLog = async (q: z.infer<typeof pointsQuery>, userId: string) => {
    await need(userId, ['cocurricular.view', 'house.manage', 'house.points']);
    const year = await thisYear();
    const where = { academicYearId: year.id, ...(q.house ? { houseId: q.house } : {}) };
    const [total, rows] = await Promise.all([db.housePoint.count({ where }), db.housePoint.findMany({ where, orderBy: [{ givenOn: 'desc' }, { createdAt: 'desc' }], skip: (q.page - 1) * 50, take: 50 })]);
    const [names, info, users] = await Promise.all([masterNames(rows.map((r) => r.houseId)), studentInfo(rows.map((r) => r.studentId!).filter(Boolean), year.id), db.user.findMany({ where: { id: { in: rows.map((r) => r.givenBy!).filter(Boolean) } }, select: { id: true, displayName: true } })]);
    return { total, page: q.page, pageSize: 50, rows: rows.map((r) => ({ id: r.id, house: names.get(r.houseId) ?? '', houseId: r.houseId, points: r.points, reason: r.reason, student: r.studentId ? (info.get(r.studentId)?.name ?? null) : null, date: isoOf(r.givenOn), by: users.find((u) => u.id === r.givenBy)?.displayName ?? null, fromResult: !!(r.competitionId || r.achievementId) })) };
};


