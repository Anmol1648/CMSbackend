/**
 * Builds a timetable: places every lesson (a subject — or a parallel group of optional subjects —
 * of a section, so many periods a week) into the week without any clash. A teacher, a room and a
 * section are never in two places at once; teachers' limits and unavailable periods are kept;
 * double periods are consecutive and never cross a break; a subject is spread over the week.
 * Greedy placement of the hardest lessons first, tried with several shuffles; the best try wins.
 * Pure (no database), so it can be tested on its own.
 */

export interface GenDay {
    weekday: number;
    periods: number;
    /** Periods followed by a break (a double period can't span them). */
    breakAfter: number[];
}

export interface GenLesson {
    /** Unique per section + subject group. */
    key: string;
    sectionId: string;
    /** One subject, or the optional subjects that run at the same time. */
    subjects: { subjectId: string; staffId: string | null; roomId: string | null }[];
    perWeek: number;
    doubles: number;
    /** Taught by the section's class teacher (preferred in the first period). */
    classTeacher: boolean;
}

export interface GenRule {
    maxPerDay: number;
    maxPerWeek: number;
    /** "weekday:periodNo" */
    unavailable: Set<string>;
}

export interface GenEntry {
    sectionId: string;
    weekday: number;
    periodNo: number;
    subjectId: string;
    staffId: string | null;
    roomId: string | null;
    locked: boolean;
}

export interface GenOptions {
    attempts: number;
    classTeacherFirst: boolean;
    maxSamePerDay: number;
    seed: number;
}

export interface Unplaced {
    lessonKey: string;
    sectionId: string;
    subjectIds: string[];
    missing: number;
    reason: string;
}

export interface GenResult {
    entries: GenEntry[];
    unplaced: Unplaced[];
    placed: number;
    wanted: number;
}

/** Small seeded random numbers (the same seed gives the same timetable). */
const random = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

interface Unit {
    lesson: GenLesson;
    length: 1 | 2;
}

const attempt = (days: GenDay[], lessons: GenLesson[], rules: Map<string, GenRule>, fallback: GenRule, locked: GenEntry[], opt: GenOptions, rnd: () => number) => {
    const sectionBusy = new Set<string>();
    const teacherBusy = new Set<string>();
    const roomBusy = new Set<string>();
    const teacherDay = new Map<string, number>();
    const teacherWeek = new Map<string, number>();
    const lessonDay = new Map<string, number>();
    const entries: GenEntry[] = [];
    const bump = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
    const rule = (staffId: string) => rules.get(staffId) ?? fallback;

    const occupy = (e: GenEntry) => {
        sectionBusy.add(`${e.sectionId}|${e.weekday}|${e.periodNo}`);
        if (e.staffId && !teacherBusy.has(`${e.staffId}|${e.weekday}|${e.periodNo}`)) {
            teacherBusy.add(`${e.staffId}|${e.weekday}|${e.periodNo}`);
            bump(teacherDay, `${e.staffId}|${e.weekday}`, 1);
            bump(teacherWeek, e.staffId, 1);
        }
        if (e.roomId) roomBusy.add(`${e.roomId}|${e.weekday}|${e.periodNo}`);
    };

    // Locked lessons first; they count towards their lesson's periods.
    const lockedCount = new Map<string, number>();
    for (const e of locked) {
        occupy(e);
        entries.push(e);
        const lesson = lessons.find((l) => l.sectionId === e.sectionId && l.subjects[0].subjectId === e.subjectId);
        if (lesson) {
            bump(lockedCount, lesson.key, 1);
            bump(lessonDay, `${lesson.key}|${e.weekday}`, 1);
        }
    }

    const demand = new Map<string, number>();
    for (const l of lessons) for (const s of l.subjects) if (s.staffId) bump(demand, s.staffId, l.perWeek);
    const units: (Unit & { order: number })[] = [];
    for (const l of lessons) {
        const left = Math.max(0, l.perWeek - (lockedCount.get(l.key) ?? 0));
        const doubles = Math.min(l.doubles, Math.floor(left / 2));
        const hardness = Math.max(0, ...l.subjects.map((s) => (s.staffId ? demand.get(s.staffId) ?? 0 : 0))) + l.subjects.length * 5;
        for (let i = 0; i < doubles; i++) units.push({ lesson: l, length: 2, order: 1000 + hardness + rnd() * 10 });
        for (let i = 0; i < left - doubles * 2; i++) units.push({ lesson: l, length: 1, order: hardness + rnd() * 10 });
    }
    units.sort((a, b) => b.order - a.order);

    const fits = (l: GenLesson, length: number, day: GenDay, start: number) => {
        if (start + length - 1 > day.periods) return false;
        if (length === 2 && day.breakAfter.includes(start)) return false;
        const sameDay = lessonDay.get(`${l.key}|${day.weekday}`) ?? 0;
        if (sameDay + length > Math.max(opt.maxSamePerDay, length)) return false;
        for (let p = start; p < start + length; p++) {
            if (sectionBusy.has(`${l.sectionId}|${day.weekday}|${p}`)) return false;
            for (const s of l.subjects) {
                if (s.staffId) {
                    if (teacherBusy.has(`${s.staffId}|${day.weekday}|${p}`)) return false;
                    if (rule(s.staffId).unavailable.has(`${day.weekday}:${p}`)) return false;
                }
                if (s.roomId && roomBusy.has(`${s.roomId}|${day.weekday}|${p}`)) return false;
            }
        }
        // The same teacher may take two subjects of a group (rare); count them once.
        for (const staffId of new Set(l.subjects.map((s) => s.staffId).filter((x): x is string => !!x))) {
            const r = rule(staffId);
            if ((teacherDay.get(`${staffId}|${day.weekday}`) ?? 0) + length > r.maxPerDay) return false;
            if ((teacherWeek.get(staffId) ?? 0) + length > r.maxPerWeek) return false;
        }
        return true;
    };

    const score = (l: GenLesson, length: number, day: GenDay, start: number) => {
        let sc = (lessonDay.get(`${l.key}|${day.weekday}`) ?? 0) * 12;
        for (const s of l.subjects) if (s.staffId) sc += (teacherDay.get(`${s.staffId}|${day.weekday}`) ?? 0) * 1.5;
        if (opt.classTeacherFirst) {
            if (l.classTeacher && start === 1) sc -= 25;
            else if (!l.classTeacher && start === 1) sc += 4;
        }
        // Doubles fit best late in the day (practicals); singles anywhere.
        if (length === 2) sc -= start / 4;
        return sc + rnd() * 3;
    };

    const place = (l: GenLesson, length: number) => {
        let best: { day: GenDay; start: number; sc: number } | null = null;
        for (const day of days) {
            for (let start = 1; start <= day.periods; start++) {
                if (!fits(l, length, day, start)) continue;
                const sc = score(l, length, day, start);
                if (!best || sc < best.sc) best = { day, start, sc };
            }
        }
        if (!best) return false;
        for (let p = best.start; p < best.start + length; p++) {
            for (const s of l.subjects) {
                const e: GenEntry = { sectionId: l.sectionId, weekday: best.day.weekday, periodNo: p, subjectId: s.subjectId, staffId: s.staffId, roomId: s.roomId, locked: false };
                occupy(e);
                entries.push(e);
            }
        }
        bump(lessonDay, `${l.key}|${best.day.weekday}`, length);
        return true;
    };

    const missing = new Map<string, number>();
    for (const u of units) {
        if (place(u.lesson, u.length)) continue;
        // A double that doesn't fit is tried as two single periods.
        if (u.length === 2) {
            const a = place(u.lesson, 1);
            const b = place(u.lesson, 1);
            const lost = (a ? 0 : 1) + (b ? 0 : 1);
            if (lost) bump(missing, u.lesson.key, lost);
            continue;
        }
        bump(missing, u.lesson.key, 1);
    }

    const why = (l: GenLesson) => {
        const total = days.reduce((a, d) => a + d.periods, 0);
        const used = [...sectionBusy].filter((k) => k.startsWith(`${l.sectionId}|`)).length;
        if (used >= total) return 'the section has no free period left this week';
        for (const s of l.subjects) {
            if (!s.staffId) continue;
            const r = rule(s.staffId);
            if ((teacherWeek.get(s.staffId) ?? 0) >= r.maxPerWeek) return `the teacher already has ${r.maxPerWeek} periods this week (their limit)`;
        }
        return 'no period left where the teacher(s), room and section are all free';
    };
    const unplaced: Unplaced[] = [...missing.entries()].map(([key, n]) => {
        const l = lessons.find((x) => x.key === key)!;
        return { lessonKey: key, sectionId: l.sectionId, subjectIds: l.subjects.map((s) => s.subjectId), missing: n, reason: why(l) };
    });
    const wanted = lessons.reduce((a, l) => a + l.perWeek, 0);
    const missed = unplaced.reduce((a, u) => a + u.missing, 0);
    // How well spread it is (lower = better), to choose between equally complete tries.
    let spread = 0;
    for (const v of lessonDay.values()) spread += v > 1 ? (v - 1) * (v - 1) : 0;
    return { entries, unplaced, placed: wanted - missed, wanted, missed, spread };
};

export const generateTimetable = (input: { days: GenDay[]; lessons: GenLesson[]; rules: Map<string, GenRule>; fallback: GenRule; locked: GenEntry[]; options: GenOptions }): GenResult => {
    const { days, lessons, rules, fallback, locked, options } = input;
    let best: ReturnType<typeof attempt> | null = null;
    for (let i = 0; i < Math.max(1, options.attempts); i++) {
        const r = attempt(days, lessons, rules, fallback, locked, options, random(options.seed + i * 7919));
        if (!best || r.missed < best.missed || (r.missed === best.missed && r.spread < best.spread)) best = r;
        if (best.missed === 0 && best.spread === 0) break;
    }
    return { entries: best!.entries, unplaced: best!.unplaced, placed: best!.placed, wanted: best!.wanted };
};
