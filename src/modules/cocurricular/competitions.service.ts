import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { dayDate, isoOf } from '../attendance/attendance.settings';
import { raiseLater } from '../alerts/deliver';
import { parentsOf, studentsOf } from '../alerts/recipients';
import { COCURRICULAR } from './cocurricular.settings';
import { houseList, housesOn, masterNames, myStudents, need, perms, staffNames, studentInfo, thisYear } from './cocurricular.common';
import { standings } from './houses.service';
import { MEMBER_ROLES, openClubsFor } from './clubs.service';

/**
 * Competitions: in the school (class level, inter-house) or outside (inter-school, district…), for
 * individuals or teams. Entries and results (1st / 2nd / 3rd, awards) give house points from System
 * Settings → Co-curricular; results can be shown to students and parents, and certificates printed.
 * Outside achievements a student brings back are recorded too. Competitions can sit on the school
 * calendar.
 */

const ORDINAL = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;
const today = () => isoOf(new Date(Date.now() + 5.5 * 3_600_000));

const loadComp = async (id: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Competition not found');
    const c = await db.competition.findFirst({ where: { id }, include: { entries: { orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }] } } });
    if (!c) throw notFound('Competition not found');
    return c;
};

export const competitionOptions = async () => {
    const [categories, levels, classes, staff, clubs, houses, on] = await Promise.all([
        db.masterValue.findMany({ where: { master: 'competition_category', isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } }),
        db.masterValue.findMany({ where: { master: 'competition_level', isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, extra: true } }),
        db.schoolClass.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } }),
        db.staff.findMany({ where: { status: 'working' }, orderBy: { firstName: 'asc' }, select: { id: true, firstName: true, middleName: true, lastName: true } }),
        db.club.findMany({ where: { isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
        houseList(),
        housesOn(),
    ]);
    const s = await getSettings({ first: COCURRICULAR.pointsFirst, second: COCURRICULAR.pointsSecond, third: COCURRICULAR.pointsThird, part: COCURRICULAR.pointsTakingPart, team: COCURRICULAR.teamTimes, ach: COCURRICULAR.achievementPoints });
    return {
        categories,
        levels: levels.map((l) => ({ id: l.id, name: l.name, inSchool: !!(l.extra as { inSchool?: boolean } | null)?.inSchool })),
        classes,
        staff: staff.map((x) => ({ id: x.id, name: [x.firstName, x.middleName, x.lastName].filter(Boolean).join(' ') })),
        clubs,
        houses: on ? houses : [],
        housesOn: on,
        points: { first: s.first, second: s.second, third: s.third, takingPart: s.part, teamTimes: s.team, achievements: on && s.ach },
    };
};

// ─── List and one ────────────────────────────────────────────────────────────

export const listQuery = z.object({
    status: z.enum(['upcoming', 'done', 'cancelled']).optional(),
    category: z.uuid().optional(),
    level: z.uuid().optional(),
    search: z.string().trim().max(60).optional(),
    page: z.coerce.number().int().min(1).default(1),
});

export const listCompetitions = async (q: z.infer<typeof listQuery>, userId: string) => {
    const p = await need(userId, ['cocurricular.view', 'competition.manage']);
    const year = await thisYear();
    const where: Prisma.CompetitionWhereInput = { academicYearId: year.id, ...(q.status ? { status: q.status } : {}), ...(q.category ? { categoryId: q.category } : {}), ...(q.level ? { levelId: q.level } : {}), ...(q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {}) };
    const [total, rows] = await Promise.all([
        db.competition.count({ where }),
        db.competition.findMany({ where, orderBy: [{ status: 'desc' }, { date: q.status === 'done' ? 'desc' : 'asc' }], skip: (q.page - 1) * 25, take: 25, include: { entries: { select: { position: true, teamName: true, houseId: true, studentIds: true } } } }),
    ]);
    const [m, info] = await Promise.all([masterNames([...rows.map((r) => r.categoryId), ...rows.map((r) => r.levelId), ...rows.flatMap((r) => r.entries.map((e) => e.houseId))]), studentInfo(rows.flatMap((r) => r.entries.filter((e) => e.position === 1).flatMap((e) => e.studentIds)), year.id)]);
    return {
        total,
        page: q.page,
        pageSize: 25,
        rows: rows.map((r) => {
            const win = r.entries.find((e) => e.position === 1);
            return { id: r.id, name: r.name, category: m.get(r.categoryId ?? '') ?? null, level: m.get(r.levelId ?? '') ?? null, date: isoOf(r.date), endDate: r.endDate ? isoOf(r.endDate) : null, venue: r.venue, kind: r.kind, byHouse: r.byHouse, status: r.status, resultsOut: r.resultsOut, entries: r.entries.length, winner: win ? win.teamName || (win.houseId ? m.get(win.houseId) : null) || win.studentIds.map((s) => info.get(s)?.name ?? '').join(', ') : null };
        }),
        can: { manage: !!p['competition.manage'] },
    };
};

export const getCompetition = async (id: string, userId: string) => {
    const p = await need(userId, ['cocurricular.view', 'competition.manage']);
    const c = await loadComp(id);
    const [m, info, staff, club, houses] = await Promise.all([
        masterNames([c.categoryId, c.levelId]),
        studentInfo(c.entries.flatMap((e) => e.studentIds), c.academicYearId),
        staffNames([c.inchargeId]),
        c.clubId ? db.club.findFirst({ where: { id: c.clubId }, select: { name: true } }) : null,
        houseList(true),
    ]);
    return {
        id: c.id,
        name: c.name,
        categoryId: c.categoryId,
        category: m.get(c.categoryId ?? '') ?? null,
        levelId: c.levelId,
        level: m.get(c.levelId ?? '') ?? null,
        date: isoOf(c.date),
        endDate: c.endDate ? isoOf(c.endDate) : null,
        venue: c.venue,
        description: c.description,
        classIds: c.classIds,
        kind: c.kind,
        byHouse: c.byHouse,
        inchargeId: c.inchargeId,
        incharge: staff.get(c.inchargeId ?? '') ?? null,
        clubId: c.clubId,
        club: club?.name ?? null,
        onCalendar: !!c.schoolEventId,
        status: c.status,
        resultsOut: c.resultsOut,
        entries: c.entries.map((e) => ({
            id: e.id,
            teamName: e.teamName,
            houseId: e.houseId,
            house: houses.find((h) => h.id === e.houseId) ?? null,
            students: e.studentIds.map((s) => ({ id: s, name: info.get(s)?.name ?? '', section: info.get(s)?.section ?? '', houseId: info.get(s)?.houseId ?? null })),
            position: e.position,
            award: e.award,
            points: e.points,
            remark: e.remark,
        })),
        can: { manage: !!p['competition.manage'] },
    };
};

// ─── Add, change, remove ─────────────────────────────────────────────────────

export const competitionSchema = z.strictObject({
    name: z.string().trim().min(2, 'is required').max(150),
    categoryId: z.uuid().nullable().optional(),
    levelId: z.uuid().nullable().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    venue: z.string().trim().max(150).nullable().optional(),
    description: z.string().trim().max(3000).nullable().optional(),
    classIds: z.array(z.uuid()).max(100).default([]),
    kind: z.enum(['individual', 'team']).default('individual'),
    byHouse: z.boolean().default(false),
    inchargeId: z.uuid().nullable().optional(),
    clubId: z.uuid().nullable().optional(),
    onCalendar: z.boolean().default(true),
    status: z.enum(['upcoming', 'done', 'cancelled']).optional(),
});
type CompInput = z.infer<typeof competitionSchema>;

const compData = (i: CompInput) => {
    if (i.endDate && i.endDate < i.date) throw badRequest('The end date is before the start', [{ field: 'endDate', message: 'is before the start' }]);
    return { name: i.name, categoryId: i.categoryId ?? null, levelId: i.levelId ?? null, date: dayDate(i.date), endDate: i.endDate ? dayDate(i.endDate) : null, venue: i.venue || null, description: i.description || null, classIds: i.classIds, kind: i.kind, byHouse: i.byHouse, inchargeId: i.inchargeId ?? null, clubId: i.clubId ?? null };
};

/** Keeps the competition's event on the school calendar in step (or removes it). */
const syncCalendar = async (id: string, userId: string) => {
    const c = await db.competition.findFirst({ where: { id } });
    if (!c) return;
    if (!c.schoolEventId) return;
    const type = await db.masterValue.findFirst({ where: { master: 'event_type', name: { in: ['Competition', 'Sports', 'Cultural programme'] } }, select: { id: true } });
    const data = { title: c.name, typeId: type?.id ?? null, startDate: c.date, endDate: c.endDate ?? c.date, venue: c.venue, description: c.description, forAllStaff: true, forStudents: true, forParents: true, classIds: c.classIds, status: c.status === 'cancelled' ? 'cancelled' : 'scheduled', updatedBy: userId };
    await db.schoolEvent.updateMany({ where: { id: c.schoolEventId }, data });
};
const putOnCalendar = async (id: string, on: boolean, userId: string) => {
    const c = await db.competition.findFirst({ where: { id } });
    if (!c) return;
    if (on && !c.schoolEventId) {
        const e = await db.schoolEvent.create({ data: { tenantId: getTenantId()!, title: c.name, startDate: c.date, endDate: c.endDate ?? c.date, createdBy: userId } });
        await db.competition.update({ where: { id }, data: { schoolEventId: e.id } });
    } else if (!on && c.schoolEventId) {
        await db.schoolEvent.deleteMany({ where: { id: c.schoolEventId } });
        await db.competition.update({ where: { id }, data: { schoolEventId: null } });
    }
    await syncCalendar(id, userId);
};

export const createCompetition = async (input: CompInput, userId: string) => {
    await need(userId, ['competition.manage']);
    const year = await thisYear();
    const c = await db.competition.create({ data: { tenantId: getTenantId()!, academicYearId: year.id, createdBy: userId, ...compData(input) } });
    await putOnCalendar(c.id, input.onCalendar, userId);
    await recordAudit({ action: 'competition_created', entity: 'competition', entityId: c.id, changes: { name: c.name } });
    return getCompetition(c.id, userId);
};

export const updateCompetition = async (id: string, input: CompInput, userId: string) => {
    await need(userId, ['competition.manage']);
    await loadComp(id);
    await db.competition.update({ where: { id }, data: { ...compData(input), ...(input.status ? { status: input.status } : {}) } });
    await putOnCalendar(id, input.onCalendar, userId);
    await syncHousePoints(id, userId);
    await recordAudit({ action: 'competition_updated', entity: 'competition', entityId: id, changes: { name: input.name } });
    return getCompetition(id, userId);
};

export const deleteCompetition = async (id: string, userId: string) => {
    await need(userId, ['competition.manage']);
    const c = await loadComp(id);
    await db.$transaction([db.housePoint.deleteMany({ where: { competitionId: id } }), ...(c.schoolEventId ? [db.schoolEvent.deleteMany({ where: { id: c.schoolEventId } })] : []), db.competition.delete({ where: { id } })]);
    await recordAudit({ action: 'competition_deleted', entity: 'competition', entityId: id, changes: { name: c.name } });
    return { id, deleted: true };
};

// ─── Entries and results ─────────────────────────────────────────────────────

export const entriesSchema = z.strictObject({
    entries: z
        .array(
            z.strictObject({
                id: z.uuid().nullable().optional(),
                teamName: z.string().trim().max(100).nullable().optional(),
                houseId: z.uuid().nullable().optional(),
                studentIds: z.array(z.uuid()).max(60).default([]),
                position: z.number().int().min(1).max(50).nullable().optional(),
                award: z.string().trim().max(100).nullable().optional(),
                /** House points by hand (empty = from System Settings). */
                points: z.number().int().min(0).max(1000).nullable().optional(),
                remark: z.string().trim().max(300).nullable().optional(),
            })
        )
        .max(500),
    /** The competition is over and these are the results. */
    done: z.boolean().optional(),
    /** Show the results to students and parents. */
    resultsOut: z.boolean().optional(),
});

/** Points a result gives from the settings (team events count more). */
const pointsFor = async (position: number | null | undefined, kind: string) => {
    const s = await getSettings({ first: COCURRICULAR.pointsFirst, second: COCURRICULAR.pointsSecond, third: COCURRICULAR.pointsThird, part: COCURRICULAR.pointsTakingPart, team: COCURRICULAR.teamTimes });
    const base = position === 1 ? s.first : position === 2 ? s.second : position === 3 ? s.third : s.part;
    return base * (kind === 'team' ? s.team : 1);
};

/** Replaces the entries (and results); then the house points and, the first time results go out, the alerts. */
export const saveEntries = async (id: string, input: z.infer<typeof entriesSchema>, userId: string) => {
    await need(userId, ['competition.manage']);
    const c = await loadComp(id);
    if (c.status === 'cancelled') throw badRequest('The competition is cancelled');
    const info = await studentInfo([...new Set(input.entries.flatMap((e) => e.studentIds))], c.academicYearId);
    const houses = new Set((await houseList(true)).map((h) => h.id));
    const seen = new Set<string>();
    for (const [n, e] of input.entries.entries()) {
        const label = `Entry ${n + 1}`;
        if (c.kind === 'individual' && e.studentIds.length !== 1) throw badRequest(`${label}: choose one student`);
        if (c.kind === 'team' && !e.studentIds.length && !e.houseId && !e.teamName) throw badRequest(`${label}: give the team a name, a house or its students`);
        if (e.houseId && !houses.has(e.houseId)) throw badRequest(`${label}: choose a house`);
        for (const s of e.studentIds) {
            const st = info.get(s);
            if (!st?.sectionId) throw badRequest(`${label}: a student isn’t enrolled this year`);
            if (c.classIds.length && !c.classIds.includes(st.classId!)) throw badRequest(`${st.name}’s class isn’t in this competition`);
            if (seen.has(s)) throw badRequest(`${st.name} is in two entries`);
            seen.add(s);
        }
    }
    const done = input.done ?? (c.status === 'done' || input.entries.some((e) => e.position));
    const keep = input.entries.map((e) => e.id).filter((x): x is string => !!x);
    await db.$transaction(async (tx) => {
        await tx.competitionEntry.deleteMany({ where: { competitionId: id, id: { notIn: keep } } });
        for (const e of input.entries) {
            const data = { teamName: e.teamName || null, houseId: e.houseId ?? null, studentIds: e.studentIds, position: e.position ?? null, award: e.award || null, points: e.points ?? (done ? await pointsFor(e.position, c.kind) : 0), remark: e.remark || null };
            if (e.id && c.entries.some((x) => x.id === e.id)) await tx.competitionEntry.update({ where: { id: e.id }, data });
            else await tx.competitionEntry.create({ data: { tenantId: getTenantId()!, competitionId: id, ...data } });
        }
        await tx.competition.update({ where: { id }, data: { status: done ? 'done' : 'upcoming', ...(input.resultsOut !== undefined ? { resultsOut: input.resultsOut && done } : {}) } });
    });
    await syncHousePoints(id, userId);
    const after = await loadComp(id);
    if (after.resultsOut && !c.resultsOut) await tellResults(after);
    await recordAudit({ action: done ? 'competition_results' : 'competition_entries', entity: 'competition', entityId: id, changes: { entries: input.entries.length, resultsOut: after.resultsOut } });
    return getCompetition(id, userId);
};

/** Gives the competition's house points again from its results (by-house competitions that are done). */
const syncHousePoints = async (id: string, userId: string) => {
    const c = await loadComp(id);
    await db.housePoint.deleteMany({ where: { competitionId: id } });
    if (!c.byHouse || c.status !== 'done' || !(await housesOn())) return;
    const info = await studentInfo(c.entries.flatMap((e) => e.studentIds), c.academicYearId);
    const rows: Prisma.HousePointCreateManyInput[] = [];
    for (const e of c.entries) {
        if (!e.points) continue;
        const what = `${c.name}: ${e.position ? ORDINAL(e.position) : 'took part'}${e.award ? ` (${e.award})` : ''}`;
        // The team's house, or (one student / a team of one house) the students' house.
        const houses = [...new Set(e.studentIds.map((s) => info.get(s)?.houseId).filter((h): h is string => !!h))];
        const house = e.houseId ?? (houses.length === 1 ? houses[0] : null);
        if (!house) continue;
        rows.push({ tenantId: getTenantId()!, academicYearId: c.academicYearId, houseId: house, points: e.points, reason: what, competitionId: id, entryId: e.id, studentId: e.studentIds.length === 1 ? e.studentIds[0] : null, givenBy: userId, givenOn: c.endDate ?? c.date });
    }
    if (rows.length) await db.housePoint.createMany({ data: rows });
};

/** Students in the results (and their parents) are told. */
const tellResults = async (c: Awaited<ReturnType<typeof loadComp>>) => {
    const { on } = await getSettings({ on: COCURRICULAR.resultsToParents });
    if (!on) return;
    for (const e of c.entries) {
        if (!e.studentIds.length) continue;
        const result = e.position ? `${ORDINAL(e.position)} place${e.award ? ` (${e.award})` : ''}` : e.award || 'took part';
        raiseLater('competition_result', { parent: () => parentsOf(e.studentIds), student: () => studentsOf(e.studentIds) }, { competition: c.name, result, date: isoOf(c.date) }, { dedupe: `competition-result:${e.id}` });
    }
};

// ─── Outside achievements ────────────────────────────────────────────────────

export const achievementSchema = z.strictObject({
    studentId: z.uuid(),
    title: z.string().trim().min(2, 'is required').max(150),
    categoryId: z.uuid().nullable().optional(),
    levelId: z.uuid().nullable().optional(),
    result: z.string().trim().max(100).nullable().optional(),
    organiser: z.string().trim().max(150).nullable().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    certificateId: z.uuid().nullable().optional(),
    points: z.number().int().min(0).max(1000).default(0),
});

export const achievementsQuery = z.object({ search: z.string().trim().max(60).optional(), level: z.uuid().optional(), page: z.coerce.number().int().min(1).default(1) });

export const listAchievements = async (q: z.infer<typeof achievementsQuery>, userId: string) => {
    const p = await need(userId, ['cocurricular.view', 'achievement.record']);
    const year = await thisYear();
    const ids = q.search ? (await db.student.findMany({ where: { OR: [{ firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }, { admissionNo: { contains: q.search, mode: 'insensitive' } }] }, select: { id: true }, take: 300 })).map((s) => s.id) : null;
    const where: Prisma.AchievementWhereInput = { academicYearId: year.id, ...(q.level ? { levelId: q.level } : {}), ...(ids ? { studentId: { in: ids } } : {}) };
    const [total, rows] = await Promise.all([db.achievement.count({ where }), db.achievement.findMany({ where, orderBy: { date: 'desc' }, skip: (q.page - 1) * 25, take: 25 })]);
    const [info, m] = await Promise.all([studentInfo(rows.map((r) => r.studentId), year.id), masterNames([...rows.map((r) => r.categoryId), ...rows.map((r) => r.levelId)])]);
    return { total, page: q.page, pageSize: 25, rows: rows.map((r) => ({ id: r.id, studentId: r.studentId, student: info.get(r.studentId)?.name ?? '', section: info.get(r.studentId)?.section ?? '', title: r.title, category: m.get(r.categoryId ?? '') ?? null, level: m.get(r.levelId ?? '') ?? null, result: r.result, organiser: r.organiser, date: isoOf(r.date), certificateId: r.certificateId, points: r.points })), can: { record: !!p['achievement.record'] } };
};

export const recordAchievement = async (input: z.infer<typeof achievementSchema>, userId: string) => {
    await need(userId, ['achievement.record']);
    const year = await thisYear();
    const st = (await studentInfo([input.studentId], year.id)).get(input.studentId);
    if (!st?.sectionId) throw badRequest('That student isn’t enrolled this year');
    if (input.date > today()) throw badRequest('The date is in the future', [{ field: 'date', message: 'is in the future' }]);
    const { ach } = await getSettings({ ach: COCURRICULAR.achievementPoints });
    const points = ach && (await housesOn()) && st.houseId ? input.points : 0;
    const a = await db.achievement.create({ data: { tenantId: getTenantId()!, academicYearId: year.id, studentId: input.studentId, title: input.title, categoryId: input.categoryId ?? null, levelId: input.levelId ?? null, result: input.result || null, organiser: input.organiser || null, date: dayDate(input.date), certificateId: input.certificateId ?? null, points, recordedBy: userId } });
    if (points) await db.housePoint.create({ data: { tenantId: getTenantId()!, academicYearId: year.id, houseId: st.houseId!, points, reason: `${input.title}${input.result ? `: ${input.result}` : ''}`, achievementId: a.id, studentId: input.studentId, givenBy: userId, givenOn: dayDate(input.date) } });
    await recordAudit({ action: 'achievement_recorded', entity: 'achievement', entityId: a.id, changes: { student: st.name, title: input.title } });
    return { id: a.id };
};

export const deleteAchievement = async (id: string, userId: string) => {
    await need(userId, ['achievement.record']);
    const a = await db.achievement.findFirst({ where: { id } });
    if (!a) throw notFound('Not found');
    await db.$transaction([db.housePoint.deleteMany({ where: { achievementId: id } }), db.achievement.delete({ where: { id } })]);
    await recordAudit({ action: 'achievement_deleted', entity: 'achievement', entityId: id, changes: { title: a.title } });
    return { id, deleted: true };
};

/** An achievement's certificate photo, for staff who see achievements or the student's family. */
export const achievementFile = async (id: string, userId: string) => {
    const a = await db.achievement.findFirst({ where: { id } });
    if (!a?.certificateId) throw notFound('Not found');
    const p = await perms(userId);
    if (p['cocurricular.view'] || p['achievement.record']) return a.certificateId;
    if (p['cocurricular.mine'] && (await myStudents(userId)).some((k) => k.id === a.studentId)) return a.certificateId;
    throw forbidden();
};

// ─── A student's activities (profile, parents, students) ─────────────────────

/** House, clubs, competitions and achievements of one student (every year). */
const activitiesOf = async (studentId: string, forFamily: boolean) => {
    const year = await thisYear();
    const [enrol, clubs, entries, achievements, points] = await Promise.all([
        db.enrolment.findFirst({ where: { academicYearId: year.id, studentId }, select: { houseId: true, section: { select: { classId: true } } } }),
        db.clubMember.findMany({ where: { studentId, status: { in: ['active', 'requested', 'left'] } }, include: { club: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }),
        db.competitionEntry.findMany({ where: { studentIds: { has: studentId }, ...(forFamily ? { competition: { status: { not: 'cancelled' } } } : {}) }, include: { competition: true }, orderBy: { competition: { date: 'desc' } } }),
        db.achievement.findMany({ where: { studentId }, orderBy: { date: 'desc' } }),
        db.housePoint.aggregate({ where: { academicYearId: year.id, studentId }, _sum: { points: true } }),
    ]);
    const [years, m, houses, table] = await Promise.all([
        db.academicYear.findMany({ where: { id: { in: [...new Set([...clubs.map((c) => c.academicYearId), ...entries.map((e) => e.competition.academicYearId), ...achievements.map((a) => a.academicYearId)])] } }, select: { id: true, name: true } }),
        masterNames([...entries.map((e) => e.competition.categoryId), ...entries.map((e) => e.competition.levelId), ...achievements.map((a) => a.levelId), ...achievements.map((a) => a.categoryId)]),
        houseList(true),
        (await housesOn()) ? standings(year.id) : Promise.resolve([]),
    ]);
    const yearName = (id: string) => years.find((y) => y.id === id)?.name ?? '';
    const house = enrol?.houseId ? table.find((h) => h.id === enrol.houseId) ?? houses.find((h) => h.id === enrol.houseId) : null;
    const officer = enrol?.houseId ? await db.houseOfficial.findFirst({ where: { academicYearId: year.id, studentId } }) : null;
    return {
        house: house ? { id: house.id, name: house.name, colour: house.colour, rank: 'rank' in house ? house.rank : null, points: 'points' in house ? house.points : null, of: table.length, role: officer ? officer.role : null, myPoints: points._sum.points ?? 0 } : null,
        clubs: clubs.filter((c) => !forFamily || c.status !== 'left' || c.academicYearId === year.id).map((c) => ({ id: c.id, clubId: c.clubId, club: c.club.name, year: yearName(c.academicYearId), current: c.academicYearId === year.id, status: c.status, role: MEMBER_ROLES[c.role] ?? c.role, grade: c.grade, remark: c.remark })),
        competitions: entries.map((e) => {
            const show = !forFamily || e.competition.resultsOut;
            return { id: e.id, competitionId: e.competition.id, name: e.competition.name, category: m.get(e.competition.categoryId ?? '') ?? null, level: m.get(e.competition.levelId ?? '') ?? null, date: isoOf(e.competition.date), year: yearName(e.competition.academicYearId), status: e.competition.status, team: e.teamName, position: show ? e.position : null, award: show ? e.award : null, resultsOut: e.competition.resultsOut };
        }),
        achievements: achievements.map((a) => ({ id: a.id, title: a.title, level: m.get(a.levelId ?? '') ?? null, category: m.get(a.categoryId ?? '') ?? null, result: a.result, organiser: a.organiser, date: isoOf(a.date), year: yearName(a.academicYearId), hasCertificate: !!a.certificateId })),
        classId: enrol?.section.classId ?? null,
        yearId: year.id,
    };
};

/** The student profile's "Activities" tab. */
export const studentActivities = async (studentId: string, userId: string) => {
    await need(userId, ['cocurricular.view', 'house.manage', 'club.manage', 'competition.manage', 'achievement.record']);
    const a = await activitiesOf(studentId, false);
    return { house: a.house, clubs: a.clubs, competitions: a.competitions, achievements: a.achievements };
};

/** A parent's (or student's) view: each child's house, clubs, results, achievements, clubs they can ask to join, and the house table. */
export const myActivities = async (userId: string) => {
    await need(userId, ['cocurricular.mine']);
    const kids = await myStudents(userId);
    const year = await thisYear();
    const on = await housesOn();
    const children = [];
    for (const k of kids) {
        const a = await activitiesOf(k.id, true);
        const upcoming = await db.competition.findMany({ where: { academicYearId: year.id, status: 'upcoming', date: { gte: dayDate(today()) }, OR: [{ classIds: { isEmpty: true } }, ...(a.classId ? [{ classIds: { has: a.classId } }] : [])] }, orderBy: { date: 'asc' }, take: 5, select: { id: true, name: true, date: true, venue: true } });
        children.push({ id: k.id, name: [k.firstName, k.middleName, k.lastName].filter(Boolean).join(' '), house: a.house, clubs: a.clubs, competitions: a.competitions, achievements: a.achievements, openClubs: await openClubsFor(k.id, a.classId, a.yearId), upcoming: upcoming.map((u) => ({ id: u.id, name: u.name, date: isoOf(u.date), venue: u.venue })) });
    }
    return { housesOn: on, standings: on ? await standings(year.id) : [], children };
};
