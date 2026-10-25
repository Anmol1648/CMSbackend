import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { currentYear } from '../academic/years.service';
import { getUserAccess } from '../rbac/access.service';
import { dayDate, isoOf } from '../attendance/attendance.settings';
import { defineReport, registerReportCategory } from '../reports/reports.registry';
import { defineWidget, extendDefaultLayout } from '../dashboard/dashboard.registry';
import { houseList, housesOn, masterNames, myStaffId, myStudents, studentInfo } from './cocurricular.common';
import { ROLES, standings } from './houses.service';

/** Co-curricular reports (Report Center) and dashboard widgets. */

registerReportCategory('Co-curricular', 53);

const range = [
    { key: 'from', label: 'From', type: 'date' as const, required: true, default: 'sessionStart' },
    { key: 'to', label: 'To', type: 'date' as const, required: true, default: 'today' },
];
const between = (f: Record<string, string>) => {
    if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
    return { gte: dayDate(f.from), lte: dayDate(f.to) };
};
const year = async () => {
    const y = await currentYear();
    if (!y) throw badRequest('No current academic year');
    return y;
};
const ORD = (n: number | null) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : n ? `${n}th` : 'Took part');

defineReport({
    key: 'house_standings',
    category: 'Co-curricular',
    label: 'House standings',
    description: 'Each house’s points in a period (from results, achievements and points given by hand), its students and its rank.',
    permissions: ['cocurricular.view', 'house.manage', 'house.points'],
    orientation: 'portrait',
    filters: range,
    columns: [
        { key: 'rank', label: 'Rank', type: 'number', width: 0.4 },
        { key: 'house', label: 'House', type: 'text', width: 1.2 },
        { key: 'results', label: 'From results', type: 'number', width: 0.8, total: true },
        { key: 'byHand', label: 'Given by hand', type: 'number', width: 0.8, total: true },
        { key: 'points', label: 'Total points', type: 'number', width: 0.8, total: true },
        { key: 'students', label: 'Students', type: 'number', width: 0.6, total: true },
    ],
    async run(f) {
        const y = await year();
        const [houses, pts, counts] = await Promise.all([houseList(), db.housePoint.findMany({ where: { academicYearId: y.id, givenOn: between(f) }, select: { houseId: true, points: true, competitionId: true, achievementId: true } }), db.enrolment.groupBy({ by: ['houseId'], where: { academicYearId: y.id, student: { status: 'active' } }, _count: { _all: true } })]);
        const rows = houses.map((h) => {
            const mine = pts.filter((p) => p.houseId === h.id);
            const results = mine.filter((p) => p.competitionId || p.achievementId).reduce((a, p) => a + p.points, 0);
            const byHand = mine.filter((p) => !p.competitionId && !p.achievementId).reduce((a, p) => a + p.points, 0);
            return { house: h.name, results, byHand, points: results + byHand, students: counts.find((c) => c.houseId === h.id)?._count._all ?? 0 };
        }).sort((a, b) => b.points - a.points);
        return { subtitle: `${f.from} – ${f.to}`, rows: rows.map((r) => ({ ...r, rank: rows.findIndex((x) => x.points === r.points) + 1 })) };
    },
});

defineReport({
    key: 'house_strength',
    category: 'Co-curricular',
    label: 'House strength by class',
    description: 'For each house: how many students of each section are in it this year (and who has no house yet).',
    permissions: ['cocurricular.view', 'house.manage'],
    orientation: 'portrait',
    filters: [{ key: 'class', label: 'Class', type: 'class' }],
    columns: [
        { key: 'section', label: 'Section', type: 'text', width: 1 },
        { key: 'boys', label: 'Boys', type: 'number', width: 0.6, total: true },
        { key: 'girls', label: 'Girls', type: 'number', width: 0.6, total: true },
        { key: 'students', label: 'Students', type: 'number', width: 0.6, total: true },
    ],
    async run(f) {
        const y = await year();
        const houses = await houseList();
        const rows = await db.enrolment.findMany({ where: { academicYearId: y.id, student: { status: 'active' }, ...(f.class ? { section: { classId: f.class } } : {}) }, select: { houseId: true, sectionId: true, student: { select: { genderId: true } }, section: { select: { name: true, sortOrder: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } } } } });
        const genders = await masterNames(rows.map((r) => r.student.genderId));
        const isGirl = (id: string | null) => /female|girl/i.test(genders.get(id ?? '') ?? '');
        const isBoy = (id: string | null) => !isGirl(id) && /male|boy/i.test(genders.get(id ?? '') ?? '');
        const out: Record<string, unknown>[] = [];
        for (const h of [...houses, { id: null as string | null, name: 'No house yet', colour: '' }]) {
            const mine = rows.filter((r) => r.houseId === h.id);
            const sections = [...new Map(mine.map((r) => [r.sectionId, r.section])).entries()].sort(([, a], [, b]) => a.schoolClass.sortOrder - b.schoolClass.sortOrder || a.sortOrder - b.sortOrder);
            for (const [id, s] of sections) {
                const of = mine.filter((r) => r.sectionId === id);
                out.push({ groupKey: h.id ?? 'none', groupLabel: h.name, section: `${s.schoolClass.shortName ?? s.schoolClass.name}-${s.name}`, boys: of.filter((r) => isBoy(r.student.genderId)).length, girls: of.filter((r) => isGirl(r.student.genderId)).length, students: of.length });
            }
        }
        return { rows: out, groupedBy: 'House', subtitle: y.name };
    },
});

defineReport({
    key: 'house_students',
    category: 'Co-curricular',
    label: 'House-wise student list',
    description: 'The students of each house this year, by class, with the house masters, captains and prefects marked. For the assembly and house meetings.',
    permissions: ['cocurricular.view', 'house.manage'],
    orientation: 'portrait',
    about: 'student',
    filters: [{ key: 'class', label: 'Class', type: 'class' }],
    columns: [
        { key: 'student', label: 'Student', type: 'text', width: 1.6 },
        { key: 'admissionNo', label: 'Adm. no.', type: 'text', width: 0.8 },
        { key: 'section', label: 'Section', type: 'text', width: 0.6 },
        { key: 'role', label: 'Role', type: 'text', width: 0.9 },
    ],
    async run(f) {
        const y = await year();
        const houses = await houseList();
        const [rows, officials] = await Promise.all([db.enrolment.findMany({ where: { academicYearId: y.id, houseId: { not: null }, student: { status: 'active' }, ...(f.class ? { section: { classId: f.class } } : {}) }, select: { studentId: true, houseId: true } }), db.houseOfficial.findMany({ where: { academicYearId: y.id, studentId: { not: null } } })]);
        const info = await studentInfo(rows.map((r) => r.studentId), y.id);
        const out = houses.flatMap((h) =>
            rows
                .filter((r) => r.houseId === h.id)
                .map((r) => info.get(r.studentId)!)
                .filter(Boolean)
                .sort((a, b) => a.section.localeCompare(b.section, 'en', { numeric: true }) || a.name.localeCompare(b.name))
                .map((s) => ({ groupKey: h.id, groupLabel: h.name, studentId: s.id, student: s.name, admissionNo: s.admissionNo, section: s.section, role: officials.filter((o) => o.studentId === s.id).map((o) => ROLES[o.role]?.label ?? o.role).join(', ') }))
        );
        return { rows: out, groupedBy: 'House', subtitle: y.name };
    },
});

defineReport({
    key: 'club_members',
    category: 'Co-curricular',
    label: 'Club members and attendance',
    description: 'Every club’s members this year with their role, meetings attended and the grade / remark of the in-charge.',
    permissions: ['cocurricular.view', 'club.manage', 'club.run'],
    orientation: 'landscape',
    about: 'student',
    filters: [],
    columns: [
        { key: 'student', label: 'Student', type: 'text', width: 1.5 },
        { key: 'section', label: 'Section', type: 'text', width: 0.6 },
        { key: 'role', label: 'Role', type: 'text', width: 0.7 },
        { key: 'attended', label: 'Attended', type: 'text', width: 0.7 },
        { key: 'grade', label: 'Grade', type: 'text', width: 0.5 },
        { key: 'remark', label: 'Remark', type: 'text', width: 1.8 },
    ],
    async run(_f, ctx) {
        const y = await year();
        const { permissions } = await getUserAccess(ctx.userId);
        const me = await myStaffId(ctx.userId);
        const onlyMine = !permissions['cocurricular.view'] && !permissions['club.manage'];
        const clubs = await db.club.findMany({ where: onlyMine ? { inchargeIds: { has: me ?? '00000000-0000-0000-0000-000000000000' } } : {}, orderBy: { name: 'asc' }, include: { members: { where: { academicYearId: y.id, status: 'active' } }, meetings: { where: { academicYearId: y.id }, select: { presentIds: true } } } });
        const info = await studentInfo(clubs.flatMap((c) => c.members.map((m) => m.studentId)), y.id);
        const out = clubs.flatMap((c) =>
            c.members
                .map((m) => ({ m, s: info.get(m.studentId) }))
                .sort((a, b) => (a.s?.section ?? '').localeCompare(b.s?.section ?? '', 'en', { numeric: true }) || (a.s?.name ?? '').localeCompare(b.s?.name ?? ''))
                .map(({ m, s }) => ({ groupKey: c.id, groupLabel: c.name, studentId: m.studentId, student: s?.name ?? '', section: s?.section ?? '', role: m.role === 'member' ? '' : m.role[0].toUpperCase() + m.role.slice(1), attended: `${c.meetings.filter((x) => x.presentIds.includes(m.studentId)).length} / ${c.meetings.length}`, grade: m.grade ?? '', remark: m.remark ?? '' }))
        );
        return { rows: out, groupedBy: 'Club', subtitle: y.name };
    },
});

defineReport({
    key: 'competition_results',
    category: 'Co-curricular',
    label: 'Competition results',
    description: 'The places and awards of every competition in a period (school and outside), by competition.',
    permissions: ['cocurricular.view', 'competition.manage'],
    orientation: 'landscape',
    filters: range,
    columns: [
        { key: 'position', label: 'Place', type: 'text', width: 0.6 },
        { key: 'who', label: 'Student / team', type: 'text', width: 2 },
        { key: 'section', label: 'Class', type: 'text', width: 0.8 },
        { key: 'house', label: 'House', type: 'text', width: 0.7 },
        { key: 'award', label: 'Award', type: 'text', width: 1 },
        { key: 'points', label: 'House points', type: 'number', width: 0.6, total: true },
    ],
    async run(f) {
        const y = await year();
        const comps = await db.competition.findMany({ where: { academicYearId: y.id, status: 'done', date: between(f) }, orderBy: { date: 'asc' }, include: { entries: { orderBy: [{ position: { sort: 'asc', nulls: 'last' } }] } } });
        const [info, houses, m] = await Promise.all([studentInfo(comps.flatMap((c) => c.entries.flatMap((e) => e.studentIds)), y.id), houseList(true), masterNames(comps.map((c) => c.levelId))]);
        const hn = (id: string | null) => houses.find((h) => h.id === id)?.name ?? '';
        return {
            subtitle: `${f.from} – ${f.to}`,
            groupedBy: 'Competition',
            rows: comps.flatMap((c) =>
                c.entries.map((e) => {
                    const names = e.studentIds.map((s) => info.get(s)?.name ?? '').filter(Boolean).join(', ');
                    return { groupKey: c.id, groupLabel: `${c.name} · ${isoOf(c.date)}${c.levelId ? ` · ${m.get(c.levelId) ?? ''}` : ''}`, position: ORD(e.position), who: e.teamName ? `${e.teamName}${names ? ` (${names})` : ''}` : names || hn(e.houseId), section: [...new Set(e.studentIds.map((s) => info.get(s)?.section ?? ''))].filter(Boolean).join(', '), house: hn(e.houseId) || [...new Set(e.studentIds.map((s) => hn(info.get(s)?.houseId ?? null)))].filter(Boolean).join(', '), award: e.award ?? '', points: e.points };
                })
            ),
        };
    },
});

defineReport({
    key: 'student_achievements',
    category: 'Co-curricular',
    label: 'Students’ achievements',
    description: 'Every place won by a student in a period: in the school’s competitions and outside (district, state…). For the annual report and the prize-giving day.',
    permissions: ['cocurricular.view', 'competition.manage', 'achievement.record'],
    orientation: 'landscape',
    about: 'student',
    filters: [...range, { key: 'section', label: 'Section', type: 'section' }],
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 0.7 },
        { key: 'student', label: 'Student', type: 'text', width: 1.4 },
        { key: 'section', label: 'Class', type: 'text', width: 0.6 },
        { key: 'what', label: 'Competition', type: 'text', width: 1.8 },
        { key: 'level', label: 'Level', type: 'text', width: 0.9 },
        { key: 'result', label: 'Result', type: 'text', width: 0.9 },
    ],
    async run(f) {
        const y = await year();
        const [entries, outside] = await Promise.all([
            db.competitionEntry.findMany({ where: { position: { not: null }, competition: { academicYearId: y.id, status: 'done', date: between(f) } }, include: { competition: { select: { name: true, date: true, levelId: true } } } }),
            db.achievement.findMany({ where: { academicYearId: y.id, date: between(f) } }),
        ]);
        const [info, m] = await Promise.all([studentInfo([...entries.flatMap((e) => e.studentIds), ...outside.map((a) => a.studentId)], y.id), masterNames([...entries.map((e) => e.competition.levelId), ...outside.map((a) => a.levelId)])]);
        const rows = [
            ...entries.flatMap((e) => e.studentIds.map((s) => ({ s, date: e.competition.date, what: e.competition.name, level: m.get(e.competition.levelId ?? '') ?? '', result: `${ORD(e.position)}${e.award ? ` · ${e.award}` : ''}` }))),
            ...outside.map((a) => ({ s: a.studentId, date: a.date, what: `${a.title}${a.organiser ? ` (${a.organiser})` : ''}`, level: m.get(a.levelId ?? '') ?? '', result: a.result ?? '' })),
        ]
            .filter((r) => !f.section || info.get(r.s)?.sectionId === f.section)
            .sort((a, b) => a.date.getTime() - b.date.getTime());
        return { subtitle: `${f.from} – ${f.to}`, rows: rows.map((r) => ({ studentId: r.s, date: isoOf(r.date), student: info.get(r.s)?.name ?? '', section: info.get(r.s)?.section ?? '', what: r.what, level: r.level, result: r.result })) };
    },
});

// ─── Widgets ─────────────────────────────────────────────────────────────────

defineWidget({
    key: 'house_standings',
    label: 'House standings',
    description: 'The houses by points this session (and the house of each child, for families).',
    category: 'School',
    type: 'list',
    size: 'md',
    href: '/houses',
    permissions: ['cocurricular.view', 'house.manage', 'house.points', 'cocurricular.mine'],
    cacheSeconds: 300,
    async load({ userId, permissions }) {
        const y = await currentYear();
        if (!y || !(await housesOn())) return { hidden: true, items: [], empty: '' };
        const table = await standings(y.id);
        if (!table.length) return { hidden: true, items: [], empty: '' };
        const staff = permissions['cocurricular.view'] || permissions['house.manage'] || permissions['house.points'];
        let mine = new Set<string>();
        if (!staff) {
            const kids = await myStudents(userId);
            mine = new Set((await db.enrolment.findMany({ where: { academicYearId: y.id, studentId: { in: kids.map((k) => k.id) } }, select: { houseId: true } })).map((e) => e.houseId!).filter(Boolean));
        }
        return { items: table.map((h) => ({ title: `${h.rank}. ${h.name}${mine.has(h.id) ? ' (yours)' : ''}`, meta: `${h.points} pts`, tone: (h.rank === 1 ? 'good' : 'neutral') as 'good' | 'neutral', href: staff ? '/houses' : '/my-activities' })), empty: 'No points yet.' };
    },
});

defineWidget({
    key: 'competitions_upcoming',
    label: 'Upcoming competitions',
    description: 'Competitions in the next weeks, and the latest results.',
    category: 'School',
    type: 'list',
    size: 'md',
    href: '/competitions',
    permissions: ['cocurricular.view', 'competition.manage'],
    cacheSeconds: 300,
    async load() {
        const y = await currentYear();
        if (!y) return { hidden: true, items: [], empty: '' };
        const todayIst = dayDate(isoOf(new Date(Date.now() + 5.5 * 3_600_000)));
        const [next, done] = await Promise.all([
            db.competition.findMany({ where: { academicYearId: y.id, status: 'upcoming', date: { gte: todayIst } }, orderBy: { date: 'asc' }, take: 5, select: { id: true, name: true, date: true, venue: true } }),
            db.competition.findMany({ where: { academicYearId: y.id, status: 'done' }, orderBy: { date: 'desc' }, take: 3, select: { id: true, name: true, date: true } }),
        ]);
        return {
            items: [
                ...next.map((c) => ({ title: c.name, sub: [isoOf(c.date), c.venue].filter(Boolean).join(' · '), href: `/competitions?open=${c.id}`, badge: 'soon' })),
                ...done.map((c) => ({ title: c.name, sub: `results · ${isoOf(c.date)}`, href: `/competitions?open=${c.id}`, tone: 'good' as const })),
            ],
            empty: 'No competitions yet.',
        };
    },
});

defineWidget({
    key: 'club_requests',
    label: 'Club requests',
    description: 'Students waiting to join the clubs you run.',
    category: 'Today',
    type: 'stat',
    size: 'sm',
    href: '/clubs',
    permissions: ['club.manage', 'club.run'],
    cacheSeconds: 120,
    async load({ userId, permissions }) {
        const y = await currentYear();
        if (!y) return { hidden: true, value: '' };
        const me = await myStaffId(userId);
        const where = { academicYearId: y.id, status: 'requested', ...(permissions['club.manage'] ? {} : { club: { inchargeIds: { has: me ?? '00000000-0000-0000-0000-000000000000' } } }) };
        const n = await db.clubMember.count({ where });
        if (!n && !permissions['club.manage']) return { hidden: true, value: '' };
        return { value: n, caption: 'requests to join a club', tone: n ? 'warn' : 'neutral' };
    },
});

extendDefaultLayout('principal', ['house_standings', 'competitions_upcoming']);
extendDefaultLayout('school-admin', ['house_standings']);
extendDefaultLayout('teacher', ['club_requests']);
extendDefaultLayout('student', ['house_standings']);
extendDefaultLayout('guardian', ['house_standings']);
