import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { ATTENDANCE, dayDate, isoOf } from './attendance.settings';

/** The school calendar: weekly off days, Saturdays off, and the holiday list. */

export type Who = 'students' | 'staff';
const NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ORDINAL = ['', '1st', '2nd', '3rd', '4th', '5th'];

/** ISO weekday (1 = Monday … 7 = Sunday). */
const weekday = (iso: string) => dayDate(iso).getUTCDay() || 7;

/** Why each day of a period is not a school day (holiday, weekly off); school days are left out. */
export const daysOff = async (from: string, to: string, who: Who) => {
    const s = await getSettings({ weeklyOff: ATTENDANCE.weeklyOff, saturdays: ATTENDANCE.saturdays });
    const holidays = await db.holiday.findMany({ where: { date: { gte: dayDate(from), lte: dayDate(to) }, ...(who === 'students' ? { forStudents: true } : { forStaff: true }) }, select: { date: true, name: true } });
    const named = new Map(holidays.map((h) => [isoOf(h.date), h.name]));
    const off = new Map<string, string>();
    for (let t = dayDate(from).getTime(); t <= dayDate(to).getTime(); t += 86_400_000) {
        const iso = isoOf(new Date(t));
        const w = weekday(iso);
        const nth = Math.ceil(Number(iso.slice(8, 10)) / 7);
        if (named.has(iso)) off.set(iso, named.get(iso)!);
        else if (s.weeklyOff.includes(String(w))) off.set(iso, `Weekly off (${NAMES[w]})`);
        else if (w === 6 && ((s.saturdays === '2nd_4th' && (nth === 2 || nth === 4)) || (s.saturdays === '1st_3rd' && (nth === 1 || nth === 3)) || (s.saturdays === 'all_but_2nd' && nth === 2)))
            off.set(iso, `${ORDINAL[nth]} Saturday off`);
    }
    return off;
};

/** Why a day is not a school day, or null when it is one. */
export const dayOff = async (date: string, who: Who) => (await daysOff(date, date, who)).get(date) ?? null;

/** The school days of a period (oldest first). */
export const schoolDays = async (from: string, to: string, who: Who) => {
    const off = await daysOff(from, to, who);
    const days: string[] = [];
    for (let t = dayDate(from).getTime(); t <= dayDate(to).getTime(); t += 86_400_000) {
        const iso = isoOf(new Date(t));
        if (!off.has(iso)) days.push(iso);
    }
    return days;
};

// ─── The holiday list ────────────────────────────────────────────────────────

const ISO = z.iso.date();

export const listHolidays = async (yearId?: string) => {
    const year = yearId ? await db.academicYear.findUnique({ where: { id: yearId } }) : await db.academicYear.findFirst({ where: { isCurrent: true } });
    if (!year) throw badRequest('No academic year to show the holidays of');
    const from = isoOf(year.startDate);
    const to = isoOf(year.endDate);
    const [holidays, off] = await Promise.all([db.holiday.findMany({ where: { date: { gte: year.startDate, lte: year.endDate } }, orderBy: { date: 'asc' } }), daysOff(from, to, 'students')]);
    const total = Math.round((dayDate(to).getTime() - dayDate(from).getTime()) / 86_400_000) + 1;
    const weeklyOff = [...off.values()].filter((r) => r.startsWith('Weekly off') || r.endsWith('Saturday off')).length;
    return {
        year: { id: year.id, name: year.name, from, to },
        holidays: holidays.map((h) => ({ id: h.id, date: isoOf(h.date), name: h.name, forStudents: h.forStudents, forStaff: h.forStaff })),
        counts: { days: total, weeklyOff, holidays: holidays.filter((h) => h.forStudents).length, schoolDays: total - off.size },
    };
};

export const holidaySchema = z
    .strictObject({
        from: ISO,
        /** Optional: the last day of a holiday of several days (Diwali break, winter vacation). */
        to: ISO.optional(),
        name: z.string().trim().min(2, 'is too short').max(80),
        forStudents: z.boolean().default(true),
        forStaff: z.boolean().default(true),
    })
    .refine((h) => !h.to || h.to >= h.from, { message: '“To” is before “from”', path: ['to'] })
    .refine((h) => h.forStudents || h.forStaff, { message: 'choose students, staff or both', path: ['forStudents'] });

/** Adds a holiday (one day or several): days that already have one get the new name. */
export const addHoliday = async (input: z.infer<typeof holidaySchema>) => {
    const tenantId = getTenantId()!;
    const days: string[] = [];
    for (let t = dayDate(input.from).getTime(); t <= dayDate(input.to ?? input.from).getTime(); t += 86_400_000) days.push(isoOf(new Date(t)));
    if (days.length > 120) throw badRequest('At most 120 days at a time', [{ field: 'to', message: 'is too far from “from”' }]);
    const data = { name: input.name, forStudents: input.forStudents, forStaff: input.forStaff };
    await withTransaction(async (tx) => {
        const range = { gte: dayDate(days[0]), lte: dayDate(days[days.length - 1]) };
        await tx.holiday.updateMany({ where: { date: range }, data });
        await tx.holiday.createMany({ data: days.map((d) => ({ tenantId, date: dayDate(d), ...data })), skipDuplicates: true });
    });
    await recordAudit({ action: 'holiday_added', entity: 'holiday', changes: { from: input.from, to: input.to ?? input.from, name: input.name } });
    return { days: days.length };
};

export const deleteHoliday = async (id: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Holiday not found');
    const h = await db.holiday.findFirst({ where: { id } });
    if (!h) throw notFound('Holiday not found');
    await db.holiday.delete({ where: { id } });
    await recordAudit({ action: 'holiday_deleted', entity: 'holiday', entityId: id, changes: { date: isoOf(h.date), name: h.name } });
};
