import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { currentYear } from '../academic/years.service';
import { staffName } from '../staff/staff.service';
import { TIMETABLE } from './timetable.settings';
import { sectionLabel, weekOf, yearOf } from './tt-setup.service';
import { GenLesson, GenRule, generateTimetable } from './generator';

/** Timetables: generating a draft, editing it, publishing, and the class / teacher / my views. */

const uuidOk = (id: string) => z.uuid().safeParse(id).success;

const findTimetable = async (id: string) => {
    const t = uuidOk(id) ? await db.timetable.findUnique({ where: { id } }) : null;
    if (!t) throw notFound('Timetable not found');
    return t;
};
const draftOnly = async (id: string) => {
    const t = await findTimetable(id);
    if (t.status !== 'draft') throw conflict('Only a draft can be changed: make a copy of the published timetable to edit it');
    return t;
};

export const listTimetables = async (yearId: string) => {
    await yearOf(yearId);
    const rows = await db.timetable.findMany({ where: { academicYearId: yearId }, include: { _count: { select: { entries: true } } }, orderBy: { createdAt: 'desc' } });
    return rows.map((t) => ({ id: t.id, name: t.name, status: t.status, entries: t._count.entries, unplaced: (t.unplaced as unknown[]).length, generatedAt: t.generatedAt, publishedAt: t.publishedAt, createdAt: t.createdAt, updatedAt: t.updatedAt }));
};

/** The published timetable of a year (current year by default). */
export const publishedOf = async (yearId?: string) => {
    const year = yearId ?? (await currentYear())?.id;
    if (!year) return null;
    return db.timetable.findFirst({ where: { academicYearId: year, status: 'published' } });
};

// ─── Generating ──────────────────────────────────────────────────────────────

/** What the generator needs, from the set-up: lessons of every section, teachers' rules. */
const buildLessons = async (yearId: string) => {
    const [sections, loads, assignments] = await Promise.all([
        db.section.findMany({ where: { academicYearId: yearId, isActive: true }, select: { id: true, classId: true, streamId: true, classTeacherId: true } }),
        db.ttLoad.findMany({ where: { academicYearId: yearId } }),
        db.teachingAssignment.findMany({ where: { academicYearId: yearId }, select: { sectionId: true, subjectId: true, staffId: true } }),
    ]);
    const teacher = new Map(assignments.map((a) => [`${a.sectionId}|${a.subjectId}`, a.staffId]));
    const lessons: GenLesson[] = [];
    const noTeacher: { sectionId: string; subjectId: string }[] = [];
    for (const sec of sections) {
        const mine = loads.filter((l) => l.classId === sec.classId && (!l.streamId || l.streamId === sec.streamId));
        const groups = new Map<string, typeof mine>();
        for (const l of mine) {
            const key = l.parallelGroup ? `g:${l.parallelGroup.toLowerCase()}:${l.streamId ?? ''}` : `s:${l.subjectId}`;
            groups.set(key, [...(groups.get(key) ?? []), l]);
        }
        for (const [key, list] of groups) {
            const subjects = list.map((l) => {
                const staffId = teacher.get(`${sec.id}|${l.subjectId}`) ?? null;
                if (!staffId) noTeacher.push({ sectionId: sec.id, subjectId: l.subjectId });
                return { subjectId: l.subjectId, staffId, roomId: l.roomId };
            });
            lessons.push({
                key: `${sec.id}|${key}`,
                sectionId: sec.id,
                subjects,
                perWeek: Math.max(...list.map((l) => l.perWeek)),
                doubles: Math.min(...list.map((l) => l.doubles)),
                classTeacher: subjects.length === 1 && !!sec.classTeacherId && subjects[0].staffId === sec.classTeacherId,
            });
        }
    }
    return { lessons, noTeacher, sections };
};

const loadRules = async (yearId: string) => {
    const s = await getSettings({ maxPerDay: TIMETABLE.maxPerDay, maxPerWeek: TIMETABLE.maxPerWeek });
    const rows = await db.ttTeacherRule.findMany({ where: { academicYearId: yearId } });
    const rules = new Map<string, GenRule>(
        rows.map((r) => [r.staffId, { maxPerDay: r.maxPerDay ?? s.maxPerDay, maxPerWeek: r.maxPerWeek ?? s.maxPerWeek, unavailable: new Set((r.unavailable as { weekday: number; periodNo: number }[]).map((u) => `${u.weekday}:${u.periodNo}`)) }])
    );
    return { rules, fallback: { maxPerDay: s.maxPerDay, maxPerWeek: s.maxPerWeek, unavailable: new Set<string>() } };
};

export const generateSchema = z.strictObject({
    /** Generate again into this draft (its locked periods stay); empty = a new draft. */
    timetableId: z.uuid().optional(),
    name: z.string().trim().max(60).optional(),
});

export const generate = async (yearId: string, input: z.infer<typeof generateSchema>, opts: { isDemo?: boolean; seed?: number } = {}) => {
    const year = await yearOf(yearId);
    const days = await weekOf(yearId);
    if (!days.length) throw badRequest('Set up the bell schedule and school days first (Timetable Setup)');
    const { lessons, noTeacher } = await buildLessons(yearId);
    if (!lessons.length) throw badRequest('Set the periods per week of the subjects first (Timetable Setup → Periods)');
    const draft = input.timetableId ? await draftOnly(input.timetableId) : null;
    const lockedRows = draft ? await db.ttEntry.findMany({ where: { timetableId: draft.id, locked: true } }) : [];
    const { rules, fallback } = await loadRules(yearId);
    const s = await getSettings({ attempts: TIMETABLE.attempts, classTeacherFirst: TIMETABLE.classTeacherFirst, maxSame: TIMETABLE.maxSamePerDay });
    const started = Date.now();
    const result = generateTimetable({
        days: days.map((d) => ({ weekday: d.weekday, periods: d.periods.length, breakAfter: d.breakAfter })),
        lessons,
        rules,
        fallback,
        locked: lockedRows.map((e) => ({ sectionId: e.sectionId, weekday: e.weekday, periodNo: e.periodNo, subjectId: e.subjectId, staffId: e.staffId, roomId: e.roomId, locked: true })),
        options: { attempts: s.attempts, classTeacherFirst: s.classTeacherFirst, maxSamePerDay: s.maxSame, seed: opts.seed ?? Date.now() % 100000 },
    });
    const tenantId = getTenantId()!;
    const unplaced = result.unplaced as unknown as Prisma.InputJsonValue;
    const timetableId = await withTransaction(
        async (tx) => {
            const t = draft
                ? await tx.timetable.update({ where: { id: draft.id }, data: { unplaced, generatedAt: new Date(), ...(input.name ? { name: input.name } : {}) } })
                : await tx.timetable.create({ data: { tenantId, academicYearId: yearId, name: input.name || `Draft ${new Date().toLocaleDateString('en-IN')}`, unplaced, generatedAt: new Date(), isDemo: opts.isDemo ?? false } });
            await tx.ttEntry.deleteMany({ where: { timetableId: t.id, locked: false } });
            const fresh = result.entries.filter((e) => !e.locked);
            for (let i = 0; i < fresh.length; i += 1000) await tx.ttEntry.createMany({ data: fresh.slice(i, i + 1000).map((e) => ({ tenantId, timetableId: t.id, ...e })) });
            return t.id;
        },
        { timeout: 120_000 }
    );
    await recordAudit({ action: 'timetable_generated', entity: 'timetable', entityId: timetableId, changes: { placed: result.placed, wanted: result.wanted, year: year.name } });
    return { timetableId, placed: result.placed, wanted: result.wanted, unplaced: result.unplaced.length, noTeacher: noTeacher.length, seconds: Math.round((Date.now() - started) / 100) / 10 };
};

// ─── Reading ─────────────────────────────────────────────────────────────────

const entryInclude = {
    subject: { select: { id: true, name: true, code: true } },
    staff: { select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true } },
    room: { select: { id: true, name: true, code: true } },
    section: { select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } }, stream: { select: { name: true } } } },
} satisfies Prisma.TtEntryInclude;
type EntryRow = Prisma.TtEntryGetPayload<{ include: typeof entryInclude }>;
const presentEntry = (e: EntryRow) => ({
    id: e.id,
    weekday: e.weekday,
    periodNo: e.periodNo,
    subject: { id: e.subject.id, name: e.subject.name, code: e.subject.code },
    staff: e.staff ? { id: e.staff.id, name: staffName(e.staff), code: e.staff.employeeCode } : null,
    room: e.room,
    section: { id: e.section.id, label: sectionLabel(e.section) },
    locked: e.locked,
});

/** Overview of a timetable: its sections and teachers (for the pickers), and what is missing. */
export const timetableOverview = async (id: string) => {
    const t = await findTimetable(id);
    const [days, sections, staffIds, counts] = await Promise.all([
        weekOf(t.academicYearId),
        db.section.findMany({ where: { academicYearId: t.academicYearId, isActive: true }, include: { schoolClass: { select: { name: true, shortName: true, sortOrder: true } }, stream: { select: { name: true } } }, orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }] }),
        db.ttEntry.findMany({ where: { timetableId: id, staffId: { not: null } }, distinct: ['staffId'], select: { staffId: true } }),
        db.ttEntry.groupBy({ by: ['sectionId'], where: { timetableId: id }, _count: { _all: true } }),
    ]);
    const staff = await db.staff.findMany({ where: { id: { in: staffIds.map((s) => s.staffId!) } }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true }, orderBy: { firstName: 'asc' } });
    const subjectIds = [...new Set((t.unplaced as { subjectIds: string[] }[]).flatMap((u) => u.subjectIds))];
    const subjects = new Map((await db.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
    const secLabel = new Map(sections.map((s) => [s.id, sectionLabel(s)]));
    return {
        id: t.id,
        name: t.name,
        status: t.status,
        academicYearId: t.academicYearId,
        generatedAt: t.generatedAt,
        publishedAt: t.publishedAt,
        days,
        sections: sections.map((s) => ({ id: s.id, label: sectionLabel(s), periods: counts.find((c) => c.sectionId === s.id)?._count._all ?? 0 })),
        teachers: staff.map((s) => ({ id: s.id, name: staffName(s), code: s.employeeCode })),
        unplaced: (t.unplaced as { sectionId: string; subjectIds: string[]; missing: number; reason: string }[]).map((u) => ({
            section: secLabel.get(u.sectionId) ?? '—',
            sectionId: u.sectionId,
            subjects: u.subjectIds.map((x) => subjects.get(x) ?? '—').join(' / '),
            missing: u.missing,
            reason: u.reason,
        })),
    };
};

/** One section's week, or one teacher's week. */
export const grid = async (timetableId: string, of: { sectionId?: string; staffId?: string }) => {
    const t = await findTimetable(timetableId);
    if (!of.sectionId && !of.staffId) throw badRequest('Choose a section or a teacher');
    const rows = await db.ttEntry.findMany({ where: { timetableId, ...(of.sectionId ? { sectionId: of.sectionId } : { staffId: of.staffId }) }, include: entryInclude });
    return { timetable: { id: t.id, name: t.name, status: t.status }, days: await weekOf(t.academicYearId), entries: rows.map(presentEntry) };
};

/** Teachers free in a period (for substitutions, or to change a lesson). */
export const freeTeachers = async (timetableId: string, weekday: number, periodNo: number) => {
    await findTimetable(timetableId);
    const busy = new Set((await db.ttEntry.findMany({ where: { timetableId, weekday, periodNo, staffId: { not: null } }, select: { staffId: true } })).map((e) => e.staffId!));
    const today = await db.ttEntry.groupBy({ by: ['staffId'], where: { timetableId, weekday, staffId: { not: null } }, _count: { _all: true } });
    const count = new Map(today.map((r) => [r.staffId!, r._count._all]));
    const staff = await db.staff.findMany({
        where: { status: 'working', staffType: { extra: { path: ['teaching'], equals: true } } },
        select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true, designation: { select: { name: true } } },
    });
    return staff
        .filter((s) => !busy.has(s.id))
        .map((s) => ({ id: s.id, name: staffName(s), code: s.employeeCode, designation: s.designation?.name ?? null, periodsThatDay: count.get(s.id) ?? 0 }))
        .sort((a, b) => a.periodsThatDay - b.periodsThatDay || a.name.localeCompare(b.name));
};

// ─── Editing a draft ─────────────────────────────────────────────────────────

export const cellSchema = z.strictObject({
    sectionId: z.uuid(),
    weekday: z.number().int().min(1).max(7),
    periodNo: z.number().int().min(1).max(20),
    /** The lessons of the period (one, or the subjects of a parallel group); empty = a free period. */
    lessons: z.array(z.strictObject({ subjectId: z.uuid(), staffId: z.uuid().nullable(), roomId: z.uuid().nullable().optional() })).max(6),
    locked: z.boolean().default(true),
});

/** Clashes a period would have: the teacher or the room is somewhere else at that time. */
const clashes = async (timetableId: string, sectionId: string, weekday: number, periodNo: number, lessons: { staffId: string | null; roomId?: string | null }[]) => {
    const staff = lessons.map((l) => l.staffId).filter((x): x is string => !!x);
    const rooms = lessons.map((l) => l.roomId).filter((x): x is string => !!x);
    if (!staff.length && !rooms.length) return [];
    const others = await db.ttEntry.findMany({ where: { timetableId, weekday, periodNo, sectionId: { not: sectionId }, OR: [...(staff.length ? [{ staffId: { in: staff } }] : []), ...(rooms.length ? [{ roomId: { in: rooms } }] : [])] }, include: entryInclude });
    return others.map((o) => (o.staffId && staff.includes(o.staffId) ? `${staffName(o.staff!)} is taking ${sectionLabel(o.section)} (${o.subject.name}) then` : `${o.room?.name} is used by ${sectionLabel(o.section)} then`));
};

export const setCell = async (timetableId: string, input: z.infer<typeof cellSchema>) => {
    const t = await draftOnly(timetableId);
    const sec = await db.section.findFirst({ where: { id: input.sectionId, academicYearId: t.academicYearId } });
    if (!sec) throw notFound('Section not found');
    const day = (await weekOf(t.academicYearId)).find((d) => d.weekday === input.weekday);
    if (!day || !day.periods.some((p) => p.periodNo === input.periodNo)) throw badRequest('That period is not in the school week');
    const found = await clashes(timetableId, input.sectionId, input.weekday, input.periodNo, input.lessons);
    if (found.length) throw conflict(`Clash: ${found.join('; ')}`);
    const tenantId = getTenantId()!;
    await withTransaction(async (tx) => {
        await tx.ttEntry.deleteMany({ where: { timetableId, sectionId: input.sectionId, weekday: input.weekday, periodNo: input.periodNo } });
        if (input.lessons.length)
            await tx.ttEntry.createMany({ data: input.lessons.map((l) => ({ tenantId, timetableId, sectionId: input.sectionId, weekday: input.weekday, periodNo: input.periodNo, subjectId: l.subjectId, staffId: l.staffId, roomId: l.roomId ?? null, locked: input.locked })) });
    });
    return grid(timetableId, { sectionId: input.sectionId });
};

export const swapSchema = z.strictObject({
    sectionId: z.uuid(),
    a: z.strictObject({ weekday: z.number().int().min(1).max(7), periodNo: z.number().int().min(1).max(20) }),
    b: z.strictObject({ weekday: z.number().int().min(1).max(7), periodNo: z.number().int().min(1).max(20) }),
});

/** Swaps two periods of a section (drag and drop), refusing if a teacher or room would clash. */
export const swapCells = async (timetableId: string, input: z.infer<typeof swapSchema>) => {
    await draftOnly(timetableId);
    const at = (p: { weekday: number; periodNo: number }) => db.ttEntry.findMany({ where: { timetableId, sectionId: input.sectionId, weekday: p.weekday, periodNo: p.periodNo } });
    const [a, b] = await Promise.all([at(input.a), at(input.b)]);
    const toB = await clashes(timetableId, input.sectionId, input.b.weekday, input.b.periodNo, a);
    const toA = await clashes(timetableId, input.sectionId, input.a.weekday, input.a.periodNo, b);
    const found = [...toB, ...toA];
    if (found.length) throw conflict(`Can't swap: ${found.join('; ')}`);
    await withTransaction(async (tx) => {
        const ids = [...a, ...b].map((e) => e.id);
        await tx.ttEntry.deleteMany({ where: { id: { in: ids } } });
        const move = (list: typeof a, to: { weekday: number; periodNo: number }) => list.map(({ id: _id, ...e }) => ({ ...e, weekday: to.weekday, periodNo: to.periodNo, locked: true }));
        const data = [...move(a, input.b), ...move(b, input.a)];
        if (data.length) await tx.ttEntry.createMany({ data });
    });
    return grid(timetableId, { sectionId: input.sectionId });
};

export const renameSchema = z.strictObject({ name: z.string().trim().min(1).max(60) });
export const renameTimetable = async (id: string, input: z.infer<typeof renameSchema>) => {
    await findTimetable(id);
    await db.timetable.update({ where: { id }, data: { name: input.name } });
    return timetableOverview(id);
};

export const publish = async (id: string) => {
    const t = await draftOnly(id);
    await withTransaction(async (tx) => {
        await tx.timetable.updateMany({ where: { academicYearId: t.academicYearId, status: 'published' }, data: { status: 'archived' } });
        await tx.timetable.update({ where: { id }, data: { status: 'published', publishedAt: new Date() } });
    });
    await recordAudit({ action: 'timetable_published', entity: 'timetable', entityId: id, changes: { name: t.name } });
    return timetableOverview(id);
};

/** A new draft with the same lessons (to change a published timetable without disturbing it). */
export const copyTimetable = async (id: string) => {
    const t = await findTimetable(id);
    const tenantId = getTenantId()!;
    const copy = await withTransaction(
        async (tx) => {
            const c = await tx.timetable.create({ data: { tenantId, academicYearId: t.academicYearId, name: `${t.name} (copy)`, unplaced: t.unplaced as Prisma.InputJsonValue, generatedAt: t.generatedAt } });
            const rows = await tx.ttEntry.findMany({ where: { timetableId: id } });
            for (let i = 0; i < rows.length; i += 1000) await tx.ttEntry.createMany({ data: rows.slice(i, i + 1000).map(({ id: _id, timetableId: _t, ...e }) => ({ ...e, timetableId: c.id })) });
            return c;
        },
        { timeout: 60_000 }
    );
    return { id: copy.id };
};

export const deleteTimetable = async (id: string) => {
    const t = await findTimetable(id);
    if (t.status === 'published') throw conflict('The published timetable can’t be deleted; publish another one first');
    await db.timetable.delete({ where: { id } });
    return { id };
};

// ─── My timetable ────────────────────────────────────────────────────────────

/** A teacher's week, a student's class week, or a parent's children's — from the published timetable. */
export const myTimetable = async (userId: string) => {
    const t = await publishedOf();
    if (!t) return { published: false, days: [], views: [] };
    const days = await weekOf(t.academicYearId);
    const views: { kind: 'teacher' | 'class'; title: string; entries: ReturnType<typeof presentEntry>[] }[] = [];
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true, firstName: true, middleName: true, lastName: true } });
    if (staff) {
        const rows = await db.ttEntry.findMany({ where: { timetableId: t.id, staffId: staff.id }, include: entryInclude });
        views.push({ kind: 'teacher', title: `My periods (${staffName(staff)})`, entries: rows.map(presentEntry) });
    }
    const students = await db.student.findMany({
        where: { status: 'active', OR: [{ userId }, { family: { guardians: { some: { userId } } } }] },
        select: { firstName: true, enrolments: { where: { academicYearId: t.academicYearId }, select: { sectionId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } }, stream: { select: { name: true } } } } } } },
    });
    for (const s of students) {
        const e = s.enrolments[0];
        if (!e) continue;
        const rows = await db.ttEntry.findMany({ where: { timetableId: t.id, sectionId: e.sectionId }, include: entryInclude });
        views.push({ kind: 'class', title: `${s.firstName} · ${sectionLabel(e.section)}`, entries: rows.map(presentEntry) });
    }
    return { published: true, name: t.name, days, views };
};
