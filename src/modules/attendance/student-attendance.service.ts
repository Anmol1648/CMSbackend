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

/** The registers of a day: "day", or "am" and "pm" when attendance is taken twice. */
export const slotsOfDay = async () => ((await getSettings({ mode: ATTENDANCE.mode })).mode === 'twice' ? ['am', 'pm'] : ['day']);
export const SLOT_NAMES: Record<string, string> = { day: 'Day', am: 'Morning', pm: 'Afternoon' };

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
    return rows.map((r) => r.id);
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
        select: { id: true, name: true, academicYearId: true, academicYear: { select: { startDate: true, endDate: true, name: true } }, schoolClass: { select: { name: true, shortName: true } }, classTeacher: { select: { firstName: true, middleName: true, lastName: true } } },
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

/** Whether the person may change this register now, and why not. */
const editRule = async (userId: string, sectionId: string, date: string, sheet: { markedAt: Date } | null) => {
    const marks = await markableSections(userId);
    if (!inScope(marks, sectionId)) return { editable: false, reason: 'You can see this register but not mark it.' };
    if (date > todayIST()) return { editable: false, reason: 'Attendance can’t be marked for a day that hasn’t come yet.' };
    if (marks === 'all') return { editable: true, reason: null };
    const s = await getSettings({ backDays: ATTENDANCE.backDays, editHours: ATTENDANCE.editHours });
    const age = Math.round((dayDate(todayIST()).getTime() - dayDate(date).getTime()) / 86_400_000);
    if (age > s.backDays) return { editable: false, reason: s.backDays ? `Teachers can mark attendance up to ${s.backDays} day(s) back. Ask the office to change older days.` : 'Teachers can mark only today’s attendance. Ask the office to change older days.' };
    if (sheet && s.editHours && Date.now() - sheet.markedAt.getTime() > s.editHours * 3600_000) return { editable: false, reason: `A register can be changed for ${s.editHours} hour(s) after it is saved. Ask the office to change it.` };
    return { editable: true, reason: null };
};

export const registerQuery = z.object({ section: z.uuid('choose a section'), date: ISO.optional(), slot: z.enum(['day', 'am', 'pm']).optional() });

/** A section's register for a date (and slot): the students with their marks, or the defaults to start from. */
export const getRegister = async (q: z.infer<typeof registerQuery>, userId: string) => {
    const date = q.date ?? todayIST();
    if (!inScope(await viewableSections(userId), q.section)) throw forbidden('You can’t see this section’s attendance');
    const section = await sectionOf(q.section);
    const slots = await slotsOfDay();
    const slot = q.slot && slots.includes(q.slot) ? q.slot : slots[0];
    const inYear = date >= isoOf(section.academicYear.startDate) && date <= isoOf(section.academicYear.endDate);
    const [list, off, students, sheet] = await Promise.all([
        statuses(),
        dayOff(date, 'students'),
        roster(section.id, section.academicYearId, date),
        db.attendanceSheet.findFirst({ where: { sectionId: section.id, date: dayDate(date), slot }, include: { marks: true } }),
    ]);
    const start = await defaultStatus(list);
    const rule = !inYear ? { editable: false, reason: `This date is outside ${section.academicYear.name}.` } : off ? { editable: false, reason: `Not a school day: ${off}.` } : await editRule(userId, section.id, date, sheet);
    const markOf = new Map((sheet?.marks ?? []).map((m) => [m.studentId, m]));
    const marker = sheet?.markedBy ? await db.user.findUnique({ where: { id: sheet.markedBy }, select: { displayName: true } }) : null;
    const editor = sheet?.updatedBy && sheet.updatedBy !== sheet.markedBy ? await db.user.findUnique({ where: { id: sheet.updatedBy }, select: { displayName: true } }) : null;
    return {
        section: { id: section.id, label: sectionLabel(section), className: section.schoolClass.name, classTeacher: section.classTeacher ? fullName(section.classTeacher) : null, year: section.academicYear.name },
        date,
        slot,
        slots: slots.map((s) => ({ value: s, label: SLOT_NAMES[s] })),
        dayOff: off,
        ...rule,
        statuses: list.filter((s) => s.isActive || [...markOf.values()].some((m) => m.statusId === s.id)),
        defaultStatusId: start?.id ?? null,
        marked: sheet ? { at: sheet.markedAt, by: marker?.displayName ?? null, changedAt: editor ? sheet.updatedAt : null, changedBy: editor?.displayName ?? null } : null,
        students: students.map((s) => ({ ...s, statusId: markOf.get(s.id)?.statusId ?? null, note: markOf.get(s.id)?.note ?? null })),
    };
};

export const saveSchema = z.strictObject({
    section: z.uuid(),
    date: ISO,
    slot: z.enum(['day', 'am', 'pm']).default('day'),
    marks: z.array(z.strictObject({ studentId: z.uuid(), statusId: z.uuid(), note: z.string().trim().max(200).optional() })).max(300),
});

/** Saves a whole register (every student of the section, in one go). */
export const saveRegister = async (input: z.infer<typeof saveSchema>, userId: string) => {
    const section = await sectionOf(input.section);
    const slots = await slotsOfDay();
    if (!slots.includes(input.slot)) throw badRequest('Attendance is not taken in that part of the day', [{ field: 'slot', message: 'is not used' }]);
    if (input.date < isoOf(section.academicYear.startDate) || input.date > isoOf(section.academicYear.endDate)) throw badRequest(`This date is outside ${section.academicYear.name}`, [{ field: 'date', message: 'is outside the session' }]);
    const off = await dayOff(input.date, 'students');
    if (off) throw badRequest(`Not a school day: ${off}`, [{ field: 'date', message: 'is not a school day' }]);
    const existing = await db.attendanceSheet.findFirst({ where: { sectionId: section.id, date: dayDate(input.date), slot: input.slot }, select: { id: true, markedAt: true } });
    const rule = await editRule(userId, section.id, input.date, existing);
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

/** Every section of the current session on a day: marked or not, and the counts. */
export const overview = async (q: z.infer<typeof overviewQuery>, userId: string) => {
    const date = q.date ?? todayIST();
    const scope = await viewableSections(userId);
    const year = await currentYear();
    if (!year) throw badRequest('No current academic year is set (Academic setup)');
    const [sections, list, off, slots] = await Promise.all([
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
        slotsOfDay(),
    ]);
    const sheets = await db.attendanceSheet.findMany({ where: { date: dayDate(date), sectionId: { in: sections.map((s) => s.id) } }, include: { marks: { select: { statusId: true } } } });
    const users = new Map((await db.user.findMany({ where: { id: { in: [...new Set(sheets.map((s) => s.markedBy).filter((x): x is string => !!x))] } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
    const byId = new Map(list.map((s) => [s.id, s]));
    const rows = sections.map((s) => {
        const mine = sheets.filter((x) => x.sectionId === s.id);
        return {
            id: s.id,
            label: sectionLabel(s),
            classTeacher: s.classTeacher ? fullName(s.classTeacher) : null,
            students: s._count.enrolments,
            slots: slots.map((slot) => {
                const sheet = mine.find((x) => x.slot === slot);
                if (!sheet) return { slot, marked: false as const };
                const count = (f: (st: { present: number; excused: boolean }) => boolean) => sheet.marks.filter((m) => byId.get(m.statusId) && f(byId.get(m.statusId)!)).length;
                return { slot, marked: true as const, present: count((st) => st.present > 0), absent: count((st) => st.present === 0 && !st.excused), leave: count((st) => st.excused), markedBy: sheet.markedBy ? (users.get(sheet.markedBy) ?? null) : null, markedAt: sheet.markedAt };
            }),
        };
    });
    const done = rows.filter((r) => r.slots.every((x) => x.marked)).length;
    return { date, dayOff: off, slots: slots.map((s) => ({ value: s, label: SLOT_NAMES[s] })), sections: rows, totals: { sections: rows.length, marked: done, notMarked: rows.length - done } };
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
        ? await db.attendanceMark.findMany({ where: { studentId: { in: studentIds }, sheet: { date: { gte: dayDate(from), lte: dayDate(to) } } }, select: { studentId: true, statusId: true, sheet: { select: { slot: true } } } })
        : [];
    const out = new Map<string, Summary>(studentIds.map((id) => [id, { days: 0, present: 0, absent: 0, excused: 0, percent: null }]));
    for (const m of marks) {
        const st = byId.get(m.statusId);
        const s = out.get(m.studentId);
        if (!st || !s) continue;
        // Twice a day: each half counts as half a day.
        const weight = m.sheet.slot === 'day' ? 1 : 0.5;
        s.days += weight;
        if (st.excused) s.excused += weight;
        else {
            s.present += st.present * weight;
            if (st.present === 0) s.absent += weight;
        }
    }
    for (const s of out.values()) {
        const counted = s.days - s.excused;
        s.percent = counted > 0 ? Math.round((s.present / counted) * 1000) / 10 : null;
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
    const byId = new Map(list.map((s) => [s.id, s]));
    const days = [];
    for (let t = dayDate(first).getTime(); t <= dayDate(last).getTime(); t += 86_400_000) {
        const iso = isoOf(new Date(t));
        const mine = marks.filter((m) => isoOf(m.sheet.date) === iso).sort((x, y) => x.sheet.slot.localeCompare(y.sheet.slot));
        days.push({
            date: iso,
            off: off.get(iso) ?? null,
            future: iso > today,
            marks: mine.map((m) => ({ slot: m.sheet.slot, code: byId.get(m.statusId)?.code ?? '?', name: byId.get(m.statusId)?.name ?? '', present: byId.get(m.statusId)?.present ?? 0, excused: byId.get(m.statusId)?.excused ?? false, note: m.note })),
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
