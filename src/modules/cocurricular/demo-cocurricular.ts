import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { getSettings } from '../../core/settings';
import { seedMasters } from '../masters/masters.service';
import { currentYear } from '../academic/years.service';
import { dayDate, isoOf } from '../attendance/attendance.settings';
import { COCURRICULAR } from './cocurricular.settings';

/**
 * Demo co-curricular: house masters and captains, a few points given by hand; six clubs (Deepak
 * Rautela runs the Science Club) with members, meetings and attendance; nine competitions this term
 * (inter-house ones with results and house points, two coming up, on the calendar); outside
 * achievements. Shubham Nautiyal (VII-B) is in the Eco Club, has asked to join the Science Club,
 * won the inter-house debate and has a district-level achievement. Marked is_demo.
 */

let seed = 7_301;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = <T>(l: readonly T[]) => l[Math.floor(rand() * l.length)];
const shuffle = <T>(l: T[]) => [...l].sort(() => rand() - 0.5);
const DAY = 86_400_000;
const day = (offset: number) => dayDate(isoOf(new Date(Date.now() + 5.5 * 3_600_000 + offset * DAY)));

export const createDemoCocurricular = async () => {
    const tenantId = getTenantId()!;
    const year = await currentYear();
    if (!year || (await db.club.count({ where: { isDemo: true } }))) return { clubs: 0, competitions: 0, achievements: 0 };
    await seedMasters();
    const [houses, clubCats, compCats, levels, eventType] = await Promise.all([
        db.masterValue.findMany({ where: { master: 'house', isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } }),
        db.masterValue.findMany({ where: { master: 'club_category' }, select: { id: true, name: true } }),
        db.masterValue.findMany({ where: { master: 'competition_category' }, select: { id: true, name: true } }),
        db.masterValue.findMany({ where: { master: 'competition_level' }, select: { id: true, name: true } }),
        db.masterValue.findFirst({ where: { master: 'event_type', name: 'Competition' }, select: { id: true } }),
    ]);
    const CC = (prefix: string) => clubCats.find((c) => c.name.startsWith(prefix))?.id ?? null;
    const KC = (prefix: string) => compCats.find((c) => c.name.startsWith(prefix))?.id ?? null;
    const LV = (prefix: string) => levels.find((c) => c.name.startsWith(prefix))?.id ?? null;
    const enrol = await db.enrolment.findMany({ where: { academicYearId: year.id, student: { status: 'active' } }, select: { studentId: true, houseId: true, section: { select: { classId: true, schoolClass: { select: { sortOrder: true, shortName: true, name: true } } } } } });
    const classOrder = (e: (typeof enrol)[number]) => e.section.schoolClass.sortOrder;
    const seniors = enrol.filter((e) => classOrder(e) >= (enrol.map(classOrder).sort((a, b) => a - b)[Math.floor(enrol.length * 0.45)] ?? 0));
    const staff = await db.staff.findMany({ where: { isDemo: true, status: 'working' }, select: { id: true, userId: true, firstName: true } });
    const deepak = await db.staff.findFirst({ where: { user: { username: 'deepak.rautela' } }, select: { id: true } });
    const principal = await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: 'principal' } } } }, select: { id: true } });
    const shubham = await db.student.findFirst({ where: { OR: [{ admissionNo: '2025/0235' }, { user: { username: '20250235' } }] }, select: { id: true } });
    const shubhamEnrol = shubham ? enrol.find((e) => e.studentId === shubham.id) : undefined;
    const others = staff.filter((s) => s.id !== deepak?.id);
    const by = principal?.id ?? null;

    // Houses: a master and an assistant (staff), a captain and vice-captain (senior students).
    let s = 0;
    for (const h of houses) {
        const members = shuffle(seniors.filter((e) => e.houseId === h.id));
        const rows = [
            { role: 'master', staffId: others[s++ % Math.max(1, others.length)]?.id ?? null, studentId: null },
            { role: 'assistant_master', staffId: others[s++ % Math.max(1, others.length)]?.id ?? null, studentId: null },
            { role: 'captain', staffId: null, studentId: members[0]?.studentId ?? null },
            { role: 'vice_captain', staffId: null, studentId: members[1]?.studentId ?? null },
        ].filter((r) => r.staffId || r.studentId);
        await db.houseOfficial.createMany({ data: rows.map((r) => ({ tenantId, academicYearId: year.id, houseId: h.id, ...r, isDemo: true })) });
    }
    const manual = [
        ['Cleanest house corridor (September)', 15],
        ['Best assembly presentation', 10],
        ['Most punctual house (monthly check)', 8],
        ['Tree plantation drive', 12],
        ['Littering found near the house notice board', -5],
        ['Most blood-donation camp volunteers (parents and staff)', 6],
    ] as const;
    for (const [reason, points] of manual) await db.housePoint.create({ data: { tenantId, academicYearId: year.id, houseId: pick(houses).id, points, reason, givenBy: by, givenOn: day(-Math.floor(10 + rand() * 60)), isDemo: true } });

    // Clubs.
    const CLUBS = [
        { name: 'Science Club', cat: 'Science', desc: 'Experiments, models and the science exhibition.', meets: 'Saturdays, 7th–8th period', max: 40, incharge: deepak?.id, seniorsOnly: false },
        { name: 'Eco Club', cat: 'Environment', desc: 'Plantation, waste segregation and the school garden.', meets: 'Wednesdays, after lunch', max: 50, incharge: others[0]?.id, seniorsOnly: false },
        { name: 'Music Club', cat: 'Arts', desc: 'Choir, instruments and the annual day band.', meets: 'Tuesdays and Fridays, 8th period', max: 35, incharge: others[1]?.id, seniorsOnly: false },
        { name: 'Literary Club', cat: 'Literary', desc: 'Debates, the school magazine and creative writing.', meets: 'Thursdays, 7th period', max: 30, incharge: others[2]?.id, seniorsOnly: true },
        { name: 'Robotics Club', cat: 'Science', desc: 'Arduino projects and the robotics league.', meets: 'Saturdays, 9 am – 11 am', max: 20, incharge: others[3]?.id, seniorsOnly: true },
        { name: 'Scouts & Guides', cat: 'Uniformed', desc: 'Camps, first aid and community service.', meets: 'Saturdays, after school', max: null, incharge: others[4]?.id, seniorsOnly: false },
    ];
    const { max } = await getSettings({ max: COCURRICULAR.maxClubs });
    const joined = new Map<string, number>();
    const clubIds: Record<string, string> = {};
    for (const c of CLUBS) {
        const club = await db.club.create({ data: { tenantId, name: c.name, description: c.desc, categoryId: CC(c.cat), inchargeIds: c.incharge ? [c.incharge] : [], classIds: c.seniorsOnly ? [...new Set(seniors.map((e) => e.section.classId))] : [], maxMembers: c.max, meets: c.meets, isDemo: true } });
        clubIds[c.name] = club.id;
        const pool = shuffle(c.seniorsOnly ? seniors : enrol).filter((e) => e.studentId !== shubham?.id && (!max || (joined.get(e.studentId) ?? 0) < max));
        const members = pool.slice(0, Math.min(c.max ?? 30, 12 + Math.floor(rand() * 14)));
        if (c.name === 'Eco Club' && shubham) members.unshift({ studentId: shubham.id } as (typeof enrol)[number]);
        await db.clubMember.createMany({ data: members.map((m, i) => ({ tenantId, clubId: club.id, academicYearId: year.id, studentId: m.studentId, role: i === 1 ? 'president' : i === 2 ? 'secretary' : 'member', status: 'active', joinedAt: new Date(Date.now() - 80 * DAY), grade: rand() < 0.5 ? pick(['A', 'A', 'B', 'A+']) : null, isDemo: true })) });
        for (const m of members) joined.set(m.studentId, (joined.get(m.studentId) ?? 0) + 1);
        const topics: Record<string, string[]> = {
            'Science Club': ['Making a water filter', 'Solar oven project', 'Visit to the science lab: microscopes', 'Models for the science exhibition'],
            'Eco Club': ['Plantation near the gate', 'Waste segregation drive', 'Composting pit', 'Bird count in the school garden'],
            'Music Club': ['Choir practice: national anthem', 'Learning the harmonium', 'Annual day song selection'],
            'Literary Club': ['Debate practice: online classes', 'Magazine articles: first drafts', 'Poetry recitation'],
            'Robotics Club': ['Arduino basics: blinking LED', 'Line-follower robot', 'Sensors and motors'],
            'Scouts & Guides': ['Knots and lashings', 'First aid basics', 'Cleanliness drive in the market'],
        };
        const list = topics[c.name] ?? [];
        for (const [i, title] of list.entries()) {
            await db.clubMeeting.create({ data: { tenantId, clubId: club.id, academicYearId: year.id, date: day(-(list.length - i) * 12), title, notes: `${title}: ${members.length} members took part.`, presentIds: members.filter(() => rand() < 0.85).map((m) => m.studentId), recordedBy: by, isDemo: true } });
        }
    }
    // Requests waiting: Shubham asks to join the Science Club (Deepak Rautela's), and two more.
    const parentOfShubham = shubham ? await db.user.findFirst({ where: { username: '9373993122' }, select: { id: true } }) : null;
    const requests = [...(shubham ? [{ studentId: shubham.id, note: 'He loves making models and wants to take part in the exhibition.', by: parentOfShubham?.id ?? null }] : []), ...shuffle(seniors).filter((e) => !joined.has(e.studentId) && e.studentId !== shubham?.id).slice(0, 2).map((e) => ({ studentId: e.studentId, note: 'I want to learn more science.', by: null }))];
    if (clubIds['Science Club']) await db.clubMember.createMany({ data: requests.map((r) => ({ tenantId, clubId: clubIds['Science Club'], academicYearId: year.id, studentId: r.studentId, status: 'requested', requestedBy: r.by, requestNote: r.note, isDemo: true })) });

    // Competitions.
    const pts = await getSettings({ first: COCURRICULAR.pointsFirst, second: COCURRICULAR.pointsSecond, third: COCURRICULAR.pointsThird, part: COCURRICULAR.pointsTakingPart, team: COCURRICULAR.teamTimes });
    const pointsFor = (pos: number | null, team: boolean) => (pos === 1 ? pts.first : pos === 2 ? pts.second : pos === 3 ? pts.third : pts.part) * (team ? pts.team : 1);
    const ord = (n: number | null) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : 'took part');
    const COMPS = [
        { name: 'Inter-house Debate', cat: 'Literary', level: 'Inter-house', ago: 40, kind: 'individual', byHouse: true, venue: 'School auditorium', award: 'Best speaker' },
        { name: 'Inter-house Football', cat: 'Sports', level: 'Inter-house', ago: 30, kind: 'team', byHouse: true, venue: 'School ground' },
        { name: 'Inter-house Group Song', cat: 'Cultural', level: 'Inter-house', ago: 22, kind: 'team', byHouse: true, venue: 'Assembly hall' },
        { name: 'Inter-house Quiz', cat: 'Academic', level: 'Inter-house', ago: 15, kind: 'team', byHouse: true, venue: 'Library' },
        { name: 'Drawing Competition (Classes I–V)', cat: 'Art', level: 'Class level', ago: 18, kind: 'individual', byHouse: false, venue: 'Art room', juniors: true },
        { name: 'Inter-school Science Exhibition', cat: 'Academic', level: 'Inter-school', ago: 10, kind: 'team', byHouse: false, venue: 'KV Gopeshwar' },
        { name: 'Inter-house Athletics Meet', cat: 'Sports', level: 'Inter-house', ago: -12, kind: 'individual', byHouse: true, venue: 'School ground' },
        { name: 'Inter-house Rangoli', cat: 'Art', level: 'Inter-house', ago: -20, kind: 'team', byHouse: true, venue: 'Courtyard' },
        { name: 'Essay Writing (Hindi Pakhwada)', cat: 'Literary', level: 'Class level', ago: 5, kind: 'individual', byHouse: false, venue: 'Classrooms', cancelled: true },
    ] as const;
    const juniors = enrol.filter((e) => !seniors.includes(e));
    let competitions = 0;
    for (const c of COMPS) {
        const done = c.ago > 0 && !('cancelled' in c);
        const date = day(-c.ago);
        const event = await db.schoolEvent.create({ data: { tenantId, title: c.name, typeId: eventType?.id ?? null, startDate: date, endDate: date, venue: c.venue, forAllStaff: true, forStudents: true, forParents: true, status: 'cancelled' in c ? 'cancelled' : 'scheduled', isDemo: true } });
        const comp = await db.competition.create({ data: { tenantId, academicYearId: year.id, name: c.name, categoryId: KC(c.cat), levelId: LV(c.level), date, venue: c.venue, kind: c.kind, byHouse: c.byHouse, inchargeId: pick(others)?.id ?? null, clubId: c.name.includes('Science') ? (clubIds['Science Club'] ?? null) : null, schoolEventId: event.id, status: 'cancelled' in c ? 'cancelled' : done ? 'done' : 'upcoming', resultsOut: done, createdBy: by, isDemo: true } });
        competitions++;
        if ('cancelled' in c) continue;
        const entries: { teamName: string | null; houseId: string | null; studentIds: string[]; position: number | null; award: string | null }[] = [];
        if (c.kind === 'team' && c.byHouse) {
            const order = shuffle(houses);
            for (const [i, h] of order.entries()) entries.push({ teamName: `${h.name} House`, houseId: h.id, studentIds: shuffle(seniors.filter((e) => e.houseId === h.id)).slice(0, c.cat === 'Sports' ? 7 : 4).map((e) => e.studentId), position: done ? (i < 3 ? i + 1 : null) : null, award: null });
        } else if (c.kind === 'team') {
            entries.push({ teamName: 'Water purifier model', houseId: null, studentIds: shuffle(seniors).slice(0, 3).map((e) => e.studentId), position: 2, award: 'Best working model' }, { teamName: 'Solar cooker model', houseId: null, studentIds: shuffle(seniors).slice(0, 3).map((e) => e.studentId), position: null, award: null });
        } else {
            const pool = 'juniors' in c ? juniors : seniors;
            const picked = new Set<string>();
            for (const h of houses) for (const e of shuffle(pool.filter((x) => x.houseId === h.id)).slice(0, 2)) picked.add(e.studentId);
            if (c.name === 'Inter-house Debate' && shubham && shubhamEnrol) picked.delete(shubham.id);
            const list = [...(c.name === 'Inter-house Debate' && shubham ? [shubham.id] : []), ...picked];
            list.forEach((id, i) => entries.push({ teamName: null, houseId: null, studentIds: [id], position: done ? (i < 3 ? i + 1 : null) : null, award: done && i === 0 && 'award' in c ? c.award : null }));
        }
        for (const e of entries) {
            const points = done ? pointsFor(e.position, c.kind === 'team') : 0;
            const row = await db.competitionEntry.create({ data: { tenantId, competitionId: comp.id, teamName: e.teamName, houseId: e.houseId, studentIds: e.studentIds, position: e.position, award: e.award, points, isDemo: true } });
            if (!done || !c.byHouse || !points) continue;
            const house = e.houseId ?? enrol.find((x) => x.studentId === e.studentIds[0])?.houseId;
            if (house) await db.housePoint.create({ data: { tenantId, academicYearId: year.id, houseId: house, points, reason: `${c.name}: ${ord(e.position)}${e.award ? ` (${e.award})` : ''}`, competitionId: comp.id, entryId: row.id, studentId: e.studentIds.length === 1 ? e.studentIds[0] : null, givenBy: by, givenOn: date, isDemo: true } });
        }
    }

    // Outside achievements.
    const ACH = [
        { title: 'District Chess Championship (Under-14)', level: 'Zonal', cat: 'Sports', result: '1st', organiser: 'District Chess Association, Chamoli', ago: 35, pts: 15, who: 'shubham' },
        { title: 'Science Olympiad (SOF)', level: 'National', cat: 'Academic', result: 'Gold medal (zonal rank 12)', organiser: 'Science Olympiad Foundation', ago: 50, pts: 10 },
        { title: 'KVS Regional Sports Meet: 400 m', level: 'Regional', cat: 'Sports', result: '2nd', organiser: 'KVS Dehradun Region', ago: 25, pts: 10 },
        { title: 'Painting competition on Swachh Bharat', level: 'Zonal', cat: 'Art', result: 'Consolation prize', organiser: 'Nagar Palika Joshimath', ago: 60, pts: 5 },
        { title: 'Inter-school Declamation', level: 'Inter-school', cat: 'Literary', result: '3rd', organiser: 'GIC Joshimath', ago: 12, pts: 5 },
    ];
    let achievements = 0;
    for (const a of ACH) {
        const st = a.who === 'shubham' && shubhamEnrol ? shubhamEnrol : pick(seniors);
        const row = await db.achievement.create({ data: { tenantId, academicYearId: year.id, studentId: st.studentId, title: a.title, categoryId: KC(a.cat), levelId: LV(a.level), result: a.result, organiser: a.organiser, date: day(-a.ago), points: st.houseId ? a.pts : 0, recordedBy: by, isDemo: true } });
        if (st.houseId) await db.housePoint.create({ data: { tenantId, academicYearId: year.id, houseId: st.houseId, points: a.pts, reason: `${a.title}: ${a.result}`, achievementId: row.id, studentId: st.studentId, givenBy: by, givenOn: day(-a.ago), isDemo: true } });
        achievements++;
    }
    return { clubs: CLUBS.length, competitions, achievements };
};

export const clearDemoCocurricular = async () => {
    const events = (await db.competition.findMany({ where: { isDemo: true, schoolEventId: { not: null } }, select: { schoolEventId: true } })).map((c) => c.schoolEventId!);
    await db.housePoint.deleteMany({ where: { isDemo: true } });
    await db.competition.deleteMany({ where: { isDemo: true } });
    await db.schoolEvent.deleteMany({ where: { id: { in: events } } });
    await db.achievement.deleteMany({ where: { isDemo: true } });
    await db.club.deleteMany({ where: { isDemo: true } });
    await db.houseOfficial.deleteMany({ where: { isDemo: true } });
};
