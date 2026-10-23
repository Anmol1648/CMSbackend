import { Prisma } from '@prisma/client';
import { classesOfYear } from '../academic/year-classes.service';
import { z } from 'zod';
import { db, withTransaction, Tx } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { staffName } from '../staff/staff.service';
import { TIMETABLE } from './timetable.settings';

/** Timetable set-up of a year: bell schedules, school days, periods per subject, teachers' limits. */

const uuidOk = (id: string) => z.uuid().safeParse(id).success;
export const WEEKDAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export const yearOf = async (id: string) => {
    const y = uuidOk(id) ? await db.academicYear.findUnique({ where: { id } }) : null;
    if (!y) throw notFound('Academic year not found');
    return y;
};

export const sectionLabel = (s: { name: string; schoolClass: { name: string; shortName: string | null }; stream?: { name: string } | null }) =>
    `${s.schoolClass.shortName ?? s.schoolClass.name}-${s.name}${s.stream ? ` (${s.stream.name})` : ''}`;

// ─── Bell schedules ──────────────────────────────────────────────────────────

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time like 08:40');
export const scheduleSchema = z.strictObject({
    name: z.string().trim().min(1, 'is required').max(60),
    slots: z
        .array(z.strictObject({ kind: z.enum(['period', 'break']), label: z.string().trim().max(40).optional(), startTime: time, endTime: time }))
        .min(1, 'add at least one period')
        .max(20),
});

const presentSchedule = (s: Prisma.TtScheduleGetPayload<{ include: { slots: true; days: true } }>) => ({
    id: s.id,
    name: s.name,
    periods: s.slots.filter((x) => x.kind === 'period').length,
    weekdays: s.days.map((d) => d.weekday).sort(),
    slots: [...s.slots].sort((a, b) => a.sortOrder - b.sortOrder).map((x) => ({ kind: x.kind, periodNo: x.periodNo, label: x.label, startTime: x.startTime, endTime: x.endTime })),
});

export const listSchedules = async (yearId: string) => {
    await yearOf(yearId);
    return (await db.ttSchedule.findMany({ where: { academicYearId: yearId }, include: { slots: true, days: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })).map(presentSchedule);
};

const checkSlots = (slots: z.infer<typeof scheduleSchema>['slots']) => {
    if (!slots.some((s) => s.kind === 'period')) throw badRequest('Add at least one period', [{ field: 'slots', message: 'needs a period' }]);
    for (let i = 0; i < slots.length; i++) {
        if (slots[i].endTime <= slots[i].startTime) throw badRequest(`Row ${i + 1} ends before it starts`, [{ field: 'slots', message: `row ${i + 1}: the end is before the start` }]);
        if (i && slots[i].startTime < slots[i - 1].endTime) throw badRequest(`Row ${i + 1} starts before row ${i} ends`, [{ field: 'slots', message: `row ${i + 1} overlaps the one before` }]);
    }
};

const slotRows = (tenantId: string, scheduleId: string, slots: z.infer<typeof scheduleSchema>['slots']) => {
    let n = 0;
    return slots.map((s, i) => {
        const periodNo = s.kind === 'period' ? ++n : null;
        return { tenantId, scheduleId, sortOrder: i + 1, kind: s.kind, periodNo, label: s.label?.trim() || (s.kind === 'period' ? `Period ${periodNo}` : 'Break'), startTime: s.startTime, endTime: s.endTime };
    });
};

export const createSchedule = async (yearId: string, input: z.infer<typeof scheduleSchema>) => {
    await yearOf(yearId);
    checkSlots(input.slots);
    if (await db.ttSchedule.findFirst({ where: { academicYearId: yearId, name: { equals: input.name, mode: 'insensitive' } } })) throw conflict(`There is already a schedule "${input.name}"`);
    const tenantId = getTenantId()!;
    await withTransaction(async (tx) => {
        const s = await tx.ttSchedule.create({ data: { tenantId, academicYearId: yearId, name: input.name, sortOrder: await tx.ttSchedule.count({ where: { academicYearId: yearId } }) } });
        await tx.ttSlot.createMany({ data: slotRows(tenantId, s.id, input.slots) });
    });
    return listSchedules(yearId);
};

export const updateSchedule = async (id: string, input: z.infer<typeof scheduleSchema>) => {
    const s = uuidOk(id) ? await db.ttSchedule.findUnique({ where: { id } }) : null;
    if (!s) throw notFound('Schedule not found');
    checkSlots(input.slots);
    if (await db.ttSchedule.findFirst({ where: { academicYearId: s.academicYearId, id: { not: id }, name: { equals: input.name, mode: 'insensitive' } } })) throw conflict(`There is already a schedule "${input.name}"`);
    const tenantId = getTenantId()!;
    await withTransaction(async (tx) => {
        await tx.ttSchedule.update({ where: { id }, data: { name: input.name } });
        await tx.ttSlot.deleteMany({ where: { scheduleId: id } });
        await tx.ttSlot.createMany({ data: slotRows(tenantId, id, input.slots) });
    });
    return listSchedules(s.academicYearId);
};

export const deleteSchedule = async (id: string) => {
    const s = uuidOk(id) ? await db.ttSchedule.findUnique({ where: { id }, include: { _count: { select: { days: true } } } }) : null;
    if (!s) throw notFound('Schedule not found');
    if (s._count.days) throw conflict('Some school days follow this schedule; give them another one first');
    await db.ttSchedule.delete({ where: { id } });
    return listSchedules(s.academicYearId);
};

// ─── School days ─────────────────────────────────────────────────────────────

export const listDays = async (yearId: string) => {
    await yearOf(yearId);
    const days = await db.ttDay.findMany({ where: { academicYearId: yearId } });
    return [1, 2, 3, 4, 5, 6, 7].map((w) => ({ weekday: w, name: WEEKDAYS[w], scheduleId: days.find((d) => d.weekday === w)?.scheduleId ?? null }));
};

export const daysSchema = z.array(z.strictObject({ weekday: z.number().int().min(1).max(7), scheduleId: z.uuid().nullable() })).max(7);

export const saveDays = async (yearId: string, input: z.infer<typeof daysSchema>) => {
    await yearOf(yearId);
    const ids = [...new Set(input.map((d) => d.scheduleId).filter((x): x is string => !!x))];
    if (ids.length && (await db.ttSchedule.count({ where: { id: { in: ids }, academicYearId: yearId } })) !== ids.length) throw badRequest("A schedule is not one of this year's");
    const tenantId = getTenantId()!;
    await withTransaction(async (tx) => {
        for (const d of input) {
            await tx.ttDay.upsert({ where: { tenantId_academicYearId_weekday: { tenantId, academicYearId: yearId, weekday: d.weekday } }, create: { tenantId, academicYearId: yearId, weekday: d.weekday, scheduleId: d.scheduleId }, update: { scheduleId: d.scheduleId } });
        }
    });
    return listDays(yearId);
};

/** The school days with their periods (the shape the generator and the grids use). */
export const weekOf = async (yearId: string, client: typeof db | Tx = db) => {
    const days = await client.ttDay.findMany({ where: { academicYearId: yearId, scheduleId: { not: null } }, include: { schedule: { include: { slots: true } } }, orderBy: { weekday: 'asc' } });
    return days.map((d) => {
        const slots = [...d.schedule!.slots].sort((a, b) => a.sortOrder - b.sortOrder);
        const periods = slots.filter((s) => s.kind === 'period');
        return {
            weekday: d.weekday,
            name: WEEKDAYS[d.weekday],
            scheduleId: d.scheduleId!,
            periods: periods.map((p) => ({ periodNo: p.periodNo!, label: p.label, startTime: p.startTime, endTime: p.endTime })),
            slots: slots.map((s) => ({ kind: s.kind, periodNo: s.periodNo, label: s.label, startTime: s.startTime, endTime: s.endTime })),
            breakAfter: slots.flatMap((s, i) => (s.kind === 'period' && slots[i + 1]?.kind === 'break' ? [s.periodNo!] : [])),
        };
    });
};

// ─── Periods per subject ─────────────────────────────────────────────────────

/** One class's subjects (per stream) with their periods a week. */
export const listLoads = async (yearId: string, classId: string) => {
    await yearOf(yearId);
    const cls = uuidOk(classId) ? await db.schoolClass.findUnique({ where: { id: classId }, select: { id: true, name: true, hasStreams: true } }) : null;
    if (!cls) throw notFound('Class not found');
    const [subjects, loads, week] = await Promise.all([
        db.classSubject.findMany({ where: { academicYearId: yearId, classId }, include: { subject: { select: { id: true, name: true, code: true } }, stream: { select: { id: true, name: true } } }, orderBy: { sortOrder: 'asc' } }),
        db.ttLoad.findMany({ where: { academicYearId: yearId, classId } }),
        weekOf(yearId),
    ]);
    const capacity = week.reduce((a, d) => a + d.periods.length, 0);
    return {
        class: cls,
        periodsInWeek: capacity,
        rows: subjects.map((cs) => {
            const l = loads.find((x) => x.subjectId === cs.subjectId && (x.streamId ?? null) === (cs.streamId ?? null));
            return {
                subject: cs.subject,
                stream: cs.stream,
                isOptional: cs.isOptional,
                perWeek: l?.perWeek ?? 0,
                doubles: l?.doubles ?? 0,
                parallelGroup: l?.parallelGroup ?? null,
                roomId: l?.roomId ?? null,
            };
        }),
    };
};

export const loadsSchema = z.strictObject({
    rows: z
        .array(
            z.strictObject({
                subjectId: z.uuid(),
                streamId: z.uuid().nullable(),
                perWeek: z.number().int().min(0).max(60),
                doubles: z.number().int().min(0).max(30).default(0),
                parallelGroup: z.union([z.literal('').transform(() => null), z.string().trim().max(30), z.null()]).optional(),
                roomId: z.uuid().nullable().optional(),
            })
        )
        .max(80),
});

export const saveLoads = async (yearId: string, classId: string, input: z.infer<typeof loadsSchema>) => {
    const current = await listLoads(yearId, classId);
    const issues: { field: string; message: string }[] = [];
    for (const r of input.rows) {
        if (!current.rows.some((c) => c.subject.id === r.subjectId && (c.stream?.id ?? null) === r.streamId)) issues.push({ field: 'rows', message: 'a subject is not taught in this class (Academic → Subjects)' });
        if (r.doubles * 2 > r.perWeek) issues.push({ field: 'rows', message: 'double periods can be at most half of the periods' });
    }
    // Subjects of a parallel group run together: the same periods and doubles.
    const groups = new Map<string, typeof input.rows>();
    for (const r of input.rows) if (r.parallelGroup && r.perWeek) groups.set(`${r.streamId}|${r.parallelGroup.toLowerCase()}`, [...(groups.get(`${r.streamId}|${r.parallelGroup.toLowerCase()}`) ?? []), r]);
    for (const [k, rows] of groups) if (new Set(rows.map((r) => `${r.perWeek}/${r.doubles}`)).size > 1) issues.push({ field: 'rows', message: `the subjects of group "${k.split('|')[1]}" must have the same periods and doubles` });
    const rooms = [...new Set(input.rows.map((r) => r.roomId).filter((x): x is string => !!x))];
    if (rooms.length && (await db.masterValue.count({ where: { id: { in: rooms }, master: 'room' } })) !== rooms.length) issues.push({ field: 'rows', message: 'a room is not in the rooms list' });
    if (issues.length) throw badRequest(issues[0].message, issues);
    const tenantId = getTenantId()!;
    await withTransaction(async (tx) => {
        await tx.ttLoad.deleteMany({ where: { academicYearId: yearId, classId } });
        const data = input.rows.filter((r) => r.perWeek > 0).map((r) => ({ tenantId, academicYearId: yearId, classId, subjectId: r.subjectId, streamId: r.streamId, perWeek: r.perWeek, doubles: r.doubles, parallelGroup: r.parallelGroup ?? null, roomId: r.roomId ?? null }));
        if (data.length) await tx.ttLoad.createMany({ data });
    });
    return listLoads(yearId, classId);
};

/** Every class with its periods a week (per stream) against what the week has. */
export const loadOverview = async (yearId: string) => {
    await yearOf(yearId);
    const [classes, loads, week] = await Promise.all([
        classesOfYear(yearId).then((cs) => cs.map((c) => ({ id: c.id, name: c.name }))),
        db.ttLoad.findMany({ where: { academicYearId: yearId }, select: { classId: true, streamId: true, perWeek: true, parallelGroup: true, subjectId: true } }),
        weekOf(yearId),
    ]);
    const capacity = week.reduce((a, d) => a + d.periods.length, 0);
    return {
        periodsInWeek: capacity,
        classes: classes.map((c) => {
            const mine = loads.filter((l) => l.classId === c.id);
            // A parallel group takes its periods once; stream subjects add to the common ones.
            const byStream = new Map<string, number>();
            const seen = new Set<string>();
            const common = mine.filter((l) => !l.streamId);
            const count = (list: typeof mine, key: string) => {
                let n = 0;
                for (const l of list) {
                    const g = l.parallelGroup ? `${key}|${l.parallelGroup.toLowerCase()}` : null;
                    if (g && seen.has(g)) continue;
                    if (g) seen.add(g);
                    n += l.perWeek;
                }
                return n;
            };
            const base = count(common, 'common');
            for (const sid of new Set(mine.filter((l) => l.streamId).map((l) => l.streamId!))) byStream.set(sid, base + count(mine.filter((l) => l.streamId === sid), sid));
            const totals = byStream.size ? [...byStream.values()] : [base];
            return { id: c.id, name: c.name, periods: Math.max(...totals), subjects: mine.length };
        }),
    };
};

// ─── Teachers ────────────────────────────────────────────────────────────────

/** Teaching staff with how many periods their subjects need, and their limits. */
export const teacherLoads = async (yearId: string) => {
    await yearOf(yearId);
    const s = await getSettings({ maxPerDay: TIMETABLE.maxPerDay, maxPerWeek: TIMETABLE.maxPerWeek });
    const [staff, assignments, sections, loads, rules] = await Promise.all([
        db.staff.findMany({ where: { status: 'working', staffType: { extra: { path: ['teaching'], equals: true } } }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true, designation: { select: { name: true } } }, orderBy: { firstName: 'asc' } }),
        db.teachingAssignment.findMany({ where: { academicYearId: yearId }, select: { staffId: true, sectionId: true, subjectId: true } }),
        db.section.findMany({ where: { academicYearId: yearId, isActive: true }, select: { id: true, classId: true, streamId: true, classTeacherId: true } }),
        db.ttLoad.findMany({ where: { academicYearId: yearId } }),
        db.ttTeacherRule.findMany({ where: { academicYearId: yearId } }),
    ]);
    const secById = new Map(sections.map((x) => [x.id, x]));
    const need = new Map<string, number>();
    for (const a of assignments) {
        const sec = secById.get(a.sectionId);
        if (!sec) continue;
        const l = loads.find((x) => x.classId === sec.classId && x.subjectId === a.subjectId && (!x.streamId || x.streamId === sec.streamId));
        if (l) need.set(a.staffId, (need.get(a.staffId) ?? 0) + l.perWeek);
    }
    return {
        defaults: s,
        teachers: staff.map((t) => {
            const r = rules.find((x) => x.staffId === t.id);
            return {
                id: t.id,
                name: staffName(t),
                code: t.employeeCode,
                designation: t.designation?.name ?? null,
                periodsNeeded: need.get(t.id) ?? 0,
                classTeacher: sections.some((x) => x.classTeacherId === t.id),
                maxPerDay: r?.maxPerDay ?? null,
                maxPerWeek: r?.maxPerWeek ?? null,
                unavailable: (r?.unavailable as { weekday: number; periodNo: number }[] | undefined) ?? [],
            };
        }),
    };
};

export const teacherRuleSchema = z.strictObject({
    maxPerDay: z.number().int().min(0).max(20).nullable(),
    maxPerWeek: z.number().int().min(0).max(100).nullable(),
    unavailable: z.array(z.strictObject({ weekday: z.number().int().min(1).max(7), periodNo: z.number().int().min(1).max(20) })).max(140),
});

export const saveTeacherRule = async (yearId: string, staffId: string, input: z.infer<typeof teacherRuleSchema>) => {
    await yearOf(yearId);
    if (!uuidOk(staffId) || !(await db.staff.findUnique({ where: { id: staffId }, select: { id: true } }))) throw notFound('Staff member not found');
    const tenantId = getTenantId()!;
    const data = { maxPerDay: input.maxPerDay, maxPerWeek: input.maxPerWeek, unavailable: input.unavailable as unknown as Prisma.InputJsonValue };
    await db.ttTeacherRule.upsert({ where: { tenantId_academicYearId_staffId: { tenantId, academicYearId: yearId, staffId } }, create: { tenantId, academicYearId: yearId, staffId, ...data }, update: data });
    return teacherLoads(yearId);
};

// ─── Starting a year ─────────────────────────────────────────────────────────

const REGULAR: z.infer<typeof scheduleSchema>['slots'] = [
    { kind: 'period', startTime: '08:00', endTime: '08:40' },
    { kind: 'period', startTime: '08:40', endTime: '09:20' },
    { kind: 'period', startTime: '09:20', endTime: '10:00' },
    { kind: 'period', startTime: '10:00', endTime: '10:40' },
    { kind: 'break', label: 'Break', startTime: '10:40', endTime: '11:00' },
    { kind: 'period', startTime: '11:00', endTime: '11:40' },
    { kind: 'period', startTime: '11:40', endTime: '12:20' },
    { kind: 'period', startTime: '12:20', endTime: '13:00' },
    { kind: 'period', startTime: '13:00', endTime: '13:40' },
];

/**
 * A starting point for a year with nothing set up: an 8-period "Regular" schedule for Monday to
 * Saturday, and periods for every subject of every class (6 a week; activities 2), to adjust.
 */
export const startYear = async (yearId: string) => {
    await yearOf(yearId);
    const tenantId = getTenantId()!;
    let schedules = 0;
    if (!(await db.ttSchedule.count({ where: { academicYearId: yearId } }))) {
        await createSchedule(yearId, { name: 'Regular', slots: REGULAR });
        const s = await db.ttSchedule.findFirstOrThrow({ where: { academicYearId: yearId } });
        await saveDays(yearId, [1, 2, 3, 4, 5, 6, 7].map((w) => ({ weekday: w, scheduleId: w <= 6 ? s.id : null })));
        schedules = 1;
    }
    let loads = 0;
    if (!(await db.ttLoad.count({ where: { academicYearId: yearId } }))) {
        const subjects = await db.classSubject.findMany({ where: { academicYearId: yearId }, include: { subject: { include: { type: { select: { name: true } } } } } });
        const data = subjects.map((cs) => ({
            tenantId,
            academicYearId: yearId,
            classId: cs.classId,
            streamId: cs.streamId,
            subjectId: cs.subjectId,
            perWeek: cs.subject.assessment === 'co_scholastic' || cs.subject.type?.name === 'Activity' ? 2 : 6,
            doubles: 0,
            parallelGroup: cs.isOptional ? 'Optional' : null,
        }));
        if (data.length) await db.ttLoad.createMany({ data });
        loads = data.length;
    }
    return { schedules, loads };
};
