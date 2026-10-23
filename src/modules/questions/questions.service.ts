import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { getUserAccess } from '../rbac/access.service';
import { currentYear } from '../academic/years.service';
import { classesOfYear } from '../academic/year-classes.service';
import { askAiJson } from '../ai/ai.service';
import { AI } from '../ai/ai.settings';
import { QUESTION_TYPES, QUESTIONS, QuestionType, TYPE_LABEL } from './questions.settings';

/**
 * Chapters (the syllabus of a class's subject) and the question bank. Teachers work on the subjects
 * they teach (and every subject of their own class); reviewers approve questions before tests use them.
 * AI can suggest chapters and draft questions; a teacher reads them before they go on.
 */

// ─── Who works on which class and subject ────────────────────────────────────

type Scope = 'all' | Set<string> | null;
const pair = (classId: string, subjectId: string) => `${classId}|${subjectId}`;

/** The class + subject pairs a teacher teaches this session (their own class: every subject). */
const taughtPairs = async (userId: string) => {
    const year = await currentYear();
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    const out = new Set<string>();
    if (!year || !staff) return out;
    const [teach, own] = await Promise.all([
        db.teachingAssignment.findMany({ where: { academicYearId: year.id, staffId: staff.id }, select: { subjectId: true, section: { select: { classId: true } } } }),
        db.section.findMany({ where: { academicYearId: year.id, classTeacherId: staff.id }, select: { classId: true } }),
    ]);
    for (const t of teach) out.add(pair(t.section.classId, t.subjectId));
    if (own.length) for (const c of await db.classSubject.findMany({ where: { academicYearId: year.id, classId: { in: own.map((o) => o.classId) } }, select: { classId: true, subjectId: true } })) out.add(pair(c.classId, c.subjectId));
    return out;
};

/** What a person may do on which pairs: 'all', their own pairs, or nothing. */
const scopeFor = async (userId: string, keys: string[]): Promise<Scope> => {
    const a = await getUserAccess(userId);
    const given = keys.map((k) => a.permissions[k]).filter(Boolean);
    if (!given.length) return null;
    if (given.includes('all')) return 'all';
    return taughtPairs(userId);
};
const inScope = (s: Scope, classId: string, subjectId: string) => s === 'all' || !!s?.has(pair(classId, subjectId));
const viewScope = async (userId: string) => {
    const a = await getUserAccess(userId);
    // Reviewers see everything they may review.
    if (a.permissions['question.approve']) return 'all' as const;
    return scopeFor(userId, ['question.view', 'question.add', 'syllabus.manage']);
};

/** Classes of this session and their subjects that a person may work on (for the pickers). */
export const pickerOptions = async (userId: string, purpose: 'chapters' | 'questions') => {
    const year = await currentYear();
    const scope = purpose === 'chapters' ? await scopeFor(userId, ['syllabus.manage']) : await viewScope(userId);
    const add = await scopeFor(userId, purpose === 'chapters' ? ['syllabus.manage'] : ['question.add']);
    if (!year || !scope) return { classes: [], canEditAll: false };
    const classes = await classesOfYear(year.id);
    const cs = await db.classSubject.findMany({ where: { academicYearId: year.id }, select: { classId: true, subject: { select: { id: true, name: true, isActive: true } } }, orderBy: { sortOrder: 'asc' } });
    return {
        classes: classes
            .map((c) => ({
                id: c.id,
                name: c.name,
                subjects: [...new Map(cs.filter((x) => x.classId === c.id && x.subject.isActive && inScope(scope, c.id, x.subject.id)).map((x) => [x.subject.id, { id: x.subject.id, name: x.subject.name, canEdit: inScope(add, c.id, x.subject.id) }])).values()],
            }))
            .filter((c) => c.subjects.length),
        canEditAll: add === 'all',
    };
};

const names = async (classId: string, subjectId: string) => {
    const [c, s] = await Promise.all([db.schoolClass.findFirst({ where: { id: classId }, select: { name: true } }), db.subject.findFirst({ where: { id: subjectId }, select: { name: true } })]);
    if (!c || !s) throw badRequest('Choose a class and a subject');
    return { className: c.name, subject: s.name };
};

// ─── Chapters ────────────────────────────────────────────────────────────────

const mayEditChapters = async (userId: string, classId: string, subjectId: string) => {
    if (!inScope(await scopeFor(userId, ['syllabus.manage']), classId, subjectId)) throw forbidden('You can set up the chapters of the subjects you teach');
};

export const chapterQuery = z.object({ class: z.uuid(), subject: z.uuid() });
export const listChapters = async (q: z.infer<typeof chapterQuery>, userId: string) => {
    if (!inScope(await viewScope(userId), q.class, q.subject)) throw forbidden();
    const rows = await db.chapter.findMany({ where: { classId: q.class, subjectId: q.subject }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    const counts = await db.question.groupBy({ by: ['chapterId', 'status'], where: { classId: q.class, subjectId: q.subject }, _count: { _all: true } });
    const count = (id: string | null, st?: string) => counts.filter((c) => c.chapterId === id && (!st || c.status === st)).reduce((a, c) => a + c._count._all, 0);
    return {
        canEdit: inScope(await scopeFor(userId, ['syllabus.manage']), q.class, q.subject),
        chapters: rows.map((c) => ({ id: c.id, name: c.name, topics: c.topics, description: c.description, isActive: c.isActive, questions: count(c.id), approved: count(c.id, 'approved') })),
        noChapter: count(null),
    };
};

export const chapterSchema = z.strictObject({
    classId: z.uuid(),
    subjectId: z.uuid(),
    name: z.string().trim().min(1, 'is required').max(150),
    topics: z.array(z.string().trim().min(1).max(150)).max(40).default([]),
    description: z.string().trim().max(2000).nullable().optional(),
    isActive: z.boolean().default(true),
});
export type ChapterInput = z.infer<typeof chapterSchema>;

const nextOrder = async (classId: string, subjectId: string) => ((await db.chapter.aggregate({ where: { classId, subjectId }, _max: { sortOrder: true } }))._max.sortOrder ?? 0) + 10;
const taken = async (classId: string, subjectId: string, name: string, exceptId?: string) => !!(await db.chapter.findFirst({ where: { classId, subjectId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) } }));

export const createChapter = async (input: ChapterInput, userId: string) => {
    await mayEditChapters(userId, input.classId, input.subjectId);
    if (await taken(input.classId, input.subjectId, input.name)) throw badRequest('This subject already has a chapter of that name', [{ field: 'name', message: 'is taken' }]);
    const c = await db.chapter.create({ data: { tenantId: getTenantId()!, ...input, description: input.description ?? null, sortOrder: await nextOrder(input.classId, input.subjectId), createdBy: userId } });
    await recordAudit({ action: 'chapter_added', entity: 'chapter', entityId: c.id, changes: { name: c.name } });
    return c;
};

/** Many chapters at once: one per line ("Name: topic, topic"). Lines already there are skipped. */
export const manySchema = z.strictObject({ classId: z.uuid(), subjectId: z.uuid(), lines: z.array(z.string().trim().max(500)).min(1).max(100) });
export const addChapters = async (input: z.infer<typeof manySchema>, userId: string) => {
    await mayEditChapters(userId, input.classId, input.subjectId);
    let order = await nextOrder(input.classId, input.subjectId);
    let added = 0;
    for (const line of input.lines.map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean)) {
        const [name, rest] = line.split(/:(.*)/s);
        const n = name.trim().slice(0, 150);
        if (!n || (await taken(input.classId, input.subjectId, n))) continue;
        const topics = (rest ?? '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 40);
        await db.chapter.create({ data: { tenantId: getTenantId()!, classId: input.classId, subjectId: input.subjectId, name: n, topics, sortOrder: order, createdBy: userId } });
        order += 10;
        added++;
    }
    await recordAudit({ action: 'chapters_added', entity: 'chapter', entityId: input.subjectId, changes: { added } });
    return { added };
};

export const updateChapter = async (id: string, input: Omit<ChapterInput, 'classId' | 'subjectId'>, userId: string) => {
    const c = await db.chapter.findFirst({ where: { id } });
    if (!c) throw notFound('Chapter not found');
    await mayEditChapters(userId, c.classId, c.subjectId);
    if (await taken(c.classId, c.subjectId, input.name, id)) throw badRequest('This subject already has a chapter of that name', [{ field: 'name', message: 'is taken' }]);
    const saved = await db.chapter.update({ where: { id }, data: { name: input.name, topics: input.topics, description: input.description ?? null, isActive: input.isActive, updatedBy: userId } });
    await recordAudit({ action: 'chapter_changed', entity: 'chapter', entityId: id, changes: { name: saved.name } });
    return saved;
};

export const deleteChapter = async (id: string, userId: string) => {
    const c = await db.chapter.findFirst({ where: { id } });
    if (!c) throw notFound('Chapter not found');
    await mayEditChapters(userId, c.classId, c.subjectId);
    const n = await db.question.count({ where: { chapterId: id } });
    if (n) throw conflict(`${c.name} has ${n} question${n === 1 ? '' : 's'}. Make it inactive instead, or move the questions first.`);
    await db.chapter.delete({ where: { id } });
    await recordAudit({ action: 'chapter_deleted', entity: 'chapter', entityId: id, changes: { name: c.name } });
    return { id, deleted: true };
};

export const moveChapter = async (id: string, direction: 'up' | 'down', userId: string) => {
    const c = await db.chapter.findFirst({ where: { id } });
    if (!c) throw notFound('Chapter not found');
    await mayEditChapters(userId, c.classId, c.subjectId);
    const list = await db.chapter.findMany({ where: { classId: c.classId, subjectId: c.subjectId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], select: { id: true } });
    const i = list.findIndex((x) => x.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return { moved: false };
    [list[i], list[j]] = [list[j], list[i]];
    for (let k = 0; k < list.length; k++) await db.chapter.update({ where: { id: list[k].id }, data: { sortOrder: (k + 1) * 10 } });
    return { moved: true };
};

/** The AI's list of chapters (and topics) for a class's subject, to add after reading. */
export const suggestChapters = async (q: z.infer<typeof chapterQuery>, userId: string) => {
    await mayEditChapters(userId, q.class, q.subject);
    if (!(await getUserAccess(userId)).permissions['ai.generate']) throw forbidden('Using AI needs “Use AI to write questions” (Roles & Permissions)');
    const n = await names(q.class, q.subject);
    const r = await askAiJson(
        'suggest_chapters',
        userId,
        {
            system: 'You know the Indian school syllabus (CBSE / NCERT). Answer only with JSON.',
            messages: [{ role: 'user', text: `List the chapters of the current NCERT / CBSE syllabus of ${n.subject} for ${n.className}, in book order, each with 3 to 6 main topics. JSON: {"chapters":[{"name":"…","topics":["…"]}]}. Use the book's language for Hindi and Sanskrit.` }],
            temperature: 0.2,
        },
        z.object({ chapters: z.array(z.object({ name: z.string().trim().min(1).max(150), topics: z.array(z.string().trim().min(1).max(150)).max(20).default([]) })).max(60) })
    );
    return r.chapters;
};

// ─── Questions ───────────────────────────────────────────────────────────────

const option = z.strictObject({ text: z.string().trim().min(1, 'is required').max(500), correct: z.boolean() });
export const questionSchema = z
    .strictObject({
        classId: z.uuid(),
        subjectId: z.uuid(),
        chapterId: z.uuid().nullable().optional(),
        type: z.enum(QUESTION_TYPES),
        text: z.string().trim().min(1, 'is required').max(5000),
        imageFileId: z.uuid().nullable().optional(),
        options: z.array(option).max(10).default([]),
        answer: z.string().trim().max(5000).nullable().optional(),
        explanation: z.string().trim().max(5000).nullable().optional(),
        marks: z.number().min(0.5).max(100),
        difficultyId: z.uuid().nullable().optional(),
        levelId: z.uuid().nullable().optional(),
    })
    .superRefine((q, ctx) => {
        const add = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
        if (q.type === 'mcq' || q.type === 'multi') {
            if (q.options.length < 2) add('options', 'needs at least 2 choices');
            const right = q.options.filter((o) => o.correct).length;
            if (q.type === 'mcq' && right !== 1) add('options', 'tick exactly one correct choice');
            if (q.type === 'multi' && right < 1) add('options', 'tick the correct choices');
        }
        if (q.type === 'true_false' && !['true', 'false'].includes(q.answer ?? '')) add('answer', 'choose true or false');
        if (q.type === 'fill' && !q.answer) add('answer', 'is required');
        if (q.type === 'fill' && !q.text.includes('__')) add('text', 'mark the blank with ____');
    });
export type QuestionInput = z.infer<typeof questionSchema>;

const mayAdd = async (userId: string, classId: string, subjectId: string) => {
    if (!inScope(await scopeFor(userId, ['question.add']), classId, subjectId)) throw forbidden('You can add questions to the subjects you teach');
};

const checkQuestion = async (input: QuestionInput) => {
    const { types, maxOptions } = await getSettings({ types: QUESTIONS.types, maxOptions: QUESTIONS.maxOptions });
    if (!types.includes(input.type)) throw badRequest('This kind of question isn’t used (System Settings → Question Bank)', [{ field: 'type', message: 'is switched off' }]);
    if (input.options.length > maxOptions) throw badRequest(`At most ${maxOptions} choices`, [{ field: 'options', message: 'has too many choices' }]);
    if (input.chapterId && !(await db.chapter.findFirst({ where: { id: input.chapterId, classId: input.classId, subjectId: input.subjectId } }))) throw badRequest('Choose a chapter of this subject', [{ field: 'chapterId', message: 'is not a chapter of the subject' }]);
};

/** Where a new question starts (drafts from AI, pending if reviewing is on, else approved). */
const startStatus = async (userId: string, source: 'manual' | 'import' | 'ai') => {
    const s = await getSettings({ approval: QUESTIONS.approval, aiReview: QUESTIONS.aiReview });
    if (source === 'ai' && s.aiReview) return 'draft';
    const canApprove = !!(await getUserAccess(userId)).permissions['question.approve'];
    return !s.approval || canApprove ? 'approved' : 'pending';
};

const clean = (q: QuestionInput) => ({
    classId: q.classId,
    subjectId: q.subjectId,
    chapterId: q.chapterId ?? null,
    type: q.type,
    text: q.text,
    imageFileId: q.imageFileId ?? null,
    options: (q.type === 'mcq' || q.type === 'multi' ? q.options : []) as Prisma.InputJsonValue,
    answer: q.type === 'mcq' || q.type === 'multi' ? null : (q.answer ?? null),
    explanation: q.explanation ?? null,
    marks: q.marks,
    difficultyId: q.difficultyId ?? null,
    levelId: q.levelId ?? null,
});

export const listQuery = z.object({
    class: z.uuid().optional(),
    subject: z.uuid().optional(),
    chapter: z.string().optional(),
    type: z.enum(QUESTION_TYPES).optional(),
    difficulty: z.uuid().optional(),
    status: z.enum(['draft', 'pending', 'approved', 'rejected']).optional(),
    source: z.enum(['manual', 'import', 'ai']).optional(),
    mine: z.enum(['1', '0']).optional(),
    search: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
});

const present = async (rows: Prisma.QuestionGetPayload<object>[], userId: string) => {
    const [chapters, masters, people, add, a] = await Promise.all([
        db.chapter.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.chapterId!).filter(Boolean))] } }, select: { id: true, name: true } }),
        db.masterValue.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.difficultyId, r.levelId]).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
        db.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.createdBy, r.reviewedBy]).filter((x): x is string => !!x))] } }, select: { id: true, displayName: true } }),
        scopeFor(userId, ['question.add']),
        getUserAccess(userId),
    ]);
    const ch = new Map(chapters.map((c) => [c.id, c.name]));
    const mv = new Map(masters.map((m) => [m.id, m.name]));
    const pe = new Map(people.map((p) => [p.id, p.displayName]));
    return rows.map((q) => ({
        ...q,
        options: q.options as { text: string; correct: boolean }[],
        chapter: q.chapterId ? (ch.get(q.chapterId) ?? null) : null,
        difficulty: q.difficultyId ? (mv.get(q.difficultyId) ?? null) : null,
        level: q.levelId ? (mv.get(q.levelId) ?? null) : null,
        by: q.createdBy ? (pe.get(q.createdBy) ?? null) : null,
        reviewer: q.reviewedBy ? (pe.get(q.reviewedBy) ?? null) : null,
        canEdit: inScope(add, q.classId, q.subjectId),
        canReview: !!a.permissions['question.approve'],
    }));
};

export const listQuestions = async (q: z.infer<typeof listQuery>, userId: string) => {
    const scope = await viewScope(userId);
    if (!scope) throw forbidden();
    const pairs = scope === 'all' ? null : [...scope].map((p) => p.split('|'));
    if (pairs && !pairs.length) return { rows: [], total: 0, page: 1, pages: 1, counts: {} };
    const where: Prisma.QuestionWhereInput = {
        ...(pairs ? { OR: pairs.map(([classId, subjectId]) => ({ classId, subjectId })) } : {}),
        ...(q.class ? { classId: q.class } : {}),
        ...(q.subject ? { subjectId: q.subject } : {}),
        ...(q.chapter ? { chapterId: q.chapter === 'none' ? null : q.chapter } : {}),
        ...(q.type ? { type: q.type } : {}),
        ...(q.difficulty ? { difficultyId: q.difficulty } : {}),
        ...(q.source ? { source: q.source } : {}),
        ...(q.mine === '1' ? { createdBy: userId } : {}),
        ...(q.search ? { text: { contains: q.search, mode: 'insensitive' } } : {}),
    };
    const take = 25;
    const [rows, total, counts] = await Promise.all([
        db.question.findMany({ where: { ...where, ...(q.status ? { status: q.status } : {}) }, orderBy: [{ createdAt: 'desc' }], skip: (q.page - 1) * take, take }),
        db.question.count({ where: { ...where, ...(q.status ? { status: q.status } : {}) } }),
        db.question.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);
    return { rows: await present(rows, userId), total, page: q.page, pages: Math.max(1, Math.ceil(total / take)), counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) };
};

const loadQuestion = async (id: string) => {
    const q = await db.question.findFirst({ where: { id } });
    if (!q) throw notFound('Question not found');
    return q;
};

export const getQuestion = async (id: string, userId: string) => {
    const q = await loadQuestion(id);
    if (!inScope(await viewScope(userId), q.classId, q.subjectId)) throw forbidden();
    return (await present([q], userId))[0];
};

export const createQuestion = async (input: QuestionInput, userId: string, opts: { asDraft?: boolean } = {}) => {
    await mayAdd(userId, input.classId, input.subjectId);
    await checkQuestion(input);
    if (input.imageFileId && !(await db.file.findFirst({ where: { id: input.imageFileId, uploadedBy: userId } }))) throw badRequest('Upload the picture again');
    const status = opts.asDraft ? 'draft' : await startStatus(userId, 'manual');
    const q = await db.question.create({ data: { tenantId: getTenantId()!, ...clean(input), status, source: 'manual', createdBy: userId } });
    await recordAudit({ action: 'question_added', entity: 'question', entityId: q.id, changes: { type: q.type, status } });
    return getQuestion(q.id, userId);
};

export const updateQuestion = async (id: string, input: QuestionInput, userId: string, opts: { asDraft?: boolean } = {}) => {
    const cur = await loadQuestion(id);
    await mayAdd(userId, cur.classId, cur.subjectId);
    await mayAdd(userId, input.classId, input.subjectId);
    await checkQuestion(input);
    // A change by someone who can't approve sends it back for review.
    const status = opts.asDraft ? 'draft' : await startStatus(userId, 'manual');
    await db.question.update({ where: { id }, data: { ...clean(input), status, reviewNote: status === 'approved' ? cur.reviewNote : null, updatedBy: userId } });
    await recordAudit({ action: 'question_changed', entity: 'question', entityId: id, changes: { status } });
    return getQuestion(id, userId);
};

export const deleteQuestion = async (id: string, userId: string) => {
    const q = await loadQuestion(id);
    await mayAdd(userId, q.classId, q.subjectId);
    await db.question.delete({ where: { id } });
    await recordAudit({ action: 'question_deleted', entity: 'question', entityId: id, changes: { text: q.text.slice(0, 80) } });
    return { id, deleted: true };
};

/** A draft sent on (for review, or approved at once when no review is needed). */
export const sendQuestions = async (ids: string[], userId: string) => {
    const rows = await db.question.findMany({ where: { id: { in: ids }, status: { in: ['draft', 'rejected'] } } });
    const status = await startStatus(userId, 'manual');
    let n = 0;
    for (const q of rows) {
        await mayAdd(userId, q.classId, q.subjectId);
        await db.question.update({ where: { id: q.id }, data: { status, updatedBy: userId } });
        n++;
    }
    return { sent: n, status };
};

export const reviewSchema = z.strictObject({ ids: z.array(z.uuid()).min(1).max(200), approve: z.boolean(), note: z.string().trim().max(500).optional() });
export const reviewQuestions = async (input: z.infer<typeof reviewSchema>, userId: string) => {
    if (!(await getUserAccess(userId)).permissions['question.approve']) throw forbidden();
    const r = await db.question.updateMany({ where: { id: { in: input.ids }, status: { in: ['pending', 'draft', 'rejected', 'approved'] } }, data: { status: input.approve ? 'approved' : 'rejected', reviewNote: input.note || null, reviewedBy: userId, reviewedAt: new Date() } });
    await recordAudit({ action: input.approve ? 'questions_approved' : 'questions_rejected', entity: 'question', entityId: input.ids[0], changes: { count: r.count } });
    return { reviewed: r.count };
};

// ─── Writing questions with AI ───────────────────────────────────────────────

export const generateSchema = z.strictObject({
    classId: z.uuid(),
    subjectId: z.uuid(),
    chapterId: z.uuid().nullable().optional(),
    type: z.enum(QUESTION_TYPES),
    count: z.number().int().min(1).max(50),
    marks: z.number().min(0.5).max(100).default(1),
    difficultyId: z.uuid().nullable().optional(),
    levelId: z.uuid().nullable().optional(),
    instructions: z.string().trim().max(1000).optional(),
});

const aiQuestion = z.object({
    text: z.string().trim().min(1).max(5000),
    options: z.array(z.object({ text: z.string().trim().min(1).max(500), correct: z.boolean() })).max(10).optional(),
    answer: z.union([z.string(), z.boolean()]).nullable().optional(),
    explanation: z.string().trim().max(5000).nullable().optional(),
});

const HOW: Record<QuestionType, string> = {
    mcq: 'exactly 4 options with exactly one correct ("correct": true); no "answer"',
    multi: '4 or 5 options with two or more correct; no "answer"',
    true_false: 'no options; "answer" is "true" or "false"',
    fill: 'the text has ____ where the blank is; "answer" is the word or words (several accepted answers separated by |); no options',
    short: 'no options; "answer" is a model answer of 1 to 3 sentences',
    long: 'no options; "answer" is a model answer with the main points a full answer needs',
};

export const generateQuestions = async (input: z.infer<typeof generateSchema>, userId: string) => {
    await mayAdd(userId, input.classId, input.subjectId);
    if (!(await getUserAccess(userId)).permissions['ai.generate']) throw forbidden('Using AI needs “Use AI to write questions” (Roles & Permissions)');
    const { max } = await getSettings({ max: AI.maxQuestions });
    if (input.count > max) throw badRequest(`At most ${max} questions in one go (System Settings → AI)`, [{ field: 'count', message: `at most ${max}` }]);
    const n = await names(input.classId, input.subjectId);
    const chapter = input.chapterId ? await db.chapter.findFirst({ where: { id: input.chapterId, classId: input.classId, subjectId: input.subjectId } }) : null;
    const [difficulty, level] = await Promise.all([input.difficultyId ? db.masterValue.findFirst({ where: { id: input.difficultyId }, select: { name: true } }) : null, input.levelId ? db.masterValue.findFirst({ where: { id: input.levelId }, select: { name: true } }) : null]);
    const existing = chapter ? await db.question.findMany({ where: { chapterId: chapter.id }, select: { text: true }, take: 40, orderBy: { createdAt: 'desc' } }) : [];
    const r = await askAiJson(
        'generate_questions',
        userId,
        {
            system: 'You are an experienced CBSE school teacher who writes clear, correct exam questions at the right level for the class. Questions are about the syllabus only, suitable for children, and factually correct. Answer only with JSON.',
            messages: [
                {
                    role: 'user',
                    text: [
                        `Write ${input.count} questions of the kind "${TYPE_LABEL[input.type]}" for ${n.className}, subject ${n.subject}${chapter ? `, chapter "${chapter.name}"${chapter.topics.length ? ` (topics: ${chapter.topics.join(', ')})` : ''}` : ''}.`,
                        difficulty ? `Difficulty: ${difficulty.name}.` : '',
                        level ? `Thinking level (Bloom): ${level.name}.` : '',
                        `Each question: ${HOW[input.type]}; add a short "explanation" of the answer.`,
                        /hindi|sanskrit/i.test(n.subject) ? 'Write in the language of the subject (Hindi / Sanskrit, Devanagari).' : 'Write in simple English.',
                        input.instructions ? `Teacher’s note: ${input.instructions}` : '',
                        existing.length ? `Don't repeat these questions already in the bank: ${existing.map((e) => `“${e.text.slice(0, 120)}”`).join('; ')}` : '',
                        'JSON: {"questions":[{"text":"…","options":[{"text":"…","correct":true}],"answer":"…","explanation":"…"}]}',
                    ]
                        .filter(Boolean)
                        .join('\n'),
                },
            ],
            temperature: 0.7,
            maxTokens: 8192,
        },
        z.object({ questions: z.array(aiQuestion).max(60) })
    );
    const status = await startStatus(userId, 'ai');
    const tenantId = getTenantId()!;
    const made: string[] = [];
    let skipped = 0;
    for (const x of r.questions.slice(0, input.count)) {
        const candidate = questionSchema.safeParse({
            classId: input.classId,
            subjectId: input.subjectId,
            chapterId: chapter?.id ?? null,
            type: input.type,
            text: x.text,
            options: input.type === 'mcq' || input.type === 'multi' ? (x.options ?? []).slice(0, 10) : [],
            answer: x.answer === true ? 'true' : x.answer === false ? 'false' : typeof x.answer === 'string' ? x.answer.trim().toLowerCase() === 'true' && input.type === 'true_false' ? 'true' : x.answer.trim().toLowerCase() === 'false' && input.type === 'true_false' ? 'false' : x.answer.trim() : null,
            explanation: x.explanation ?? null,
            marks: input.marks,
            difficultyId: input.difficultyId ?? null,
            levelId: input.levelId ?? null,
        });
        if (!candidate.success) {
            skipped++;
            continue;
        }
        const q = await db.question.create({ data: { tenantId, ...clean(candidate.data), status, source: 'ai', createdBy: userId } });
        made.push(q.id);
    }
    await recordAudit({ action: 'questions_generated', entity: 'question', entityId: made[0] ?? input.subjectId, changes: { made: made.length, skipped, type: input.type } });
    const rows = await db.question.findMany({ where: { id: { in: made } }, orderBy: { createdAt: 'asc' } });
    return { made: made.length, skipped, status, questions: await present(rows, userId) };
};
