import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { staffName } from '../staff/staff.service';
import { TIMETABLE } from './timetable.settings';
import { sectionLabel, weekOf } from './tt-setup.service';
import { publishedOf } from './timetable.service';

/** Arrangement periods: on a date, others take an absent teacher's periods (from the published timetable). */

const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const weekdayOf = (s: string) => ((toDate(s).getUTCDay() + 6) % 7) + 1; // 1 = Monday
const day = z.iso.date('must be a date like 2026-10-21');
const uuidOk = (id: string) => z.uuid().safeParse(id).success;

const needPublished = async () => {
    const t = await publishedOf();
    if (!t) throw badRequest('Publish a timetable first (Timetable)');
    return t;
};

/** Everyone absent on a date, their periods and who takes them, with suggestions for the open ones. */
export const substitutionDay = async (date: string) => {
    const t = await needPublished();
    const weekday = weekdayOf(date);
    const days = await weekOf(t.academicYearId);
    const periods = days.find((d) => d.weekday === weekday)?.periods ?? [];
    const rows = await db.ttSubstitution.findMany({
        where: { date: toDate(date) },
        include: {
            section: { select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } }, stream: { select: { name: true } } } },
            subject: { select: { id: true, name: true } },
            absent: { select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true } },
            substitute: { select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true } },
        },
        orderBy: [{ periodNo: 'asc' }],
    });
    const { max } = await getSettings({ max: TIMETABLE.substituteMaxPerDay });
    // Who is busy when: their own lessons that day, and substitutions already given.
    const lessons = await db.ttEntry.findMany({ where: { timetableId: t.id, weekday, staffId: { not: null } }, select: { staffId: true, periodNo: true, sectionId: true } });
    const absentIds = new Set(rows.map((r) => r.absentStaffId));
    const busy = new Set([...lessons.map((l) => `${l.staffId}|${l.periodNo}`), ...rows.filter((r) => r.substituteStaffId).map((r) => `${r.substituteStaffId}|${r.periodNo}`)]);
    const lessonsOf = new Map<string, number>();
    for (const l of lessons) lessonsOf.set(l.staffId!, (lessonsOf.get(l.staffId!) ?? 0) + 1);
    const subsOf = new Map<string, number>();
    for (const r of rows) if (r.substituteStaffId) subsOf.set(r.substituteStaffId, (subsOf.get(r.substituteStaffId) ?? 0) + 1);
    const teachesSection = new Set((await db.teachingAssignment.findMany({ where: { academicYearId: t.academicYearId }, select: { staffId: true, sectionId: true } })).map((a) => `${a.staffId}|${a.sectionId}`));
    const teachers = await db.staff.findMany({
        where: { status: 'working', staffType: { extra: { path: ['teaching'], equals: true } } },
        select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true },
    });

    const suggest = (sectionId: string, periodNo: number) =>
        teachers
            .filter((s) => !absentIds.has(s.id) && !busy.has(`${s.id}|${periodNo}`))
            .map((s) => ({
                id: s.id,
                name: staffName(s),
                code: s.employeeCode,
                knowsClass: teachesSection.has(`${s.id}|${sectionId}`),
                periodsThatDay: lessonsOf.get(s.id) ?? 0,
                substitutionsThatDay: subsOf.get(s.id) ?? 0,
                overLimit: (subsOf.get(s.id) ?? 0) >= max,
            }))
            .sort((a, b) => Number(a.overLimit) - Number(b.overLimit) || Number(b.knowsClass) - Number(a.knowsClass) || a.periodsThatDay + a.substitutionsThatDay - (b.periodsThatDay + b.substitutionsThatDay) || a.name.localeCompare(b.name))
            .slice(0, 8);

    const byTeacher = new Map<string, { teacher: { id: string; name: string; code: string }; periods: unknown[] }>();
    for (const r of rows) {
        const g = byTeacher.get(r.absentStaffId) ?? { teacher: { id: r.absent.id, name: staffName(r.absent), code: r.absent.employeeCode }, periods: [] };
        const p = periods.find((x) => x.periodNo === r.periodNo);
        g.periods.push({
            id: r.id,
            periodNo: r.periodNo,
            time: p ? `${p.startTime}–${p.endTime}` : null,
            section: { id: r.section.id, label: sectionLabel(r.section) },
            subject: r.subject,
            substitute: r.substitute ? { id: r.substitute.id, name: staffName(r.substitute), code: r.substitute.employeeCode } : null,
            note: r.note,
            suggestions: r.substituteStaffId ? [] : suggest(r.sectionId, r.periodNo),
        });
        byTeacher.set(r.absentStaffId, g);
    }
    return {
        date,
        weekday,
        schoolDay: periods.length > 0,
        limitPerDay: max,
        absent: [...byTeacher.values()],
        open: rows.filter((r) => !r.substituteStaffId).length,
    };
};

export const absentSchema = z.strictObject({ date: day, staffId: z.uuid() });

/** A teacher is absent on a date: their periods of that day need someone else. */
export const markAbsent = async (input: z.infer<typeof absentSchema>) => {
    const t = await needPublished();
    const weekday = weekdayOf(input.date);
    const staff = await db.staff.findUnique({ where: { id: input.staffId }, select: { id: true, firstName: true, lastName: true } });
    if (!staff) throw notFound('Staff member not found');
    const lessons = await db.ttEntry.findMany({ where: { timetableId: t.id, staffId: input.staffId, weekday }, select: { sectionId: true, periodNo: true, subjectId: true } });
    if (!lessons.length) throw badRequest(`${staff.firstName} has no periods on that day`);
    const tenantId = getTenantId()!;
    await db.ttSubstitution.createMany({
        data: lessons.map((l) => ({ tenantId, date: toDate(input.date), sectionId: l.sectionId, periodNo: l.periodNo, subjectId: l.subjectId, absentStaffId: input.staffId })),
        skipDuplicates: true,
    });
    await recordAudit({ action: 'teacher_absent', entity: 'staff', entityId: input.staffId, changes: { date: input.date, periods: lessons.length } });
    return substitutionDay(input.date);
};

/** The teacher is not absent after all: their arrangement periods of that date go. */
export const clearAbsent = async (input: z.infer<typeof absentSchema>) => {
    await db.ttSubstitution.deleteMany({ where: { date: toDate(input.date), absentStaffId: input.staffId } });
    return substitutionDay(input.date);
};

export const assignSchema = z.strictObject({
    substituteStaffId: z.uuid().nullable(),
    note: z.union([z.literal('').transform(() => null), z.string().trim().max(200), z.null()]).optional(),
});

export const assignSubstitute = async (id: string, input: z.infer<typeof assignSchema>) => {
    const r = uuidOk(id) ? await db.ttSubstitution.findUnique({ where: { id } }) : null;
    if (!r) throw notFound('Arrangement period not found');
    const date = r.date.toISOString().slice(0, 10);
    if (input.substituteStaffId) {
        if (input.substituteStaffId === r.absentStaffId) throw badRequest('Choose someone other than the absent teacher');
        const t = await needPublished();
        const weekday = weekdayOf(date);
        const own = await db.ttEntry.findFirst({ where: { timetableId: t.id, staffId: input.substituteStaffId, weekday, periodNo: r.periodNo } });
        if (own) throw conflict('That teacher has their own class in this period');
        const other = await db.ttSubstitution.findFirst({ where: { date: r.date, periodNo: r.periodNo, substituteStaffId: input.substituteStaffId, id: { not: id } } });
        if (other) throw conflict('That teacher is already substituting in this period');
        if (await db.ttSubstitution.findFirst({ where: { date: r.date, absentStaffId: input.substituteStaffId } })) throw conflict('That teacher is absent that day');
    }
    await db.ttSubstitution.update({ where: { id }, data: { substituteStaffId: input.substituteStaffId, ...(input.note !== undefined ? { note: input.note } : {}) } });
    return substitutionDay(date);
};

/** A teacher's arrangement periods from today on (for My Timetable). */
export const mySubstitutions = async (staffId: string) => {
    const today = toDate(new Date().toISOString().slice(0, 10));
    const rows = await db.ttSubstitution.findMany({
        where: { substituteStaffId: staffId, date: { gte: today } },
        include: { section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } }, stream: { select: { name: true } } } }, subject: { select: { name: true } }, absent: { select: { firstName: true, middleName: true, lastName: true } } },
        orderBy: [{ date: 'asc' }, { periodNo: 'asc' }],
        take: 30,
    });
    return rows.map((r) => ({ date: r.date.toISOString().slice(0, 10), periodNo: r.periodNo, section: sectionLabel(r.section), subject: r.subject?.name ?? null, for: staffName(r.absent), note: r.note }));
};

/** How many arrangement periods each teacher took in a month. */
export const substitutionReport = async (month: string) => {
    if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('Choose a month like 2026-10');
    const from = toDate(`${month}-01`);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0));
    const rows = await db.ttSubstitution.findMany({ where: { date: { gte: from, lte: to } }, select: { absentStaffId: true, substituteStaffId: true } });
    const ids = [...new Set(rows.flatMap((r) => [r.absentStaffId, r.substituteStaffId]).filter((x): x is string => !!x))];
    const staff = new Map((await db.staff.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true } })).map((s) => [s.id, s]));
    const tally = new Map<string, { taken: number; missed: number }>();
    for (const r of rows) {
        const a = tally.get(r.absentStaffId) ?? { taken: 0, missed: 0 };
        a.missed++;
        tally.set(r.absentStaffId, a);
        if (r.substituteStaffId) {
            const s = tally.get(r.substituteStaffId) ?? { taken: 0, missed: 0 };
            s.taken++;
            tally.set(r.substituteStaffId, s);
        }
    }
    return {
        month,
        total: rows.length,
        arranged: rows.filter((r) => r.substituteStaffId).length,
        teachers: [...tally.entries()]
            .map(([id, t]) => ({ id, name: staff.get(id) ? staffName(staff.get(id)!) : '—', code: staff.get(id)?.employeeCode ?? null, ...t }))
            .sort((a, b) => b.taken - a.taken || b.missed - a.missed),
    };
};
