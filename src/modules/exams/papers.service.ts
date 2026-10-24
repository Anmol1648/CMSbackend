import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { getUserAccess } from '../rbac/access.service';
import { isoOf, todayIST } from '../attendance/attendance.settings';
import { loadExam } from './setup.service';

/**
 * Question papers: one per exam subject of a class, built from the question bank (approved
 * questions, picked by hand or filled by chapter / type / marks) or an uploaded file. Seen only by
 * those with exam.papers and the teachers of that subject in that class.
 */

type Line = { section: string; questionId: string; marks: number };

const mayMake = async (userId: string, yearId: string, classId: string, subjectId: string) => {
    const a = await getUserAccess(userId);
    if (a.permissions['exam.papers']) return true;
    if (!a.permissions['exam.marks']) return false;
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    if (!staff) return false;
    return !!(await db.teachingAssignment.findFirst({ where: { academicYearId: yearId, staffId: staff.id, subjectId, section: { classId } }, select: { id: true } }));
};

/** The exam subjects whose papers the person may make, with each paper's state. */
export const paperList = async (examId: string, userId: string) => {
    const exam = await loadExam(examId);
    const subs = await db.examSubject.findMany({ where: { examId }, orderBy: [{ classId: 'asc' }, { sortOrder: 'asc' }] });
    const a = await getUserAccess(userId);
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    const teaches = a.permissions['exam.papers'] || !staff ? [] : await db.teachingAssignment.findMany({ where: { academicYearId: exam.academicYearId, staffId: staff.id }, select: { subjectId: true, section: { select: { classId: true } } } });
    const allowed = (classId: string, subjectId: string) => !!a.permissions['exam.papers'] || teaches.some((t) => t.subjectId === subjectId && t.section.classId === classId);
    const [papers, subjects, classes] = await Promise.all([db.examPaper.findMany({ where: { examId } }), db.subject.findMany({ where: { id: { in: subs.map((s) => s.subjectId) } }, select: { id: true, name: true } }), db.schoolClass.findMany({ where: { id: { in: subs.map((s) => s.classId) } }, select: { id: true, name: true, sortOrder: true } })]);
    return {
        exam: { id: exam.id, name: exam.name },
        rows: subs
            .filter((s) => allowed(s.classId, s.subjectId))
            .map((s) => {
                const p = papers.find((x) => x.classId === s.classId && x.subjectId === s.subjectId);
                const cl = classes.find((c) => c.id === s.classId);
                return { classId: s.classId, className: cl?.name ?? '', classOrder: cl?.sortOrder ?? 0, subjectId: s.subjectId, subject: subjects.find((x) => x.id === s.subjectId)?.name ?? '', date: s.date ? isoOf(s.date) : null, max: (s.components as { max: number }[]).reduce((t, c) => t + c.max, 0), paper: p ? { id: p.id, status: p.status, questions: (p.questions as Line[]).length, marks: (p.questions as Line[]).reduce((t, q) => t + q.marks, 0), file: !!p.fileId } : null };
            })
            .sort((x, y) => x.classOrder - y.classOrder || x.subject.localeCompare(y.subject)),
    };
};

/** One paper (made empty if new), with its questions written out. */
export const getPaper = async (examId: string, classId: string, subjectId: string, userId: string) => {
    const exam = await loadExam(examId);
    if (!(await mayMake(userId, exam.academicYearId, classId, subjectId))) throw forbidden('Only the subject’s teachers and the exam office see this paper');
    const es = await db.examSubject.findFirst({ where: { examId, classId, subjectId } });
    if (!es) throw notFound('This class does not write that subject in the exam');
    const [p, subject, cls] = await Promise.all([db.examPaper.findFirst({ where: { examId, classId, subjectId } }), db.subject.findUnique({ where: { id: subjectId }, select: { name: true } }), db.schoolClass.findUnique({ where: { id: classId }, select: { name: true } })]);
    const lines = (p?.questions ?? []) as Line[];
    const qs = await db.question.findMany({ where: { id: { in: lines.map((l) => l.questionId) } } });
    const chapters = await db.chapter.findMany({ where: { id: { in: qs.map((q) => q.chapterId!).filter(Boolean) } }, select: { id: true, name: true } });
    return {
        id: p?.id ?? null,
        exam: { id: exam.id, name: exam.name },
        className: cls?.name ?? '',
        subject: subject?.name ?? '',
        date: es.date ? isoOf(es.date) : null,
        max: (es.components as { max: number }[]).reduce((t, c) => t + c.max, 0),
        title: p?.title ?? `${exam.name}: ${subject?.name ?? ''} (${cls?.name ?? ''})`,
        instructions: p?.instructions ?? 'All questions are compulsory.\nWrite neatly; marks are shown against each question.',
        durationMins: p?.durationMins ?? 180,
        status: p?.status ?? 'draft',
        fileId: p?.fileId ?? null,
        lines: lines.map((l) => {
            const q = qs.find((x) => x.id === l.questionId);
            return { ...l, type: q?.type ?? '', text: q?.text ?? '(question removed from the bank)', chapter: chapters.find((c) => c.id === q?.chapterId)?.name ?? '' };
        }),
    };
};

export const paperSchema = z.strictObject({
    title: z.string().trim().min(2).max(200),
    instructions: z.string().trim().max(2000).nullable().optional(),
    durationMins: z.number().int().min(10).max(600),
    lines: z.array(z.strictObject({ section: z.string().trim().max(20), questionId: z.uuid(), marks: z.number().min(0).max(100) })).max(200),
    fileId: z.uuid().nullable().optional(),
    status: z.enum(['draft', 'final']),
});

export const savePaper = async (examId: string, classId: string, subjectId: string, input: z.infer<typeof paperSchema>, userId: string, opts: { isDemo?: boolean } = {}) => {
    const exam = await loadExam(examId);
    if (!(await mayMake(userId, exam.academicYearId, classId, subjectId))) throw forbidden('Only the subject’s teachers and the exam office make this paper');
    if (!(await db.examSubject.findFirst({ where: { examId, classId, subjectId }, select: { id: true } }))) throw notFound('This class does not write that subject in the exam');
    const data = { title: input.title, instructions: input.instructions || null, durationMins: input.durationMins, questions: input.lines, fileId: input.fileId ?? null, status: input.status };
    await db.examPaper.upsert({ where: { examId_classId_subjectId: { examId, classId, subjectId } }, create: { ...data, tenantId: getTenantId()!, examId, classId, subjectId, createdBy: userId, isDemo: !!opts.isDemo }, update: data });
    return getPaper(examId, classId, subjectId, userId);
};

/** Bank questions of the class and subject to pick from (approved, filtered). */
export const bankQuery = z.object({ chapter: z.uuid().optional(), type: z.string().max(20).optional(), marks: z.coerce.number().optional(), search: z.string().max(60).optional() });
export const bank = async (examId: string, classId: string, subjectId: string, q: z.infer<typeof bankQuery>, userId: string) => {
    const exam = await loadExam(examId);
    if (!(await mayMake(userId, exam.academicYearId, classId, subjectId))) throw forbidden();
    const [rows, chapters] = await Promise.all([
        db.question.findMany({ where: { classId, subjectId, status: 'approved', ...(q.chapter ? { chapterId: q.chapter } : {}), ...(q.type ? { type: q.type } : {}), ...(q.marks ? { marks: q.marks } : {}), ...(q.search ? { text: { contains: q.search, mode: 'insensitive' } } : {}) }, take: 200, orderBy: [{ chapterId: 'asc' }, { marks: 'asc' }] }),
        db.chapter.findMany({ where: { classId, subjectId }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } }),
    ]);
    return { chapters, questions: rows.map((r) => ({ id: r.id, type: r.type, text: r.text, marks: r.marks, chapter: chapters.find((c) => c.id === r.chapterId)?.name ?? '' })) };
};

/** Fills a paper automatically: N questions of each (type, marks) from the chosen chapters, at random. */
export const autoSchema = z.strictObject({ chapterIds: z.array(z.uuid()).max(60), plan: z.array(z.strictObject({ section: z.string().max(20), type: z.string().max(20), marks: z.number().min(0).max(100), count: z.number().int().min(1).max(50) })).min(1).max(12) });
export const autoFill = async (examId: string, classId: string, subjectId: string, input: z.infer<typeof autoSchema>, userId: string) => {
    const exam = await loadExam(examId);
    if (!(await mayMake(userId, exam.academicYearId, classId, subjectId))) throw forbidden();
    const lines: Line[] = [];
    const short: string[] = [];
    for (const p of input.plan) {
        const pool = await db.question.findMany({ where: { classId, subjectId, status: 'approved', type: p.type, ...(input.chapterIds.length ? { chapterId: { in: input.chapterIds } } : {}), id: { notIn: lines.map((l) => l.questionId) } }, select: { id: true } });
        const picked = pool.sort(() => Math.random() - 0.5).slice(0, p.count);
        if (picked.length < p.count) short.push(`${p.count - picked.length} × ${p.type} (${p.marks} marks)`);
        lines.push(...picked.map((x) => ({ section: p.section, questionId: x.id, marks: p.marks })));
    }
    if (!lines.length) throw badRequest('The question bank has no approved questions for this. Add some on Learning → Question Bank.');
    return { lines, short };
};

/** The paper for printing (and its answer key): only for those who may see it. */
export const paperDocument = async (examId: string, classId: string, subjectId: string, userId: string, withKey: boolean) => {
    const p = await getPaper(examId, classId, subjectId, userId);
    if (!p.id) throw badRequest('Save the paper first');
    const qs = await db.question.findMany({ where: { id: { in: p.lines.map((l) => l.questionId) } } });
    const sections: { name: string; marks: number; questions: { no: number; text: string; marks: number; options: string[]; answer: string }[] }[] = [];
    let no = 0;
    for (const l of p.lines) {
        const q = qs.find((x) => x.id === l.questionId);
        const opts = Array.isArray(q?.options) ? (q!.options as { text: string; correct?: boolean }[]) : [];
        const answer = q ? (opts.length ? opts.filter((o) => o.correct).map((o) => o.text).join(', ') : (q.answer ?? '')) : '';
        let sec = sections.find((s) => s.name === (l.section || ''));
        if (!sec) sections.push((sec = { name: l.section || '', marks: 0, questions: [] }));
        sec.marks += l.marks;
        sec.questions.push({ no: ++no, text: q?.text ?? '', marks: l.marks, options: opts.map((o, i) => `(${String.fromCharCode(97 + i)}) ${o.text}`), answer });
    }
    return { title: p.title, className: p.className, subject: p.subject, exam: p.exam.name, date: p.date, duration: `${Math.floor(p.durationMins / 60) ? `${Math.floor(p.durationMins / 60)} h ` : ''}${p.durationMins % 60 ? `${p.durationMins % 60} min` : ''}`.trim(), max: p.lines.reduce((t, l) => t + l.marks, 0), instructions: (p.instructions ?? '').split('\n').filter(Boolean), sections, withKey, today: todayIST() };
};
