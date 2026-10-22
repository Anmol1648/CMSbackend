import { db } from '../../core/db';
import { fullName } from '../students/students.service';
import { weekOf } from '../timetable/tt-setup.service';
import { dayDate } from './attendance.settings';

/**
 * Period-wise attendance reads the published timetable: which periods a section has on a day, who
 * teaches each, and that day's substitutions (the substitute marks instead of the absent teacher).
 */

const weekday = (iso: string) => dayDate(iso).getUTCDay() || 7;
const name = { select: { firstName: true, middleName: true, lastName: true } } as const;

const publishedOf = (yearId: string) => db.timetable.findFirst({ where: { academicYearId: yearId, status: 'published' }, orderBy: { publishedAt: 'desc' }, select: { id: true } });

export interface Period {
    value: string;
    periodNo: number;
    label: string;
    subject: string;
    time: string | null;
    /** Who marks it: the substitute when there is one, else the period's teachers. */
    markers: string[];
    teacher: string | null;
}

/** A section's periods on a date (null when the session has no published timetable). */
export const periodsOf = async (sectionId: string, yearId: string, date: string): Promise<Period[] | null> => {
    const tt = await publishedOf(yearId);
    if (!tt) return null;
    const w = weekday(date);
    const [week, entries, subs] = await Promise.all([
        weekOf(yearId),
        db.ttEntry.findMany({ where: { timetableId: tt.id, sectionId, weekday: w }, select: { periodNo: true, staffId: true, staff: name, subject: { select: { name: true } } } }),
        db.ttSubstitution.findMany({ where: { date: dayDate(date), sectionId }, select: { periodNo: true, absentStaffId: true, substituteStaffId: true, substitute: name } }),
    ]);
    const slots = week.find((d) => d.weekday === w)?.periods ?? [];
    return [...new Set(entries.map((e) => e.periodNo))]
        .sort((a, b) => a - b)
        .map((n) => {
            const es = entries.filter((e) => e.periodNo === n);
            const sub = subs.find((s) => s.periodNo === n);
            const slot = slots.find((p) => p.periodNo === n);
            const subject = [...new Set(es.map((e) => e.subject.name))].join(' / ');
            const teachers = es.map((e) => (e.staff ? fullName(e.staff) : null)).filter((x): x is string => !!x);
            const markers = sub ? (sub.substituteStaffId ? [sub.substituteStaffId] : []) : es.map((e) => e.staffId).filter((x): x is string => !!x);
            return {
                value: `p${n}`,
                periodNo: n,
                label: `${slot?.label ?? `Period ${n}`}${slot ? ` · ${slot.startTime}` : ''} · ${subject}`,
                subject,
                time: slot ? `${slot.startTime}–${slot.endTime}` : null,
                markers,
                teacher: sub ? (sub.substitute ? `${fullName(sub.substitute)} (substitute)` : 'No teacher (substitution not arranged)') : teachers.join(', ') || null,
            };
        });
};

/** A teacher's lessons on a date: their periods (unless someone substitutes) and the ones they substitute. */
export const lessonsOf = async (staffId: string, yearId: string, date: string) => {
    const tt = await publishedOf(yearId);
    if (!tt) return [];
    const w = weekday(date);
    const [week, mine, subs] = await Promise.all([
        weekOf(yearId),
        db.ttEntry.findMany({ where: { timetableId: tt.id, staffId, weekday: w }, select: { sectionId: true, periodNo: true, subject: { select: { name: true } } } }),
        db.ttSubstitution.findMany({ where: { date: dayDate(date), OR: [{ absentStaffId: staffId }, { substituteStaffId: staffId }] }, select: { sectionId: true, periodNo: true, absentStaffId: true, substituteStaffId: true, subject: { select: { name: true } } } }),
    ]);
    const slots = week.find((d) => d.weekday === w)?.periods ?? [];
    const away = new Set(subs.filter((s) => s.absentStaffId === staffId).map((s) => `${s.sectionId}|${s.periodNo}`));
    const lessons = [
        ...mine.filter((e) => !away.has(`${e.sectionId}|${e.periodNo}`)).map((e) => ({ sectionId: e.sectionId, periodNo: e.periodNo, subject: e.subject.name, substitute: false })),
        ...subs.filter((s) => s.substituteStaffId === staffId).map((s) => ({ sectionId: s.sectionId, periodNo: s.periodNo, subject: s.subject?.name ?? 'Substitution', substitute: true })),
    ];
    const seen = new Set<string>();
    return lessons
        .filter((l) => (seen.has(`${l.sectionId}|${l.periodNo}`) ? false : (seen.add(`${l.sectionId}|${l.periodNo}`), true)))
        .map((l) => {
            const slot = slots.find((p) => p.periodNo === l.periodNo);
            return { ...l, slot: `p${l.periodNo}`, label: slot?.label ?? `Period ${l.periodNo}`, time: slot ? `${slot.startTime}–${slot.endTime}` : null };
        })
        .sort((a, b) => a.periodNo - b.periodNo);
};

/** Sections where a teacher has any period in the session's published timetable (or substitutes on a date). */
export const sectionsTaughtBy = async (staffId: string, yearId: string, date?: string) => {
    const tt = await publishedOf(yearId);
    const [entries, subs] = await Promise.all([
        tt ? db.ttEntry.findMany({ where: { timetableId: tt.id, staffId }, select: { sectionId: true }, distinct: ['sectionId'] }) : Promise.resolve([]),
        date ? db.ttSubstitution.findMany({ where: { date: dayDate(date), substituteStaffId: staffId }, select: { sectionId: true } }) : Promise.resolve([]),
    ]);
    return [...new Set([...entries.map((e) => e.sectionId), ...subs.map((s) => s.sectionId)])];
};
