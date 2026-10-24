import type { Exam } from '@prisma/client';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { assertYearOpen } from '../academic/years.service';
import { classesOfYear } from '../academic/year-classes.service';
import { dayDate, isoOf } from '../attendance/attendance.settings';
import { getSettings } from '../../core/settings';
import { EXAMS } from './exams.settings';
import { alertDatesheet, alertResults } from './exams.alerts';

/**
 * Exam set-up: grading scales and result rules (per class group), terms and exams of a session,
 * and each exam's subjects per class (their parts with maximum marks, and the date sheet).
 */

const ISO = z.iso.date();
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time like 09:30');
const uuidOk = (id: string) => z.uuid().safeParse(id).success;

export type Band = { grade: string; min?: number; point?: number; remark?: string };
export type Part = { key: string; label: string; max: number };

// ─── Grading scales and result rules (filled with the usual ones the first time) ──

const CBSE: Band[] = [
    { grade: 'A1', min: 91, point: 10, remark: 'Outstanding' },
    { grade: 'A2', min: 81, point: 9, remark: 'Excellent' },
    { grade: 'B1', min: 71, point: 8, remark: 'Very good' },
    { grade: 'B2', min: 61, point: 7, remark: 'Good' },
    { grade: 'C1', min: 51, point: 6, remark: 'Above average' },
    { grade: 'C2', min: 41, point: 5, remark: 'Average' },
    { grade: 'D', min: 33, point: 4, remark: 'Fair' },
    { grade: 'E1', min: 21, point: 0, remark: 'Needs improvement' },
    { grade: 'E2', min: 0, point: 0, remark: 'Needs improvement' },
];
const CO: Band[] = [
    { grade: 'A', remark: 'Outstanding' },
    { grade: 'B', remark: 'Very good' },
    { grade: 'C', remark: 'Fair' },
];
const PRE: Band[] = [
    { grade: 'Excellent', remark: 'Does it very well' },
    { grade: 'Very good', remark: 'Does it well' },
    { grade: 'Good', remark: 'Is learning it' },
    { grade: 'Needs support', remark: 'Needs more practice' },
];

/** Makes the usual scales and rules for a school that has none yet. */
export const ensureExamSetup = async () => {
    if (await db.gradeScale.count()) return;
    const tenantId = getTenantId()!;
    const [cbse, co, pre] = await Promise.all([
        db.gradeScale.create({ data: { tenantId, name: 'CBSE 9-point (marks)', kind: 'marks', bands: CBSE, sortOrder: 1 } }),
        db.gradeScale.create({ data: { tenantId, name: 'Co-scholastic (A / B / C)', kind: 'descriptive', bands: CO, sortOrder: 2 } }),
        db.gradeScale.create({ data: { tenantId, name: 'Pre-primary (descriptive)', kind: 'descriptive', bands: PRE, sortOrder: 3 } }),
    ]);
    const prePrimary = await db.masterValue.findFirst({ where: { master: 'class_group', name: { contains: 'Pre', mode: 'insensitive' } }, select: { id: true } });
    await db.resultRule.create({ data: { tenantId, gradeScaleId: cbse.id, coScaleId: co.id } });
    if (prePrimary) await db.resultRule.create({ data: { tenantId, classGroupId: prePrimary.id, descriptive: true, gradeScaleId: pre.id, coScaleId: co.id } });
};

export const listScales = async () => {
    await ensureExamSetup();
    return (await db.gradeScale.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })).map((g) => ({ id: g.id, name: g.name, kind: g.kind as 'marks' | 'descriptive', bands: g.bands as Band[] }));
};

export const scaleSchema = z
    .strictObject({
        name: z.string().trim().min(2).max(60),
        kind: z.enum(['marks', 'descriptive']),
        bands: z.array(z.strictObject({ grade: z.string().trim().min(1).max(20), min: z.number().min(0).max(100).optional(), point: z.number().min(0).max(100).optional(), remark: z.string().trim().max(60).optional() })).min(2).max(20),
    })
    .refine((s) => s.kind === 'descriptive' || s.bands.every((b) => b.min != null), { message: 'every grade needs its lowest %', path: ['bands'] })
    .refine((s) => s.kind === 'descriptive' || s.bands.some((b) => b.min === 0), { message: 'one grade must start at 0%', path: ['bands'] });

const sortBands = (s: z.infer<typeof scaleSchema>) => (s.kind === 'marks' ? [...s.bands].sort((a, b) => b.min! - a.min!) : s.bands);

export const saveScale = async (id: string | null, input: z.infer<typeof scaleSchema>) => {
    await ensureExamSetup();
    if (id) {
        if (!uuidOk(id) || !(await db.gradeScale.findFirst({ where: { id } }))) throw notFound('Grading scale not found');
        await db.gradeScale.update({ where: { id }, data: { name: input.name, kind: input.kind, bands: sortBands(input) } });
    } else await db.gradeScale.create({ data: { tenantId: getTenantId()!, name: input.name, kind: input.kind, bands: sortBands(input), sortOrder: (await db.gradeScale.count()) + 1 } });
    await recordAudit({ action: 'grade_scale_saved', entity: 'grade_scale', entityId: id ?? undefined, changes: { name: input.name } });
    return listScales();
};

export const deleteScale = async (id: string) => {
    if (await db.resultRule.count({ where: { OR: [{ gradeScaleId: id }, { coScaleId: id }] } })) throw conflict('A result rule uses this scale. Change the rule first.');
    await db.gradeScale.deleteMany({ where: { id } });
    return listScales();
};

export const listRules = async () => {
    await ensureExamSetup();
    const [rules, groups] = await Promise.all([db.resultRule.findMany({ orderBy: { createdAt: 'asc' } }), db.masterValue.findMany({ where: { master: 'class_group' }, select: { id: true, name: true } })]);
    const names = new Map(groups.map((g) => [g.id, g.name]));
    return rules.map((r) => ({ ...r, group: r.classGroupId ? (names.get(r.classGroupId) ?? '—') : 'Every other class' }));
};

export const ruleSchema = z.strictObject({
    classGroupId: z.uuid().nullable(),
    descriptive: z.boolean(),
    gradeScaleId: z.uuid().nullable(),
    coScaleId: z.uuid().nullable(),
    passPercent: z.number().min(0).max(100),
    passEachPart: z.boolean(),
    graceMarks: z.number().int().min(0).max(20),
    graceSubjects: z.number().int().min(0).max(5),
    showRank: z.boolean(),
    showAttendance: z.boolean(),
    cardFormat: z.enum(['standard', 'cbse', 'cbse_senior', 'state', 'preprimary']).default('standard'),
});

export const saveRule = async (id: string | null, input: z.infer<typeof ruleSchema>) => {
    await ensureExamSetup();
    const clash = await db.resultRule.findFirst({ where: { classGroupId: input.classGroupId, ...(id ? { id: { not: id } } : {}) } });
    if (clash) throw conflict(input.classGroupId ? 'That class group already has a rule' : 'There is already a rule for every other class');
    if (id) await db.resultRule.update({ where: { id }, data: input });
    else await db.resultRule.create({ data: { tenantId: getTenantId()!, ...input } });
    await recordAudit({ action: 'result_rule_saved', entity: 'result_rule', entityId: id ?? undefined, changes: { group: input.classGroupId } });
    return listRules();
};

export const deleteRule = async (id: string) => {
    const r = await db.resultRule.findFirst({ where: { id } });
    if (!r) throw notFound('Rule not found');
    if (!r.classGroupId) throw badRequest('The rule for every other class is needed');
    await db.resultRule.delete({ where: { id } });
    return listRules();
};

/** The rule for a class (its group's, else the general one) with its scales. */
export const ruleFor = async (classId: string) => {
    await ensureExamSetup();
    const cls = await db.schoolClass.findUnique({ where: { id: classId }, select: { groupId: true } });
    const rules = await db.resultRule.findMany();
    const rule = rules.find((r) => r.classGroupId && r.classGroupId === cls?.groupId) ?? rules.find((r) => !r.classGroupId)!;
    const scales = await db.gradeScale.findMany({ where: { id: { in: [rule.gradeScaleId, rule.coScaleId].filter((x): x is string => !!x) } } });
    const scale = scales.find((s) => s.id === rule.gradeScaleId);
    const co = scales.find((s) => s.id === rule.coScaleId);
    return { ...rule, scale: scale ? { kind: scale.kind, bands: scale.bands as Band[] } : { kind: 'marks', bands: CBSE }, co: co ? (co.bands as Band[]) : CO };
};

/** The grade of a % on a marks scale. */
export const gradeOf = (bands: Band[], pct: number | null) => {
    if (pct == null) return null;
    const sorted = [...bands].filter((b) => b.min != null).sort((a, b) => b.min! - a.min!);
    return sorted.find((b) => pct >= b.min!) ?? sorted[sorted.length - 1] ?? null;
};

// ─── Terms ───────────────────────────────────────────────────────────────────

export const termSchema = z.strictObject({ name: z.string().trim().min(1).max(40), startDate: ISO.nullable().optional(), endDate: ISO.nullable().optional() });

export const listTerms = async (yearId: string) =>
    (await db.examTerm.findMany({ where: { academicYearId: yearId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })).map((t) => ({ id: t.id, name: t.name, startDate: t.startDate ? isoOf(t.startDate) : null, endDate: t.endDate ? isoOf(t.endDate) : null }));

export const saveTerm = async (yearId: string, id: string | null, input: z.infer<typeof termSchema>) => {
    await assertYearOpen(yearId);
    const data = { name: input.name, startDate: input.startDate ? dayDate(input.startDate) : null, endDate: input.endDate ? dayDate(input.endDate) : null };
    if (id) await db.examTerm.update({ where: { id }, data });
    else await db.examTerm.create({ data: { tenantId: getTenantId()!, academicYearId: yearId, ...data, sortOrder: (await db.examTerm.count({ where: { academicYearId: yearId } })) + 1 } });
    return listTerms(yearId);
};

export const deleteTerm = async (id: string) => {
    const t = await db.examTerm.findFirst({ where: { id } });
    if (!t) throw notFound('Term not found');
    if (await db.exam.count({ where: { termId: id } })) throw conflict('The term has exams. Move or delete them first.');
    await db.examTerm.delete({ where: { id } });
    return listTerms(t.academicYearId);
};

// ─── Exams ───────────────────────────────────────────────────────────────────

const partSchema = z.strictObject({ key: z.string().trim().min(1).max(10).regex(/^[a-z0-9_]+$/, 'letters and numbers only'), label: z.string().trim().min(1).max(30), max: z.number().positive().max(1000) });
const partsSchema = z
    .array(partSchema)
    .min(1, 'give at least one part (e.g. Written, 100)')
    .max(6)
    .refine((ps) => new Set(ps.map((p) => p.key)).size === ps.length, 'two parts have the same key');

export const examSchema = z.strictObject({
    name: z.string().trim().min(2).max(60),
    shortName: z.string().trim().max(12).nullable().optional(),
    termId: z.uuid().nullable().optional(),
    classIds: z.array(z.uuid()).min(1, 'choose the classes taking it').max(60),
    components: partsSchema,
    weightage: z.number().min(0).max(100),
    countsInResult: z.boolean(),
    entryDeadline: ISO.nullable().optional(),
});

const presentExam = (e: Exam & { term?: { name: string } | null; _count?: { subjects: number } }) => ({
    id: e.id,
    name: e.name,
    shortName: e.shortName,
    termId: e.termId,
    term: e.term?.name ?? null,
    classIds: e.classIds,
    components: e.components as Part[],
    weightage: e.weightage,
    countsInResult: e.countsInResult,
    status: e.status as 'draft' | 'open' | 'locked' | 'published',
    entryDeadline: e.entryDeadline ? isoOf(e.entryDeadline) : null,
    publishedAt: e.publishedAt,
    subjects: e._count?.subjects ?? 0,
    datesheetPublished: !!e.datesheetNoticeId,
});

export const listExams = async (yearId: string) => {
    const rows = await db.exam.findMany({ where: { academicYearId: yearId }, include: { term: { select: { name: true } }, _count: { select: { subjects: true } } }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(presentExam);
};

export const loadExam = async (id: string) => {
    if (!uuidOk(id)) throw notFound('Exam not found');
    const e = await db.exam.findFirst({ where: { id }, include: { term: { select: { name: true } }, _count: { select: { subjects: true } } } });
    if (!e) throw notFound('Exam not found');
    return e;
};

/** Adds the subjects of the exam's classes that it doesn't have yet; drops those of classes taken off (without marks). */
const syncSubjects = async (exam: Exam) => {
    const classSubjects = await db.classSubject.findMany({
        where: { academicYearId: exam.academicYearId, classId: { in: exam.classIds }, subject: { assessment: 'scholastic', isActive: true } },
        select: { classId: true, subjectId: true, sortOrder: true, subject: { select: { sortOrder: true } } },
    });
    const existing = await db.examSubject.findMany({ where: { examId: exam.id }, select: { id: true, classId: true, subjectId: true, _count: { select: { marks: true } } } });
    const have = new Set(existing.map((x) => `${x.classId}|${x.subjectId}`));
    const tenantId = getTenantId()!;
    const seen = new Set<string>();
    const fresh = classSubjects.filter((c) => {
        const k = `${c.classId}|${c.subjectId}`;
        if (have.has(k) || seen.has(k)) return false;
        seen.add(k);
        return true;
    });
    if (fresh.length) await db.examSubject.createMany({ data: fresh.map((c) => ({ tenantId, examId: exam.id, classId: c.classId, subjectId: c.subjectId, components: exam.components as object, sortOrder: c.sortOrder || c.subject.sortOrder })), skipDuplicates: true });
    const gone = existing.filter((x) => !exam.classIds.includes(x.classId) && !x._count.marks);
    if (gone.length) await db.examSubject.deleteMany({ where: { id: { in: gone.map((g) => g.id) } } });
    return fresh.length;
};

export const createExam = async (yearId: string, input: z.infer<typeof examSchema>) => {
    await assertYearOpen(yearId);
    const running = new Set((await classesOfYear(yearId)).map((c) => c.id));
    if (input.classIds.some((c) => !running.has(c))) throw badRequest('Choose classes of this session');
    if (input.termId && !(await db.examTerm.findFirst({ where: { id: input.termId, academicYearId: yearId } }))) throw badRequest('Choose a term of this session');
    const e = await db.exam.create({
        data: {
            tenantId: getTenantId()!,
            academicYearId: yearId,
            name: input.name,
            shortName: input.shortName ?? null,
            termId: input.termId ?? null,
            classIds: input.classIds,
            components: input.components,
            weightage: input.weightage,
            countsInResult: input.countsInResult,
            entryDeadline: input.entryDeadline ? dayDate(input.entryDeadline) : null,
            sortOrder: (await db.exam.count({ where: { academicYearId: yearId } })) + 1,
        },
    });
    await syncSubjects(e);
    await recordAudit({ action: 'exam_created', entity: 'exam', entityId: e.id, changes: { name: e.name } });
    return presentExam(await loadExam(e.id));
};

export const updateExam = async (id: string, input: z.infer<typeof examSchema>) => {
    const e = await loadExam(id);
    if (e.status === 'published') throw conflict('The results are published. Unpublish them to change the exam.');
    const partsChanged = JSON.stringify(e.components) !== JSON.stringify(input.components);
    const updated = await db.exam.update({
        where: { id },
        data: { name: input.name, shortName: input.shortName ?? null, termId: input.termId ?? null, classIds: input.classIds, components: input.components, weightage: input.weightage, countsInResult: input.countsInResult, entryDeadline: input.entryDeadline ? dayDate(input.entryDeadline) : null },
    });
    // New default parts go to subjects that still have the old default and no marks.
    if (partsChanged) {
        const subjects = await db.examSubject.findMany({ where: { examId: id }, select: { id: true, components: true, _count: { select: { marks: true } } } });
        const same = subjects.filter((s) => !s._count.marks && JSON.stringify(s.components) === JSON.stringify(e.components)).map((s) => s.id);
        if (same.length) await db.examSubject.updateMany({ where: { id: { in: same } }, data: { components: input.components } });
    }
    await syncSubjects(updated);
    return presentExam(await loadExam(id));
};

export const deleteExam = async (id: string) => {
    const e = await loadExam(id);
    if (await db.examMark.count({ where: { examSubject: { examId: id } } })) throw conflict(`${e.name} has marks entered. Delete them first (or keep the exam).`);
    await db.exam.delete({ where: { id } });
    await recordAudit({ action: 'exam_deleted', entity: 'exam', entityId: id, changes: { name: e.name } });
};

/** draft → open (marks can be entered) → locked → published; published can go back to locked. */
export const setExamStatus = async (id: string, status: 'draft' | 'open' | 'locked' | 'published', userId: string) => {
    const e = await loadExam(id);
    await db.exam.update({ where: { id }, data: { status, ...(status === 'published' ? { publishedAt: new Date(), publishedBy: userId } : status === 'locked' && e.status === 'published' ? { publishedAt: null } : {}) } });
    await recordAudit({ action: `exam_${status}`, entity: 'exam', entityId: id, changes: { name: e.name, was: e.status } });
    if (status === 'published' && e.status !== 'published') alertResults({ key: `exam:${id}`, label: e.name, yearId: e.academicYearId, classIds: e.classIds });
    return presentExam(await loadExam(id));
};

// ─── The exam's subjects and its date sheet ──────────────────────────────────

export const examSubjects = async (id: string) => {
    const e = await loadExam(id);
    const [rows, classes, staff] = await Promise.all([
        db.examSubject.findMany({ where: { examId: id }, orderBy: [{ sortOrder: 'asc' }] }),
        db.schoolClass.findMany({ where: { id: { in: e.classIds } }, select: { id: true, name: true, sortOrder: true }, orderBy: { sortOrder: 'asc' } }),
        db.staff.findMany({ where: { status: 'working' }, select: { id: true, firstName: true, lastName: true } }),
    ]);
    const subjects = new Map((await db.subject.findMany({ where: { id: { in: rows.map((r) => r.subjectId) } }, select: { id: true, name: true, code: true } })).map((s) => [s.id, s]));
    const names = new Map(staff.map((s) => [s.id, [s.firstName, s.lastName].filter(Boolean).join(' ')]));
    const marks = await db.examMark.groupBy({ by: ['examSubjectId'], where: { examSubject: { examId: id } }, _count: { _all: true } });
    const entered = new Map(marks.map((m) => [m.examSubjectId, m._count._all]));
    return {
        exam: presentExam(e),
        classes: classes.map((c) => ({
            id: c.id,
            name: c.name,
            subjects: rows
                .filter((r) => r.classId === c.id)
                .map((r) => ({
                    id: r.id,
                    subjectId: r.subjectId,
                    subject: subjects.get(r.subjectId)?.name ?? '—',
                    code: subjects.get(r.subjectId)?.code ?? null,
                    components: r.components as Part[],
                    max: (r.components as Part[]).reduce((a, p) => a + p.max, 0),
                    date: r.date ? isoOf(r.date) : null,
                    startTime: r.startTime,
                    endTime: r.endTime,
                    room: r.room,
                    invigilatorId: r.invigilatorId,
                    invigilator: r.invigilatorId ? (names.get(r.invigilatorId) ?? null) : null,
                    marksEntered: entered.get(r.id) ?? 0,
                })),
        })),
    };
};

export const subjectRowsSchema = z.strictObject({
    rows: z
        .array(
            z.strictObject({
                id: z.uuid(),
                components: partsSchema.optional(),
                date: ISO.nullable().optional(),
                startTime: HHMM.nullable().optional(),
                endTime: HHMM.nullable().optional(),
                room: z.string().trim().max(30).nullable().optional(),
                invigilatorId: z.uuid().nullable().optional(),
            })
        )
        .max(500),
});

/** Saves the parts / maximum marks and the date sheet of many subjects at once; warns about clashes. */
export const saveSubjects = async (examId: string, input: z.infer<typeof subjectRowsSchema>) => {
    const e = await loadExam(examId);
    if (e.status === 'published') throw conflict('The results are published. Unpublish them to change the subjects.');
    const rows = await db.examSubject.findMany({ where: { examId }, select: { id: true, classId: true, _count: { select: { marks: true } }, components: true } });
    const by = new Map(rows.map((r) => [r.id, r]));
    for (const r of input.rows) {
        const cur = by.get(r.id);
        if (!cur) throw badRequest('A subject is not of this exam');
        if (r.components && cur._count.marks && JSON.stringify(r.components) !== JSON.stringify(cur.components)) {
            const keys = new Set((cur.components as Part[]).map((p) => p.key));
            if (r.components.some((p) => !keys.has(p.key))) throw conflict('Marks are already entered for a subject: its parts can’t change (maximum marks still can).');
        }
    }
    await withTransaction(async (tx) => {
        for (const r of input.rows)
            await tx.examSubject.update({
                where: { id: r.id },
                data: {
                    ...(r.components ? { components: r.components } : {}),
                    ...(r.date !== undefined ? { date: r.date ? dayDate(r.date) : null } : {}),
                    ...(r.startTime !== undefined ? { startTime: r.startTime || null } : {}),
                    ...(r.endTime !== undefined ? { endTime: r.endTime || null } : {}),
                    ...(r.room !== undefined ? { room: r.room || null } : {}),
                    ...(r.invigilatorId !== undefined ? { invigilatorId: r.invigilatorId || null } : {}),
                },
            });
    });
    // Clashes: a class with two papers at once, or an invigilator in two places.
    const all = await db.examSubject.findMany({ where: { examId, date: { not: null } }, select: { classId: true, date: true, startTime: true, invigilatorId: true, subjectId: true } });
    const warnings: string[] = [];
    const seen = new Map<string, number>();
    for (const r of all) {
        const k = `${r.classId}|${isoOf(r.date!)}|${r.startTime ?? ''}`;
        seen.set(k, (seen.get(k) ?? 0) + 1);
        if (r.invigilatorId) {
            const ki = `inv|${r.invigilatorId}|${isoOf(r.date!)}|${r.startTime ?? ''}`;
            seen.set(ki, (seen.get(ki) ?? 0) + 1);
        }
    }
    const classNames = new Map((await db.schoolClass.findMany({ where: { id: { in: e.classIds } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    for (const [k, n] of seen)
        if (n > 1) {
            const [a, b, c, d] = k.split('|');
            warnings.push(a === 'inv' ? `An invigilator has ${n} papers on ${c}${d ? ` at ${d}` : ''}` : `${classNames.get(a) ?? 'A class'} has ${n} papers on ${b}${c ? ` at ${c}` : ''}`);
        }
    return { ...(await examSubjects(examId)), warnings };
};

/** Puts the date sheet on the school calendar and the notice board (students and parents of the classes). */
export const publishDatesheet = async (examId: string, userId: string) => {
    const s = await examSubjects(examId);
    const dated = s.classes.flatMap((c) => c.subjects.filter((x) => x.date).map((x) => ({ ...x, className: c.name })));
    if (!dated.length) throw badRequest('Give the papers their dates first');
    const dates = dated.map((d) => d.date!).sort();
    const e = await loadExam(examId);
    const tenantId = getTenantId()!;
    const examType = await db.masterValue.findFirst({ where: { master: 'event_type', name: 'Exam' }, select: { id: true } });
    const category = await db.masterValue.findFirst({ where: { master: 'notice_category', name: 'Exam notice' }, select: { id: true } });
    const show = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const body = [
        `**${e.name}: date sheet**`,
        '',
        ...s.classes.flatMap((c) => {
            const list = c.subjects.filter((x) => x.date).sort((a, b) => a.date!.localeCompare(b.date!) || (a.startTime ?? '').localeCompare(b.startTime ?? ''));
            return list.length ? [`**${c.name}**`, ...list.map((x) => `- ${show(x.date!)}${x.startTime ? ` ${x.startTime}${x.endTime ? `–${x.endTime}` : ''}` : ''}: ${x.subject} (${x.max} marks)`), ''] : [];
        }),
    ].join('\n');
    const audience = { forEveryone: false, forAllStaff: true, roleIds: [], forStudents: true, forParents: true, classIds: e.classIds, sectionIds: [] };
    const { withNotice } = await getSettings({ withNotice: EXAMS.datesheetNotice });
    await withTransaction(async (tx) => {
        if (e.datesheetNoticeId) await tx.notice.deleteMany({ where: { id: e.datesheetNoticeId } });
        await tx.schoolEvent.deleteMany({ where: { title: `${e.name} (exams)`, startDate: { gte: dayDate(dates[0]) } } });
        await tx.schoolEvent.create({ data: { tenantId, title: `${e.name} (exams)`, typeId: examType?.id ?? null, startDate: dayDate(dates[0]), endDate: dayDate(dates[dates.length - 1]), description: 'See the date sheet on the notice board.', ...audience, isDemo: e.isDemo } });
        if (!withNotice) return;
        const n = await tx.notice.create({ data: { tenantId, title: `${e.name}: date sheet`, body, categoryId: category?.id ?? null, important: true, status: 'published', publishAt: new Date(), publishedAt: new Date(), publishedBy: userId, expiresOn: dayDate(dates[dates.length - 1]), ...audience, isDemo: e.isDemo } });
        await tx.exam.update({ where: { id: examId }, data: { datesheetNoticeId: n.id } });
    });
    await recordAudit({ action: 'datesheet_published', entity: 'exam', entityId: examId, changes: { name: e.name, papers: dated.length } });
    alertDatesheet(examId);
    return examSubjects(examId);
};
