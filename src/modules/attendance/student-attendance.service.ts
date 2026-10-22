import type { DataScope, Prisma } from '@prisma/client';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { getUserAccess } from '../rbac/access.service';
import { currentYear } from '../academic/years.service';
import { scopeWhere as studentScope, fullName } from '../students/students.service';
import { ATTENDANCE, dayDate, isoOf, todayIST } from './attendance.settings';
import { dayOff, daysOff } from './calendar.service';
import { lessonsOf, Period, periodsOf, sectionsTaughtBy } from './periods.service';

/**
 * Student attendance: the class teacher (or someone allowed to mark any section) marks a section's
 * register for a day — once, or morning and afternoon. Statuses come from the "attendance_status"
 * list; what each counts as decides the attendance %.
 */

const ISO = z.iso.date();
const DEFAULT_STATUSES = [
    { name: 'Present', code: 'P', extra: { present: 1, excused: false } },
    { name: 'Absent', code: 'A', extra: { present: 0, excused: false } },
    { name: 'Late', code: 'LT', extra: { present: 1, excused: false } },
    { name: 'Half day', code: 'HD', extra: { present: 0.5, excused: false } },
    { name: 'Leave', code: 'LV', extra: { present: 0, excused: true } },
    { name: 'Medical leave', code: 'ML', extra: { present: 0, excused: true } },
];

// ─── Statuses ────────────────────────────────────────────────────────────────

export interface Status {
    id: string;
    name: string;
    code: string;
    present: number;
    excused: boolean;
    isActive: boolean;
}

/** The school's statuses (the defaults are added the first time if the list is empty). */
export const statuses = async (): Promise<Status[]> => {
    let rows = await db.masterValue.findMany({ where: { master: 'attendance_status' }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    if (!rows.length) {
        await db.masterValue.createMany({ data: DEFAULT_STATUSES.map((s, i) => ({ tenantId: getTenantId()!, master: 'attendance_status', name: s.name, code: s.code, sortOrder: i + 1, extra: s.extra })), skipDuplicates: true });
        rows = await db.masterValue.findMany({ where: { master: 'attendance_status' }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    }
    return rows.map((r) => {
        const extra = (r.extra ?? {}) as { present?: number | string; excused?: boolean };
        const present = Number(extra.present ?? 0);
        return { id: r.id, name: r.name, code: r.code ?? r.name.slice(0, 2).toUpperCase(), present: Number.isFinite(present) ? Math.max(0, Math.min(1, present)) : 0, excused: !!extra.excused, isActive: r.isActive };
    });
};

const defaultStatus = async (list: Status[]) => {
    const { defaultStatus: code } = await getSettings({ defaultStatus: ATTENDANCE.defaultStatus });
    return list.find((s) => s.isActive && s.code.toLowerCase() === code.toLowerCase()) ?? list.find((s) => s.isActive && s.present === 1) ?? list[0];
};

export const modeOf = async () => (await getSettings({ mode: ATTENDANCE.mode })).mode;
export const SLOT_NAMES: Record<string, string> = { day: 'Day', am: 'Morning', pm: 'Afternoon' };

export interface SlotInfo {
    value: string;
    label: string;
    period: Period | null;
}

/**
 * The registers of a section on a day: "day"; "am" and "pm" when taken twice; one per period
 * ("p1", "p2"…) from the published timetable when taken every period (null: no timetable).
 */
export const slotsFor = async (section: { id: string; academicYearId: string }, date: string): Promise<SlotInfo[] | null> => {
    const mode = await modeOf();
    if (mode === 'twice') return ['am', 'pm'].map((v) => ({ value: v, label: SLOT_NAMES[v], period: null }));
    if (mode !== 'period') return [{ value: 'day', label: SLOT_NAMES.day, period: null }];
    const periods = await periodsOf(section.id, section.academicYearId, date);
    return periods ? periods.map((p) => ({ value: p.value, label: p.label, period: p })) : null;
};

/** How a day with several registers (periods, morning / afternoon) reads in one cell: P, A, or 5/8. */
export const dayCode = (marks: { code: string; present: number; excused: boolean }[]) => {
    if (marks.length <= 2) return marks.map((m) => m.code).join('/');
    const present = marks.filter((m) => m.present > 0).length;
    if (marks.every((m) => m.excused)) return marks[0].code;
    return present === marks.length ? 'P' : present === 0 ? 'A' : `${present}/${marks.length}`;
};

// ─── Who may mark / see which section ────────────────────────────────────────

const staffOf = (userId: string) => db.staff.findFirst({ where: { userId }, select: { id: true } });

/** Sections a person may mark: 'all', or the ids (class teacher; subject teachers when the school allows). */
export const markableSections = async (userId: string): Promise<'all' | string[]> => {
    const a = await getUserAccess(userId);
    if (a.permissions['attendance.mark_any']) return 'all';
    if (!a.permissions['attendance.mark']) return [];
    const staff = await staffOf(userId);
    if (!staff) return [];
    const { subjectTeachersMark } = await getSettings({ subjectTeachersMark: ATTENDANCE.subjectTeachersMark });
    const rows = await db.section.findMany({
        where: { OR: [{ classTeacherId: staff.id }, ...(subjectTeachersMark ? [{ teachingAssignments: { some: { staffId: staff.id } } }] : [])] },
        select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    if ((await modeOf()) === 'period') {
        const year = await currentYear();
        if (year) ids.push(...(await sectionsTaughtBy(staff.id, year.id, todayIST())));
    }
    return [...new Set(ids)];
};

/** Sections whose attendance a person may see: those they mark, plus attendance.view's reach. */
export const viewableSections = async (userId: string): Promise<'all' | string[]> => {
    const a = await getUserAccess(userId);
    const marks = await markableSections(userId);
    if (marks === 'all' || a.permissions['attendance.view'] === 'all') return 'all';
    if (a.permissions['attendance.view'] === 'assigned') {
        const staff = await staffOf(userId);
        if (staff) {
            const rows = await db.section.findMany({ where: { OR: [{ classTeacherId: staff.id }, { teachingAssignments: { some: { staffId: staff.id } } }] }, select: { id: true } });
            return [...new Set([...marks, ...rows.map((r) => r.id)])];
        }
    }
    return marks;
};

const inScope = (scope: 'all' | string[], sectionId: string) => scope === 'all' || scope.includes(sectionId);

// ─── The register ────────────────────────────────────────────────────────────

const sectionLabel = (s: { name: string; schoolClass: { name: string; shortName: string | null } }) => `${s.schoolClass.shortName ?? s.schoolClass.name}-${s.name}`;

const sectionOf = async (id: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Section not found');
    const s = await db.section.findFirst({
        where: { id },
        select: { id: true, name: true, academicYearId: true, classTeacherId: true, academicYear: { select: { startDate: true, endDate: true, name: true } }, schoolClass: { select: { name: true, shortName: true } }, classTeacher: { select: { firstName: true, middleName: true, lastName: true } } },
    });
    if (!s) throw notFound('Section not found');
    return s;
};

/** The students on a section's register on a date: enrolled, admitted by then, and not yet left. */
const roster = async (sectionId: string, yearId: string, date: string) => {
    const d = dayDate(date);
    const rows = await db.enrolment.findMany({
        where: { sectionId, academicYearId: yearId, student: { admissionDate: { lte: d }, OR: [{ status: 'active' }, { statusDate: { gt: d } }] } },
        select: { rollNumber: true, student: { select: { id: true, admissionNo: true, firstName: true, middleName: true, lastName: true } } },
    });
    return rows
        .map((r) => ({ id: r.student.id, name: fullName(r.student), admissionNo: r.student.admissionNo, roll: r.rollNumber }))
        .sort((a, b) => (a.roll ?? 9999) - (b.roll ?? 9999) || a.name.localeCompare(b.name));
};

/**
 * Whether the person may change this register now, and why not: the class teacher (any register of
 * their section); in period mode the period's teacher or substitute; subject teachers when allowed.
 */
const editRule = async (userId: string, section: { id: string; classTeacherId: string | null }, date: string, sheet: { markedAt: Date } | null, period: Period | null) => {
    const a = await getUserAccess(userId);
    if (date > todayIST()) return { editable: false, reason: 'Attendance can’t be marked for a day that hasn’t come yet.' };
    if (a.permissions['attendance.mark_any']) return { editable: true, reason: null };
    const staff = a.permissions['attendance.mark'] ? await staffOf(userId) : null;
    let may = !!staff && section.classTeacherId === staff.id;
    if (staff && !may) {
        if (period) may = period.markers.includes(staff.id);
        else if ((await getSettings({ subjectTeachersMark: ATTENDANCE.subjectTeachersMark })).subjectTeachersMark)
            may = (await db.teachingAssignment.count({ where: { sectionId: section.id, staffId: staff.id } })) > 0;
    }
    if (!may) return { editable: false, reason: period ? `This period is marked by ${period.teacher ?? 'its teacher'} (or the class teacher).` : 'You can see this register but not mark it.' };
    const s = await getSettings({ backDays: ATTENDANCE.backDays, editHours: ATTENDANCE.editHours });
    const age = Math.round((dayDate(todayIST()).getTime() - dayDate(date).getTime()) / 86_400_000);
    if (age > s.backDays) return { editable: false, reason: s.backDays ? `Teachers can mark attendance up to ${s.backDays} day(s) back. Ask the office to change older days.` : 'Teachers can mark only today’s attendance. Ask the office to change older days.' };
    if (sheet && s.editHours && Date.now() - sheet.markedAt.getTime() > s.editHours * 3600_000) return { editable: false, reason: `A register can be changed for ${s.editHours} hour(s) after it is saved. Ask the office to change it.` };
    return { editable: true, reason: null };
};

const SLOT = z.string().regex(/^(day|am|pm|p\d{1,2})$/, 'is not a part of the day');
export const registerQuery = z.object({ section: z.uuid('choose a section'), date: ISO.optional(), slot: SLOT.optional() });

/** A section's register for a date (and slot): the students with their marks, or the defaults to start from. */
export const getRegister = async (q: z.infer<typeof registerQuery>, userId: string) => {
    const date = q.date ?? todayIST();
    if (!inScope(await viewableSections(userId), q.section)) throw forbidden('You can’t see this section’s attendance');
    const section = await sectionOf(q.section);
    const slots = (await slotsFor(section, date)) ?? [];
    const noTimetable = (await modeOf()) === 'period' && !slots.length;
    const current = slots.find((x) => x.value === q.slot) ?? slots[0] ?? null;
    const slot = current?.value ?? q.slot ?? 'day';
    const inYear = date >= isoOf(section.academicYear.startDate) && date <= isoOf(section.academicYear.endDate);
    const [list, off, students, sheet] = await Promise.all([
        statuses(),
        dayOff(date, 'students'),
        roster(section.id, section.academicYearId, date),
        db.attendanceSheet.findFirst({ where: { sectionId: section.id, date: dayDate(date), slot }, include: { marks: true } }),
    ]);
    const start = await defaultStatus(list);
    const leave = await leaveOn(students.map((s) => s.id), date, list);
    const rule = !inYear
        ? { editable: false, reason: `This date is outside ${section.academicYear.name}.` }
        : off
          ? { editable: false, reason: `Not a school day: ${off}.` }
          : !current
            ? { editable: false, reason: noTimetable ? 'Attendance is taken every period, but this session has no published timetable yet (Timetable).' : 'This section has no periods on this day in the timetable.' }
            : await editRule(userId, section, date, sheet, current.period);
    const markOf = new Map((sheet?.marks ?? []).map((m) => [m.studentId, m]));
    const marker = sheet?.markedBy ? await db.user.findUnique({ where: { id: sheet.markedBy }, select: { displayName: true } }) : null;
    const editor = sheet?.updatedBy && sheet.updatedBy !== sheet.markedBy ? await db.user.findUnique({ where: { id: sheet.updatedBy }, select: { displayName: true } }) : null;
    return {
        section: { id: section.id, label: sectionLabel(section), className: section.schoolClass.name, classTeacher: section.classTeacher ? fullName(section.classTeacher) : null, year: section.academicYear.name },
        date,
        slot,
        slots: slots.map((s) => ({ value: s.value, label: s.label })),
        period: current?.period ? { label: current.period.label, subject: current.period.subject, time: current.period.time, teacher: current.period.teacher } : null,
        dayOff: off,
        ...rule,
        statuses: list.filter((s) => s.isActive || [...markOf.values()].some((m) => m.statusId === s.id)),
        defaultStatusId: start?.id ?? null,
        marked: sheet ? { at: sheet.markedAt, by: marker?.displayName ?? null, changedAt: editor ? sheet.updatedAt : null, changedBy: editor?.displayName ?? null } : null,
        students: students.map((s) => ({ ...s, statusId: markOf.get(s.id)?.statusId ?? null, note: markOf.get(s.id)?.note ?? null, leave: leave.get(s.id) ?? null })),
    };
};

/** Students on approved leave on a date, with the status their leave gives (Leave / Medical leave). */
export const leaveOn = async (studentIds: string[], date: string, list: Status[]) => {
    if (!studentIds.length) return new Map<string, { statusId: string | null; kind: string; reason: string }>();
    const rows = await db.studentLeave.findMany({ where: { studentId: { in: studentIds }, status: 'approved', fromDate: { lte: dayDate(date) }, toDate: { gte: dayDate(date) } }, select: { studentId: true, kind: true, reason: true } });
    return new Map(rows.map((r) => [r.studentId, { statusId: leaveStatus(list, r.kind)?.id ?? null, kind: r.kind, reason: r.reason }]));
};

/** The status a kind of leave gives: ML for medical, LV for leave, else any status left out of the %. */
export const leaveStatus = (list: Status[], kind: string) =>
    list.find((s) => s.isActive && s.code === (kind === 'medical' ? 'ML' : 'LV')) ?? list.find((s) => s.isActive && s.code === 'LV') ?? list.find((s) => s.isActive && s.excused);

export const saveSchema = z.strictObject({
    section: z.uuid(),
    date: ISO,
    slot: SLOT.default('day'),
    marks: z.array(z.strictObject({ studentId: z.uuid(), statusId: z.uuid(), note: z.string().trim().max(200).optional() })).max(300),
});

/** Saves a whole register (every student of the section, in one go). */
export const saveRegister = async (input: z.infer<typeof saveSchema>, userId: string) => {
    const section = await sectionOf(input.section);
    const slots = (await slotsFor(section, input.date)) ?? [];
    const current = slots.find((x) => x.value === input.slot);
    if (!current) throw badRequest('Attendance is not taken in that part of the day (or period)', [{ field: 'slot', message: 'is not used' }]);
    if (input.date < isoOf(section.academicYear.startDate) || input.date > isoOf(section.academicYear.endDate)) throw badRequest(`This date is outside ${section.academicYear.name}`, [{ field: 'date', message: 'is outside the session' }]);
    const off = await dayOff(input.date, 'students');
    if (off) throw badRequest(`Not a school day: ${off}`, [{ field: 'date', message: 'is not a school day' }]);
    const existing = await db.attendanceSheet.findFirst({ where: { sectionId: section.id, date: dayDate(input.date), slot: input.slot }, select: { id: true, markedAt: true } });
    const rule = await editRule(userId, section, input.date, existing, current.period);
    if (!rule.editable) throw forbidden(rule.reason ?? 'You can’t mark this register');

    const students = await roster(section.id, section.academicYearId, input.date);
    const onRoll = new Set(students.map((s) => s.id));
    const given = new Map(input.marks.map((m) => [m.studentId, m]));
    if (given.size !== input.marks.length) throw badRequest('A student is marked twice');
    const stranger = input.marks.find((m) => !onRoll.has(m.studentId));
    if (stranger) throw badRequest('A student is not on this section’s register', [{ field: 'marks', message: 'has a student of another section' }]);
    const missing = students.filter((s) => !given.has(s.id));
    if (missing.length) throw badRequest(`Mark every student: ${missing.slice(0, 3).map((s) => s.name).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''} not marked`, [{ field: 'marks', message: 'is missing students' }]);
    const list = await statuses();
    const usable = new Set(list.filter((s) => s.isActive).map((s) => s.id));
    if (input.marks.some((m) => !usable.has(m.statusId))) throw badRequest('Choose a status from the list', [{ field: 'marks', message: 'has an unknown status' }]);

    const tenantId = getTenantId()!;
    const sheetId = await withTransaction(async (tx) => {
        const sheet = existing
            ? await tx.attendanceSheet.update({ where: { id: existing.id }, data: { updatedAt: new Date() }, select: { id: true } })
            : await tx.attendanceSheet.create({ data: { tenantId, sectionId: section.id, date: dayDate(input.date), slot: input.slot, markedBy: userId }, select: { id: true } });
        await tx.attendanceMark.deleteMany({ where: { sheetId: sheet.id } });
        await tx.attendanceMark.createMany({ data: input.marks.map((m) => ({ tenantId, sheetId: sheet.id, studentId: m.studentId, statusId: m.statusId, note: m.note || null })) });
        return sheet.id;
    });
    const byStatus = Object.fromEntries(list.map((s) => [s.code, input.marks.filter((m) => m.statusId === s.id).length]).filter(([, n]) => n));
    await recordAudit({ action: existing ? 'attendance_changed' : 'attendance_marked', entity: 'attendance_sheet', entityId: sheetId, changes: { section: sectionLabel(section), date: input.date, slot: input.slot, ...byStatus } });
    return getRegister({ section: section.id, date: input.date, slot: input.slot }, userId);
};

// ─── The day at a glance ─────────────────────────────────────────────────────

/** Sections a person may mark, for their picker (their own first). */
export const mySections = async (userId: string) => {
    const scope = await markableSections(userId);
    const year = await currentYear();
    if (!year) return [];
    const staff = await staffOf(userId);
    const rows = await db.section.findMany({
        where: { academicYearId: year.id, isActive: true, ...(scope === 'all' ? {} : { id: { in: scope } }) },
        select: { id: true, name: true, sortOrder: true, classTeacherId: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } },
        orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
    });
    return rows.map((s) => ({ id: s.id, label: sectionLabel(s), mine: !!staff && s.classTeacherId === staff.id })).sort((a, b) => Number(b.mine) - Number(a.mine));
};

export const overviewQuery = z.object({ date: ISO.optional() });

/**
 * Every section of the current session on a day: marked or not, and the counts. In period mode one
 * column: how many of the day's periods are marked (counts from the first period's register).
 */
export const overview = async (q: z.infer<typeof overviewQuery>, userId: string) => {
    const date = q.date ?? todayIST();
    const scope = await viewableSections(userId);
    const year = await currentYear();
    if (!year) throw badRequest('No current academic year is set (Academic setup)');
    const mode = await modeOf();
    const [sections, list, off] = await Promise.all([
        db.section.findMany({
            where: { academicYearId: year.id, isActive: true, ...(scope === 'all' ? {} : { id: { in: scope } }) },
            select: {
                id: true,
                name: true,
                schoolClass: { select: { name: true, shortName: true } },
                classTeacher: { select: { firstName: true, middleName: true, lastName: true } },
                _count: { select: { enrolments: { where: { academicYearId: year.id, student: { status: 'active' } } } } },
            },
            orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
        }),
        statuses(),
        dayOff(date, 'students'),
    ]);
    const columns = mode === 'twice' ? ['am', 'pm'] : mode === 'period' ? ['periods'] : ['day'];
    // Period mode: how many periods each section has today (one query for all).
    const periodsToday = new Map<string, number>();
    if (mode === 'period') {
        const tt = await db.timetable.findFirst({ where: { academicYearId: year.id, status: 'published' }, orderBy: { publishedAt: 'desc' }, select: { id: true } });
        if (tt) {
            const entries = await db.ttEntry.findMany({ where: { timetableId: tt.id, weekday: dayDate(date).getUTCDay() || 7, sectionId: { in: sections.map((s) => s.id) } }, select: { sectionId: true, periodNo: true }, distinct: ['sectionId', 'periodNo'] });
            for (const e of entries) periodsToday.set(e.sectionId, (periodsToday.get(e.sectionId) ?? 0) + 1);
        }
    }
    const sheets = await db.attendanceSheet.findMany({ where: { date: dayDate(date), sectionId: { in: sections.map((s) => s.id) } }, include: { marks: { select: { statusId: true } } }, orderBy: { slot: 'asc' } });
    const users = new Map((await db.user.findMany({ where: { id: { in: [...new Set(sheets.map((s) => s.markedBy).filter((x): x is string => !!x))] } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
    const byId = new Map(list.map((s) => [s.id, s]));
    const counts = (sheet: (typeof sheets)[number]) => {
        const count = (f: (st: Status) => boolean) => sheet.marks.filter((m) => byId.get(m.statusId) && f(byId.get(m.statusId)!)).length;
        return { present: count((st) => st.present > 0), absent: count((st) => st.present === 0 && !st.excused), leave: count((st) => st.excused), markedBy: sheet.markedBy ? (users.get(sheet.markedBy) ?? null) : null, markedAt: sheet.markedAt };
    };
    const periodOrder = (slot: string) => Number(slot.slice(1)) || 0;
    const rows = sections.map((s) => {
        const mine = sheets.filter((x) => x.sectionId === s.id);
        const cells = columns.map((col) => {
            if (col === 'periods') {
                const done = mine.filter((x) => x.slot.startsWith('p')).sort((a, b) => periodOrder(a.slot) - periodOrder(b.slot));
                const total = periodsToday.get(s.id) ?? 0;
                if (!done.length) return { slot: col, marked: false as const, total, done: 0 };
                return { slot: col, marked: done.length >= total, total, done: done.length, ...counts(done[0]) };
            }
            const sheet = mine.find((x) => x.slot === col);
            return sheet ? { slot: col, marked: true as const, ...counts(sheet) } : { slot: col, marked: false as const };
        });
        return { id: s.id, label: sectionLabel(s), classTeacher: s.classTeacher ? fullName(s.classTeacher) : null, students: s._count.enrolments, slots: cells };
    });
    const doneRows = rows.filter((r) => r.slots.every((x) => x.marked)).length;
    return {
        date,
        dayOff: off,
        mode,
        slots: columns.map((c) => ({ value: c, label: c === 'periods' ? 'Periods' : SLOT_NAMES[c] })),
        sections: rows,
        totals: { sections: rows.length, marked: doneRows, notMarked: rows.length - doneRows },
    };
};

// ─── Attendance % ────────────────────────────────────────────────────────────

export interface Summary {
    /** Registers the student was on (excused ones included). */
    days: number;
    present: number;
    absent: number;
    excused: number;
    /** Present ÷ (days − excused), as a %; null with nothing marked yet. */
    percent: number | null;
}

/** Each student's attendance in a period (registers of any section they were on). */
export const summaries = async (studentIds: string[], from: string, to: string) => {
    const list = await statuses();
    const byId = new Map(list.map((s) => [s.id, s]));
    const marks = studentIds.length
        ? await db.attendanceMark.findMany({ where: { studentId: { in: studentIds }, sheet: { date: { gte: dayDate(from), lte: dayDate(to) } } }, select: { studentId: true, statusId: true, sheetId: true, sheet: { select: { sectionId: true, date: true } } } })
        : [];
    // A day counts once, however many registers it had (morning / afternoon, every period).
    const sheetsOfDay = new Map<string, Set<string>>();
    for (const m of marks) {
        const k = `${m.sheet.sectionId}|${isoOf(m.sheet.date)}`;
        if (!sheetsOfDay.has(k)) sheetsOfDay.set(k, new Set());
        sheetsOfDay.get(k)!.add(m.sheetId);
    }
    const out = new Map<string, Summary>(studentIds.map((id) => [id, { days: 0, present: 0, absent: 0, excused: 0, percent: null }]));
    for (const m of marks) {
        const st = byId.get(m.statusId);
        const s = out.get(m.studentId);
        if (!st || !s) continue;
        const weight = 1 / (sheetsOfDay.get(`${m.sheet.sectionId}|${isoOf(m.sheet.date)}`)?.size ?? 1);
        s.days += weight;
        if (st.excused) s.excused += weight;
        else {
            s.present += st.present * weight;
            if (st.present === 0) s.absent += weight;
        }
    }
    const r1 = (n: number) => Math.round(n * 10) / 10;
    for (const s of out.values()) {
        const counted = s.days - s.excused;
        s.percent = counted > 0 ? Math.round((s.present / counted) * 1000) / 10 : null;
        s.days = r1(s.days);
        s.present = r1(s.present);
        s.absent = r1(s.absent);
        s.excused = r1(s.excused);
    }
    return out;
};

// ─── A student's own (students and parents) ─────────────────────────────────

export const myQuery = z.object({ student: z.uuid().optional(), month: z.string().regex(/^\d{4}-\d{2}$/).optional() });

/** A student's month (calendar) and their session so far — for the student themself or their parent. */
export const myAttendance = async (q: z.infer<typeof myQuery>, userId: string) => {
    const a = await getUserAccess(userId);
    const scope = (a.permissions['attendance.view'] ?? 'own') as DataScope;
    const where: Prisma.StudentWhereInput = await studentScope({ userId, scope: scope === 'all' ? 'all' : 'own', sensitive: false });
    const children = await db.student.findMany({ where: { ...where, ...(scope === 'all' && q.student ? { id: q.student } : {}) }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true }, orderBy: { firstName: 'asc' }, take: scope === 'all' ? 1 : 20 });
    if (!children.length) return { children: [], student: null };
    const child = children.find((c) => c.id === q.student) ?? children[0];
    const year = await currentYear();
    if (!year) throw badRequest('No current academic year is set');
    const today = todayIST();
    const month = q.month ?? today.slice(0, 7);
    const first = `${month}-01`;
    const last = isoOf(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)));
    const [list, off, marks, enrol] = await Promise.all([
        statuses(),
        daysOff(first, last, 'students'),
        db.attendanceMark.findMany({ where: { studentId: child.id, sheet: { date: { gte: dayDate(first), lte: dayDate(last) } } }, select: { statusId: true, note: true, sheet: { select: { date: true, slot: true } } } }),
        db.enrolment.findFirst({ where: { studentId: child.id, academicYearId: year.id }, select: { rollNumber: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } }),
    ]);
    // Leave asked for (waiting) or approved in the month: shown on its days even before they are marked.
    const leaves = await db.studentLeave.findMany({ where: { studentId: child.id, status: { in: ['pending', 'approved'] }, fromDate: { lte: dayDate(last) }, toDate: { gte: dayDate(first) } }, select: { fromDate: true, toDate: true, status: true, kind: true, reason: true } });
    const byId = new Map(list.map((s) => [s.id, s]));
    const days = [];
    for (let t = dayDate(first).getTime(); t <= dayDate(last).getTime(); t += 86_400_000) {
        const iso = isoOf(new Date(t));
        const mine = marks.filter((m) => isoOf(m.sheet.date) === iso).sort((x, y) => x.sheet.slot.localeCompare(y.sheet.slot, 'en', { numeric: true }));
        const each = mine.map((m) => ({ slot: m.sheet.slot, code: byId.get(m.statusId)?.code ?? '?', name: byId.get(m.statusId)?.name ?? '', present: byId.get(m.statusId)?.present ?? 0, excused: byId.get(m.statusId)?.excused ?? false, note: m.note }));
        const many = each.length > 2;
        const presentIn = each.filter((m) => m.present > 0).length;
        const lv = leaves.find((l) => isoOf(l.fromDate) <= iso && isoOf(l.toDate) >= iso);
        days.push({
            date: iso,
            off: off.get(iso) ?? null,
            future: iso > today,
            leave: lv && !off.has(iso) ? { status: lv.status, kind: lv.kind, reason: lv.reason } : null,
            // Every period: one mark for the day ("present in 6 of 8 periods").
            marks: many
                ? [{ slot: 'periods', code: dayCode(each), name: presentIn === each.length ? 'Present in every period' : `Present in ${presentIn} of ${each.length} periods`, present: presentIn / each.length, excused: each.every((m) => m.excused), note: each.map((m) => m.note).filter(Boolean).join('; ') || null }]
                : each,
        });
    }
    const yearFrom = isoOf(year.startDate);
    const [monthSum, yearSum] = await Promise.all([summaries([child.id], first, last < today ? last : today), summaries([child.id], yearFrom, today)]);
    const { minPercent } = await getSettings({ minPercent: ATTENDANCE.minPercent });
    return {
        children: children.map((c) => ({ id: c.id, name: fullName(c), admissionNo: c.admissionNo })),
        student: { id: child.id, name: fullName(child), admissionNo: child.admissionNo, section: enrol ? sectionLabel(enrol.section) : null, roll: enrol?.rollNumber ?? null },
        month,
        days,
        statuses: list.filter((s) => s.isActive).map(({ code, name, present, excused }) => ({ code, name, present, excused })),
        monthSummary: monthSum.get(child.id)!,
        yearSummary: { ...yearSum.get(child.id)!, from: yearFrom, year: year.name },
        minPercent,
    };
};

// ─── A teacher's lessons (period mode) ──────────────────────────────────────

/** In period mode: the teacher's periods on a date (with substitutions), each marked or not. */
export const myLessons = async (userId: string, date?: string) => {
    const day = date ?? todayIST();
    const mode = await modeOf();
    const staff = await staffOf(userId);
    const year = await currentYear();
    if (mode !== 'period' || !staff || !year) return { mode, date: day, lessons: [] };
    const lessons = await lessonsOf(staff.id, year.id, day);
    const sectionIds = [...new Set(lessons.map((l) => l.sectionId))];
    const [sections, sheets] = await Promise.all([
        db.section.findMany({ where: { id: { in: sectionIds } }, select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } } } }),
        db.attendanceSheet.findMany({ where: { date: dayDate(day), sectionId: { in: sectionIds } }, select: { sectionId: true, slot: true } }),
    ]);
    const done = new Set(sheets.map((x) => `${x.sectionId}|${x.slot}`));
    return {
        mode,
        date: day,
        lessons: lessons.map((l) => ({ ...l, section: sectionLabel(sections.find((s) => s.id === l.sectionId)!), marked: done.has(`${l.sectionId}|${l.slot}`) })),
    };
};
