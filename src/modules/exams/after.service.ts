import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { getUserAccess } from '../rbac/access.service';
import { fullName } from '../students/students.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { isoOf, todayIST } from '../attendance/attendance.settings';
import { registerFeeSource } from '../fees/dues.service';
import { raiseLater } from '../alerts/deliver';
import { holdersOf, usersOf } from '../alerts/recipients';
import { Part } from './setup.service';
import { computeResults, mapLimit } from './results.service';
import { EXAMS2 } from './exams2.settings';

/**
 * After the result: the supplementary exam (students who failed in up to N subjects of the final
 * result write those subjects again; their marks replace them in the final result), and re-check
 * requests from parents (reviewed by the subject teacher, decided by exam.recheck; marks change only
 * when approved, and every change is recorded).
 */

const DAY = 86_400_000;

// ─── Supplementary ───────────────────────────────────────────────────────────

/** Students of the session who failed in 1..N subjects of the final result (N from System Settings). */
export const supplementaryCandidates = async (yearId: string, classId?: string) => {
    const { n } = await getSettings({ n: EXAMS2.supplementarySubjects });
    if (!n) return { limit: 0, sections: [], existing: [] };
    const sections = await db.section.findMany({ where: { academicYearId: yearId, isActive: true, ...(classId ? { classId } : {}) }, orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }], select: { id: true, name: true, classId: true, schoolClass: { select: { name: true, shortName: true } } } });
    const results = await mapLimit(sections, 3, (sec) => computeResults('final', yearId, sec.id).catch(() => null));
    const out = [];
    for (const [k, sec] of sections.entries()) {
        const r = results[k];
        if (!r) continue;
        const list = r.students
            .map((s) => ({ s, failed: s.subjects.filter((x) => x.passed === false && !x.supplementary) }))
            .filter((x) => x.failed.length >= 1 && x.failed.length <= n)
            .map(({ s, failed }) => ({ studentId: s.student.id, name: s.student.name, admissionNo: s.student.admissionNo, subjects: failed.map((f) => ({ subjectId: f.subjectId, subject: f.subject, percent: f.percent })) }));
        if (list.length) out.push({ sectionId: sec.id, section: sectionLabel(sec), classId: sec.classId, students: list });
    }
    const existing = await db.exam.findMany({ where: { academicYearId: yearId, kind: 'supplementary' }, select: { id: true, name: true, status: true, candidates: true } });
    return { limit: n, sections: out, existing: existing.map((e) => ({ id: e.id, name: e.name, status: e.status, students: Object.keys((e.candidates ?? {}) as object).length })) };
};

export const supplementarySchema = z.strictObject({ name: z.string().trim().min(2).max(80), candidates: z.record(z.uuid(), z.array(z.uuid()).min(1).max(10)) });

/** Makes the supplementary exam: the candidates' classes and failed subjects (parts as in the session's last exam). */
export const createSupplementary = async (yearId: string, input: z.infer<typeof supplementarySchema>, userId: string, opts: { isDemo?: boolean } = {}) => {
    const ids = Object.keys(input.candidates);
    if (!ids.length) throw badRequest('Choose the students');
    const enrol = await db.enrolment.findMany({ where: { academicYearId: yearId, studentId: { in: ids } }, select: { studentId: true, section: { select: { classId: true } } } });
    const classIds = [...new Set(enrol.map((e) => e.section.classId))];
    const regular = await db.exam.findMany({ where: { academicYearId: yearId, kind: 'regular' }, orderBy: { sortOrder: 'desc' }, select: { id: true } });
    const lastSubs = await db.examSubject.findMany({ where: { examId: { in: regular.map((r) => r.id) } }, select: { examId: true, classId: true, subjectId: true, components: true } });
    const order = new Map(regular.map((r, i) => [r.id, i]));
    const partsOf = (classId: string, subjectId: string) => lastSubs.filter((s) => s.classId === classId && s.subjectId === subjectId).sort((a, b) => (order.get(a.examId) ?? 0) - (order.get(b.examId) ?? 0))[0]?.components ?? [{ key: 'th', label: 'Written', max: 100 }];
    const tenantId = getTenantId()!;
    const maxOrder = await db.exam.aggregate({ where: { academicYearId: yearId }, _max: { sortOrder: true } });
    const exam = await db.exam.create({ data: { tenantId, academicYearId: yearId, name: input.name, shortName: 'Supp.', kind: 'supplementary', candidates: input.candidates, classIds, countsInResult: false, weightage: 0, status: 'open', sortOrder: (maxOrder._max.sortOrder ?? 0) + 1, isDemo: !!opts.isDemo } });
    const pairs = new Map<string, { classId: string; subjectId: string }>();
    for (const e of enrol) for (const sub of input.candidates[e.studentId] ?? []) pairs.set(`${e.section.classId}|${sub}`, { classId: e.section.classId, subjectId: sub });
    let i = 0;
    for (const p of pairs.values()) await db.examSubject.create({ data: { tenantId, examId: exam.id, classId: p.classId, subjectId: p.subjectId, components: partsOf(p.classId, p.subjectId) as object, sortOrder: i++ } });
    await recordAudit({ action: 'supplementary_exam_created', entity: 'exam', entityId: exam.id, changes: { students: ids.length, papers: pairs.size, by: userId } });
    return { id: exam.id, papers: pairs.size, students: ids.length };
};

// ─── Re-checks ───────────────────────────────────────────────────────────────

const mineCheck = async (userId: string, studentId: string) => {
    const s = await db.student.findFirst({ where: { id: studentId, OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, select: { id: true } });
    if (!s) throw forbidden();
};

/** Whether a re-check can be asked for this child's exam, the last date, the fee and the subjects. */
export const recheckOptions = async (examId: string, studentId: string, userId: string) => {
    await mineCheck(userId, studentId);
    const s = await getSettings({ on: EXAMS2.recheck, days: EXAMS2.recheckDays, fee: EXAMS2.recheckFee });
    const exam = await db.exam.findFirst({ where: { id: examId } });
    if (!exam) throw notFound('Exam not found');
    const enrol = await db.enrolment.findFirst({ where: { academicYearId: exam.academicYearId, studentId }, select: { section: { select: { classId: true } } } });
    const lastDate = exam.publishedAt ? isoOf(new Date(exam.publishedAt.getTime() + s.days * DAY + 5.5 * 3_600_000)) : null;
    const why = !s.on ? 'The school does not take re-check requests' : exam.status !== 'published' ? 'The results are not published' : lastDate && lastDate < todayIST() ? `The last date (${lastDate}) has passed` : null;
    const subs = enrol ? await db.examSubject.findMany({ where: { examId, classId: enrol.section.classId }, orderBy: { sortOrder: 'asc' } }) : [];
    const [marks, open, names] = await Promise.all([db.examMark.findMany({ where: { examSubjectId: { in: subs.map((x) => x.id) }, studentId } }), db.examRecheck.findMany({ where: { examId, studentId } }), db.subject.findMany({ where: { id: { in: subs.map((x) => x.subjectId) } }, select: { id: true, name: true } })]);
    return {
        allowed: !why,
        why,
        lastDate,
        fee: s.fee,
        subjects: subs
            .filter((x) => marks.some((m) => m.examSubjectId === x.id && m.status === 'P'))
            .map((x) => ({ examSubjectId: x.id, subject: names.find((n) => n.id === x.subjectId)?.name ?? '', marks: marks.find((m) => m.examSubjectId === x.id)?.total ?? null, max: (x.components as Part[]).reduce((t, c) => t + c.max, 0), asked: open.find((o) => o.examSubjectId === x.id)?.status ?? null })),
    };
};

export const recheckSchema = z.strictObject({ examId: z.uuid(), studentId: z.uuid(), examSubjectId: z.uuid(), reason: z.string().trim().max(500).nullable().optional() });
export const askRecheck = async (input: z.infer<typeof recheckSchema>, userId: string, opts: { isDemo?: boolean } = {}) => {
    const o = await recheckOptions(input.examId, input.studentId, userId);
    if (!o.allowed) throw badRequest(o.why ?? 'Not allowed');
    const sub = o.subjects.find((x) => x.examSubjectId === input.examSubjectId);
    if (!sub) throw badRequest('Choose a subject with marks');
    if (sub.asked) throw badRequest('A re-check of this subject is already asked for');
    const [exam, mark] = await Promise.all([db.exam.findFirst({ where: { id: input.examId }, select: { academicYearId: true, name: true } }), db.examMark.findFirst({ where: { examSubjectId: input.examSubjectId, studentId: input.studentId } })]);
    const r = await db.examRecheck.create({ data: { tenantId: getTenantId()!, academicYearId: exam!.academicYearId, examId: input.examId, examSubjectId: input.examSubjectId, studentId: input.studentId, requestedBy: userId, reason: input.reason || null, fee: o.fee || null, oldMarks: (mark?.marks ?? {}) as object, oldTotal: mark?.total ?? null, isDemo: !!opts.isDemo } });
    const st = await db.student.findFirst({ where: { id: input.studentId }, select: { firstName: true, middleName: true, lastName: true } });
    raiseLater('exam_recheck_asked', { office: () => holdersOf('exam.recheck') }, { student: st ? fullName(st) : '', exam: exam!.name, subject: sub.subject }, { dedupe: `recheck:${r.id}` });
    return { id: r.id };
};

const recheckRows = async (where: object) => {
    const rows = await db.examRecheck.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
    const [subs, students, exams, users] = await Promise.all([
        db.examSubject.findMany({ where: { id: { in: rows.map((r) => r.examSubjectId) } }, select: { id: true, subjectId: true, classId: true, components: true } }),
        db.student.findMany({ where: { id: { in: rows.map((r) => r.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } }),
        db.exam.findMany({ where: { id: { in: rows.map((r) => r.examId) } }, select: { id: true, name: true } }),
        db.user.findMany({ where: { id: { in: rows.flatMap((r) => [r.requestedBy, r.reviewedBy, r.decidedBy]).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } }),
    ]);
    const names = await db.subject.findMany({ where: { id: { in: subs.map((s) => s.subjectId) } }, select: { id: true, name: true } });
    const un = (id: string | null) => (id ? (users.find((u) => u.id === id)?.displayName ?? '') : '');
    return rows.map((r) => {
        const es = subs.find((s) => s.id === r.examSubjectId);
        const st = students.find((s) => s.id === r.studentId);
        return { id: r.id, exam: exams.find((e) => e.id === r.examId)?.name ?? '', examId: r.examId, examSubjectId: r.examSubjectId, subject: names.find((n) => n.id === es?.subjectId)?.name ?? '', parts: (es?.components ?? []) as Part[], student: st ? fullName(st) : '', admissionNo: st?.admissionNo ?? '', studentId: r.studentId, reason: r.reason, fee: r.fee, status: r.status, oldMarks: r.oldMarks as Record<string, number>, oldTotal: r.oldTotal, newMarks: (r.newMarks ?? null) as Record<string, number> | null, newTotal: r.newTotal, reviewNote: r.reviewNote, askedBy: un(r.requestedBy), reviewedBy: un(r.reviewedBy), decidedBy: un(r.decidedBy), createdAt: r.createdAt };
    });
};

export const myRechecks = async (userId: string) => {
    const kids = await db.student.findMany({ where: { OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, select: { id: true } });
    return recheckRows({ studentId: { in: kids.map((k) => k.id) } });
};

/** For exam.recheck holders: all; for teachers: those of the subjects and sections they teach. */
export const listRechecks = async (show: string, userId: string) => {
    const a = await getUserAccess(userId);
    const status = show === 'open' ? { status: { in: ['pending', 'reviewed'] } } : show === 'done' ? { status: { in: ['approved', 'rejected'] } } : {};
    if (a.permissions['exam.recheck']) return recheckRows(status);
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    if (!staff) return [];
    const teaches = await db.teachingAssignment.findMany({ where: { staffId: staff.id }, select: { sectionId: true, subjectId: true } });
    const all = await recheckRows(status);
    const enrol = await db.enrolment.findMany({ where: { studentId: { in: all.map((r) => r.studentId) } }, select: { studentId: true, sectionId: true, academicYearId: true } });
    const subs = await db.examSubject.findMany({ where: { id: { in: all.map((r) => r.examSubjectId) } }, select: { id: true, subjectId: true } });
    return all.filter((r) => {
        const subj = subs.find((s) => s.id === r.examSubjectId)?.subjectId;
        return enrol.some((e) => e.studentId === r.studentId && teaches.some((t) => t.sectionId === e.sectionId && t.subjectId === subj));
    });
};

export const reviewSchema = z.strictObject({ newMarks: z.record(z.string(), z.number().min(0).max(1000)), note: z.string().trim().max(500).nullable().optional() });
export const reviewRecheck = async (id: string, input: z.infer<typeof reviewSchema>, userId: string) => {
    const r = await db.examRecheck.findFirst({ where: { id } });
    if (!r || !['pending', 'reviewed'].includes(r.status)) throw badRequest('Already decided');
    const mine = (await listRechecks('open', userId)).some((x) => x.id === id);
    if (!mine) throw forbidden('Only the subject teacher or the exam office reviews this');
    const es = await db.examSubject.findFirst({ where: { id: r.examSubjectId } });
    const parts = (es?.components ?? []) as Part[];
    const clean: Record<string, number> = {};
    for (const p of parts) {
        const v = input.newMarks[p.key];
        if (v === undefined) continue;
        if (v > p.max) throw badRequest(`${p.label} can be at most ${p.max}`);
        clean[p.key] = v;
    }
    const total = Object.values(clean).reduce((t, v) => t + v, 0);
    await db.examRecheck.update({ where: { id }, data: { status: 'reviewed', newMarks: clean, newTotal: total, reviewNote: input.note || null, reviewedBy: userId } });
    return { id };
};

export const decideRecheck = async (id: string, approve: boolean, userId: string) => {
    const r = await db.examRecheck.findFirst({ where: { id } });
    if (!r || !['pending', 'reviewed'].includes(r.status)) throw badRequest('Already decided');
    if (approve && r.status !== 'reviewed') throw badRequest('The subject teacher has not reviewed it yet');
    await db.examRecheck.update({ where: { id }, data: { status: approve ? 'approved' : 'rejected', decidedBy: userId, decidedAt: new Date() } });
    const changed = approve && r.newTotal !== r.oldTotal;
    if (changed) {
        await db.examMark.updateMany({ where: { examSubjectId: r.examSubjectId, studentId: r.studentId }, data: { marks: r.newMarks as object, total: r.newTotal, enteredBy: userId } });
        await recordAudit({ action: 'marks_rechecked', entity: 'exam', entityId: r.examId, changes: { student: r.studentId, examSubject: r.examSubjectId, from: r.oldMarks, to: r.newMarks } });
    }
    const [st, exam, es] = await Promise.all([db.student.findFirst({ where: { id: r.studentId }, select: { firstName: true, middleName: true, lastName: true } }), db.exam.findFirst({ where: { id: r.examId }, select: { name: true } }), db.examSubject.findFirst({ where: { id: r.examSubjectId }, select: { subjectId: true } })]);
    const subject = es ? ((await db.subject.findUnique({ where: { id: es.subjectId }, select: { name: true } }))?.name ?? '') : '';
    if (r.requestedBy) raiseLater('exam_recheck_done', { parent: () => usersOf([r.requestedBy!]) }, { student: st ? fullName(st) : '', exam: exam?.name ?? '', subject, result: changed ? `marks changed from ${r.oldTotal ?? '-'} to ${r.newTotal}` : 'no change in marks' }, { dedupe: `recheck-done:${id}` });
    return { id, changed };
};

// Re-check fees in the student's fees (next instalment after the request).
registerFeeSource(async (yearId, students, instalments) => {
    const out = new Map<string, { feeHeadId: string; instalmentId: string; amount: number }[]>();
    if (!students.length || !instalments.length) return out;
    const rows = await db.examRecheck.findMany({ where: { academicYearId: yearId, fee: { gt: 0 }, studentId: { in: students.map((s) => s.id) } }, select: { studentId: true, fee: true, createdAt: true } });
    if (!rows.length) return out;
    const { code } = await getSettings({ code: EXAMS2.recheckFeeHead });
    const head = await db.masterValue.findFirst({ where: { master: 'fee_head', code: { equals: code, mode: 'insensitive' } }, select: { id: true } });
    if (!head) return out;
    const sorted = [...instalments].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
    for (const r of rows) {
        const inst = sorted.find((i) => isoOf(i.dueDate) >= isoOf(r.createdAt)) ?? sorted[sorted.length - 1];
        const lines = out.get(r.studentId) ?? [];
        const same = lines.find((l) => l.instalmentId === inst.id);
        if (same) same.amount += r.fee!;
        else lines.push({ feeHeadId: head.id, instalmentId: inst.id, amount: r.fee! });
        out.set(r.studentId, lines);
    }
    return out;
});

