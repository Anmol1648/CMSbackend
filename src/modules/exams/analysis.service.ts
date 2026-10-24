import { db } from '../../core/db';
import { forbidden, notFound } from '../../core/errors';
import { getUserAccess } from '../rbac/access.service';
import { fullName } from '../students/students.service';
import { analyse, computeResults, mapLimit, resolveScope, ScopeKind, sectionLimits, seesInFull } from './results.service';

/**
 * Result analysis across sections: each section's pass % and average, subjects across the school,
 * subject teachers' results, the grade spread, students at risk (failing 2+ subjects), students whose
 * marks fell 10%+ since the previous exam, and the toppers. A parent's view: their child's progress
 * across the session's published exams with stronger and weaker subjects.
 */

const r1 = (n: number) => Math.round(n * 10) / 10;
const avg = (l: number[]) => (l.length ? r1(l.reduce((a, b) => a + b, 0) / l.length) : null);

export const schoolAnalysis = async (kind: ScopeKind, id: string, classId: string | undefined, userId: string) => {
    const scope = await resolveScope(kind, id);
    const a = await getUserAccess(userId);
    const limits = await sectionLimits(userId, scope.yearId);
    const classIds = [...new Set(scope.exams.flatMap((e) => e.classIds))];
    const sections = await db.section.findMany({ where: { academicYearId: scope.yearId, isActive: true, classId: { in: classId ? [classId] : classIds } }, orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }], select: { id: true, classId: true } });
    const mine = sections.filter((s) => a.permissions['exam.analysis'] || seesInFull(limits, s.id));
    if (!mine.length) throw forbidden('No sections to analyse');
    // The previous exam of the same classes (for “marks fell”), for a single exam only.
    const prev = kind === 'exam' ? await db.exam.findFirst({ where: { academicYearId: scope.yearId, kind: 'regular', sortOrder: { lt: scope.exams[0].sortOrder }, classIds: { hasSome: scope.exams[0].classIds } }, orderBy: { sortOrder: 'desc' } }) : null;
    const teach = await db.teachingAssignment.findMany({ where: { academicYearId: scope.yearId, sectionId: { in: mine.map((s) => s.id) } }, select: { sectionId: true, subjectId: true, staff: { select: { id: true, firstName: true, middleName: true, lastName: true } } } });
    const sectionRows = [];
    const subjectAgg = new Map<string, { subject: string; pcts: number[]; passed: number; total: number; highest: number }>();
    const teacherAgg = new Map<string, { teacher: string; subject: string; section: string; pcts: number[]; passed: number; total: number }>();
    const grades: Record<string, number> = {};
    const atRisk: { name: string; section: string; subjects: string[] }[] = [];
    const fell: { name: string; section: string; from: number; to: number }[] = [];
    const toppers: { name: string; section: string; percent: number }[] = [];
    const computed = await mapLimit(mine, 3, async (sec) => ({ r: await computeResults(kind, id, sec.id).catch(() => null), before: prev && prev.classIds.includes(sec.classId) ? await computeResults('exam', prev.id, sec.id).catch(() => null) : null }));
    for (const [k, sec] of mine.entries()) {
        const { r, before } = computed[k];
        if (!r || !r.students.length) continue;
        const an = analyse(r);
        sectionRows.push({ sectionId: sec.id, section: r.section.label, students: an.students, withResult: an.withResult, passPercent: an.passPercent, average: an.average, top: an.toppers[0] ?? null });
        for (const st of r.students) {
            if (st.grade) grades[st.grade] = (grades[st.grade] ?? 0) + 1;
            if (st.failedSubjects.length >= 2) atRisk.push({ name: st.student.name, section: r.section.label, subjects: st.failedSubjects });
            if (st.percent != null) toppers.push({ name: st.student.name, section: r.section.label, percent: st.percent });
            const b = before?.students.find((x) => x.student.id === st.student.id);
            if (b?.percent != null && st.percent != null && b.percent - st.percent >= 10) fell.push({ name: st.student.name, section: r.section.label, from: b.percent, to: st.percent });
            for (const s of st.subjects) {
                if (s.percent == null) continue;
                const g = subjectAgg.get(s.subject) ?? { subject: s.subject, pcts: [], passed: 0, total: 0, highest: 0 };
                g.pcts.push(s.percent);
                g.total++;
                if (s.passed) g.passed++;
                g.highest = Math.max(g.highest, s.percent);
                subjectAgg.set(s.subject, g);
                for (const t of teach.filter((x) => x.sectionId === sec.id && x.subjectId === s.subjectId)) {
                    const k = `${t.staff.id}|${s.subjectId}|${sec.id}`;
                    const ta = teacherAgg.get(k) ?? { teacher: fullName(t.staff), subject: s.subject, section: r.section.label, pcts: [], passed: 0, total: 0 };
                    ta.pcts.push(s.percent);
                    ta.total++;
                    if (s.passed) ta.passed++;
                    teacherAgg.set(k, ta);
                }
            }
        }
    }
    return {
        label: scope.label,
        previous: prev?.name ?? null,
        sections: sectionRows,
        subjects: [...subjectAgg.values()].map((s) => ({ subject: s.subject, students: s.total, average: avg(s.pcts), highest: s.highest, passPercent: s.total ? r1((s.passed / s.total) * 100) : null })).sort((x, y) => (y.average ?? 0) - (x.average ?? 0)),
        teachers: [...teacherAgg.values()].map((t) => ({ teacher: t.teacher, subject: t.subject, section: t.section, students: t.total, average: avg(t.pcts), passPercent: t.total ? r1((t.passed / t.total) * 100) : null })).sort((x, y) => x.teacher.localeCompare(y.teacher) || x.section.localeCompare(y.section)),
        grades,
        atRisk,
        fell: fell.sort((x, y) => y.from - y.to - (x.from - x.to)),
        toppers: toppers.sort((x, y) => y.percent - x.percent).slice(0, 10),
    };
};

/** A child's progress across the session's published exams (overall and per subject). */
export const myProgress = async (studentId: string, userId: string) => {
    const s = await db.student.findFirst({ where: { id: studentId, OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, select: { id: true } });
    if (!s) throw forbidden();
    const enrol = await db.enrolment.findFirst({ where: { studentId }, orderBy: { academicYear: { startDate: 'desc' } }, select: { academicYearId: true, sectionId: true, section: { select: { classId: true } } } });
    if (!enrol) throw notFound('No class found');
    const exams = await db.exam.findMany({ where: { academicYearId: enrol.academicYearId, status: 'published', classIds: { has: enrol.section.classId } }, orderBy: { sortOrder: 'asc' } });
    const points: { exam: string; percent: number | null; subjects: Record<string, number | null> }[] = [];
    for (const e of exams) {
        const r = await computeResults('exam', e.id, enrol.sectionId, studentId).catch(() => null);
        const st = r?.students[0];
        if (!st) continue;
        points.push({ exam: e.shortName ?? e.name, percent: st.percent, subjects: Object.fromEntries(st.subjects.map((x) => [x.subject, x.percent])) });
    }
    const names = [...new Set(points.flatMap((p) => Object.keys(p.subjects)))];
    const subjectAvg = names.map((n) => ({ subject: n, average: avg(points.map((p) => p.subjects[n]).filter((v): v is number => v != null)) })).filter((x) => x.average != null).sort((x, y) => y.average! - x.average!);
    return { points, subjects: subjectAvg, stronger: subjectAvg.slice(0, 2), weaker: subjectAvg.length > 2 ? subjectAvg.slice(-2).reverse() : [] };
};
