import type { Exam } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getUserAccess } from '../rbac/access.service';
import { fullName } from '../students/students.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { isoOf, todayIST } from '../attendance/attendance.settings';
import { summaries } from '../attendance/student-attendance.service';
import { nextClassIn, nextYearOf } from '../promotion/promotion.service';
import { Band, gradeOf, Part, ruleFor } from './setup.service';
import { getSettings } from '../../core/settings';
import { EXAMS } from './exams.settings';
import { markStatuses } from './exams.labels';

/**
 * Results: for one exam, a term (its exams, by weightage) or the session (every exam that counts).
 * Per subject: marks, %, grade, pass; overall %, grade, result (with grace), rank; co-scholastic
 * grades, remarks and attendance for the report card. Worked out from the marks every time, so a
 * corrected mark shows at once (until published, which only decides who may see it).
 */

const round1 = (n: number) => Math.round(n * 10) / 10;
export type ScopeKind = 'exam' | 'term' | 'final';
export const scopeQuery = z.object({ scope: z.enum(['exam', 'term', 'final']), id: z.uuid(), section: z.uuid().optional(), student: z.uuid().optional() });

/** The exams of a scope (exam, term, session) and what it is called. */
export const resolveScope = async (kind: ScopeKind, id: string) => {
    if (kind === 'exam') {
        const e = await db.exam.findFirst({ where: { id } });
        if (!e) throw notFound('Exam not found');
        return { yearId: e.academicYearId, label: e.name, exams: [e], term: null as null | { id: string; name: string; startDate: Date | null; endDate: Date | null }, published: e.status === 'published' };
    }
    if (kind === 'term') {
        const t = await db.examTerm.findFirst({ where: { id } });
        if (!t) throw notFound('Term not found');
        const exams = await db.exam.findMany({ where: { termId: id, countsInResult: true }, orderBy: [{ sortOrder: 'asc' }] });
        const pub = await db.resultPublication.findFirst({ where: { academicYearId: t.academicYearId, scope: 'term', termId: id } });
        return { yearId: t.academicYearId, label: t.name, exams, term: t, published: !!pub };
    }
    const y = await db.academicYear.findFirst({ where: { id } });
    if (!y) throw notFound('Session not found');
    const exams = await db.exam.findMany({ where: { academicYearId: id, countsInResult: true }, orderBy: [{ sortOrder: 'asc' }] });
    const pub = await db.resultPublication.findFirst({ where: { academicYearId: id, scope: 'final' } });
    const { finalName } = await getSettings({ finalName: EXAMS.finalName });
    return { yearId: id, label: `${finalName} ${y.name}`, exams, term: null, published: !!pub };
};

type SubjectResult = {
    subjectId: string;
    subject: string;
    exams: { examId: string; obtained: number | null; max: number; status: string; grade: string | null; parts: Record<string, number | null> }[];
    percent: number | null;
    grade: string | null;
    point: number | null;
    passed: boolean | null;
    grace: number;
};

/** Results of the students of a section (or of one student) for a scope. */
export const computeResults = async (kind: ScopeKind, id: string, sectionId: string, onlyStudentId?: string) => {
    const scope = await resolveScope(kind, id);
    const section = await db.section.findFirst({ where: { id: sectionId, academicYearId: scope.yearId }, select: { id: true, name: true, classId: true, classTeacher: { select: { firstName: true, middleName: true, lastName: true } }, schoolClass: { select: { name: true, shortName: true } } } });
    if (!section) throw notFound('Section not found');
    const rule = await ruleFor(section.classId);
    const exams = scope.exams.filter((e: Exam) => e.classIds.includes(section.classId));
    const examSubjects = await db.examSubject.findMany({ where: { examId: { in: exams.map((e) => e.id) }, classId: section.classId }, orderBy: { sortOrder: 'asc' } });
    const subjectIds = [...new Set(examSubjects.map((s) => s.subjectId))];
    const [subjects, enrol] = await Promise.all([
        db.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } }),
        db.enrolment.findMany({
            where: { academicYearId: scope.yearId, sectionId, ...(onlyStudentId ? { studentId: onlyStudentId } : { student: { status: 'active' } }) },
            select: { rollNumber: true, student: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, dateOfBirth: true, photoFileId: true, family: { select: { guardians: { select: { name: true, relation: { select: { name: true } } } } } } } } },
            orderBy: [{ rollNumber: 'asc' }, { student: { firstName: 'asc' } }],
        }),
    ]);
    const order = new Map(examSubjects.map((s, i) => [s.subjectId, i]));
    subjects.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const ids = enrol.map((e) => e.student.id);
    const marks = await db.examMark.findMany({ where: { examSubjectId: { in: examSubjects.map((s) => s.id) }, studentId: { in: ids } } });
    const markOf = new Map(marks.map((m) => [`${m.examSubjectId}|${m.studentId}`, m]));
    const notes = await db.examStudentNote.findMany({ where: { examId: { in: exams.map((e) => e.id) }, studentId: { in: ids } } });
    const coAreas = await db.classSubject.findMany({ where: { academicYearId: scope.yearId, classId: section.classId, subject: { assessment: 'co_scholastic' } }, select: { subject: { select: { id: true, name: true } } }, orderBy: { sortOrder: 'asc' } });
    const areas = [...new Map(coAreas.map((c) => [c.subject.id, c.subject])).values()];
    // Equal shares when no exam has a weightage.
    const totalWeight = exams.reduce((a, e) => a + e.weightage, 0);
    const weightOf = (e: Exam) => (totalWeight > 0 ? e.weightage : 1);
    const bands = rule.scale.bands as Band[];
    const year = await db.academicYear.findUnique({ where: { id: scope.yearId }, select: { name: true, startDate: true, endDate: true } });
    const from = scope.term?.startDate ? isoOf(scope.term.startDate) : isoOf(year!.startDate);
    const toCap = scope.term?.endDate ? isoOf(scope.term.endDate) : isoOf(year!.endDate);
    const to = toCap < todayIST() ? toCap : todayIST();
    const attendance = rule.showAttendance && from <= to ? await summaries(ids, from, to) : new Map();
    const countsOf = new Map((await markStatuses()).map((s) => [s.code, s.counts]));
    const nextYear = kind === 'final' ? await nextYearOf(scope.yearId) : null;
    const nextClass = nextYear ? await nextClassIn(section.classId, nextYear.id) : null;

    const students = enrol.map((e) => {
        const sid = e.student.id;
        const perSubject = subjects.map((s) => {
            const per = exams.flatMap((ex) => {
                const es = examSubjects.find((x) => x.examId === ex.id && x.subjectId === s.id);
                if (!es) return [];
                const parts = es.components as Part[];
                const max = parts.reduce((a, p) => a + p.max, 0);
                const m = markOf.get(`${es.id}|${sid}`);
                const status = m?.status ?? 'none';
                // Absent, medical… count as the school set them (Masters → Mark statuses).
                const counts = status === 'P' || status === 'none' ? null : (countsOf.get(status.toUpperCase()) ?? 'leave_out');
                const pm = (m?.marks ?? {}) as Record<string, number | string>;
                const obtained: number | null = status === 'P' ? (m?.total ?? null) : counts === 'zero' ? 0 : null;
                const grade: string | null = rule.descriptive ? ((pm.grade as string) ?? null) : null;
                const partMarks = Object.fromEntries(parts.map((p) => [p.key, typeof pm[p.key] === 'number' ? (pm[p.key] as number) : null]));
                return [{ examId: ex.id, obtained, max, status, grade, parts: partMarks, exam: ex, components: parts, average: counts === 'average' }];
            });
            return { s, per };
        });
        // “Average”: the student's % in the exam's other papers they sat, applied to this paper.
        for (const ex of exams) {
            const papers = perSubject.flatMap((x) => x.per.filter((p) => p.examId === ex.id));
            if (!papers.some((p) => p.average)) continue;
            const sat = papers.filter((p) => p.status === 'P' && p.obtained != null && p.max > 0);
            const pct = sat.length ? sat.reduce((a, p) => a + p.obtained!, 0) / sat.reduce((a, p) => a + p.max, 0) : null;
            for (const p of papers) if (p.average && pct != null) p.obtained = round1(p.max * pct);
        }
        const subj: SubjectResult[] = perSubject.map(({ s, per }) => {
            if (!rule.descriptive) for (const p of per) p.grade = p.obtained != null && p.max ? (gradeOf(bands, (p.obtained / p.max) * 100)?.grade ?? null) : null;
            if (rule.descriptive) {
                const last = [...per].reverse().find((p) => p.grade);
                return { subjectId: s.id, subject: s.name, exams: per.map(({ exam: _e, components: _c, average: _a, ...x }) => x), percent: null, grade: last?.grade ?? null, point: null, passed: null, grace: 0 };
            }
            const counted = per.filter((p) => p.obtained != null && p.max > 0);
            const w = counted.reduce((a, p) => a + weightOf(p.exam), 0);
            const percent = counted.length && w > 0 ? round1(counted.reduce((a, p) => a + weightOf(p.exam) * ((p.obtained! / p.max) * 100), 0) / w) : null;
            let passed = percent == null ? null : percent >= rule.passPercent;
            // Each part (theory, practical…) passed on its own.
            if (passed && rule.passEachPart)
                for (const p of counted)
                    for (const c of p.components) {
                        const v = p.parts[c.key];
                        if (v != null && (v / c.max) * 100 < rule.passPercent) passed = false;
                    }
            const g = gradeOf(bands, percent);
            return { subjectId: s.id, subject: s.name, exams: per.map(({ exam: _e, components: _c, average: _a, ...x }) => x), percent, grade: g?.grade ?? null, point: g?.point ?? null, passed, grace: 0 };
        });

        // Overall: one exam = total of marks; several = the average of the subjects' %.
        let totalObtained: number | null = null;
        let totalMax: number | null = null;
        let overall: number | null = null;
        if (!rule.descriptive) {
            const withPct = subj.filter((s) => s.percent != null);
            if (exams.length === 1) {
                const rows = subj.flatMap((s) => s.exams.filter((x) => x.obtained != null));
                totalObtained = rows.reduce((a, r) => a + r.obtained!, 0);
                totalMax = rows.reduce((a, r) => a + r.max, 0);
                overall = totalMax ? round1((totalObtained / totalMax) * 100) : null;
            } else overall = withPct.length ? round1(withPct.reduce((a, s) => a + s.percent!, 0) / withPct.length) : null;
            // Grace: a few marks in a few subjects to pass.
            const failed = subj.filter((s) => s.passed === false);
            if (failed.length && rule.graceMarks > 0 && failed.length <= rule.graceSubjects) {
                const need = failed.map((s) => {
                    const max = s.exams.reduce((a, x) => a + x.max, 0) / Math.max(1, s.exams.length);
                    return Math.ceil(((rule.passPercent - (s.percent ?? 0)) / 100) * max);
                });
                if (need.every((n) => n <= rule.graceMarks))
                    failed.forEach((s, i) => {
                        s.grace = need[i];
                        s.passed = true;
                    });
            }
        }
        const done = subj.some((s) => s.percent != null || s.grade != null);
        const failedSubjects = subj.filter((s) => s.passed === false).map((s) => s.subject);
        const result = !done ? null : rule.descriptive ? 'Completed' : failedSubjects.length ? 'Needs improvement' : 'Passed';
        const note = [...notes].reverse().find((n) => n.studentId === sid && exams.some((x) => x.id === n.examId));
        const co = (note?.coGrades ?? {}) as Record<string, string>;
        const g = e.student.family?.guardians ?? [];
        const parent = (re: RegExp) => g.find((x) => x.relation && re.test(x.relation.name))?.name ?? null;
        const att = attendance.get(sid) as { days: number; present: number; percent: number | null } | undefined;
        return {
            student: { id: sid, name: fullName(e.student), admissionNo: e.student.admissionNo, roll: e.rollNumber, dateOfBirth: e.student.dateOfBirth ? isoOf(e.student.dateOfBirth) : null, father: parent(/father/i), mother: parent(/mother/i), photoFileId: e.student.photoFileId },
            subjects: subj,
            totalObtained,
            totalMax,
            percent: overall,
            grade: rule.descriptive ? null : (gradeOf(bands, overall)?.grade ?? null),
            result,
            failedSubjects,
            graced: subj.filter((s) => s.grace > 0).map((s) => `${s.subject} (+${s.grace})`),
            rank: null as number | null,
            promotedTo: kind === 'final' && result === 'Passed' ? (nextClass?.name ?? null) : null,
            co: areas.map((a) => ({ area: a.name, grade: co[a.id] ?? null })),
            discipline: note?.discipline ?? null,
            remark: note?.remark ?? null,
            attendance: att ? { days: Math.round(att.days), present: Math.round(att.present * 10) / 10, percent: att.percent } : null,
        };
    });
    if (rule.showRank && !rule.descriptive) {
        const ranked = students.filter((s) => s.percent != null).sort((a, b) => b.percent! - a.percent!);
        let rank = 0;
        let last: number | null = null;
        ranked.forEach((s, i) => {
            if (s.percent !== last) rank = i + 1;
            last = s.percent;
            s.rank = rank;
        });
    }
    return {
        scope: { kind, id, label: scope.label, published: scope.published },
        year: year!.name,
        section: { id: section.id, label: sectionLabel(section), className: section.schoolClass.name, classTeacher: section.classTeacher ? fullName(section.classTeacher) : null },
        rule: { descriptive: rule.descriptive, passPercent: rule.passPercent, showRank: rule.showRank, showAttendance: rule.showAttendance, bands, coBands: rule.co },
        exams: exams.map((x) => ({ id: x.id, name: x.name, shortName: x.shortName ?? x.name, weightage: x.weightage })),
        subjects: subjects.map((s) => ({ id: s.id, name: s.name })),
        areas: areas.map((a) => a.name),
        students,
        /** Subject teacher's view: only these subjects, no overall result (see limitResults). */
        limitedTo: null as string[] | null,
    };
};

type Computed = Awaited<ReturnType<typeof computeResults>>;

/** A subject teacher's view of a section: their subjects' marks only, no totals, rank, result or card details. */
export const limitResults = (r: Computed, subjectIds: string[] | null): Computed => {
    if (!subjectIds) return r;
    const keep = new Set(subjectIds);
    const subjects = r.subjects.filter((s) => keep.has(s.id));
    return {
        ...r,
        limitedTo: subjects.map((s) => s.name),
        subjects,
        areas: [],
        students: r.students.map((st) => {
            const subs = st.subjects.filter((x) => keep.has(x.subjectId));
            return { ...st, subjects: subs, totalObtained: null, totalMax: null, percent: null, grade: null, result: null, failedSubjects: subs.filter((x) => x.passed === false).map((x) => x.subject), graced: [], rank: null, promotedTo: null, co: [], discipline: null, remark: null, attendance: null };
        }),
    };
};

/** Class analysis: per subject average, highest, lowest, pass %, grades; overall pass %, toppers. */
export const analyse = (r: Computed) => {
    // A subject teacher's view has no overall result: the figures are of their subjects.
    const limited = !!r.limitedTo;
    const scoreOf = (s: Computed['students'][number]) => {
        if (!limited) return s.percent;
        const p = s.subjects.filter((x) => x.percent != null).map((x) => x.percent!);
        return p.length ? round1(p.reduce((a, b) => a + b, 0) / p.length) : null;
    };
    const gradeOfStudent = (s: Computed['students'][number]) => (limited ? (s.subjects.length === 1 ? s.subjects[0].grade : null) : s.grade);
    const passedOf = (s: Computed['students'][number]) => (limited ? s.subjects.every((x) => x.passed !== false) : s.result === 'Passed' || s.result === 'Completed');
    const done = r.students.filter((s) => (limited ? scoreOf(s) != null : s.result));
    const subjects = r.subjects.map((s) => {
        const vals = r.students.map((st) => st.subjects.find((x) => x.subjectId === s.id)).filter((x): x is SubjectResult => !!x && x.percent != null);
        const pcts = vals.map((v) => v.percent!);
        const grades: Record<string, number> = {};
        for (const v of vals) if (v.grade) grades[v.grade] = (grades[v.grade] ?? 0) + 1;
        return {
            subject: s.name,
            students: vals.length,
            average: pcts.length ? round1(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
            highest: pcts.length ? Math.max(...pcts) : null,
            lowest: pcts.length ? Math.min(...pcts) : null,
            passPercent: vals.length ? round1((vals.filter((v) => v.passed).length / vals.length) * 100) : null,
            grades,
        };
    });
    const scored = done.map((s) => ({ s, score: scoreOf(s) })).filter((x): x is { s: (typeof done)[number]; score: number } => x.score != null);
    const toppers = [...scored].sort((a, b) => b.score - a.score).slice(0, 5).map(({ s, score }) => ({ name: s.student.name, percent: score, grade: gradeOfStudent(s) }));
    const passed = done.filter(passedOf).length;
    return {
        students: r.students.length,
        withResult: done.length,
        passed,
        passPercent: done.length ? round1((passed / done.length) * 100) : null,
        average: scored.length ? round1(scored.reduce((a, x) => a + x.score, 0) / scored.length) : null,
        subjects,
        toppers,
        needSupport: r.students.filter((s) => s.failedSubjects.length).map((s) => ({ name: s.student.name, subjects: s.failedSubjects })),
    };
};

// ─── Who may see what ────────────────────────────────────────────────────────

/**
 * What the person sees of each section's results: 'all' (in full), or per section either null (in
 * full: their own class) or the subjects they teach there (exam.view_taught_sections: in full).
 */
export type SectionLimits = 'all' | Map<string, string[] | null>;
export const sectionLimits = async (userId: string, yearId: string): Promise<SectionLimits> => {
    const a = await getUserAccess(userId);
    if (a.permissions['exam.view'] === 'all' || a.permissions['exam.publish'] || a.permissions['exam.marks_any']) return 'all';
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    if (!staff) return new Map();
    const [own, teach] = await Promise.all([
        db.section.findMany({ where: { academicYearId: yearId, classTeacherId: staff.id }, select: { id: true } }),
        db.teachingAssignment.findMany({ where: { academicYearId: yearId, staffId: staff.id }, select: { sectionId: true, subjectId: true } }),
    ]);
    const full = !!a.permissions['exam.view_taught_sections'];
    const m = new Map<string, string[] | null>();
    for (const t of teach) m.set(t.sectionId, full ? null : [...(m.get(t.sectionId) ?? []), t.subjectId]);
    for (const s of own) m.set(s.id, null);
    return m;
};
/** Sections whose results the person sees (in full or in part). */
export const viewableSections = async (userId: string, yearId: string): Promise<'all' | string[]> => {
    const l = await sectionLimits(userId, yearId);
    return l === 'all' ? 'all' : [...l.keys()];
};
/** The subjects a person is limited to in a section (null = in full). Only for sections they see. */
export const limitIn = (l: SectionLimits, sectionId: string) => (l === 'all' ? null : (l.get(sectionId) ?? null));
/** Whether the person sees the section in full (needed for report cards and overall results). */
export const seesInFull = (l: SectionLimits, sectionId: string) => l === 'all' || (l.has(sectionId) && l.get(sectionId) === null);

export const sectionResults = async (q: z.infer<typeof scopeQuery>, userId: string) => {
    if (!q.section) throw badRequest('Choose a section');
    const scope = await resolveScope(q.scope, q.id);
    const limits = await sectionLimits(userId, scope.yearId);
    if (limits !== 'all' && !limits.has(q.section)) throw forbidden('You can see the results of your own sections only');
    const r = limitResults(await computeResults(q.scope, q.id, q.section), limitIn(limits, q.section));
    return { ...r, analysis: analyse(r) };
};

/** Scopes (exams, terms, final) and sections of a session for the results screen. */
export const resultChoices = async (yearId: string, userId: string) => {
    const [exams, terms, pubs, limits] = await Promise.all([
        db.exam.findMany({ where: { academicYearId: yearId }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, status: true, classIds: true } }),
        db.examTerm.findMany({ where: { academicYearId: yearId }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } }),
        db.resultPublication.findMany({ where: { academicYearId: yearId } }),
        sectionLimits(userId, yearId),
    ]);
    const sections = await db.section.findMany({
        where: { academicYearId: yearId, isActive: true, ...(limits === 'all' ? {} : { id: { in: [...limits.keys()] } }) },
        select: { id: true, name: true, classId: true, schoolClass: { select: { name: true, shortName: true } } },
        orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
    });
    return {
        exams: exams.map((e) => ({ id: e.id, name: e.name, status: e.status, published: e.status === 'published', classIds: e.classIds })),
        terms: terms.map((t) => ({ ...t, published: pubs.some((p) => p.scope === 'term' && p.termId === t.id) })),
        finalPublished: pubs.some((p) => p.scope === 'final'),
        sections: sections.map((s) => ({ id: s.id, label: sectionLabel(s), classId: s.classId, inFull: seesInFull(limits, s.id) })),
    };
};

// ─── Publishing a term's / the final result ──────────────────────────────────

export const publishScope = async (yearId: string, scope: 'term' | 'final', termId: string | null, publish: boolean, userId: string) => {
    if (scope === 'term' && !termId) throw badRequest('Choose the term');
    await db.resultPublication.deleteMany({ where: { academicYearId: yearId, scope, termId: scope === 'term' ? termId : null } });
    if (publish) await db.resultPublication.create({ data: { tenantId: getTenantId()!, academicYearId: yearId, scope, termId: scope === 'term' ? termId : null, publishedBy: userId } });
    await recordAudit({ action: publish ? 'results_published' : 'results_unpublished', entity: 'academic_year', entityId: yearId, changes: { scope, termId } });
    return { published: publish };
};

// ─── Students and parents ────────────────────────────────────────────────────

/** The published results of the person's own child(ren) (or their own). */
export const myResults = async (userId: string) => {
    const students = await db.student.findMany({ where: { status: { in: ['active', 'left', 'passed_out'] }, OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, select: { id: true, firstName: true, middleName: true, lastName: true, enrolments: { select: { academicYearId: true, sectionId: true, academicYear: { select: { name: true, startDate: true } } }, orderBy: { academicYear: { startDate: 'desc' } } } } });
    const out = [];
    for (const s of students) {
        const cards = [];
        for (const e of s.enrolments) {
            const [exams, pubs, terms] = await Promise.all([
                db.exam.findMany({ where: { academicYearId: e.academicYearId, status: 'published' }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, classIds: true } }),
                db.resultPublication.findMany({ where: { academicYearId: e.academicYearId } }),
                db.examTerm.findMany({ where: { academicYearId: e.academicYearId }, select: { id: true, name: true } }),
            ]);
            const section = await db.section.findUnique({ where: { id: e.sectionId }, select: { classId: true } });
            for (const x of exams) if (section && x.classIds.includes(section.classId)) cards.push({ scope: 'exam' as const, id: x.id, label: x.name, year: e.academicYear.name, sectionId: e.sectionId });
            for (const p of pubs) cards.push(p.scope === 'final' ? { scope: 'final' as const, id: e.academicYearId, label: `Final result`, year: e.academicYear.name, sectionId: e.sectionId } : { scope: 'term' as const, id: p.termId!, label: terms.find((t) => t.id === p.termId)?.name ?? 'Term', year: e.academicYear.name, sectionId: e.sectionId });
        }
        out.push({ student: { id: s.id, name: fullName(s) }, cards });
    }
    return out;
};

/** A published result of one's own child, for the report card (throws if not theirs or not published). */
export const assertMine = async (userId: string, studentId: string, kind: ScopeKind, id: string) => {
    const mine = await db.student.findFirst({ where: { id: studentId, OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, select: { id: true } });
    if (!mine) throw forbidden();
    const scope = await resolveScope(kind, id);
    if (!scope.published) throw forbidden('These results are not published yet');
};
