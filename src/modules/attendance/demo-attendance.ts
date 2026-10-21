import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { atIST, dayDate, isoOf, todayIST } from './attendance.settings';
import { schoolDays } from './calendar.service';
import { statuses } from './student-attendance.service';

/**
 * Demo attendance: the national holidays of the session, every section's register for the last
 * school days (up to yesterday, so today can be marked by hand), and demo staff check-ins.
 */

let seed = 20261022;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

const HOLIDAYS: [string, string][] = [
    ['08-15', 'Independence Day'],
    ['10-02', 'Gandhi Jayanti'],
    ['12-25', 'Christmas'],
    ['01-26', 'Republic Day'],
];

export const createDemoAttendance = async (year: { id: string; startDate: Date; endDate: Date }, options: { days?: number } = {}) => {
    const tenantId = getTenantId()!;
    seed = 20261022;
    const from = isoOf(year.startDate);
    const to = isoOf(year.endDate);
    // National holidays that fall in the session.
    const first = Number(from.slice(0, 4));
    const holidays = [first, first + 1].flatMap((y) => HOLIDAYS.map(([md, name]) => ({ date: `${y}-${md}`, name }))).filter((h) => h.date >= from && h.date <= to);
    await db.holiday.createMany({ data: holidays.map((h) => ({ tenantId, date: dayDate(h.date), name: h.name, isDemo: true })), skipDuplicates: true });

    const list = (await statuses()).filter((s) => s.isActive);
    const code = (c: string) => list.find((s) => s.code === c)?.id ?? list[0].id;
    const P = code('P');
    const pickStudent = () => {
        const r = rand();
        return r < 0.9 ? P : r < 0.94 ? code('A') : r < 0.965 ? code('LT') : r < 0.98 ? code('HD') : code('LV');
    };

    // The last school days before today.
    const today = todayIST();
    const back = isoOf(new Date(dayDate(today).getTime() - (options.days ?? 30) * 86_400_000));
    const startFrom = back > from ? back : from;
    const yesterday = isoOf(new Date(dayDate(today).getTime() - 86_400_000));
    const days = yesterday >= startFrom ? await schoolDays(startFrom, yesterday, 'students') : [];

    const sections = await db.section.findMany({ where: { academicYearId: year.id, isActive: true }, select: { id: true, classTeacher: { select: { userId: true } } } });
    const enrolments = await db.enrolment.findMany({ where: { academicYearId: year.id, student: { status: 'active' } }, select: { sectionId: true, studentId: true, student: { select: { admissionDate: true } } } });
    let sheets = 0;
    for (const d of days) {
        const created = await db.attendanceSheet.createManyAndReturn({
            data: sections.map((s) => ({ tenantId, sectionId: s.id, date: dayDate(d), slot: 'day', markedBy: s.classTeacher?.userId ?? null, markedAt: atIST(d, `0${8 + Math.floor(rand() * 2)}:${String(Math.floor(rand() * 60)).padStart(2, '0')}`), isDemo: true })),
            skipDuplicates: true,
            select: { id: true, sectionId: true },
        });
        sheets += created.length;
        const marks = created.flatMap((sheet) =>
            enrolments.filter((e) => e.sectionId === sheet.sectionId && isoOf(e.student.admissionDate) <= d).map((e) => ({ tenantId, sheetId: sheet.id, studentId: e.studentId, statusId: pickStudent() }))
        );
        if (marks.length) await db.attendanceMark.createMany({ data: marks, skipDuplicates: true });
    }

    // Demo staff: most check in a little before 8, some late; a few forget to check out.
    const staffDays = yesterday >= startFrom ? await schoolDays(startFrom, yesterday, 'staff') : [];
    const staff = await db.staff.findMany({ where: { isDemo: true, status: 'working' }, select: { id: true } });
    const rows = staffDays.flatMap((d) =>
        staff
            .filter(() => rand() > 0.04)
            .map((s) => {
                const r = rand();
                const inMin = r < 0.8 ? 7 * 60 + 35 + Math.floor(rand() * 30) : r < 0.97 ? 8 * 60 + 11 + Math.floor(rand() * 40) : 10 * 60 + Math.floor(rand() * 30);
                const outMin = 14 * 60 + 30 + Math.floor(rand() * 45);
                const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
                return {
                    tenantId,
                    staffId: s.id,
                    date: dayDate(d),
                    checkIn: atIST(d, hhmm(inMin)),
                    checkOut: rand() < 0.95 ? atIST(d, hhmm(outMin)) : null,
                    statusId: inMin >= 10 * 60 ? code('HD') : inMin > 8 * 60 + 10 ? code('LT') : P,
                    late: inMin > 8 * 60 + 10,
                    source: 'button',
                    isDemo: true,
                };
            })
    );
    if (rows.length) await db.staffAttendance.createMany({ data: rows, skipDuplicates: true });
    return { holidays: holidays.length, days: days.length, registers: sheets, staffDays: rows.length };
};

export const clearDemoAttendance = async () => {
    await db.attendanceSheet.deleteMany({ where: { isDemo: true } });
    await db.staffAttendance.deleteMany({ where: { isDemo: true } });
    await db.holiday.deleteMany({ where: { isDemo: true } });
};
