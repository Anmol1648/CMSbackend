import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { getUserAccess } from '../rbac/access.service';
import { currentYear } from '../academic/years.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { takers } from '../exams/marks.service';
import { askAiJson } from '../ai/ai.service';
import { TESTS } from './tests.settings';
import { alertResults, alertTestPublished } from './tests.alerts';

/**
 * Online tests: a teacher makes a test from approved questions of the bank (picked, or drawn by
 * rules), for sections of a class, open in a time window. Students take it once, with a timer and
 * autosave; objective answers are marked at once, written ones by the teacher (AI can suggest).
 * Results go to students when the teacher publishes them (or at once, if the test says so).
 */

type Snap = { type: string; text: string; options: { text: string; correct: boolean }[]; answer: string | null; explanation: string | null; imageFileId: string | null; chapterId: string | null };
type Mark = { marks: number | null; by: 'auto' | 'teacher'; note?: string | null };
const OBJECTIVE = ['mcq', 'multi', 'true_false', 'fill'];
const GRACE_MS = 30_000;

// ─── Who may do what ─────────────────────────────────────────────────────────

const powers = async (userId: string) => {
    const a = await getUserAccess(userId);
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    return { create: a.permissions['test.create'], mark: !!a.permissions['test.mark'], view: a.permissions['test.view'], staffId: staff?.id ?? null };
};
type Powers = Awaited<ReturnType<typeof powers>>;

/** Per section: the subjects a teacher teaches there ('all' = their own class). */
const taught = async (staffId: string | null, yearId: string) => {
    const out = new Map<string, Set<string> | 'all'>();
    if (!staffId) return out;
    const [teach, own] = await Promise.all([
        db.teachingAssignment.findMany({ where: { academicYearId: yearId, staffId }, select: { sectionId: true, subjectId: true } }),
        db.section.findMany({ where: { academicYearId: yearId, classTeacherId: staffId }, select: { id: true } }),
    ]);
    for (const t of teach) {
        const cur = out.get(t.sectionId);
        if (cur !== 'all') out.set(t.sectionId, new Set([...(cur ?? []), t.subjectId]));
    }
    for (const s of own) out.set(s.id, 'all');
    return out;
};
const teaches = (t: Map<string, Set<string> | 'all'>, sectionId: string, subjectId: string) => {
    const x = t.get(sectionId);
    return x === 'all' || !!x?.has(subjectId);
};

type T = Prisma.OnlineTestGetPayload<object>;

/** What a person may do with a test. */
const accessTo = async (t: T, p: Powers) => {
    const tt = await taught(p.staffId, t.academicYearId);
    const own = !!p.staffId && t.staffId === p.staffId;
    const teachesAll = t.sectionIds.every((s) => teaches(tt, s, t.subjectId));
    const seesSome = t.sectionIds.some((s) => tt.has(s));
    const edit = !!p.create && (p.create === 'all' || own || teachesAll);
    const view = edit || p.view === 'all' || (!!p.view && seesSome) || own;
    return { edit, view, mark: p.mark && view };
};

const load = async (id: string, userId: string, need: 'view' | 'edit' | 'mark') => {
    const t = await db.onlineTest.findFirst({ where: { id } });
    if (!t) throw notFound('Test not found');
    const p = await powers(userId);
    const a = await accessTo(t, p);
    if (!a[need]) throw forbidden(need === 'edit' ? 'Only the teacher who made it (or the office) can change it' : undefined);
    return { t, p, a };
};

// ─── Making a test ───────────────────────────────────────────────────────────

/** Sections and subjects a teacher can make tests for (this session), grouped by class. */
export const createOptions = async (userId: string) => {
    const p = await powers(userId);
    const year = await currentYear();
    if (!year || !p.create) return { classes: [] };
    const tt = p.create === 'all' ? null : await taught(p.staffId, year.id);
    const sections = await db.section.findMany({ where: { academicYearId: year.id, isActive: true, ...(tt ? { id: { in: [...tt.keys()] } } : {}) }, select: { id: true, classId: true, name: true, schoolClass: { select: { name: true, shortName: true } } }, orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }] });
    const cs = await db.classSubject.findMany({ where: { academicYearId: year.id, classId: { in: [...new Set(sections.map((s) => s.classId))] } }, select: { classId: true, subject: { select: { id: true, name: true, isActive: true } } }, orderBy: { sortOrder: 'asc' } });
    const classes = new Map<string, { id: string; name: string; subjects: { id: string; name: string; sectionIds: string[] }[]; sections: { id: string; label: string }[] }>();
    for (const s of sections) {
        const c = classes.get(s.classId) ?? { id: s.classId, name: s.schoolClass.name, subjects: [], sections: [] };
        c.sections.push({ id: s.id, label: sectionLabel(s) });
        for (const x of cs.filter((y) => y.classId === s.classId && y.subject.isActive && (!tt || teaches(tt, s.id, y.subject.id)))) {
            const sub = c.subjects.find((y) => y.id === x.subject.id) ?? (c.subjects.push({ id: x.subject.id, name: x.subject.name, sectionIds: [] }), c.subjects[c.subjects.length - 1]);
            if (!sub.sectionIds.includes(s.id)) sub.sectionIds.push(s.id);
        }
        classes.set(s.classId, c);
    }
    const d = await getSettings({ duration: TESTS.duration, sq: TESTS.shuffleQuestions, so: TESTS.shuffleOptions, show: TESTS.showResult, neg: TESTS.negative });
    return { classes: [...classes.values()].filter((c) => c.subjects.length), defaults: { durationMin: d.duration, shuffleQuestions: d.sq, shuffleOptions: d.so, showResult: d.show, negativeMarks: d.neg } };
};

export const testSchema = z
    .strictObject({
        sectionIds: z.array(z.uuid()).min(1, 'choose a section').max(30),
        subjectId: z.uuid('choose the subject'),
        chapterIds: z.array(z.uuid()).max(60).default([]),
        title: z.string().trim().min(1, 'is required').max(200),
        instructions: z.string().trim().max(5000).default(''),
        durationMin: z.number().int().min(1).max(600),
        startsAt: z.coerce.date(),
        endsAt: z.coerce.date(),
        shuffleQuestions: z.boolean(),
        shuffleOptions: z.boolean(),
        showResult: z.enum(['instant', 'after_review']),
        negativeMarks: z.number().min(0).max(10),
    })
    .refine((x) => x.endsAt > x.startsAt, { path: ['endsAt'], message: 'must be after the start' });
export type TestInput = z.infer<typeof testSchema>;

const checkSections = async (input: TestInput, p: Powers) => {
    const year = await currentYear();
    if (!year) throw badRequest('No current academic year is set');
    const secs = await db.section.findMany({ where: { id: { in: input.sectionIds }, academicYearId: year.id }, select: { id: true, classId: true } });
    if (secs.length !== input.sectionIds.length) throw badRequest('Choose sections of this session');
    const classIds = [...new Set(secs.map((s) => s.classId))];
    if (classIds.length > 1) throw badRequest('Choose sections of one class', [{ field: 'sectionIds', message: 'are of different classes' }]);
    if (!(await db.classSubject.count({ where: { academicYearId: year.id, classId: classIds[0], subjectId: input.subjectId } }))) throw badRequest('This subject isn’t taught in that class', [{ field: 'subjectId', message: 'is not a subject of the class' }]);
    if (p.create !== 'all') {
        const tt = await taught(p.staffId, year.id);
        if (input.sectionIds.some((s) => !teaches(tt, s, input.subjectId))) throw forbidden('You don’t teach this subject in one of these sections (Subject Teachers)');
    }
    if (input.chapterIds.length && (await db.chapter.count({ where: { id: { in: input.chapterIds }, classId: classIds[0], subjectId: input.subjectId } })) !== input.chapterIds.length) throw badRequest('Choose chapters of this subject', [{ field: 'chapterIds', message: 'are not chapters of the subject' }]);
    return { yearId: year.id, classId: classIds[0] };
};

export const createTest = async (input: TestInput, userId: string) => {
    const p = await powers(userId);
    if (!p.create) throw forbidden();
    const { yearId, classId } = await checkSections(input, p);
    const t = await db.onlineTest.create({ data: { tenantId: getTenantId()!, academicYearId: yearId, classId, ...input, staffId: p.staffId, createdBy: userId } });
    await recordAudit({ action: 'test_created', entity: 'online_test', entityId: t.id, changes: { title: t.title } });
    return getTest(t.id, userId);
};

const hasAttempts = async (testId: string) => (await db.testAttempt.count({ where: { testId } })) > 0;

export const updateTest = async (id: string, input: TestInput, userId: string) => {
    const { t, p } = await load(id, userId, 'edit');
    const started = await hasAttempts(id);
    if (started && (input.subjectId !== t.subjectId || t.sectionIds.some((x) => !input.sectionIds.includes(x)))) throw conflict('Students have started it: sections can only be added, and the subject can’t change');
    if (!started && input.subjectId !== t.subjectId) await db.onlineTestQuestion.deleteMany({ where: { testId: id } });
    await checkSections(input, p);
    await db.onlineTest.update({ where: { id }, data: { ...input, updatedBy: userId } });
    await recordAudit({ action: 'test_changed', entity: 'online_test', entityId: id, changes: { title: input.title } });
    return getTest(id, userId);
};

export const deleteTest = async (id: string, userId: string) => {
    const { t } = await load(id, userId, 'edit');
    if (await hasAttempts(id)) throw conflict('Students have taken it; it can’t be deleted');
    await db.onlineTest.delete({ where: { id } });
    await recordAudit({ action: 'test_deleted', entity: 'online_test', entityId: id, changes: { title: t.title } });
    return { id, deleted: true };
};

const snapshotOf = (q: Prisma.QuestionGetPayload<object>): Snap => ({ type: q.type, text: q.text, options: q.options as Snap['options'], answer: q.answer, explanation: q.explanation, imageFileId: q.imageFileId, chapterId: q.chapterId });

const recount = async (testId: string) => {
    const sum = await db.onlineTestQuestion.aggregate({ where: { testId }, _sum: { marks: true } });
    await db.onlineTest.update({ where: { id: testId }, data: { totalMarks: sum._sum.marks ?? 0 } });
};

const lockedQuestions = async (testId: string) => {
    if (await hasAttempts(testId)) throw conflict('Students have started it; its questions can’t change');
};

/** Approved questions of the bank for the test's class + subject (and chapters), to pick from. */
export const bankFor = async (id: string, q: { chapter?: string; type?: string; difficulty?: string; search?: string }, userId: string) => {
    const { t } = await load(id, userId, 'edit');
    const inTest = new Set((await db.onlineTestQuestion.findMany({ where: { testId: id }, select: { questionId: true } })).map((x) => x.questionId));
    const rows = await db.question.findMany({
        where: {
            classId: t.classId,
            subjectId: t.subjectId,
            status: 'approved',
            ...(q.chapter ? { chapterId: q.chapter } : t.chapterIds.length ? { chapterId: { in: t.chapterIds } } : {}),
            ...(q.type ? { type: q.type } : {}),
            ...(q.difficulty ? { difficultyId: q.difficulty } : {}),
            ...(q.search ? { text: { contains: q.search, mode: 'insensitive' } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 300,
    });
    const chapters = new Map((await db.chapter.findMany({ where: { classId: t.classId, subjectId: t.subjectId }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    const diffs = new Map((await db.masterValue.findMany({ where: { master: 'question_difficulty' }, select: { id: true, name: true } })).map((d) => [d.id, d.name]));
    return rows.map((r) => ({ id: r.id, type: r.type, text: r.text, marks: r.marks, chapter: r.chapterId ? (chapters.get(r.chapterId) ?? null) : null, difficulty: r.difficultyId ? (diffs.get(r.difficultyId) ?? null) : null, inTest: inTest.has(r.id) }));
};

export const addQuestions = async (id: string, questionIds: string[], userId: string) => {
    const { t } = await load(id, userId, 'edit');
    await lockedQuestions(id);
    const have = new Set((await db.onlineTestQuestion.findMany({ where: { testId: id }, select: { questionId: true } })).map((x) => x.questionId));
    const rows = await db.question.findMany({ where: { id: { in: questionIds.filter((q) => !have.has(q)) }, classId: t.classId, subjectId: t.subjectId, status: 'approved' } });
    let order = ((await db.onlineTestQuestion.aggregate({ where: { testId: id }, _max: { sortOrder: true } }))._max.sortOrder ?? 0) + 1;
    const tenantId = getTenantId()!;
    for (const q of rows) await db.onlineTestQuestion.create({ data: { tenantId, testId: id, questionId: q.id, sortOrder: order++, marks: q.marks, snapshot: snapshotOf(q) as Prisma.InputJsonValue } });
    await recount(id);
    return getTest(id, userId);
};

export const autoSchema = z.strictObject({ rules: z.array(z.strictObject({ count: z.number().int().min(1).max(100), type: z.string().max(20).nullable().optional(), difficultyId: z.uuid().nullable().optional(), chapterId: z.uuid().nullable().optional() })).min(1).max(20) });

/** Draws questions by rules ("5 easy MCQ, 3 hard short") at random from the approved bank. */
export const autoPick = async (id: string, input: z.infer<typeof autoSchema>, userId: string) => {
    const { t } = await load(id, userId, 'edit');
    await lockedQuestions(id);
    const have = new Set((await db.onlineTestQuestion.findMany({ where: { testId: id }, select: { questionId: true } })).map((x) => x.questionId!));
    const picked: string[] = [];
    const short: string[] = [];
    for (const r of input.rules) {
        const pool = await db.question.findMany({
            where: { classId: t.classId, subjectId: t.subjectId, status: 'approved', id: { notIn: [...have, ...picked] }, ...(r.type ? { type: r.type } : {}), ...(r.difficultyId ? { difficultyId: r.difficultyId } : {}), ...(r.chapterId ? { chapterId: r.chapterId } : t.chapterIds.length ? { chapterId: { in: t.chapterIds } } : {}) },
            select: { id: true },
        });
        const shuffled = pool.map((q) => [Math.random(), q.id] as const).sort((a, b) => a[0] - b[0]).map(([, q]) => q);
        picked.push(...shuffled.slice(0, r.count));
        if (shuffled.length < r.count) short.push(`${r.count - shuffled.length} short for a rule`);
    }
    await addQuestions(id, picked, userId);
    return { added: picked.length, short, test: await getTest(id, userId) };
};

export const removeQuestion = async (id: string, tqId: string, userId: string) => {
    await load(id, userId, 'edit');
    await lockedQuestions(id);
    await db.onlineTestQuestion.deleteMany({ where: { id: tqId, testId: id } });
    await recount(id);
    return getTest(id, userId);
};

export const editQuestionSchema = z.strictObject({ marks: z.number().min(0.5).max(100).optional(), move: z.enum(['up', 'down']).optional() });
export const editTestQuestion = async (id: string, tqId: string, input: z.infer<typeof editQuestionSchema>, userId: string) => {
    await load(id, userId, 'edit');
    await lockedQuestions(id);
    if (input.marks !== undefined) await db.onlineTestQuestion.updateMany({ where: { id: tqId, testId: id }, data: { marks: input.marks } });
    if (input.move) {
        const list = await db.onlineTestQuestion.findMany({ where: { testId: id }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
        const i = list.findIndex((x) => x.id === tqId);
        const j = input.move === 'up' ? i - 1 : i + 1;
        if (i >= 0 && j >= 0 && j < list.length) {
            [list[i], list[j]] = [list[j], list[i]];
            for (let k = 0; k < list.length; k++) await db.onlineTestQuestion.update({ where: { id: list[k].id }, data: { sortOrder: k + 1 } });
        }
    }
    await recount(id);
    return getTest(id, userId);
};

export const publishTest = async (id: string, publish: boolean, userId: string) => {
    const { t } = await load(id, userId, 'edit');
    if (publish) {
        if (!(await db.onlineTestQuestion.count({ where: { testId: id } }))) throw badRequest('Add questions first');
        if (t.endsAt <= new Date()) throw badRequest('Its window has already ended; change the dates');
        await db.onlineTest.update({ where: { id }, data: { status: 'published' } });
        alertTestPublished(id);
    } else {
        if (await hasAttempts(id)) throw conflict('Students have started it; it can’t be taken back');
        await db.onlineTest.update({ where: { id }, data: { status: 'draft' } });
    }
    await recordAudit({ action: publish ? 'test_published' : 'test_unpublished', entity: 'online_test', entityId: id, changes: { title: t.title } });
    return getTest(id, userId);
};

// ─── Lists ───────────────────────────────────────────────────────────────────

const stateOf = (t: Pick<T, 'status' | 'startsAt' | 'endsAt'>) => {
    if (t.status === 'draft') return 'draft';
    if (t.status === 'results') return 'results';
    const now = new Date();
    return now < t.startsAt ? 'upcoming' : now <= t.endsAt ? 'open' : 'closed';
};

const namesOf = async (rows: Pick<T, 'classId' | 'subjectId' | 'sectionIds' | 'staffId'>[]) => {
    const [classes, subjects, sections, staff] = await Promise.all([
        db.schoolClass.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.classId))] } }, select: { id: true, name: true } }),
        db.subject.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.subjectId))] } }, select: { id: true, name: true } }),
        db.section.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => r.sectionIds))] } }, select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } } } }),
        db.staff.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.staffId!).filter(Boolean))] } }, select: { id: true, firstName: true, lastName: true } }),
    ]);
    return {
        class: new Map(classes.map((c) => [c.id, c.name])),
        subject: new Map(subjects.map((s) => [s.id, s.name])),
        section: new Map(sections.map((s) => [s.id, sectionLabel(s)])),
        staff: new Map(staff.map((s) => [s.id, [s.firstName, s.lastName].filter(Boolean).join(' ')])),
    };
};

export const listQuery = z.object({ mine: z.enum(['1', '0']).optional(), state: z.enum(['draft', 'upcoming', 'open', 'closed', 'results']).optional(), page: z.coerce.number().int().min(1).default(1) });

export const listTests = async (q: z.infer<typeof listQuery>, userId: string) => {
    const p = await powers(userId);
    const year = await currentYear();
    if (!year) return { rows: [], total: 0, page: 1, pages: 1, canCreate: !!p.create };
    const tt = await taught(p.staffId, year.id);
    const seeAll = p.view === 'all' || p.create === 'all';
    const where: Prisma.OnlineTestWhereInput = {
        academicYearId: year.id,
        ...(q.mine === '1' ? { staffId: p.staffId ?? '00000000-0000-0000-0000-000000000000' } : seeAll ? {} : { OR: [...(p.staffId ? [{ staffId: p.staffId }] : []), { sectionIds: { hasSome: [...tt.keys()] } }] }),
    };
    const all = await db.onlineTest.findMany({ where, orderBy: { startsAt: 'desc' } });
    const filtered = q.state ? all.filter((t) => stateOf(t) === q.state) : all;
    const take = 25;
    const rows = filtered.slice((q.page - 1) * take, q.page * take);
    const n = await namesOf(rows);
    const counts = rows.length ? await db.testAttempt.groupBy({ by: ['testId', 'status'], where: { testId: { in: rows.map((r) => r.id) } }, _count: { _all: true } }) : [];
    const qcount = rows.length ? await db.onlineTestQuestion.groupBy({ by: ['testId'], where: { testId: { in: rows.map((r) => r.id) } }, _count: { _all: true } }) : [];
    return {
        rows: rows.map((t) => ({
            id: t.id,
            title: t.title,
            className: n.class.get(t.classId) ?? '',
            subject: n.subject.get(t.subjectId) ?? '',
            sections: t.sectionIds.map((s) => n.section.get(s) ?? '').filter(Boolean),
            by: t.staffId ? (n.staff.get(t.staffId) ?? null) : null,
            mine: !!p.staffId && t.staffId === p.staffId,
            startsAt: t.startsAt,
            endsAt: t.endsAt,
            durationMin: t.durationMin,
            totalMarks: t.totalMarks,
            questions: qcount.find((x) => x.testId === t.id)?._count._all ?? 0,
            state: stateOf(t),
            taken: counts.filter((c) => c.testId === t.id && c.status !== 'in_progress').reduce((a, c) => a + c._count._all, 0),
            toMark: counts.find((c) => c.testId === t.id && c.status === 'submitted')?._count._all ?? 0,
        })),
        total: filtered.length,
        page: q.page,
        pages: Math.max(1, Math.ceil(filtered.length / take)),
        canCreate: !!p.create,
    };
};

export const getTest = async (id: string, userId: string) => {
    const { t, a } = await load(id, userId, 'view');
    const n = await namesOf([t]);
    const qs = await db.onlineTestQuestion.findMany({ where: { testId: id }, orderBy: { sortOrder: 'asc' } });
    const chapters = new Map((await db.chapter.findMany({ where: { classId: t.classId, subjectId: t.subjectId }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    return {
        ...t,
        className: n.class.get(t.classId) ?? '',
        subject: n.subject.get(t.subjectId) ?? '',
        sections: t.sectionIds.map((s) => ({ id: s, label: n.section.get(s) ?? '' })),
        chapters: t.chapterIds.map((c) => ({ id: c, name: chapters.get(c) ?? '' })),
        by: t.staffId ? (n.staff.get(t.staffId) ?? null) : null,
        state: stateOf(t),
        locked: await hasAttempts(id),
        canEdit: a.edit,
        canMark: a.mark,
        questions: qs.map((x) => ({ id: x.id, questionId: x.questionId, marks: x.marks, ...(x.snapshot as Snap), chapter: (x.snapshot as Snap).chapterId ? (chapters.get((x.snapshot as Snap).chapterId!) ?? null) : null })),
    };
};

// ─── Marking ─────────────────────────────────────────────────────────────────

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Marks of one objective answer (null = written, for the teacher). */
const autoMark = (q: { marks: number; snapshot: unknown }, answer: unknown, neg: number, partial: boolean): number | null => {
    const s = q.snapshot as Snap;
    if (!OBJECTIVE.includes(s.type)) return null;
    const blank = answer === undefined || answer === null || answer === '' || (Array.isArray(answer) && !answer.length);
    if (blank) return 0;
    if (s.type === 'mcq') return s.options[Number(answer)]?.correct ? q.marks : -neg;
    if (s.type === 'true_false') return norm(answer) === norm(s.answer) ? q.marks : -neg;
    if (s.type === 'fill') return (s.answer ?? '').split('|').map(norm).filter(Boolean).includes(norm(answer)) ? q.marks : -neg;
    const picked = new Set((Array.isArray(answer) ? answer : []).map(Number));
    const right = s.options.map((o, i) => (o.correct ? i : -1)).filter((i) => i >= 0);
    const good = right.filter((i) => picked.has(i)).length;
    const bad = [...picked].filter((i) => !right.includes(i)).length;
    if (good === right.length && !bad) return q.marks;
    if (partial) return Math.max(0, Math.round(((good - bad) / right.length) * q.marks * 2) / 2);
    return -neg;
};

const scoreOf = (marks: Record<string, Mark>) => Math.round(Object.values(marks).reduce((a, m) => a + (m.marks ?? 0), 0) * 100) / 100;
const pendingIn = (marks: Record<string, Mark>) => Object.values(marks).some((m) => m.marks === null);

/** Submits an attempt: objective answers marked; written ones wait for the teacher. */
export const submitAttempt = async (attemptId: string) => {
    const at = await db.testAttempt.findFirst({ where: { id: attemptId }, include: { test: true } });
    if (!at || at.status !== 'in_progress') return at;
    const qs = await db.onlineTestQuestion.findMany({ where: { testId: at.testId } });
    const { partial } = await getSettings({ partial: TESTS.multiPartial });
    const answers = (at.answers ?? {}) as Record<string, unknown>;
    const marks: Record<string, Mark> = {};
    for (const q of qs) marks[q.id] = { marks: autoMark(q, answers[q.id], at.test.negativeMarks, partial), by: 'auto' };
    return db.testAttempt.update({ where: { id: attemptId }, data: { status: pendingIn(marks) ? 'submitted' : 'marked', submittedAt: new Date(), marks: marks as Prisma.InputJsonValue, score: scoreOf(marks), markedAt: pendingIn(marks) ? null : new Date() } });
};

/** Attempts whose time ran out are submitted (also checked when anyone opens them). */
export const submitExpired = async () => {
    const due = await db.testAttempt.findMany({ where: { status: 'in_progress', dueAt: { lt: new Date(Date.now() - GRACE_MS) } }, select: { id: true }, take: 200 });
    for (const a of due) await submitAttempt(a.id);
    return due.length;
};

/** Every student of the test's sections with their attempt, for marking. */
export const results = async (id: string, userId: string) => {
    const { t, a } = await load(id, userId, 'view');
    const qs = await db.onlineTestQuestion.findMany({ where: { testId: id }, orderBy: { sortOrder: 'asc' } });
    const attempts = new Map((await db.testAttempt.findMany({ where: { testId: id } })).map((x) => [x.studentId, x]));
    const n = await namesOf([t]);
    const students = [];
    for (const s of t.sectionIds)
        for (const x of await takers(t.academicYearId, s, t.subjectId)) {
            const at = attempts.get(x.student.id);
            students.push({
                id: x.student.id,
                name: fullName(x.student),
                admissionNo: x.student.admissionNo,
                roll: x.rollNumber,
                section: n.section.get(s) ?? '',
                attemptId: at?.id ?? null,
                status: at ? (at.status === 'in_progress' && at.dueAt.getTime() + GRACE_MS < Date.now() ? 'submitted' : at.status) : stateOf(t) === 'upcoming' || stateOf(t) === 'open' ? 'not_started' : 'absent',
                score: at?.score ?? null,
                submittedAt: at?.submittedAt ?? null,
            });
        }
    const written = qs.filter((q) => !OBJECTIVE.includes((q.snapshot as Snap).type)).length;
    return { test: { id: t.id, title: t.title, totalMarks: t.totalMarks, state: stateOf(t), status: t.status, showResult: t.showResult, written }, canMark: a.mark, students };
};

/** One student's attempt in full, for the teacher (answers, the right answers, marks). */
export const attemptForTeacher = async (attemptId: string, userId: string) => {
    const at0 = await db.testAttempt.findFirst({ where: { id: attemptId } });
    if (!at0) throw notFound('Attempt not found');
    const { t, a } = await load(at0.testId, userId, 'view');
    const at = at0.status === 'in_progress' && at0.dueAt.getTime() + GRACE_MS < Date.now() ? (await submitAttempt(at0.id))! : at0;
    const qs = await db.onlineTestQuestion.findMany({ where: { testId: t.id }, orderBy: { sortOrder: 'asc' } });
    const st = await db.student.findFirst({ where: { id: at.studentId }, select: { firstName: true, middleName: true, lastName: true, admissionNo: true } });
    const answers = (at.answers ?? {}) as Record<string, unknown>;
    const marks = (at.marks ?? {}) as Record<string, Mark>;
    const { ai } = await getSettings({ ai: TESTS.aiMarking });
    return {
        id: at.id,
        student: st ? `${fullName(st)} (${st.admissionNo})` : '',
        status: at.status,
        score: at.score,
        totalMarks: t.totalMarks,
        startedAt: at.startedAt,
        submittedAt: at.submittedAt,
        canMark: a.mark,
        aiMarking: ai,
        questions: qs.map((q) => ({ id: q.id, marks: q.marks, ...(q.snapshot as Snap), given: answers[q.id] ?? null, got: marks[q.id]?.marks ?? null, by: marks[q.id]?.by ?? null, note: marks[q.id]?.note ?? null })),
    };
};

export const markSchema = z.strictObject({ marks: z.record(z.string(), z.strictObject({ marks: z.number().min(-100).max(100).nullable(), note: z.string().trim().max(500).nullable().optional() })) });

export const markAttempt = async (attemptId: string, input: z.infer<typeof markSchema>, userId: string) => {
    const at = await db.testAttempt.findFirst({ where: { id: attemptId } });
    if (!at) throw notFound('Attempt not found');
    await load(at.testId, userId, 'mark');
    if (at.status === 'in_progress') throw badRequest('The student hasn’t submitted yet');
    const qs = new Map((await db.onlineTestQuestion.findMany({ where: { testId: at.testId } })).map((q) => [q.id, q]));
    const marks = { ...((at.marks ?? {}) as Record<string, Mark>) };
    for (const [tqId, m] of Object.entries(input.marks)) {
        const q = qs.get(tqId);
        if (!q) throw badRequest('A question is not of this test');
        if (m.marks !== null && m.marks > q.marks) throw badRequest(`At most ${q.marks} marks for that question`);
        marks[tqId] = { marks: m.marks, by: 'teacher', note: m.note ?? null };
    }
    const done = !pendingIn(marks);
    await db.testAttempt.update({ where: { id: attemptId }, data: { marks: marks as Prisma.InputJsonValue, score: scoreOf(marks), status: done ? 'marked' : 'submitted', markedBy: userId, markedAt: done ? new Date() : null } });
    await recordAudit({ action: 'test_marked', entity: 'test_attempt', entityId: attemptId, changes: { score: scoreOf(marks) } });
    return attemptForTeacher(attemptId, userId);
};

/** The AI's suggestion for a written answer (the teacher decides). */
export const suggestMarks = async (attemptId: string, tqId: string, userId: string) => {
    const at = await db.testAttempt.findFirst({ where: { id: attemptId } });
    if (!at) throw notFound('Attempt not found');
    const { t } = await load(at.testId, userId, 'mark');
    const { ai } = await getSettings({ ai: TESTS.aiMarking });
    if (!ai) throw badRequest('AI marking help is switched off (System Settings → Online Tests)');
    const q = await db.onlineTestQuestion.findFirst({ where: { id: tqId, testId: t.id } });
    if (!q) throw notFound('Question not found');
    const s = q.snapshot as Snap;
    const given = String(((at.answers ?? {}) as Record<string, unknown>)[tqId] ?? '').trim();
    if (!given) return { marks: 0, reason: 'No answer was written.' };
    const subject = await db.subject.findFirst({ where: { id: t.subjectId }, select: { name: true } });
    const r = await askAiJson(
        'marking',
        userId,
        {
            system: 'You are a fair, careful school teacher marking a student’s written answer. Judge the meaning, not the wording or spelling. Answer only with JSON.',
            messages: [{ role: 'user', text: `Subject: ${subject?.name ?? ''}\nQuestion (${q.marks} marks): ${s.text}\nModel answer / points: ${s.answer ?? '(none given: use your knowledge)'}\nStudent's answer: ${given.slice(0, 4000)}\n\nJSON: {"marks": number from 0 to ${q.marks} in steps of 0.5, "reason": "one or two sentences for the teacher"}` }],
            temperature: 0.2,
            maxTokens: 400,
        },
        z.object({ marks: z.number(), reason: z.string().max(1000) })
    );
    return { marks: Math.max(0, Math.min(q.marks, Math.round(r.marks * 2) / 2)), reason: r.reason };
};

export const publishResults = async (id: string, publish: boolean, userId: string) => {
    const { t } = await load(id, userId, 'mark');
    if (publish) {
        const pending = await db.testAttempt.count({ where: { testId: id, status: { in: ['submitted', 'in_progress'] } } });
        if (pending && stateOf(t) !== 'closed') throw badRequest('Wait until the test closes, or mark every answer first');
        await submitExpired();
        await db.onlineTest.update({ where: { id }, data: { status: 'results', resultsAt: new Date() } });
        alertResults(id);
    } else await db.onlineTest.update({ where: { id }, data: { status: 'published', resultsAt: null } });
    await recordAudit({ action: publish ? 'test_results_published' : 'test_results_hidden', entity: 'online_test', entityId: id, changes: { title: t.title } });
    return results(id, userId);
};

/** How the class did: per question, per chapter, and the spread of scores. */
export const analysis = async (id: string, userId: string) => {
    const { t } = await load(id, userId, 'view');
    const qs = await db.onlineTestQuestion.findMany({ where: { testId: id }, orderBy: { sortOrder: 'asc' } });
    const done = await db.testAttempt.findMany({ where: { testId: id, status: { in: ['submitted', 'marked'] } } });
    const chapters = new Map((await db.chapter.findMany({ where: { classId: t.classId, subjectId: t.subjectId }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    const perQuestion = qs.map((q, i) => {
        const s = q.snapshot as Snap;
        const got = done.map((a) => ((a.marks ?? {}) as Record<string, Mark>)[q.id]?.marks).filter((m): m is number => m !== null && m !== undefined);
        const full = got.filter((m) => m >= q.marks).length;
        return { n: i + 1, id: q.id, text: s.text, type: s.type, marks: q.marks, chapter: s.chapterId ? (chapters.get(s.chapterId) ?? null) : null, answered: got.length, correct: full, percent: got.length ? Math.round((got.reduce((a, m) => a + Math.max(0, m), 0) / (got.length * q.marks)) * 1000) / 10 : null };
    });
    const byChapter = new Map<string, { chapter: string; got: number; max: number }>();
    for (const q of perQuestion) {
        const k = q.chapter ?? 'No chapter';
        const g = byChapter.get(k) ?? { chapter: k, got: 0, max: 0 };
        const tq = qs.find((x) => x.id === q.id)!;
        for (const a of done) {
            const m = ((a.marks ?? {}) as Record<string, Mark>)[q.id]?.marks;
            if (m === null || m === undefined) continue;
            g.got += Math.max(0, m);
            g.max += tq.marks;
        }
        byChapter.set(k, g);
    }
    const scores = done.map((a) => a.score ?? 0);
    const pct = (x: number) => (t.totalMarks ? Math.round((x / t.totalMarks) * 1000) / 10 : 0);
    const bands = [0, 33, 50, 75, 90].map((from, i, all) => ({ label: `${from}–${all[i + 1] ?? 100}%`, count: scores.filter((s) => pct(s) >= from && pct(s) < (all[i + 1] ?? 100.01)).length }));
    return {
        taken: done.length,
        average: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
        highest: scores.length ? Math.max(...scores) : null,
        lowest: scores.length ? Math.min(...scores) : null,
        totalMarks: t.totalMarks,
        bands,
        questions: perQuestion,
        chapters: [...byChapter.values()].map((c) => ({ chapter: c.chapter, percent: c.max ? Math.round((c.got / c.max) * 1000) / 10 : null })).sort((a, b) => (a.percent ?? 0) - (b.percent ?? 0)),
    };
};

// ─── Into an exam ────────────────────────────────────────────────────────────

/** Exams open for marks that have this test's class and subject, with their parts. */
export const examTargets = async (id: string, userId: string) => {
    const { t } = await load(id, userId, 'mark');
    const subs = await db.examSubject.findMany({ where: { classId: t.classId, subjectId: t.subjectId, exam: { academicYearId: t.academicYearId, status: 'open' } }, select: { id: true, components: true, exam: { select: { id: true, name: true } } } });
    return subs.map((s) => ({ examSubjectId: s.id, exam: s.exam.name, parts: s.components as { key: string; label: string; max: number }[] }));
};

export const toExamSchema = z.strictObject({ examSubjectId: z.uuid(), part: z.string().trim().min(1).max(40) });

/** Puts each student's test score into a part of an exam (scaled to its maximum). */
export const pushToExam = async (id: string, input: z.infer<typeof toExamSchema>, userId: string) => {
    const { t } = await load(id, userId, 'mark');
    const a = await getUserAccess(userId);
    if (!a.permissions['exam.marks'] && !a.permissions['exam.marks_any']) throw forbidden('Putting marks into an exam needs “Enter marks” (Roles & Permissions)');
    const es = await db.examSubject.findFirst({ where: { id: input.examSubjectId, classId: t.classId, subjectId: t.subjectId }, include: { exam: true } });
    if (!es || es.exam.status !== 'open') throw badRequest('Choose an exam that is open for marks');
    const part = (es.components as { key: string; label: string; max: number }[]).find((p) => p.key === input.part);
    if (!part) throw badRequest('Choose a part of the exam');
    if (!a.permissions['exam.marks_any']) {
        const tt = await taught((await db.staff.findFirst({ where: { userId }, select: { id: true } }))?.id ?? null, t.academicYearId);
        if (t.sectionIds.some((s) => !teaches(tt, s, t.subjectId))) throw forbidden('You can put marks only for the sections you teach');
    }
    if (await db.testAttempt.count({ where: { testId: id, status: { in: ['in_progress', 'submitted'] } } })) throw badRequest('Mark every answer first');
    const attempts = await db.testAttempt.findMany({ where: { testId: id, status: 'marked' } });
    const tenantId = getTenantId()!;
    let n = 0;
    for (const at of attempts) {
        const value = t.totalMarks ? Math.round((Math.max(0, at.score ?? 0) / t.totalMarks) * part.max * 2) / 2 : 0;
        const cur = await db.examMark.findFirst({ where: { examSubjectId: es.id, studentId: at.studentId } });
        const marks = { ...((cur?.marks ?? {}) as Record<string, number>), [part.key]: value };
        const total = Object.values(marks).reduce((x, v) => x + (typeof v === 'number' ? v : 0), 0);
        if (cur) await db.examMark.update({ where: { id: cur.id }, data: { marks, total, status: 'P', enteredBy: userId } });
        else await db.examMark.create({ data: { tenantId, examSubjectId: es.id, studentId: at.studentId, marks, total, status: 'P', enteredBy: userId } });
        n++;
    }
    await recordAudit({ action: 'test_to_exam', entity: 'online_test', entityId: id, changes: { exam: es.exam.name, part: part.label, students: n } });
    return { students: n, exam: es.exam.name, part: part.label };
};

// ─── Students ────────────────────────────────────────────────────────────────

/** The student(s) a person sees tests of: themselves, or their children. */
const myStudents = async (userId: string) => {
    const year = await currentYear();
    if (!year) return [];
    const rows = await db.student.findMany({ where: { status: 'active', OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, select: { id: true, userId: true, firstName: true, middleName: true, lastName: true, enrolments: { where: { academicYearId: year.id }, select: { sectionId: true, optionalSubjectIds: true, section: { select: { classId: true, streamId: true, name: true, schoolClass: { select: { name: true, shortName: true } } } } } } } });
    return rows.filter((s) => s.enrolments.length).map((s) => ({ id: s.id, self: s.userId === userId, name: fullName(s), yearId: year.id, ...s.enrolments[0] }));
};

const testsFor = async (st: Awaited<ReturnType<typeof myStudents>>[number]) => {
    const rows = await db.onlineTest.findMany({ where: { academicYearId: st.yearId, status: { in: ['published', 'results'] }, sectionIds: { has: st.sectionId } }, orderBy: { startsAt: 'desc' } });
    const optional = new Set((await db.classSubject.findMany({ where: { academicYearId: st.yearId, classId: st.section.classId, isOptional: true }, select: { subjectId: true } })).map((c) => c.subjectId));
    return rows.filter((t) => !optional.has(t.subjectId) || st.optionalSubjectIds.includes(t.subjectId));
};

const resultVisible = (t: T, at: { status: string } | null) => t.status === 'results' || (t.showResult === 'instant' && at?.status === 'marked');

export const myTests = async (userId: string) => {
    const students = await myStudents(userId);
    const { join } = await getSettings({ join: TESTS.joinMinutes });
    const out = [];
    for (const st of students) {
        const list = await testsFor(st);
        const n = await namesOf(list);
        const attempts = new Map((await db.testAttempt.findMany({ where: { studentId: st.id, testId: { in: list.map((t) => t.id) } } })).map((a) => [a.testId, a]));
        const qcount = list.length ? await db.onlineTestQuestion.groupBy({ by: ['testId'], where: { testId: { in: list.map((t) => t.id) } }, _count: { _all: true } }) : [];
        out.push({
            student: { id: st.id, name: st.name, section: sectionLabel(st.section), self: st.self },
            tests: list.map((t) => {
                const at = attempts.get(t.id) ?? null;
                const now = Date.now();
                const lateBy = join > 0 && now > t.startsAt.getTime() + join * 60_000;
                return {
                    id: t.id,
                    title: t.title,
                    subject: n.subject.get(t.subjectId) ?? '',
                    instructions: t.instructions,
                    startsAt: t.startsAt,
                    endsAt: t.endsAt,
                    durationMin: t.durationMin,
                    totalMarks: t.totalMarks,
                    questions: qcount.find((x) => x.testId === t.id)?._count._all ?? 0,
                    state: stateOf(t),
                    attempt: at ? { status: at.status === 'in_progress' && at.dueAt.getTime() + GRACE_MS < now ? 'submitted' : at.status, dueAt: at.dueAt, submittedAt: at.submittedAt } : null,
                    canStart: st.self && !at && stateOf(t) === 'open' && !lateBy,
                    canContinue: st.self && !!at && at.status === 'in_progress' && at.dueAt.getTime() > now,
                    result: resultVisible(t, at) && at && at.status !== 'in_progress' ? { score: at.score, totalMarks: t.totalMarks } : null,
                };
            }),
        });
    }
    return out;
};

const shuffle = <X>(xs: X[]) => xs.map((x) => [Math.random(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);

/** The attempt as the student sees it while taking the test: no correct answers. */
const takingView = async (at: Prisma.TestAttemptGetPayload<object>, t: T) => {
    const qs = new Map((await db.onlineTestQuestion.findMany({ where: { testId: t.id } })).map((q) => [q.id, q]));
    const layout = (at.layout ?? {}) as { questions?: string[]; options?: Record<string, number[]> };
    const order = (layout.questions ?? [...qs.keys()]).filter((id) => qs.has(id));
    return {
        attemptId: at.id,
        test: { id: t.id, title: t.title, instructions: t.instructions, totalMarks: t.totalMarks, negativeMarks: t.negativeMarks },
        dueAt: at.dueAt,
        now: new Date(),
        answers: at.answers,
        questions: order.map((id, i) => {
            const q = qs.get(id)!;
            const s = q.snapshot as Snap;
            const idx = layout.options?.[id] ?? s.options.map((_, k) => k);
            return { id, n: i + 1, type: s.type, text: s.text, marks: q.marks, hasImage: !!s.imageFileId, options: s.type === 'mcq' || s.type === 'multi' ? idx.map((k) => ({ index: k, text: s.options[k]?.text ?? '' })) : [] };
        }),
    };
};

const ownAttempt = async (testId: string, userId: string) => {
    const st = (await myStudents(userId)).find((s) => s.self);
    if (!st) throw forbidden('Only the student can take the test');
    const t = (await testsFor(st)).find((x) => x.id === testId);
    if (!t) throw notFound('Test not found');
    return { st, t };
};

export const startTest = async (testId: string, userId: string) => {
    const { st, t } = await ownAttempt(testId, userId);
    const existing = await db.testAttempt.findFirst({ where: { testId, studentId: st.id } });
    if (existing) {
        if (existing.status !== 'in_progress' || existing.dueAt.getTime() + GRACE_MS < Date.now()) {
            await submitAttempt(existing.id);
            throw badRequest('You have already taken this test');
        }
        return takingView(existing, t);
    }
    const now = new Date();
    if (stateOf(t) !== 'open') throw badRequest(now < t.startsAt ? 'The test hasn’t opened yet' : 'The test has closed');
    const { join } = await getSettings({ join: TESTS.joinMinutes });
    if (join > 0 && now.getTime() > t.startsAt.getTime() + join * 60_000) throw badRequest(`The test could be started only in its first ${join} minutes`);
    const qs = await db.onlineTestQuestion.findMany({ where: { testId }, orderBy: { sortOrder: 'asc' } });
    const ids = qs.map((q) => q.id);
    const layout = { questions: t.shuffleQuestions ? shuffle(ids) : ids, options: Object.fromEntries(qs.filter((q) => ['mcq', 'multi'].includes((q.snapshot as Snap).type)).map((q) => { const k = (q.snapshot as Snap).options.map((_, i) => i); return [q.id, t.shuffleOptions ? shuffle(k) : k]; })) };
    const dueAt = new Date(Math.min(now.getTime() + t.durationMin * 60_000, t.endsAt.getTime()));
    try {
        const at = await db.testAttempt.create({ data: { tenantId: getTenantId()!, testId, studentId: st.id, startedAt: now, dueAt, layout: layout as Prisma.InputJsonValue } });
        await recordAudit({ action: 'test_started', entity: 'online_test', entityId: testId, changes: { student: st.name } });
        return takingView(at, t);
    } catch {
        // Started twice at once (two tabs): the first one wins.
        const at = await db.testAttempt.findFirstOrThrow({ where: { testId, studentId: st.id } });
        return takingView(at, t);
    }
};

export const answersSchema = z.strictObject({ answers: z.record(z.string(), z.union([z.string().max(10_000), z.number(), z.array(z.number()).max(10), z.null()])) });

/** Autosave: the answers so far (only while time is left). */
export const saveAnswers = async (testId: string, input: z.infer<typeof answersSchema>, userId: string) => {
    const { st } = await ownAttempt(testId, userId);
    const at = await db.testAttempt.findFirst({ where: { testId, studentId: st.id } });
    if (!at || at.status !== 'in_progress') throw badRequest('This test has been submitted');
    if (at.dueAt.getTime() + GRACE_MS < Date.now()) {
        await submitAttempt(at.id);
        throw badRequest('Time is up: the test has been submitted');
    }
    const valid = new Set((await db.onlineTestQuestion.findMany({ where: { testId }, select: { id: true } })).map((q) => q.id));
    const answers = { ...((at.answers ?? {}) as Record<string, unknown>) };
    for (const [k, v] of Object.entries(input.answers)) if (valid.has(k)) answers[k] = v;
    await db.testAttempt.update({ where: { id: at.id }, data: { answers: answers as Prisma.InputJsonValue } });
    return { saved: true, at: new Date() };
};

export const submitTest = async (testId: string, input: z.infer<typeof answersSchema>, userId: string) => {
    const { st } = await ownAttempt(testId, userId);
    const at = await db.testAttempt.findFirst({ where: { testId, studentId: st.id } });
    if (!at) throw badRequest('Start the test first');
    if (at.status === 'in_progress' && at.dueAt.getTime() + GRACE_MS >= Date.now()) await saveAnswers(testId, input, userId);
    await submitAttempt(at.id);
    await recordAudit({ action: 'test_submitted', entity: 'online_test', entityId: testId, changes: { student: st.name } });
    return myResult(testId, userId, st.id);
};

/** A student's (or child's) result: their answers against the right ones, once results are out. */
export const myResult = async (testId: string, userId: string, studentId?: string) => {
    const students = await myStudents(userId);
    const st = studentId ? students.find((s) => s.id === studentId) : students[0];
    if (!st) throw forbidden();
    const t = (await testsFor(st)).find((x) => x.id === testId);
    if (!t) throw notFound('Test not found');
    let at = await db.testAttempt.findFirst({ where: { testId, studentId: st.id } });
    if (at && at.status === 'in_progress' && at.dueAt.getTime() + GRACE_MS < Date.now()) at = await submitAttempt(at.id);
    const visible = resultVisible(t, at);
    const base = { test: { id: t.id, title: t.title, totalMarks: t.totalMarks }, student: st.name, status: at?.status ?? 'not_taken', submittedAt: at?.submittedAt ?? null };
    if (!at || !visible) return { ...base, visible: false, score: null, questions: [] };
    const qs = new Map((await db.onlineTestQuestion.findMany({ where: { testId } })).map((q) => [q.id, q]));
    const layout = (at.layout ?? {}) as { questions?: string[] };
    const answers = (at.answers ?? {}) as Record<string, unknown>;
    const marks = (at.marks ?? {}) as Record<string, Mark>;
    return {
        ...base,
        visible: true,
        score: at.score,
        questions: (layout.questions ?? [...qs.keys()]).filter((id) => qs.has(id)).map((id, i) => {
            const q = qs.get(id)!;
            return { id, n: i + 1, marks: q.marks, ...(q.snapshot as Snap), given: answers[id] ?? null, got: marks[id]?.marks ?? null, note: marks[id]?.note ?? null };
        }),
    };
};

/** A picture of a question (students only see it during or after their test). */
export const imageFor = async (testId: string, tqId: string, userId: string) => {
    const q = await db.onlineTestQuestion.findFirst({ where: { id: tqId, testId } });
    const file = (q?.snapshot as Snap | undefined)?.imageFileId;
    if (!q || !file) throw notFound('No picture');
    const a = await getUserAccess(userId);
    if (a.permissions['test.take']) {
        const mine = (await myStudents(userId)).map((x) => x.id);
        if (!mine.length || !(await db.testAttempt.findFirst({ where: { testId, studentId: { in: mine } } }))) throw forbidden();
    } else await load(testId, userId, 'view');
    return file;
};
