import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { currentYear } from '../academic/years.service';
import { registerImport } from '../imports/import.service';
import { QUESTION_TYPES, TYPE_LABEL } from './questions.settings';
import { createQuestion, QuestionInput, questionSchema } from './questions.service';

/** Excel imports: chapters, and questions (Learning → Question Bank → Import). */

interface Ctx {
    classes: Map<string, string>;
    subjects: Map<string, string>;
    classSubjects: Set<string>;
    chapters: Map<string, string>;
    difficulty: Map<string, string>;
}

const prepare = async (): Promise<Ctx> => {
    const year = await currentYear();
    const [classes, subjects, cs, chapters, difficulty] = await Promise.all([
        db.schoolClass.findMany({ select: { id: true, name: true, shortName: true } }),
        db.subject.findMany({ select: { id: true, name: true, code: true } }),
        year ? db.classSubject.findMany({ where: { academicYearId: year.id }, select: { classId: true, subjectId: true } }) : [],
        db.chapter.findMany({ select: { id: true, classId: true, subjectId: true, name: true } }),
        db.masterValue.findMany({ where: { master: 'question_difficulty' }, select: { id: true, name: true } }),
    ]);
    const map = <T>(rows: T[], keys: (r: T) => (string | null | undefined)[], id: (r: T) => string) => new Map(rows.flatMap((r) => keys(r).filter((k): k is string => !!k).map((k) => [k.trim().toLowerCase(), id(r)] as const)));
    return {
        classes: map(classes, (c) => [c.name, c.shortName], (c) => c.id),
        subjects: map(subjects, (s) => [s.name, s.code], (s) => s.id),
        classSubjects: new Set(cs.map((c) => `${c.classId}|${c.subjectId}`)),
        chapters: new Map(chapters.map((c) => [`${c.classId}|${c.subjectId}|${c.name.toLowerCase()}`, c.id])),
        difficulty: new Map(difficulty.map((d) => [d.name.toLowerCase(), d.id])),
    };
};

const lookup = (row: { values: Record<string, unknown>; issues: { field: string; message: string }[] }, ctx: Ctx) => {
    const classId = ctx.classes.get(String(row.values.class ?? '').trim().toLowerCase());
    const subjectId = ctx.subjects.get(String(row.values.subject ?? '').trim().toLowerCase());
    if (!classId) row.issues.push({ field: 'Class', message: 'is not a class of the school' });
    if (!subjectId) row.issues.push({ field: 'Subject', message: 'is not a subject of the school' });
    if (classId && subjectId && !ctx.classSubjects.has(`${classId}|${subjectId}`)) row.issues.push({ field: 'Subject', message: 'is not taught in that class this session' });
    return { classId, subjectId };
};

registerImport<Ctx>({
    kind: 'chapters',
    label: 'Chapters',
    permission: 'syllabus.manage',
    columns: async () => [
        { key: 'class', header: 'Class', type: 'text', required: true, example: 'Class VII' },
        { key: 'subject', header: 'Subject', type: 'text', required: true, example: 'Science' },
        { key: 'chapter', header: 'Chapter', type: 'text', required: true, max: 150, help: 'A chapter already there is left as it is.', example: 'Nutrition in Plants' },
        { key: 'topics', header: 'Topics', type: 'text', max: 2000, help: 'Comma-separated.', example: 'Photosynthesis, Modes of nutrition' },
    ],
    prepare,
    check: (row, ctx) => {
        lookup(row, ctx);
    },
    importRow: async (row, ctx, userId) => {
        const { classId, subjectId } = lookup(row, ctx);
        const name = String(row.values.chapter).trim();
        const key = `${classId}|${subjectId}|${name.toLowerCase()}`;
        if (ctx.chapters.has(key)) return { Chapter: name, Result: 'Already there' };
        const max = (await db.chapter.aggregate({ where: { classId: classId!, subjectId: subjectId! }, _max: { sortOrder: true } }))._max.sortOrder ?? 0;
        const c = await db.chapter.create({ data: { tenantId: getTenantId()!, classId: classId!, subjectId: subjectId!, name, topics: String(row.values.topics ?? '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 40), sortOrder: max + 10, createdBy: userId } });
        ctx.chapters.set(key, c.id);
        return { Chapter: name, Result: 'Added' };
    },
});

const TYPE_BY_LABEL = new Map<string, (typeof QUESTION_TYPES)[number]>([...QUESTION_TYPES.map((t) => [t, t] as const), ...QUESTION_TYPES.map((t) => [TYPE_LABEL[t].toLowerCase(), t] as const), ['mcq', 'mcq'], ['true/false', 'true_false'], ['fill', 'fill']]);
const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f'];

/** A row of the sheet as a question (or the problem with it). */
const toQuestion = (row: { values: Record<string, unknown> }, ctx: Ctx, ids: { classId?: string; subjectId?: string }) => {
    const v = row.values;
    const type = TYPE_BY_LABEL.get(String(v.type ?? '').trim().toLowerCase());
    const correct = String(v.correct ?? '').toLowerCase().split(/[\s,;/]+/).filter(Boolean);
    const options = LETTERS.map((l) => ({ l, text: String(v[`option_${l}`] ?? '').trim() })).filter((o) => o.text);
    const chapterId = v.chapter ? ctx.chapters.get(`${ids.classId}|${ids.subjectId}|${String(v.chapter).trim().toLowerCase()}`) : null;
    const tf = correct[0] === 'true' || correct[0] === 't' ? 'true' : correct[0] === 'false' || correct[0] === 'f' ? 'false' : null;
    return {
        chapterMissing: !!v.chapter && !chapterId,
        input: {
            classId: ids.classId,
            subjectId: ids.subjectId,
            chapterId: chapterId ?? null,
            type,
            text: String(v.question ?? '').trim(),
            options: type === 'mcq' || type === 'multi' ? options.map((o) => ({ text: o.text, correct: correct.includes(o.l) })) : [],
            answer: type === 'true_false' ? tf : v.answer ? String(v.answer).trim() : null,
            explanation: v.explanation ? String(v.explanation).trim() : null,
            marks: Number(v.marks) || 1,
            difficultyId: v.difficulty ? (ctx.difficulty.get(String(v.difficulty).trim().toLowerCase()) ?? null) : null,
        },
    };
};

registerImport<Ctx>({
    kind: 'questions',
    label: 'Questions',
    permission: 'question.add',
    columns: async () => [
        { key: 'class', header: 'Class', type: 'text', required: true, example: 'Class VII' },
        { key: 'subject', header: 'Subject', type: 'text', required: true, example: 'Science' },
        { key: 'chapter', header: 'Chapter', type: 'text', help: 'As on the Chapters screen (optional).', example: 'Nutrition in Plants' },
        { key: 'type', header: 'Type', type: 'choice', required: true, choices: QUESTION_TYPES.map((t) => TYPE_LABEL[t]), example: TYPE_LABEL.mcq },
        { key: 'question', header: 'Question', type: 'text', required: true, max: 5000, help: 'Fill in the blank: write ____ for the blank.', example: 'Which gas do plants take in for photosynthesis?' },
        { key: 'option_a', header: 'Option A', type: 'text', max: 500, example: 'Oxygen' },
        { key: 'option_b', header: 'Option B', type: 'text', max: 500, example: 'Carbon dioxide' },
        { key: 'option_c', header: 'Option C', type: 'text', max: 500, example: 'Nitrogen' },
        { key: 'option_d', header: 'Option D', type: 'text', max: 500, example: 'Hydrogen' },
        { key: 'option_e', header: 'Option E', type: 'text', max: 500 },
        { key: 'correct', header: 'Correct', type: 'text', max: 20, help: 'Multiple choice: the letter(s), e.g. B or A,C. True / false: True or False.', example: 'B' },
        { key: 'answer', header: 'Answer', type: 'text', max: 5000, help: 'Fill in the blank: the word(s), | between accepted ones. Short / long: a model answer.' },
        { key: 'explanation', header: 'Explanation', type: 'text', max: 5000 },
        { key: 'marks', header: 'Marks', type: 'number', example: '1' },
        { key: 'difficulty', header: 'Difficulty', type: 'text', help: 'As in Masters → Difficulty levels.', example: 'Easy' },
    ],
    prepare,
    check: (row, ctx) => {
        const ids = lookup(row, ctx);
        if (!ids.classId || !ids.subjectId) return;
        const { input, chapterMissing } = toQuestion(row, ctx, ids);
        if (chapterMissing) row.issues.push({ field: 'Chapter', message: 'is not a chapter of the subject (add it on Chapters first)' });
        if (!input.type) {
            row.issues.push({ field: 'Type', message: 'is not one of the kinds' });
            return;
        }
        const r = questionSchema.safeParse(input);
        if (!r.success) for (const i of r.error.issues) row.issues.push({ field: String(i.path[0] ?? 'Question'), message: i.message });
    },
    importRow: async (row, ctx, userId) => {
        const ids = lookup(row, ctx);
        const { input } = toQuestion(row, ctx, ids);
        const q = await createQuestion(questionSchema.parse(input) as QuestionInput, userId);
        // Imported, not typed.
        await db.question.update({ where: { id: q.id }, data: { source: 'import' } });
        return { Question: input.text.slice(0, 60), Result: q.status === 'approved' ? 'Added' : 'Added, waits for review' };
    },
});
