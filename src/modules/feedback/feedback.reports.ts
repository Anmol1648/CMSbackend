import { db } from '../../core/db';
import { isoOf } from '../attendance/attendance.settings';
import { sectionLabel } from '../timetable/tt-setup.service';
import { defineReport, registerReportCategory } from '../reports/reports.registry';
import { defineWidget } from '../dashboard/dashboard.registry';
import { myFeedback, results, teachersBySection } from './feedback.service';

/** Teacher feedback reports (Report Center) and widgets. */

registerReportCategory('Teacher Feedback', 54);

/** The round a report is about: the chosen one (by its name typed), else the latest closed / released. */
const roundFor = async (name?: string) => (name ? db.feedbackRound.findFirst({ where: { name: { contains: name, mode: 'insensitive' } }, orderBy: { createdAt: 'desc' } }) : db.feedbackRound.findFirst({ where: { status: { in: ['closed', 'released', 'open'] } }, orderBy: { createdAt: 'desc' } }));
const ROUND = [{ key: 'round', label: 'Round (part of its name; empty = the latest)', type: 'text' as const }];

defineReport({
    key: 'feedback_teachers',
    category: 'Teacher Feedback',
    label: 'Teacher feedback summary',
    description: 'Each teacher’s overall score, number of responses and rank in a feedback round (teachers below the minimum responses show no score).',
    permissions: ['feedback.results'],
    orientation: 'portrait',
    filters: ROUND,
    columns: [
        { key: 'rank', label: '#', type: 'number', width: 0.4 },
        { key: 'teacher', label: 'Teacher', type: 'text', width: 1.8 },
        { key: 'responses', label: 'Responses', type: 'number', width: 0.7, total: true },
        { key: 'score', label: 'Score', type: 'number', width: 0.6 },
        { key: 'vsSchool', label: 'vs school', type: 'number', width: 0.6 },
        { key: 'sections', label: 'Sections', type: 'text', width: 1.6 },
    ],
    async run(f, ctx) {
        const r = await roundFor(f.round || undefined);
        if (!r) return { rows: [] };
        const res = await results(r.id, ctx.userId);
        let rank = 0;
        return {
            subtitle: `${r.name} · school average ${res.school.overall ?? '—'} / ${res.scale}`,
            rows: res.teachers.map((t) => ({ rank: t.overall !== null ? ++rank : null, teacher: t.name, responses: t.responses, score: t.overall, vsSchool: t.overall !== null && res.school.overall !== null ? Math.round((t.overall - res.school.overall) * 100) / 100 : null, sections: t.bySection.map((s) => `${s.section}${s.overall !== null ? ` (${s.overall})` : ''}`).join(', ') })),
        };
    },
});

defineReport({
    key: 'feedback_questions',
    category: 'Teacher Feedback',
    label: 'Feedback by question',
    description: 'The school-wide average for each question of a round: the strongest and weakest areas.',
    permissions: ['feedback.results'],
    orientation: 'portrait',
    filters: ROUND,
    columns: [
        { key: 'question', label: 'Question', type: 'text', width: 3 },
        { key: 'kind', label: 'Kind', type: 'text', width: 0.6 },
        { key: 'average', label: 'Average', type: 'number', width: 0.7 },
        { key: 'yes', label: 'Yes %', type: 'number', width: 0.6 },
        { key: 'answers', label: 'Answers', type: 'number', width: 0.7 },
    ],
    async run(f, ctx) {
        const r = await roundFor(f.round || undefined);
        if (!r) return { rows: [] };
        const res = await results(r.id, ctx.userId);
        return { subtitle: `${r.name} · ${res.school.responses} responses · out of ${res.scale}`, rows: res.questions.filter((q) => q.kind !== 'text').map((q) => ({ question: q.text, kind: q.kind === 'rating' ? 'Rating' : 'Yes / no', average: res.school.per[q.id]?.avg ?? null, yes: res.school.per[q.id]?.yes ?? null, answers: res.school.per[q.id]?.n ?? 0 })) };
    },
});

defineReport({
    key: 'feedback_response_rate',
    category: 'Teacher Feedback',
    label: 'Feedback response rate by section',
    description: 'For each section of a round: forms expected, filled, and the response rate.',
    permissions: ['feedback.results', 'feedback.manage'],
    orientation: 'portrait',
    filters: ROUND,
    columns: [
        { key: 'section', label: 'Section', type: 'text', width: 1 },
        { key: 'teachers', label: 'Teachers', type: 'number', width: 0.7 },
        { key: 'expected', label: 'Forms expected', type: 'number', width: 0.9, total: true },
        { key: 'filled', label: 'Filled', type: 'number', width: 0.7, total: true },
        { key: 'rate', label: 'Rate %', type: 'number', width: 0.6 },
    ],
    async run(f) {
        const r = await roundFor(f.round || undefined);
        if (!r) return { rows: [] };
        const [teachers, responses, enrol, sections] = await Promise.all([teachersBySection(r.academicYearId, r.sectionIds), db.feedbackResponse.groupBy({ by: ['sectionId'], where: { roundId: r.id }, _count: { _all: true } }), db.enrolment.findMany({ where: { academicYearId: r.academicYearId, sectionId: { in: r.sectionIds }, student: { status: 'active' } }, select: { sectionId: true, student: { select: { userId: true, familyId: true } } } }), db.section.findMany({ where: { id: { in: r.sectionIds } }, select: { id: true, name: true, sortOrder: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } } })]);
        const guardians = r.audience !== 'student' ? await db.guardian.findMany({ where: { familyId: { in: enrol.map((e) => e.student.familyId!).filter(Boolean) }, userId: { not: null } }, select: { familyId: true } }) : [];
        return {
            subtitle: `${r.name} · ${isoOf(r.opensOn)} – ${isoOf(r.closesOn)}`,
            rows: sections
                .sort((a, b) => a.schoolClass.sortOrder - b.schoolClass.sortOrder || a.sortOrder - b.sortOrder)
                .map((s) => {
                    const mine = enrol.filter((e) => e.sectionId === s.id);
                    const people = (r.audience !== 'parent' ? mine.filter((e) => e.student.userId).length : 0) + (r.audience !== 'student' ? mine.reduce((a, e) => a + guardians.filter((g) => g.familyId === e.student.familyId).length, 0) : 0);
                    const t = teachers.get(s.id)?.length ?? 0;
                    const expected = people * t;
                    const filled = responses.find((x) => x.sectionId === s.id)?._count._all ?? 0;
                    return { section: sectionLabel(s), teachers: t, expected, filled, rate: expected ? Math.round((filled / expected) * 1000) / 10 : null };
                }),
        };
    },
});

defineWidget({
    key: 'feedback_to_give',
    label: 'Teacher feedback to fill',
    description: 'For students and parents: an open feedback round and how many teachers are left.',
    category: 'Today',
    type: 'stat',
    size: 'sm',
    href: '/my-feedback',
    permissions: ['feedback.give'],
    cacheSeconds: 120,
    async load({ userId }) {
        const m = await myFeedback(userId);
        const left = m.rounds.reduce((a, r) => a + r.children.reduce((b, c) => b + c.teachers.filter((t) => !t.done).length, 0), 0);
        if (!m.rounds.length) return { hidden: true, value: '' };
        return { value: left, caption: left ? 'teachers left to give feedback on' : 'all done, thank you!', tone: left ? 'warn' : 'good', action: left ? { label: 'Fill in now', href: '/my-feedback' } : undefined };
    },
});
