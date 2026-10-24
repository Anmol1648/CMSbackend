import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { seedMasters } from '../masters/masters.service';
import { currentYear } from '../academic/years.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { sittingBySection, slotsOf } from './ptm.service';

/**
 * Demo PTMs: one held three weeks ago for Classes VI–X (most families came, remarks written), one
 * coming next week for VI–XII that parents can book (some already have, Shubham Nautiyal with his
 * class teacher), and a draft for the primary classes. Marked is_demo.
 */

let seed = 6_101;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = <T>(l: readonly T[]) => l[Math.floor(rand() * l.length)];
const plus = (iso: string, n: number) => isoOf(new Date(dayDate(iso).getTime() + n * 86_400_000));
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const NOTES = ['Want to know about maths marks', 'Child finds science difficult', 'Homework load', 'Handwriting', 'Wants to join the sports team', null, null, null];
const ACTIONS = ['Practise 10 sums daily at home', 'Read one chapter aloud every evening', 'Check the diary every day', 'Extra class on Saturday for two weeks', 'Revise the unit test mistakes'];

export const createDemoPtm = async () => {
    const tenantId = getTenantId()!;
    const year = await currentYear();
    if (!year || (await db.ptm.count({ where: { isDemo: true } }))) return { ptms: 0, meetings: 0 };
    await seedMasters();
    const sections = await db.section.findMany({ where: { academicYearId: year.id }, select: { id: true, name: true, schoolClass: { select: { shortName: true, name: true } } } });
    const ofClasses = (names: string[]) => sections.filter((s) => names.includes(s.schoolClass.shortName ?? '')).map((s) => s.id);
    const [remarks, topics] = await Promise.all([db.masterValue.findMany({ where: { master: 'ptm_remark' }, select: { id: true, extra: true } }), db.masterValue.findMany({ where: { master: 'ptm_topic' }, select: { id: true } })]);
    const good = remarks.filter((r) => (r.extra as { tone?: string } | null)?.tone === 'good').map((r) => r.id);
    const work = remarks.filter((r) => (r.extra as { tone?: string } | null)?.tone !== 'good').map((r) => r.id);
    const today = todayIST();
    let meetings = 0;

    const make = async (title: string, date: string, sectionIds: string[], status: string, extra: { note?: string } = {}) => {
        const p = await db.ptm.create({ data: { tenantId, academicYearId: year.id, title, date: dayDate(date), startTime: '09:00', endTime: '13:00', slotMinutes: 10, breakStart: '11:00', breakEnd: '11:20', mode: 'in_person', whoSits: 'class_subject', booking: true, sectionIds, status, publishedAt: status === 'draft' ? null : new Date(Date.parse(`${date}T00:00:00Z`) - 10 * 86_400_000), note: extra.note ?? null, isDemo: true } });
        const { bySection } = await sittingBySection(p);
        const staff = [...new Set([...bySection.values()].flatMap((m) => [...m.keys()]))];
        if (status !== 'draft') await db.ptmTeacher.createMany({ data: staff.map((staffId, i) => ({ tenantId, ptmId: p.id, staffId, room: `Room ${101 + i}` })), skipDuplicates: true });
        return { p, bySection };
    };
    const students = async (sectionIds: string[]) => db.enrolment.findMany({ where: { academicYearId: year.id, sectionId: { in: sectionIds }, student: { status: 'active' } }, select: { sectionId: true, student: { select: { id: true, userId: true, admissionNo: true } } } });

    // 1. Held: Classes VI–X, three weeks ago.
    const pastDate = plus(today, -21);
    const past = await make('PTM after Unit Test 1', pastDate, ofClasses(ROMAN.slice(5, 10)), 'done');
    const slots = slotsOf(past.p);
    const rows: Parameters<typeof db.ptmMeeting.createMany>[0]['data'] = [];
    const busy = new Set<string>();
    for (const e of await students(past.p.sectionIds)) {
        if (rand() < 0.22) continue; // didn't come at all
        const teachers = [...(past.bySection.get(e.sectionId)?.entries() ?? [])];
        const classTeacher = teachers.find(([, i]) => i.classTeacher);
        const chosen = [...(classTeacher ? [classTeacher] : []), ...teachers.filter(([, i]) => !i.classTeacher).sort(() => rand() - 0.5).slice(0, Math.floor(rand() * 3))];
        for (const [staffId] of chosen) {
            let slot: string | null = null;
            for (let k = 0; k < 6 && !slot; k++) {
                const t = pick(slots);
                if (!busy.has(`${staffId}:${t}`)) slot = t;
            }
            if (slot) busy.add(`${staffId}:${slot}`);
            const came = rand() > 0.08;
            const praise = rand() < 0.6;
            rows.push({ tenantId, ptmId: past.p.id, staffId, studentId: e.student.id, slot: rand() < 0.85 ? slot : null, topicIds: rand() < 0.5 ? [pick(topics).id] : [], parentNote: pick(NOTES), status: came ? 'attended' : 'absent', metAt: came ? new Date(`${pastDate}T04:00:00Z`) : null, remarkIds: came ? [...new Set([pick(praise ? good : work), ...(rand() < 0.5 ? [pick(praise ? work : good)] : [])])] : [], remarks: came && rand() < 0.4 ? pick(['Doing well overall; keep it up.', 'Capable but needs to be regular with work.', 'Spoke about the unit test answers; will revise together.', 'Good improvement in reading.']) : null, actions: came && rand() < 0.3 ? pick(ACTIONS) : null, followUpOn: came && rand() < 0.15 ? dayDate(plus(pastDate, 30)) : null, shared: true, isDemo: true });
        }
    }
    // Shubham Nautiyal's parents always met his class teacher (so My PTM shows remarks).
    const shubhamPast = await db.student.findFirst({ where: { OR: [{ admissionNo: '2025/0235' }, { user: { username: '20250235' } }] }, select: { id: true } });
    const viiB = sections.find((s) => s.name === 'B' && s.schoolClass.shortName === 'VII');
    const ctPast = viiB ? [...(past.bySection.get(viiB.id)?.entries() ?? [])].find(([, i]) => i.classTeacher) : undefined;
    if (shubhamPast && ctPast) {
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].studentId === shubhamPast.id) rows.splice(i, 1);
        rows.push({ tenantId, ptmId: past.p.id, staffId: ctPast[0], studentId: shubhamPast.id, slot: '09:30', topicIds: [topics[0].id], parentNote: 'Want to know about the unit test marks', status: 'attended', metAt: new Date(`${pastDate}T04:00:00Z`), remarkIds: [good[0], work[0]].filter(Boolean), remarks: 'Shubham is attentive in class. Maths needs regular practice; the unit test had careless mistakes.', actions: 'Practise 10 sums daily at home; parent to check the diary', followUpOn: dayDate(plus(pastDate, 30)), shared: true, isDemo: true });
    }
    if (rows.length) await db.ptmMeeting.createMany({ data: rows, skipDuplicates: true });
    meetings += rows.length;

    // 2. Coming next week: Classes VI–XII, booking open; some families have booked.
    const nextDate = plus(today, 6);
    const next = await make('PTM after Half-yearly exams', nextDate, ofClasses(ROMAN.slice(5)), 'published', { note: 'Report cards will be given to parents. Please bring the school diary.' });
    const nextSlots = slotsOf(next.p);
    const shubham = await db.student.findFirst({ where: { OR: [{ admissionNo: '2025/0235' }, { user: { username: '20250235' } }] }, select: { id: true } });
    const booked: Parameters<typeof db.ptmMeeting.createMany>[0]['data'] = [];
    const taken = new Set<string>();
    const bookOne = (staffId: string, studentId: string, slot: string, note: string | null) => {
        if (taken.has(`${staffId}:${slot}`) || taken.has(`s:${studentId}:${slot}`)) return;
        taken.add(`${staffId}:${slot}`);
        taken.add(`s:${studentId}:${slot}`);
        booked.push({ tenantId, ptmId: next.p.id, staffId, studentId, slot, topicIds: [pick(topics).id], parentNote: note, status: 'booked', isDemo: true });
    };
    for (const e of await students(next.p.sectionIds)) {
        const teachers = [...(next.bySection.get(e.sectionId)?.entries() ?? [])];
        const ct = teachers.find(([, i]) => i.classTeacher);
        if (e.student.id === shubham?.id) {
            if (ct) bookOne(ct[0], e.student.id, '09:20', 'Want to discuss the half-yearly maths marks');
            continue;
        }
        if (rand() > 0.35) continue;
        if (ct) bookOne(ct[0], e.student.id, pick(nextSlots), pick(NOTES));
        const other = teachers.filter(([, i]) => !i.classTeacher);
        if (other.length && rand() < 0.4) bookOne(pick(other)[0], e.student.id, pick(nextSlots), null);
    }
    if (booked.length) await db.ptmMeeting.createMany({ data: booked, skipDuplicates: true });
    meetings += booked.length;

    // 3. A draft for the primary classes.
    await make('Primary classes PTM and orientation', plus(today, 20), ofClasses(['BV1', 'BV2', 'BV3', ...ROMAN.slice(0, 5)]), 'draft');
    return { ptms: 3, meetings };
};

export const clearDemoPtm = async () => {
    await db.ptm.deleteMany({ where: { isDemo: true } });
};
