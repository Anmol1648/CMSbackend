import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { getUserAccess } from '../rbac/access.service';
import { currentYear } from '../academic/years.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { raiseLater } from '../alerts/deliver';
import { parentsOf, staffOf, studentsOf } from '../alerts/recipients';
import { defineDailyJob } from '../alerts/jobs';
import { FEEDBACK, Question, STARTER_FORMS } from './feedback.settings';

/**
 * Teacher feedback: question sets; rounds (a set, some sections, open between two dates, anonymous
 * by default); students and parents fill one form per teacher of the section (class teacher and
 * subject teachers); results per teacher and question, shown only with enough responses; comments
 * screened before teachers see them; teachers see their own results once a round is released.
 */

const DAY = 86_400_000;
const staffName = (s: { firstName: string; middleName?: string | null; lastName?: string | null }) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');
const questionsOf = (q: Prisma.JsonValue) => (Array.isArray(q) ? (q as unknown as Question[]) : []);

/** The starter question sets, the first time a school opens the page. */
export const ensureForms = async () => {
    if (await db.feedbackForm.count()) return;
    await db.feedbackForm.createMany({ data: STARTER_FORMS.map((f) => ({ tenantId: getTenantId()!, name: f.name, audience: f.audience, questions: f.questions as unknown as Prisma.InputJsonValue })) });
};

// ─── Question sets ───────────────────────────────────────────────────────────

export const listForms = async () => {
    await ensureForms();
    const rows = await db.feedbackForm.findMany({ orderBy: { createdAt: 'asc' }, include: { _count: { select: { rounds: true } } } });
    return rows.map((f) => ({ id: f.id, name: f.name, audience: f.audience, questions: questionsOf(f.questions), isActive: f.isActive, rounds: f._count.rounds }));
};

export const formSchema = z.strictObject({
    name: z.string().trim().min(3, 'is required').max(120),
    audience: z.enum(['student', 'parent', 'both']),
    questions: z.array(z.strictObject({ id: z.string().trim().min(1).max(20), kind: z.enum(['rating', 'yesno', 'text']), text: z.string().trim().min(3, 'write the question').max(300), required: z.boolean().optional() })).min(1, 'add at least one question').max(30),
    isActive: z.boolean().default(true),
});

export const saveForm = async (id: string | null, input: z.infer<typeof formSchema>) => {
    if (new Set(input.questions.map((q) => q.id)).size !== input.questions.length) throw badRequest('Two questions have the same id');
    if (id && (await db.feedbackRound.count({ where: { formId: id, status: { not: 'draft' } } }))) {
        // Answers point at the question ids: a used set can't lose or change its questions.
        const cur = await db.feedbackForm.findFirst({ where: { id } });
        const old = questionsOf(cur!.questions);
        if (old.some((q) => !input.questions.find((n) => n.id === q.id && n.kind === q.kind))) throw badRequest('This set has been used: you can add questions or change their wording, not remove them. Make a copy for big changes.');
    }
    const data = { name: input.name, audience: input.audience, questions: input.questions as unknown as Prisma.InputJsonValue, isActive: input.isActive };
    const f = id ? await db.feedbackForm.update({ where: { id }, data }) : await db.feedbackForm.create({ data: { ...data, tenantId: getTenantId()! } });
    return { id: f.id };
};

// ─── Who is asked about whom ─────────────────────────────────────────────────

type Sitting = { staffId: string; classTeacher: boolean; subjects: string[] };

/** Each section's teachers: the class teacher and the subject teachers. */
export const teachersBySection = async (yearId: string, sectionIds: string[]) => {
    const [sections, teaching] = await Promise.all([db.section.findMany({ where: { id: { in: sectionIds } }, select: { id: true, classTeacherId: true } }), db.teachingAssignment.findMany({ where: { academicYearId: yearId, sectionId: { in: sectionIds } }, select: { sectionId: true, staffId: true, subject: { select: { name: true } } } })]);
    const out = new Map<string, Sitting[]>();
    for (const s of sections) {
        const m = new Map<string, Sitting>();
        if (s.classTeacherId) m.set(s.classTeacherId, { staffId: s.classTeacherId, classTeacher: true, subjects: [] });
        for (const t of teaching.filter((x) => x.sectionId === s.id)) {
            const cur = m.get(t.staffId) ?? { staffId: t.staffId, classTeacher: false, subjects: [] };
            cur.subjects.push(t.subject.name);
            m.set(t.staffId, cur);
        }
        out.set(s.id, [...m.values()]);
    }
    return out;
};

/** The people who can fill a round: students with a login, and/or parents with a login (one per child). */
const respondents = async (round: { academicYearId: string; sectionIds: string[]; audience: string }) => {
    const enrol = await db.enrolment.findMany({ where: { academicYearId: round.academicYearId, sectionId: { in: round.sectionIds }, student: { status: 'active' } }, select: { sectionId: true, student: { select: { id: true, userId: true, familyId: true } } } });
    const out: { userId: string; studentId: string; sectionId: string; kind: 'student' | 'parent' }[] = [];
    if (round.audience !== 'parent') for (const e of enrol) if (e.student.userId) out.push({ userId: e.student.userId, studentId: e.student.id, sectionId: e.sectionId, kind: 'student' });
    if (round.audience !== 'student') {
        const guardians = await db.guardian.findMany({ where: { familyId: { in: enrol.map((e) => e.student.familyId!).filter(Boolean) }, userId: { not: null } }, select: { familyId: true, userId: true } });
        for (const e of enrol) for (const g of guardians.filter((x) => x.familyId === e.student.familyId)) out.push({ userId: g.userId!, studentId: e.student.id, sectionId: e.sectionId, kind: 'parent' });
    }
    return out;
};

// ─── Rounds ──────────────────────────────────────────────────────────────────

export const roundSchema = z
    .strictObject({
        formId: z.uuid(),
        name: z.string().trim().min(3, 'is required').max(120),
        audience: z.enum(['student', 'parent', 'both']),
        sectionIds: z.array(z.uuid()).min(1, 'choose at least one section').max(200),
        anonymous: z.boolean(),
        opensOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        closesOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .refine((r) => r.closesOn >= r.opensOn, { message: 'is before the opening day', path: ['closesOn'] });

export const roundDefaults = async () => {
    const s = await getSettings({ anon: FEEDBACK.anonymous });
    return { anonymous: s.anon };
};

/** Rounds with how far along they are (forms filled of those expected). */
export const listRounds = async () => {
    const rows = await db.feedbackRound.findMany({ orderBy: { createdAt: 'desc' }, take: 50, include: { form: { select: { name: true } }, _count: { select: { completions: true, responses: true } } } });
    const out = [];
    for (const r of rows) {
        const [who, teachers] = await Promise.all([respondents(r), teachersBySection(r.academicYearId, r.sectionIds)]);
        const expected = who.reduce((a, w) => a + (teachers.get(w.sectionId)?.length ?? 0), 0);
        out.push({ id: r.id, name: r.name, form: r.form.name, audience: r.audience, sections: r.sectionIds.length, anonymous: r.anonymous, opensOn: isoOf(r.opensOn), closesOn: isoOf(r.closesOn), status: r.status, filled: r._count.completions || r._count.responses, expected, people: new Set(who.map((w) => w.userId)).size });
    }
    return out;
};

export const saveRound = async (id: string | null, input: z.infer<typeof roundSchema>, userId: string) => {
    const year = await currentYear();
    if (!year) throw badRequest('No current academic year');
    const form = await db.feedbackForm.findFirst({ where: { id: input.formId } });
    if (!form) throw badRequest('Choose a question set');
    if (form.audience !== 'both' && input.audience !== form.audience) throw badRequest(`This question set is for ${form.audience}s`, [{ field: 'audience', message: `the set is for ${form.audience}s` }]);
    const data = { ...input, opensOn: dayDate(input.opensOn), closesOn: dayDate(input.closesOn) };
    if (id) {
        const cur = await db.feedbackRound.findFirst({ where: { id } });
        if (!cur) throw notFound('Round not found');
        if (cur.status !== 'draft' && (cur.formId !== input.formId || cur.anonymous !== input.anonymous)) throw badRequest('Once opened, the question set and anonymity can’t change');
        await db.feedbackRound.update({ where: { id }, data });
        return { id };
    }
    const r = await db.feedbackRound.create({ data: { ...data, tenantId: getTenantId()!, academicYearId: year.id, createdBy: userId } });
    return { id: r.id };
};

const roundVars = (r: { name: string; closesOn: Date }) => ({ round: r.name, closes: new Date(r.closesOn).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) });

/** Opens a round: everyone asked is told. */
export const openRound = async (id: string) => {
    const r = await db.feedbackRound.findFirst({ where: { id } });
    if (!r) throw notFound('Round not found');
    if (!['draft', 'closed'].includes(r.status)) throw badRequest('Already open');
    if (isoOf(r.closesOn) < todayIST()) throw badRequest('The closing day has passed; change it first');
    await db.feedbackRound.update({ where: { id }, data: { status: 'open', opensOn: isoOf(r.opensOn) > todayIST() ? r.opensOn : dayDate(todayIST()) } });
    const who = await respondents(r);
    const students = [...new Set(who.filter((w) => w.kind === 'student').map((w) => w.studentId))];
    const forParents = [...new Set(who.filter((w) => w.kind === 'parent').map((w) => w.studentId))];
    raiseLater('feedback_open', { ...(students.length ? { student: () => studentsOf(students) } : {}), ...(forParents.length ? { parent: () => parentsOf(forParents) } : {}) }, { ...roundVars(r), anonymous: r.anonymous ? 'Your answers are anonymous: no one sees who wrote what.' : '' }, { dedupe: `feedback-open:${id}` });
    await recordAudit({ action: 'feedback_round_opened', entity: 'feedback_round', entityId: id, changes: { people: new Set(who.map((w) => w.userId)).size } });
    return { opened: true };
};

export const closeRound = async (id: string) => {
    await db.feedbackRound.update({ where: { id }, data: { status: 'closed' } });
    return { closed: true };
};

/** Releases the results to the teachers (if the school lets teachers see theirs). */
export const releaseRound = async (id: string) => {
    const r = await db.feedbackRound.findFirst({ where: { id } });
    if (!r) throw notFound('Round not found');
    if (r.status === 'open') throw badRequest('Close the round first');
    const pending = await db.feedbackResponse.count({ where: { roundId: id, commentStatus: 'pending' } });
    const { screen } = await getSettings({ screen: FEEDBACK.screenComments });
    if (screen && pending) throw badRequest(`${pending} comment${pending === 1 ? ' is' : 's are'} waiting to be screened`);
    await db.feedbackRound.update({ where: { id }, data: { status: 'released', releasedAt: new Date() } });
    const { see } = await getSettings({ see: FEEDBACK.teachersSee });
    if (see) {
        const staff = [...new Set((await db.feedbackResponse.findMany({ where: { roundId: id }, select: { staffId: true }, distinct: ['staffId'] })).map((x) => x.staffId))];
        if (staff.length) raiseLater('feedback_results', { teacher: () => staffOf(staff) }, { round: r.name }, { dedupe: `feedback-results:${id}` });
    }
    await recordAudit({ action: 'feedback_released', entity: 'feedback_round', entityId: id, changes: {} });
    return { released: true };
};

export const deleteRound = async (id: string) => {
    const r = await db.feedbackRound.findFirst({ where: { id } });
    if (!r) throw notFound('Round not found');
    if (r.status !== 'draft') throw badRequest('Only a draft round can be deleted');
    await db.feedbackRound.delete({ where: { id } });
    return { deleted: true };
};

// ─── Filling in ──────────────────────────────────────────────────────────────

/** What a student or parent has to fill: open rounds, each child's teachers, done or not. */
export const myFeedback = async (userId: string) => {
    const year = await currentYear();
    if (!year) return { rounds: [], scale: 5 };
    const today = dayDate(todayIST());
    const rounds = await db.feedbackRound.findMany({ where: { academicYearId: year.id, status: 'open', opensOn: { lte: today }, closesOn: { gte: today } }, include: { form: true } });
    const { scale } = await getSettings({ scale: FEEDBACK.scale });
    const out = [];
    for (const r of rounds) {
        const mine = (await respondents(r)).filter((w) => w.userId === userId);
        if (!mine.length) continue;
        const [teachers, done, staff, students, sections] = await Promise.all([
            teachersBySection(r.academicYearId, [...new Set(mine.map((w) => w.sectionId))]),
            db.feedbackCompletion.findMany({ where: { roundId: r.id, userId }, select: { studentId: true, staffId: true } }),
            db.staff.findMany({ select: { id: true, firstName: true, middleName: true, lastName: true, photoFileId: true } }),
            db.student.findMany({ where: { id: { in: mine.map((w) => w.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true } }),
            db.section.findMany({ where: { id: { in: mine.map((w) => w.sectionId) } }, select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } } } }),
        ]);
        out.push({
            id: r.id,
            name: r.name,
            closesOn: isoOf(r.closesOn),
            anonymous: r.anonymous,
            questions: questionsOf(r.form.questions),
            children: mine.map((w) => ({
                studentId: w.studentId,
                as: w.kind,
                name: fullName(students.find((s) => s.id === w.studentId) ?? { firstName: '' }),
                section: sectionLabel(sections.find((s) => s.id === w.sectionId) ?? { name: '', schoolClass: { name: '', shortName: '' } }),
                teachers: (teachers.get(w.sectionId) ?? []).map((t) => ({ staffId: t.staffId, name: staffName(staff.find((s) => s.id === t.staffId) ?? { firstName: '' }), role: t.classTeacher ? `Class teacher${t.subjects.length ? ` · ${t.subjects.join(', ')}` : ''}` : t.subjects.join(', '), done: done.some((d) => d.studentId === w.studentId && d.staffId === t.staffId) })),
            })),
        });
    }
    return { rounds: out, scale: Number(scale) };
};

export const submitSchema = z.strictObject({ roundId: z.uuid(), staffId: z.uuid(), studentId: z.uuid(), answers: z.record(z.string(), z.union([z.number(), z.boolean(), z.string().max(1000)])) });

export const submit = async (input: z.infer<typeof submitSchema>, userId: string) => {
    const r = await db.feedbackRound.findFirst({ where: { id: input.roundId }, include: { form: true } });
    const today = todayIST();
    if (!r || r.status !== 'open' || isoOf(r.opensOn) > today || isoOf(r.closesOn) < today) throw badRequest('This feedback round isn’t open');
    const me = (await respondents(r)).find((w) => w.userId === userId && w.studentId === input.studentId);
    if (!me) throw forbidden();
    if (!(await teachersBySection(r.academicYearId, [me.sectionId])).get(me.sectionId)?.some((t) => t.staffId === input.staffId)) throw badRequest('This teacher doesn’t teach this class');
    if (await db.feedbackCompletion.findFirst({ where: { roundId: r.id, userId, studentId: input.studentId, staffId: input.staffId } })) throw badRequest('Already filled for this teacher');
    const { scale, screen } = await getSettings({ scale: FEEDBACK.scale, screen: FEEDBACK.screenComments });
    const max = Number(scale);
    const answers: Record<string, number | boolean | string> = {};
    let hasText = false;
    for (const q of questionsOf(r.form.questions)) {
        const v = input.answers[q.id];
        if (v === undefined || v === '' || v === null) {
            if (q.required) throw badRequest(`Answer “${q.text}”`, [{ field: q.id, message: 'is required' }]);
            continue;
        }
        if (q.kind === 'rating') {
            if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) throw badRequest(`“${q.text}” must be 1 to ${max}`);
            answers[q.id] = v;
        } else if (q.kind === 'yesno') {
            if (typeof v !== 'boolean') throw badRequest(`“${q.text}”: yes or no`);
            answers[q.id] = v;
        } else if (typeof v === 'string' && v.trim()) {
            answers[q.id] = v.trim().slice(0, 1000);
            hasText = true;
        }
    }
    await db.feedbackResponse.create({ data: { tenantId: getTenantId()!, roundId: r.id, staffId: input.staffId, sectionId: me.sectionId, respondentKind: me.kind, userId: r.anonymous ? null : userId, studentId: r.anonymous ? null : input.studentId, answers, commentStatus: hasText && screen ? 'pending' : 'shown' } });
    await db.feedbackCompletion.create({ data: { tenantId: getTenantId()!, roundId: r.id, userId, studentId: input.studentId, staffId: input.staffId } });
    return { saved: true };
};

// ─── Results ─────────────────────────────────────────────────────────────────

type Resp = { staffId: string; sectionId: string; respondentKind: string; answers: Prisma.JsonValue; commentStatus: string; id: string; userId: string | null; studentId: string | null; createdAt: Date };

/** Averages of a set of responses: per rating question, overall, yes %, and the text answers. */
const summarise = (rows: Resp[], questions: Question[]) => {
    const per: Record<string, { avg: number | null; n: number; yes?: number | null }> = {};
    const all: number[] = [];
    for (const q of questions) {
        const vals = rows.map((r) => (r.answers as Record<string, unknown>)[q.id]).filter((v) => v !== undefined && v !== null);
        if (q.kind === 'rating') {
            const nums = vals.filter((v): v is number => typeof v === 'number');
            per[q.id] = { avg: nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null, n: nums.length };
            all.push(...nums);
        } else if (q.kind === 'yesno') {
            const b = vals.filter((v): v is boolean => typeof v === 'boolean');
            per[q.id] = { avg: null, n: b.length, yes: b.length ? Math.round((b.filter(Boolean).length / b.length) * 100) : null };
        }
    }
    return { per, overall: all.length ? Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 100) / 100 : null };
};

/** A round's results: every teacher (those who see all results), or only oneself (released rounds). */
export const results = async (roundId: string, userId: string, onlyStaffId?: string) => {
    const r = await db.feedbackRound.findFirst({ where: { id: roundId }, include: { form: true } });
    if (!r) throw notFound('Round not found');
    const a = await getUserAccess(userId);
    const all = !!a.permissions['feedback.results'];
    const s = await getSettings({ min: FEEDBACK.minResponses, see: FEEDBACK.teachersSee, comments: FEEDBACK.teachersSeeComments, scale: FEEDBACK.scale });
    let mine: string | null = null;
    if (!all || onlyStaffId === 'me') {
        if (!a.permissions['feedback.own'] || !s.see) throw forbidden();
        if (r.status !== 'released') throw badRequest('These results aren’t released yet');
        mine = (await db.staff.findFirst({ where: { userId }, select: { id: true } }))?.id ?? null;
        if (!mine) throw forbidden();
    }
    const questions = questionsOf(r.form.questions);
    const rows = (await db.feedbackResponse.findMany({ where: { roundId, ...(mine ? { staffId: mine } : onlyStaffId ? { staffId: onlyStaffId } : {}) } })) as Resp[];
    const everyone = (await db.feedbackResponse.findMany({ where: { roundId } })) as Resp[];
    const [staff, sections] = await Promise.all([db.staff.findMany({ where: { id: { in: [...new Set(rows.map((x) => x.staffId))] } }, select: { id: true, firstName: true, middleName: true, lastName: true } }), db.section.findMany({ where: { id: { in: r.sectionIds } }, select: { id: true, name: true, sortOrder: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } } })]);
    const school = summarise(everyone, questions);
    const showComments = all || s.comments;
    const teachers = staff
        .map((st) => {
            const theirs = rows.filter((x) => x.staffId === st.id);
            const enough = theirs.length >= s.min;
            const sum = summarise(theirs, questions);
            const bySection = [...new Set(theirs.map((x) => x.sectionId))].map((sid) => {
                const part = theirs.filter((x) => x.sectionId === sid);
                const sec = sections.find((x) => x.id === sid);
                return { section: sec ? sectionLabel(sec) : '', responses: part.length, overall: part.length >= s.min ? summarise(part, questions).overall : null };
            });
            const texts = showComments ? theirs.filter((x) => all || x.commentStatus === 'shown').flatMap((x) => questions.filter((q) => q.kind === 'text').map((q) => ({ responseId: x.id, question: q.text, text: (x.answers as Record<string, unknown>)[q.id], status: x.commentStatus, kind: x.respondentKind })).filter((c) => typeof c.text === 'string' && c.text)) : [];
            return { staffId: st.id, name: staffName(st), responses: theirs.length, enough, overall: enough ? sum.overall : null, per: enough ? sum.per : {}, bySection, comments: enough || all ? texts : [] };
        })
        .sort((x, y) => (y.overall ?? -1) - (x.overall ?? -1));
    return { round: { id: r.id, name: r.name, status: r.status, anonymous: r.anonymous, opensOn: isoOf(r.opensOn), closesOn: isoOf(r.closesOn) }, questions, scale: Number(s.scale), minResponses: s.min, school: { overall: school.overall, per: school.per, responses: everyone.length }, teachers, all: !mine };
};

/** A teacher's own released rounds. */
export const myRounds = async (userId: string) => {
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    if (!staff) return [];
    const rounds = await db.feedbackRound.findMany({ where: { status: 'released', responses: { some: { staffId: staff.id } } }, orderBy: { releasedAt: 'desc' }, select: { id: true, name: true, closesOn: true, releasedAt: true } });
    return rounds.map((r) => ({ id: r.id, name: r.name, closesOn: isoOf(r.closesOn), releasedAt: r.releasedAt }));
};

// ─── Comment screening ───────────────────────────────────────────────────────

export const pendingComments = async (roundId: string) => {
    const r = await db.feedbackRound.findFirst({ where: { id: roundId }, include: { form: true } });
    if (!r) throw notFound('Round not found');
    const questions = questionsOf(r.form.questions).filter((q) => q.kind === 'text');
    const rows = await db.feedbackResponse.findMany({ where: { roundId, commentStatus: { in: ['pending', 'hidden'] } }, orderBy: { createdAt: 'asc' } });
    const staff = await db.staff.findMany({ where: { id: { in: rows.map((x) => x.staffId) } }, select: { id: true, firstName: true, middleName: true, lastName: true } });
    return rows.map((x) => ({ id: x.id, teacher: staffName(staff.find((s) => s.id === x.staffId) ?? { firstName: '' }), kind: x.respondentKind, status: x.commentStatus, texts: questions.map((q) => (x.answers as Record<string, unknown>)[q.id]).filter((t): t is string => typeof t === 'string' && !!t) }));
};

export const screen = async (responseIds: string[], status: 'shown' | 'hidden') => {
    const r = await db.feedbackResponse.updateMany({ where: { id: { in: responseIds } }, data: { commentStatus: status } });
    return { updated: r.count };
};

// ─── Daily: reminders and closing ────────────────────────────────────────────

defineDailyJob({
    key: 'feedback_rounds',
    run: async () => {
        const today = todayIST();
        const { days } = await getSettings({ days: FEEDBACK.remindDays });
        // Past their closing day: closed.
        const closed = await db.feedbackRound.updateMany({ where: { status: 'open', closesOn: { lt: dayDate(today) } }, data: { status: 'closed' } });
        let reminded = 0;
        if (days) {
            const due = await db.feedbackRound.findMany({ where: { status: 'open', closesOn: dayDate(isoOf(new Date(dayDate(today).getTime() + days * DAY))) } });
            for (const r of due) {
                const [who, teachers, done] = await Promise.all([respondents(r), teachersBySection(r.academicYearId, r.sectionIds), db.feedbackCompletion.findMany({ where: { roundId: r.id }, select: { userId: true, studentId: true, staffId: true } })]);
                const left = who.filter((w) => (teachers.get(w.sectionId) ?? []).some((t) => !done.some((d) => d.userId === w.userId && d.studentId === w.studentId && d.staffId === t.staffId)));
                const students = [...new Set(left.filter((w) => w.kind === 'student').map((w) => w.studentId))];
                const parents = [...new Set(left.filter((w) => w.kind === 'parent').map((w) => w.studentId))];
                raiseLater('feedback_reminder', { ...(students.length ? { student: () => studentsOf(students) } : {}), ...(parents.length ? { parent: () => parentsOf(parents) } : {}) }, roundVars(r), { dedupe: `feedback-remind:${r.id}` });
                reminded += new Set(left.map((w) => w.userId)).size;
            }
        }
        return `${closed.count} closed, ${reminded} reminded`;
    },
});
