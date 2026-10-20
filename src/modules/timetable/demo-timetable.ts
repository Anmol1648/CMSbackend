import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { createSchedule, saveDays, weekOf } from './tt-setup.service';
import { generate, publish } from './timetable.service';

/**
 * Demo timetable, KV style: an 8-period day, Monday to Saturday; periods a week per subject by class
 * level; Hindi / Sanskrit (IX–X) and the XI–XII electives as parallel groups; labs with double
 * periods for practicals. Generated and published, with one teacher absent today and substitutes.
 */

type Load = { perWeek: number; doubles?: number; group?: string; room?: string };
const PLAN: { classes: string[]; streams?: string[]; loads: Record<string, Load> }[] = [
    { classes: ['BV1', 'BV2', 'BV3'], loads: { ENG: { perWeek: 8 }, HIN: { perWeek: 8 }, MAT: { perWeek: 8 }, ART: { perWeek: 4 } } },
    { classes: ['I', 'II'], loads: { ENG: { perWeek: 8 }, HIN: { perWeek: 8 }, MAT: { perWeek: 8 }, ART: { perWeek: 3 }, HPE: { perWeek: 3 } } },
    { classes: ['III', 'IV', 'V'], loads: { ENG: { perWeek: 7 }, HIN: { perWeek: 7 }, MAT: { perWeek: 8 }, EVS: { perWeek: 6 }, ART: { perWeek: 2 }, WE: { perWeek: 2 }, HPE: { perWeek: 3 } } },
    {
        classes: ['VI', 'VII', 'VIII'],
        loads: { ENG: { perWeek: 6 }, HIN: { perWeek: 5 }, SKT: { perWeek: 2 }, MAT: { perWeek: 7 }, SCI: { perWeek: 7, doubles: 1 }, SST: { perWeek: 6 }, ART: { perWeek: 1 }, WE: { perWeek: 1 }, HPE: { perWeek: 1 } },
    },
    {
        classes: ['IX', 'X'],
        loads: {
            ENG: { perWeek: 6 },
            HIN: { perWeek: 6, group: 'Second language' },
            SKT: { perWeek: 6, group: 'Second language' },
            MAT: { perWeek: 7 },
            SCI: { perWeek: 7, doubles: 1 },
            SST: { perWeek: 6 },
            AI: { perWeek: 3, room: 'COMP-LAB' },
            ART: { perWeek: 1 },
            WE: { perWeek: 1 },
            HPE: { perWeek: 1 },
        },
    },
    { classes: ['XI', 'XII'], loads: { ENG: { perWeek: 6 }, WE: { perWeek: 1 }, HPE: { perWeek: 1 } } },
    {
        classes: ['XI', 'XII'],
        streams: ['Science'],
        loads: {
            PHY: { perWeek: 7, doubles: 1, room: 'PHY-LAB' },
            CHE: { perWeek: 7, doubles: 1, room: 'CHE-LAB' },
            MAT: { perWeek: 7, doubles: 1, group: 'Elective 1' },
            BIO: { perWeek: 7, doubles: 1, group: 'Elective 1', room: 'BIO-LAB' },
            CS: { perWeek: 4, doubles: 1, group: 'Elective 2', room: 'COMP-LAB' },
            PED: { perWeek: 4, doubles: 1, group: 'Elective 2', room: 'GROUND' },
        },
    },
    {
        classes: ['XI', 'XII'],
        streams: ['Commerce'],
        loads: { ACC: { perWeek: 7 }, BST: { perWeek: 7 }, ECO: { perWeek: 7 }, MAT: { perWeek: 7, group: 'Elective 1' }, IP: { perWeek: 7, group: 'Elective 1', room: 'COMP-LAB' }, PED: { perWeek: 3, room: 'GROUND' } },
    },
    {
        classes: ['XI', 'XII'],
        streams: ['Humanities'],
        loads: { HIS: { perWeek: 7 }, GEO: { perWeek: 7 }, POL: { perWeek: 7 }, ECO: { perWeek: 7, group: 'Elective 1' }, HIN: { perWeek: 7, group: 'Elective 1' }, PED: { perWeek: 3, room: 'GROUND' } },
    },
];

export const createDemoTimetable = async (yearId: string) => {
    const tenantId = getTenantId()!;
    if (!(await db.ttSchedule.count({ where: { academicYearId: yearId } }))) {
        await createSchedule(yearId, {
            name: 'Regular',
            slots: [
                { kind: 'period', startTime: '08:00', endTime: '08:40' },
                { kind: 'period', startTime: '08:40', endTime: '09:20' },
                { kind: 'period', startTime: '09:20', endTime: '10:00' },
                { kind: 'period', startTime: '10:00', endTime: '10:40' },
                { kind: 'break', label: 'Break', startTime: '10:40', endTime: '11:00' },
                { kind: 'period', startTime: '11:00', endTime: '11:40' },
                { kind: 'period', startTime: '11:40', endTime: '12:20' },
                { kind: 'period', startTime: '12:20', endTime: '13:00' },
                { kind: 'period', startTime: '13:00', endTime: '13:40' },
            ],
        });
        const s = await db.ttSchedule.findFirstOrThrow({ where: { academicYearId: yearId } });
        await saveDays(yearId, [1, 2, 3, 4, 5, 6, 7].map((w) => ({ weekday: w, scheduleId: w <= 6 ? s.id : null })));
    }
    if (!(await db.ttLoad.count({ where: { academicYearId: yearId } }))) {
        const [classes, subjects, streams, rooms, classSubjects] = await Promise.all([
            db.schoolClass.findMany({ select: { id: true, shortName: true } }),
            db.subject.findMany({ select: { id: true, code: true } }),
            db.masterValue.findMany({ where: { master: 'stream' }, select: { id: true, name: true } }),
            db.masterValue.findMany({ where: { master: 'room' }, select: { id: true, code: true } }),
            db.classSubject.findMany({ where: { academicYearId: yearId }, select: { classId: true, streamId: true, subjectId: true } }),
        ]);
        const subjectId = new Map(subjects.map((s) => [s.code, s.id]));
        const data: { tenantId: string; academicYearId: string; classId: string; streamId: string | null; subjectId: string; perWeek: number; doubles: number; parallelGroup: string | null; roomId: string | null }[] = [];
        for (const p of PLAN) {
            for (const short of p.classes) {
                const cls = classes.find((c) => c.shortName === short);
                if (!cls) continue;
                for (const streamName of p.streams ?? [null]) {
                    const streamId = streamName ? streams.find((s) => s.name === streamName)?.id ?? null : null;
                    if (streamName && !streamId) continue;
                    for (const [code, l] of Object.entries(p.loads)) {
                        const sid = subjectId.get(code);
                        // Only subjects the class (stream) actually has.
                        if (!sid || !classSubjects.some((cs) => cs.classId === cls.id && cs.subjectId === sid && (cs.streamId ?? null) === streamId)) continue;
                        data.push({ tenantId, academicYearId: yearId, classId: cls.id, streamId, subjectId: sid, perWeek: l.perWeek, doubles: l.doubles ?? 0, parallelGroup: l.group ?? null, roomId: l.room ? rooms.find((r) => r.code === l.room)?.id ?? null : null });
                    }
                }
            }
        }
        if (data.length) await db.ttLoad.createMany({ data });
    }
    if (await db.timetable.count({ where: { academicYearId: yearId, status: 'published' } })) return { generated: false };
    const r = await generate(yearId, { name: 'Regular timetable' }, { isDemo: true, seed: 20261022 });
    await publish(r.timetableId);

    // One teacher is absent today: half of their periods already arranged.
    let substitutions = 0;
    const weekday = ((new Date().getUTCDay() + 6) % 7) + 1;
    const week = await weekOf(yearId);
    if (week.some((d) => d.weekday === weekday)) {
        const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
        const busiest = await db.ttEntry.groupBy({ by: ['staffId'], where: { timetableId: r.timetableId, weekday, staffId: { not: null } }, _count: { _all: true }, orderBy: { _count: { staffId: 'desc' } }, take: 1 });
        const absent = busiest[0]?.staffId;
        if (absent) {
            const periods = await db.ttEntry.findMany({ where: { timetableId: r.timetableId, weekday, staffId: absent }, orderBy: { periodNo: 'asc' } });
            const busy = new Set((await db.ttEntry.findMany({ where: { timetableId: r.timetableId, weekday, staffId: { not: null } }, select: { staffId: true, periodNo: true } })).map((e) => `${e.staffId}|${e.periodNo}`));
            const teachers = (await db.ttEntry.findMany({ where: { timetableId: r.timetableId, staffId: { not: null } }, distinct: ['staffId'], select: { staffId: true } })).map((t) => t.staffId!).filter((id) => id !== absent);
            const used = new Set<string>();
            for (const [i, p] of periods.entries()) {
                const sub = i % 2 === 0 ? teachers.find((t) => !busy.has(`${t}|${p.periodNo}`) && !used.has(t)) ?? null : null;
                if (sub) used.add(sub);
                await db.ttSubstitution.create({ data: { tenantId, date: today, sectionId: p.sectionId, periodNo: p.periodNo, subjectId: p.subjectId, absentStaffId: absent, substituteStaffId: sub, isDemo: true } });
                substitutions++;
            }
        }
    }
    return { generated: true, placed: r.placed, wanted: r.wanted, unplaced: r.unplaced, substitutions };
};

/** Removes the demo timetables and arrangement periods; real timetables lose demo teachers. */
export const clearDemoTimetable = async () => {
    await db.ttSubstitution.deleteMany({ where: { OR: [{ isDemo: true }, { absent: { isDemo: true } }] } });
    await db.ttSubstitution.updateMany({ where: { substitute: { isDemo: true } }, data: { substituteStaffId: null } });
    const removed = await db.timetable.deleteMany({ where: { isDemo: true } });
    await db.ttEntry.updateMany({ where: { staff: { isDemo: true } }, data: { staffId: null } });
    return removed.count;
};
