import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { getUserAccess } from '../rbac/access.service';
import { currentYear } from '../academic/years.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { todayIST } from '../attendance/attendance.settings';
import { AiMessage, askAiJson } from '../ai/ai.service';
import { LEARN } from './learn.settings';

/**
 * AI Learning: a student picks a subject and a chapter of their class and learns with the AI tutor
 * (ask, explain simply, summary, key points, important questions) or takes a practice quiz (from the
 * school's question bank, else written by the AI). The tutor keeps to the syllabus and the student's
 * level, and in "guide" mode helps them work answers out rather than doing their homework.
 */

const MODES = ['ask', 'explain', 'summary', 'points', 'questions'] as const;
type Mode = (typeof MODES)[number];
const FIRST: Record<Exclude<Mode, 'ask'>, string> = {
    explain: 'Explain this chapter simply, as to a student of my class, with an everyday example.',
    summary: 'Give me a short summary of this chapter.',
    points: 'List the key points of this chapter that I must remember.',
    questions: 'Give me the important questions of this chapter for the exam (without the answers), easy to hard.',
};
const TITLE: Record<Mode, string> = { ask: 'Question', explain: 'Explained simply', summary: 'Summary', points: 'Key points', questions: 'Important questions' };

// ─── The student ─────────────────────────────────────────────────────────────

/** The student who is learning (their own login), with their class this session. */
const me = async (userId: string) => {
    const year = await currentYear();
    const s = await db.student.findFirst({ where: { userId, status: 'active' }, select: { id: true, firstName: true, middleName: true, lastName: true, enrolments: { where: { academicYearId: year?.id }, select: { sectionId: true, optionalSubjectIds: true, section: { select: { classId: true, streamId: true, name: true, schoolClass: { select: { name: true, shortName: true } } } } } } } });
    if (!s || !year || !s.enrolments.length) throw forbidden('AI Learning is for students (with their own login, in a class this session)');
    const e = s.enrolments[0];
    return { id: s.id, name: fullName(s), yearId: year.id, classId: e.section.classId, className: e.section.schoolClass.name, section: sectionLabel(e.section), sectionId: e.sectionId, streamId: e.section.streamId, optional: e.optionalSubjectIds };
};
type Me = Awaited<ReturnType<typeof me>>;

/** The subjects of the student's class (optional ones only if chosen), each with its chapters. */
export const mySubjects = async (userId: string) => {
    const st = await me(userId);
    const cs = await db.classSubject.findMany({ where: { academicYearId: st.yearId, classId: st.classId, OR: [{ streamId: null }, { streamId: st.streamId }] }, select: { isOptional: true, subject: { select: { id: true, name: true, isActive: true, assessment: true } } }, orderBy: { sortOrder: 'asc' } });
    const subjects = cs.filter((c) => c.subject.isActive && c.subject.assessment === 'scholastic' && (!c.isOptional || st.optional.includes(c.subject.id))).map((c) => c.subject);
    const chapters = await db.chapter.findMany({ where: { classId: st.classId, subjectId: { in: subjects.map((s) => s.id) }, isActive: true }, orderBy: [{ sortOrder: 'asc' }], select: { id: true, subjectId: true, name: true, topics: true } });
    const quizzes = await db.practiceQuiz.groupBy({ by: ['chapterId'], where: { studentId: st.id, submittedAt: { not: null } }, _avg: { score: true, total: true }, _count: { _all: true } });
    const best = new Map(quizzes.map((q) => [q.chapterId, { quizzes: q._count._all, percent: q._avg.total ? Math.round(((q._avg.score ?? 0) / q._avg.total) * 100) : null }]));
    const { mode } = await getSettings({ mode: LEARN.mode });
    return {
        student: { name: st.name, className: st.className, section: st.section },
        mode,
        subjects: [...new Map(subjects.map((s) => [s.id, s])).values()].map((s) => ({ id: s.id, name: s.name, chapters: chapters.filter((c) => c.subjectId === s.id).map((c) => ({ id: c.id, name: c.name, topics: c.topics, practice: best.get(c.id) ?? null })) })),
    };
};

const contextOf = async (st: Me, subjectId: string, chapterId: string | null) => {
    const subject = await db.classSubject.findFirst({ where: { academicYearId: st.yearId, classId: st.classId, subjectId }, select: { subject: { select: { id: true, name: true } } } });
    if (!subject) throw badRequest('Choose a subject of your class');
    const chapter = chapterId ? await db.chapter.findFirst({ where: { id: chapterId, classId: st.classId, subjectId } }) : null;
    if (chapterId && !chapter) throw badRequest('Choose a chapter of the subject');
    return { subject: subject.subject.name, chapter };
};

const systemPrompt = async (st: Me, ctx: Awaited<ReturnType<typeof contextOf>>) => {
    const { mode } = await getSettings({ mode: LEARN.mode });
    const school = await db.schoolProfile.findFirst({ select: { shortName: true, legalName: true } });
    return [
        `You are a friendly, patient tutor for a student of ${st.className} at ${school?.shortName ?? school?.legalName ?? 'an Indian school'} (CBSE / NCERT syllabus).`,
        `Subject: ${ctx.subject}.${ctx.chapter ? ` Chapter: "${ctx.chapter.name}"${ctx.chapter.topics.length ? ` (topics: ${ctx.chapter.topics.join(', ')})` : ''}.` : ''}`,
        'Rules:',
        '- Stay on school learning: this subject, and studying in general. For anything else (personal, adult, violent, dangerous, hateful, other people’s private information, cheating in exams), kindly say you can only help with studies, and set "flag" to "off_topic", or "unsafe" for anything harmful.',
        '- Teach at the level of the student’s class, in short, clear steps, with simple everyday Indian examples. Be correct; if you are not sure, say so.',
        mode === 'guide'
            ? '- Guide, don’t just give answers: when asked to solve homework or a question, give hints and the method step by step and ask the student to try the next step; give the final answer only after they have tried, or for checking.'
            : '- You may give complete worked answers, explaining each step.',
        '- Answer in the language the student writes in (English, Hindi or Hinglish); for Hindi and Sanskrit subjects use Devanagari. Use simple Markdown (bold, lists); no tables or images.',
        '- Keep answers short (under 250 words) unless asked for more. End with a small question to check understanding, when it helps.',
        'Reply only with JSON: {"reply": "…", "flag": "ok" | "off_topic" | "unsafe"}',
    ].join('\n');
};

const replySchema = z.object({ reply: z.string().min(1).max(8000), flag: z.enum(['ok', 'off_topic', 'unsafe']).catch('ok') });

const checkDaily = async (st: Me) => {
    const { daily } = await getSettings({ daily: LEARN.dailyMessages });
    const n = await db.learnMessage.count({ where: { role: 'user', createdAt: { gte: new Date(`${todayIST()}T00:00:00+05:30`) }, chat: { studentId: st.id } } });
    if (n >= daily) throw badRequest(`You have asked ${daily} questions today, the most for a day. Come back tomorrow!`);
};

const answer = async (userId: string, st: Me, chat: { id: string; subjectId: string; chapterId: string | null }, text: string) => {
    await checkDaily(st);
    const ctx = await contextOf(st, chat.subjectId, chat.chapterId);
    const history = await db.learnMessage.findMany({ where: { chatId: chat.id }, orderBy: { createdAt: 'desc' }, take: 12 });
    const messages: AiMessage[] = [...history.reverse().map((m) => ({ role: m.role as AiMessage['role'], text: m.text })), { role: 'user', text }];
    const tenantId = getTenantId()!;
    await db.learnMessage.create({ data: { tenantId, chatId: chat.id, role: 'user', text } });
    const r = await askAiJson('tutor', userId, { system: await systemPrompt(st, ctx), messages, temperature: 0.5, maxTokens: 2048 }, replySchema);
    const m = await db.learnMessage.create({ data: { tenantId, chatId: chat.id, role: 'assistant', text: r.reply, flag: r.flag } });
    await db.learnChat.update({ where: { id: chat.id }, data: { messages: { increment: 2 }, ...(r.flag !== 'ok' ? { flagged: true } : {}) } });
    return { id: m.id, role: 'assistant', text: m.text, flag: m.flag, at: m.createdAt };
};

// ─── Chats ───────────────────────────────────────────────────────────────────

export const startSchema = z.strictObject({ subjectId: z.uuid(), chapterId: z.uuid().nullable().optional(), mode: z.enum(MODES), text: z.string().trim().max(2000).optional() });

export const startChat = async (input: z.infer<typeof startSchema>, userId: string) => {
    const st = await me(userId);
    const ctx = await contextOf(st, input.subjectId, input.chapterId ?? null);
    const text = input.mode === 'ask' ? input.text : FIRST[input.mode];
    if (!text) throw badRequest('Write your question');
    const chat = await db.learnChat.create({
        data: { tenantId: getTenantId()!, studentId: st.id, userId, classId: st.classId, subjectId: input.subjectId, chapterId: ctx.chapter?.id ?? null, mode: input.mode, title: input.mode === 'ask' ? text.slice(0, 80) : `${TITLE[input.mode]}${ctx.chapter ? `: ${ctx.chapter.name}` : ''}` },
    });
    try {
        await answer(userId, st, chat, text);
    } catch (err) {
        // Nothing was answered: no empty conversation is kept.
        await db.learnChat.delete({ where: { id: chat.id } });
        throw err;
    }
    return getChat(chat.id, userId);
};

export const sendSchema = z.strictObject({ text: z.string().trim().min(1, 'Write your question').max(2000) });
export const sendMessage = async (chatId: string, text: string, userId: string) => {
    const st = await me(userId);
    const chat = await db.learnChat.findFirst({ where: { id: chatId, studentId: st.id } });
    if (!chat) throw notFound('Conversation not found');
    await answer(userId, st, chat, text);
    return getChat(chatId, userId);
};

const chatView = async (chatId: string) => {
    const chat = await db.learnChat.findFirst({ where: { id: chatId }, include: { items: { orderBy: { createdAt: 'asc' } } } });
    if (!chat) throw notFound('Conversation not found');
    const [subject, chapter] = await Promise.all([db.subject.findFirst({ where: { id: chat.subjectId }, select: { name: true } }), chat.chapterId ? db.chapter.findFirst({ where: { id: chat.chapterId }, select: { name: true } }) : null]);
    return { id: chat.id, title: chat.title, mode: chat.mode, subject: subject?.name ?? '', subjectId: chat.subjectId, chapter: chapter?.name ?? null, chapterId: chat.chapterId, flagged: chat.flagged, createdAt: chat.createdAt, messages: chat.items.map((m) => ({ id: m.id, role: m.role, text: m.text, flag: m.flag, at: m.createdAt })), studentId: chat.studentId };
};

export const getChat = async (chatId: string, userId: string) => {
    const v = await chatView(chatId);
    const st = await db.student.findFirst({ where: { userId }, select: { id: true } });
    if (v.studentId !== st?.id && !(await maySeeStudent(userId, v.studentId))) throw forbidden();
    return v;
};

export const myChats = async (userId: string, q: { subject?: string; chapter?: string }) => {
    const st = await me(userId);
    const rows = await db.learnChat.findMany({ where: { studentId: st.id, ...(q.subject ? { subjectId: q.subject } : {}), ...(q.chapter ? { chapterId: q.chapter } : {}) }, orderBy: { updatedAt: 'desc' }, take: 50 });
    return rows.map((c) => ({ id: c.id, title: c.title, mode: c.mode, subjectId: c.subjectId, chapterId: c.chapterId, messages: c.messages, updatedAt: c.updatedAt }));
};

export const deleteChat = async (chatId: string, userId: string) => {
    const st = await me(userId);
    await db.learnChat.deleteMany({ where: { id: chatId, studentId: st.id } });
    return { id: chatId, deleted: true };
};

// ─── Practice quizzes ────────────────────────────────────────────────────────

type QuizQ = { text: string; options: { text: string; correct: boolean }[]; explanation: string | null };
export const quizSchema = z.strictObject({ subjectId: z.uuid(), chapterId: z.uuid().nullable().optional() });

const shuffle = <T>(xs: T[]) => xs.map((x) => [Math.random(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);

export const newQuiz = async (input: z.infer<typeof quizSchema>, userId: string) => {
    const st = await me(userId);
    const ctx = await contextOf(st, input.subjectId, input.chapterId ?? null);
    const { size, bankFirst } = await getSettings({ size: LEARN.quizSize, bankFirst: LEARN.bankFirst });
    let questions: QuizQ[] = [];
    let source: 'bank' | 'ai' = 'bank';
    if (bankFirst) {
        // Approved MCQ / true-false of the school's bank (not ones in a live online test).
        const pool = await db.question.findMany({ where: { classId: st.classId, subjectId: input.subjectId, status: 'approved', type: { in: ['mcq', 'true_false'] }, ...(ctx.chapter ? { chapterId: ctx.chapter.id } : {}) }, select: { type: true, text: true, options: true, answer: true, explanation: true } });
        if (pool.length >= size)
            questions = shuffle(pool)
                .slice(0, size)
                .map((q) => ({ text: q.text, options: q.type === 'true_false' ? [{ text: 'True', correct: q.answer === 'true' }, { text: 'False', correct: q.answer === 'false' }] : shuffle(q.options as QuizQ['options']), explanation: q.explanation }));
    }
    if (!questions.length) {
        source = 'ai';
        const r = await askAiJson(
            'quiz',
            userId,
            {
                system: 'You write short practice quizzes for Indian school students (CBSE / NCERT), correct and at the right level. Answer only with JSON.',
                messages: [{ role: 'user', text: `Write ${size} multiple-choice questions for ${st.className}, ${ctx.subject}${ctx.chapter ? `, chapter "${ctx.chapter.name}"` : ''}, easy to hard, each with 4 options, exactly one correct, and a one-line explanation. ${/hindi|sanskrit/i.test(ctx.subject) ? 'Write in Devanagari.' : 'Write in simple English.'} JSON: {"questions":[{"text":"…","options":[{"text":"…","correct":true}],"explanation":"…"}]}` }],
                temperature: 0.7,
                maxTokens: 4096,
            },
            z.object({ questions: z.array(z.object({ text: z.string().min(1).max(1000), options: z.array(z.object({ text: z.string().min(1).max(300), correct: z.boolean() })).min(2).max(6), explanation: z.string().max(1000).nullable().optional() })).min(1).max(30) })
        );
        questions = r.questions.filter((q) => q.options.filter((o) => o.correct).length === 1).slice(0, size).map((q) => ({ text: q.text, options: q.options, explanation: q.explanation ?? null }));
        if (!questions.length) throw badRequest('The AI couldn’t make a quiz just now. Try again.');
    }
    const quiz = await db.practiceQuiz.create({ data: { tenantId: getTenantId()!, studentId: st.id, userId, classId: st.classId, subjectId: input.subjectId, chapterId: ctx.chapter?.id ?? null, source, questions: questions as Prisma.InputJsonValue, total: questions.length } });
    return { id: quiz.id, source, subject: ctx.subject, chapter: ctx.chapter?.name ?? null, questions: questions.map((q) => ({ text: q.text, options: q.options.map((o) => o.text) })) };
};

export const quizAnswerSchema = z.strictObject({ answers: z.array(z.number().int().min(-1).max(10)).max(30) });
export const submitQuiz = async (quizId: string, answers: number[], userId: string) => {
    const st = await me(userId);
    const quiz = await db.practiceQuiz.findFirst({ where: { id: quizId, studentId: st.id } });
    if (!quiz) throw notFound('Quiz not found');
    if (quiz.submittedAt) throw badRequest('This quiz is done; start a new one');
    const qs = quiz.questions as QuizQ[];
    const score = qs.filter((q, i) => q.options[answers[i]]?.correct).length;
    await db.practiceQuiz.update({ where: { id: quizId }, data: { answers, score, submittedAt: new Date() } });
    return { score, total: qs.length, questions: qs.map((q, i) => ({ text: q.text, options: q.options.map((o) => o.text), correct: q.options.findIndex((o) => o.correct), given: answers[i] ?? -1, explanation: q.explanation })) };
};

// ─── Progress (student, parents, teachers) ───────────────────────────────────

/** Whether a person may see a student's learning (their child, a student of their section, or all). */
const maySeeStudent = async (userId: string, studentId: string) => {
    const a = await getUserAccess(userId);
    const v = a.permissions['learn.view'];
    if (!v) return false;
    if (v === 'all') return true;
    if (v === 'own') return !!(await db.student.findFirst({ where: { id: studentId, family: { guardians: { some: { userId } } } }, select: { id: true } }));
    const year = await currentYear();
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    if (!year || !staff) return false;
    const e = await db.enrolment.findFirst({ where: { academicYearId: year.id, studentId }, select: { sectionId: true, section: { select: { classTeacherId: true } } } });
    if (!e) return false;
    return e.section.classTeacherId === staff.id || !!(await db.teachingAssignment.findFirst({ where: { academicYearId: year.id, staffId: staff.id, sectionId: e.sectionId }, select: { id: true } }));
};

/** One student's learning: per subject and chapter, quizzes and their scores, and conversations. */
export const progressOf = async (studentId: string, userId: string) => {
    const self = await db.student.findFirst({ where: { id: studentId, userId }, select: { id: true } });
    if (!self && !(await maySeeStudent(userId, studentId))) throw forbidden();
    const [student, quizzes, chats] = await Promise.all([
        db.student.findFirst({ where: { id: studentId }, select: { firstName: true, middleName: true, lastName: true, admissionNo: true } }),
        db.practiceQuiz.findMany({ where: { studentId, submittedAt: { not: null } }, orderBy: { createdAt: 'desc' }, select: { subjectId: true, chapterId: true, score: true, total: true, createdAt: true } }),
        db.learnChat.findMany({ where: { studentId }, orderBy: { updatedAt: 'desc' }, select: { id: true, title: true, subjectId: true, chapterId: true, messages: true, flagged: true, updatedAt: true }, take: 200 }),
    ]);
    const ids = { subjects: [...new Set([...quizzes, ...chats].map((x) => x.subjectId))], chapters: [...new Set([...quizzes, ...chats].map((x) => x.chapterId!).filter(Boolean))] };
    const [subjects, chapters] = await Promise.all([db.subject.findMany({ where: { id: { in: ids.subjects } }, select: { id: true, name: true } }), db.chapter.findMany({ where: { id: { in: ids.chapters } }, select: { id: true, name: true } })]);
    const sub = new Map(subjects.map((s) => [s.id, s.name]));
    const ch = new Map(chapters.map((c) => [c.id, c.name]));
    const byChapter = new Map<string, { subject: string; chapter: string; quizzes: number; score: number; total: number; chats: number; last: Date }>();
    const key = (s: string, c: string | null) => `${s}|${c ?? ''}`;
    for (const q of quizzes) {
        const g = byChapter.get(key(q.subjectId, q.chapterId)) ?? { subject: sub.get(q.subjectId) ?? '', chapter: q.chapterId ? (ch.get(q.chapterId) ?? '') : 'Whole subject', quizzes: 0, score: 0, total: 0, chats: 0, last: q.createdAt };
        g.quizzes++;
        g.score += q.score ?? 0;
        g.total += q.total;
        if (q.createdAt > g.last) g.last = q.createdAt;
        byChapter.set(key(q.subjectId, q.chapterId), g);
    }
    for (const c of chats) {
        const g = byChapter.get(key(c.subjectId, c.chapterId)) ?? { subject: sub.get(c.subjectId) ?? '', chapter: c.chapterId ? (ch.get(c.chapterId) ?? '') : 'Whole subject', quizzes: 0, score: 0, total: 0, chats: 0, last: c.updatedAt };
        g.chats++;
        if (c.updatedAt > g.last) g.last = c.updatedAt;
        byChapter.set(key(c.subjectId, c.chapterId), g);
    }
    const rows = [...byChapter.values()].map((g) => ({ ...g, percent: g.total ? Math.round((g.score / g.total) * 100) : null }));
    return {
        student: student ? `${fullName(student)} (${student.admissionNo})` : '',
        quizzes: quizzes.length,
        average: quizzes.length ? Math.round((quizzes.reduce((a, q) => a + (q.score ?? 0), 0) / Math.max(1, quizzes.reduce((a, q) => a + q.total, 0))) * 100) : null,
        chats: chats.length,
        flagged: chats.filter((c) => c.flagged).length,
        chapters: rows.sort((a, b) => b.last.getTime() - a.last.getTime()),
        weak: rows.filter((r) => r.percent !== null && r.percent < 60).sort((a, b) => (a.percent ?? 0) - (b.percent ?? 0)).slice(0, 5),
        conversations: chats.slice(0, 30).map((c) => ({ id: c.id, title: c.title, subject: sub.get(c.subjectId) ?? '', chapter: c.chapterId ? (ch.get(c.chapterId) ?? null) : null, messages: c.messages, flagged: c.flagged, updatedAt: c.updatedAt })),
    };
};

/** The students a person can see the learning of: their children, their sections' students, or a section. */
export const progressChoices = async (userId: string) => {
    const a = await getUserAccess(userId);
    const v = a.permissions['learn.view'];
    const year = await currentYear();
    if (!v || !year) return { children: [], sections: [] };
    if (v === 'own') {
        const kids = await db.student.findMany({ where: { status: 'active', family: { guardians: { some: { userId } } } }, select: { id: true, firstName: true, middleName: true, lastName: true } });
        return { children: kids.map((k) => ({ id: k.id, name: fullName(k) })), sections: [] };
    }
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    const own = v === 'all' ? null : staff ? [...new Set([...(await db.section.findMany({ where: { academicYearId: year.id, classTeacherId: staff.id }, select: { id: true } })).map((s) => s.id), ...(await db.teachingAssignment.findMany({ where: { academicYearId: year.id, staffId: staff.id }, select: { sectionId: true } })).map((t) => t.sectionId)])] : [];
    const sections = await db.section.findMany({ where: { academicYearId: year.id, isActive: true, ...(own ? { id: { in: own } } : {}) }, select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } } }, orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }] });
    return { children: [], sections: sections.map((s) => ({ id: s.id, label: sectionLabel(s) })) };
};

/** A section at a glance: each student's practice and conversations. */
export const sectionProgress = async (sectionId: string, userId: string) => {
    const choices = await progressChoices(userId);
    if (!choices.sections.some((s) => s.id === sectionId)) throw forbidden();
    const year = (await currentYear())!;
    const enrol = await db.enrolment.findMany({ where: { academicYearId: year.id, sectionId, student: { status: 'active' } }, select: { rollNumber: true, student: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } } }, orderBy: [{ rollNumber: 'asc' }] });
    const ids = enrol.map((e) => e.student.id);
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [quiz, chats, flagged] = await Promise.all([
        db.practiceQuiz.groupBy({ by: ['studentId'], where: { studentId: { in: ids }, submittedAt: { not: null } }, _sum: { score: true, total: true }, _count: { _all: true }, _max: { createdAt: true } }),
        db.learnChat.groupBy({ by: ['studentId'], where: { studentId: { in: ids }, updatedAt: { gte: since } }, _count: { _all: true } }),
        db.learnChat.groupBy({ by: ['studentId'], where: { studentId: { in: ids }, flagged: true }, _count: { _all: true } }),
    ]);
    return enrol.map((e) => {
        const q = quiz.find((x) => x.studentId === e.student.id);
        return {
            id: e.student.id,
            roll: e.rollNumber,
            name: fullName(e.student),
            admissionNo: e.student.admissionNo,
            quizzes: q?._count._all ?? 0,
            percent: q?._sum.total ? Math.round(((q._sum.score ?? 0) / q._sum.total) * 100) : null,
            lastQuiz: q?._max.createdAt ?? null,
            chats30: chats.find((x) => x.studentId === e.student.id)?._count._all ?? 0,
            flagged: flagged.find((x) => x.studentId === e.student.id)?._count._all ?? 0,
        };
    });
};

/** Old conversations go after the days the school keeps them. */
export const purgeOldChats = async () => {
    const { days } = await getSettings({ days: LEARN.keepDays });
    const r = await db.learnChat.deleteMany({ where: { updatedAt: { lt: new Date(Date.now() - days * 86_400_000) } } });
    return `${r.count} conversations`;
};
