import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getUserAccess } from '../rbac/access.service';
import { fullName } from '../students/students.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { isoOf, todayIST } from '../attendance/attendance.settings';
import { getSettings } from '../../core/settings';
import { Band, loadExam, Part, ruleFor } from './setup.service';
import { EXAMS } from './exams.settings';
import { markStatuses } from './exams.labels';

/**
 * Entering marks: the subject teacher of a section (Subject Teachers), or the office for any; while
 * the exam is open for entry and before its deadline. After that only those who may moderate change
 * them, and each change is recorded. Class teachers add co-scholastic grades and remarks.
 */

const powers = async (userId: string) => {
    const a = await getUserAccess(userId);
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    return { any: !!a.permissions['exam.marks_any'], moderate: !!a.permissions['exam.moderate'], ownClass: !!a.permissions['exam.marks_class'], staffId: staff?.id ?? null };
};

/** Students of a section who take a subject (optional subjects: only those who chose it; streams: theirs). */
export const takers = async (yearId: string, sectionId: string, subjectId: string) => {
    const section = await db.section.findUnique({ where: { id: sectionId }, select: { classId: true, streamId: true } });
    if (!section) return [];
    const cs = await db.classSubject.findMany({ where: { academicYearId: yearId, classId: section.classId, subjectId }, select: { isOptional: true, streamId: true } });
    const forSection = cs.find((c) => !c.streamId || c.streamId === section.streamId);
    const rows = await db.enrolment.findMany({
        where: { academicYearId: yearId, sectionId, student: { status: { in: ['active', 'left', 'passed_out'] } } },
        select: { rollNumber: true, optionalSubjectIds: true, student: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, status: true } } },
        orderBy: [{ rollNumber: 'asc' }, { student: { firstName: 'asc' } }],
    });
    return rows.filter((r) => r.student.status === 'active' && (!forSection?.isOptional || r.optionalSubjectIds.includes(subjectId)));
};

/** Who takes a paper: the section's takers of the subject; for a supplementary exam, only its candidates in that subject. */
const sheetTakers = async (exam: { academicYearId: string; kind: string; candidates: unknown }, sectionId: string, subjectId: string) => {
    const all = await takers(exam.academicYearId, sectionId, subjectId);
    if (exam.kind !== 'supplementary') return all;
    const c = (exam.candidates ?? {}) as Record<string, string[]>;
    return all.filter((r) => (c[r.student.id] ?? []).includes(subjectId));
};

/** The "marks submitted" lock of a sheet, if any. */
const lockOf = (examSubjectId: string, sectionId: string) => db.examSheetLock.findFirst({ where: { examSubjectId, sectionId } });

const editState = (exam: { status: string; entryDeadline: Date | null }, p: { moderate: boolean }) => {
    if (exam.status === 'published') return { can: false, why: 'The results are published. They must be unpublished to change marks.' };
    const late = !!exam.entryDeadline && isoOf(exam.entryDeadline) < todayIST();
    if (exam.status === 'open' && !late) return { can: true, why: null };
    if (p.moderate) return { can: true, why: exam.status === 'draft' ? null : 'Entry is closed: changes are recorded as moderation.', moderating: exam.status !== 'draft' };
    return { can: false, why: exam.status === 'draft' ? 'Marks entry hasn’t opened yet.' : late ? 'The last date for entering marks has passed.' : 'Marks entry is locked.' };
};

// ─── The sheets a person can fill ────────────────────────────────────────────

/** Every section × subject of an exam the person enters (all for the office), with how far each is. */
export const mySheets = async (examId: string, userId: string) => {
    const exam = await loadExam(examId);
    const p = await powers(userId);
    const [sections, subjects, teaches] = await Promise.all([
        db.section.findMany({ where: { academicYearId: exam.academicYearId, classId: { in: exam.classIds }, isActive: true }, select: { id: true, name: true, classId: true, classTeacherId: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } }, orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }] }),
        db.examSubject.findMany({ where: { examId }, orderBy: { sortOrder: 'asc' } }),
        p.staffId ? db.teachingAssignment.findMany({ where: { academicYearId: exam.academicYearId, staffId: p.staffId }, select: { sectionId: true, subjectId: true } }) : [],
    ]);
    const mine = new Set(teaches.map((t) => `${t.sectionId}|${t.subjectId}`));
    // exam.marks_class: a class teacher may enter every subject of their own section.
    if (p.ownClass && p.staffId) for (const sec of sections.filter((s) => s.classTeacherId === p.staffId)) for (const sub of subjects.filter((x) => x.classId === sec.classId)) mine.add(`${sec.id}|${sub.subjectId}`);
    const names = new Map((await db.subject.findMany({ where: { id: { in: subjects.map((s) => s.subjectId) } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
    const counts = await db.examMark.groupBy({ by: ['examSubjectId'], where: { examSubject: { examId } }, _count: { _all: true } });
    const locks = new Set((await db.examSheetLock.findMany({ where: { examSubjectId: { in: subjects.map((s) => s.id) } }, select: { examSubjectId: true, sectionId: true } })).map((l) => `${l.examSubjectId}|${l.sectionId}`));
    const cands = exam.kind === 'supplementary' ? ((exam.candidates ?? {}) as Record<string, string[]>) : null;
    const candSubjects = cands ? new Set(Object.values(cands).flat()) : null;
    const done = new Map(counts.map((c) => [c.examSubjectId, c._count._all]));
    const out = [];
    for (const sec of sections)
        for (const sub of subjects.filter((x) => x.classId === sec.classId)) {
            if (!p.any && !mine.has(`${sec.id}|${sub.subjectId}`)) continue;
            if (candSubjects && !candSubjects.has(sub.subjectId)) continue;
            out.push({ examSubjectId: sub.id, sectionId: sec.id, section: sectionLabel(sec), subject: names.get(sub.subjectId) ?? '—', max: (sub.components as Part[]).reduce((a, c) => a + c.max, 0), mine: mine.has(`${sec.id}|${sub.subjectId}`), entered: done.get(sub.id) ?? 0, submitted: locks.has(`${sub.id}|${sec.id}`) });
        }
    // Sections they are class teacher of: co-scholastic grades and remarks.
    const classOf = sections.filter((s) => p.any || (p.staffId && s.classTeacherId === p.staffId)).map((s) => ({ sectionId: s.id, section: sectionLabel(s) }));
    return { exam: { id: exam.id, name: exam.name, status: exam.status, entryDeadline: exam.entryDeadline ? isoOf(exam.entryDeadline) : null }, edit: editState(exam, p), sheets: out, classTeacherOf: classOf };
};

/** The open exams the person enters marks for (the entry page's first list). */
export const myExams = async (yearId: string, userId: string) => {
    const p = await powers(userId);
    const exams = await db.exam.findMany({ where: { academicYearId: yearId, status: { not: 'draft' } }, orderBy: [{ sortOrder: 'asc' }] });
    if (p.any || p.moderate) return exams.map((e) => ({ id: e.id, name: e.name, status: e.status, entryDeadline: e.entryDeadline ? isoOf(e.entryDeadline) : null }));
    const teaches = p.staffId ? await db.teachingAssignment.findMany({ where: { academicYearId: yearId, staffId: p.staffId }, select: { section: { select: { classId: true } } } }) : [];
    const own = p.staffId ? await db.section.findMany({ where: { academicYearId: yearId, classTeacherId: p.staffId }, select: { classId: true } }) : [];
    const classes = new Set([...teaches.map((t) => t.section.classId), ...own.map((o) => o.classId)]);
    return exams.filter((e) => e.classIds.some((c) => classes.has(c))).map((e) => ({ id: e.id, name: e.name, status: e.status, entryDeadline: e.entryDeadline ? isoOf(e.entryDeadline) : null }));
};

// ─── One sheet: a subject of a section ───────────────────────────────────────

const loadSheet = async (examSubjectId: string, sectionId: string, userId: string) => {
    if (!z.uuid().safeParse(examSubjectId).success || !z.uuid().safeParse(sectionId).success) throw notFound('Sheet not found');
    const es = await db.examSubject.findFirst({ where: { id: examSubjectId }, include: { exam: true } });
    if (!es) throw notFound('Sheet not found');
    const section = await db.section.findFirst({ where: { id: sectionId, classId: es.classId, academicYearId: es.exam.academicYearId }, select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } } } });
    if (!section) throw notFound('Section not found');
    const p = await powers(userId);
    const teaches = p.staffId ? await db.teachingAssignment.findFirst({ where: { sectionId, subjectId: es.subjectId, staffId: p.staffId }, select: { id: true } }) : null;
    const ownClass = p.ownClass && p.staffId ? !!(await db.section.findFirst({ where: { id: sectionId, classTeacherId: p.staffId }, select: { id: true } })) : false;
    if (!p.any && !p.moderate && !teaches && !ownClass) throw forbidden('You don’t teach this subject in this section (Subject Teachers)');
    return { es, section, p };
};

export const getSheet = async (examSubjectId: string, sectionId: string, userId: string) => {
    const { es, section, p } = await loadSheet(examSubjectId, sectionId, userId);
    const [students, rule, subject, lock] = await Promise.all([sheetTakers(es.exam, sectionId, es.subjectId), ruleFor(es.classId), db.subject.findUnique({ where: { id: es.subjectId }, select: { name: true } }), lockOf(examSubjectId, sectionId)]);
    const lockedBy = lock?.submittedBy ? ((await db.user.findFirst({ where: { id: lock.submittedBy }, select: { displayName: true } }))?.displayName ?? '') : '';
    const baseEdit = editState(es.exam, p);
    const canUnlock = p.any || p.moderate || (await isClassTeacher(sectionId, p.staffId));
    const marks = new Map((await db.examMark.findMany({ where: { examSubjectId, studentId: { in: students.map((s) => s.student.id) } } })).map((m) => [m.studentId, m]));
    const parts = es.components as Part[];
    return {
        exam: { id: es.exam.id, name: es.exam.name, status: es.exam.status },
        subject: subject?.name ?? '—',
        section: sectionLabel(section),
        parts,
        max: parts.reduce((a, c) => a + c.max, 0),
        descriptive: rule.descriptive,
        grades: rule.descriptive ? rule.scale.bands.map((b: Band) => b.grade) : [],
        passPercent: rule.passPercent,
        edit: lock && baseEdit.can && !canUnlock ? { can: false, why: 'You submitted these marks. Ask the class teacher or the office to unlock them to change.' } : baseEdit,
        lock: lock ? { by: lockedBy, at: lock.submittedAt, canUnlock } : null,
        students: students.map((s) => {
            const m = marks.get(s.student.id);
            return { id: s.student.id, name: fullName(s.student), admissionNo: s.student.admissionNo, roll: s.rollNumber, status: m?.status ?? 'P', marks: (m?.marks ?? {}) as Record<string, number | string | null>, total: m?.total ?? null, entered: !!m };
        }),
    };
};

export const sheetSchema = z.strictObject({
    rows: z
        .array(
            z.strictObject({
                studentId: z.uuid(),
                status: z.string().trim().toUpperCase().pipe(z.string().min(1).max(20)),
                marks: z.record(z.string(), z.union([z.number().min(0).max(1000), z.string().max(20), z.null()])),
            })
        )
        .max(200),
});

export const saveSheet = async (examSubjectId: string, sectionId: string, input: z.infer<typeof sheetSchema>, userId: string) => {
    const { es, p } = await loadSheet(examSubjectId, sectionId, userId);
    const state = editState(es.exam, p);
    if (!state.can) throw forbidden(state.why ?? 'Marks can’t be changed now');
    if ((await lockOf(examSubjectId, sectionId)) && !(p.any || p.moderate || (await isClassTeacher(sectionId, p.staffId)))) throw forbidden('These marks are submitted. Ask the class teacher or the office to unlock them.');
    const [students, rule] = await Promise.all([sheetTakers(es.exam, sectionId, es.subjectId), ruleFor(es.classId)]);
    const allowed = new Set(students.map((s) => s.student.id));
    const parts = es.components as Part[];
    const grades = new Set(rule.scale.bands.map((b: Band) => b.grade));
    const { halves } = await getSettings({ halves: EXAMS.halfMarks });
    const statuses = new Set((await markStatuses()).filter((s) => s.active).map((s) => s.code));
    const issues: { field: string; message: string }[] = [];
    const rows = input.rows.map((r, i) => {
        if (!allowed.has(r.studentId)) issues.push({ field: `rows.${i}`, message: 'is not a student of this subject' });
        if (r.status !== 'P' && !statuses.has(r.status)) issues.push({ field: `rows.${i}.status`, message: 'is not a mark status (Masters → Mark statuses)' });
        if (r.status !== 'P') return { ...r, marks: {}, total: null };
        if (rule.descriptive) {
            const g = typeof r.marks.grade === 'string' ? r.marks.grade : null;
            if (g && !grades.has(g)) issues.push({ field: `rows.${i}.grade`, message: 'is not a grade of the scale' });
            return { ...r, marks: g ? { grade: g } : {}, total: null };
        }
        const clean: Record<string, number> = {};
        let total = 0;
        let any = false;
        for (const part of parts) {
            const v = r.marks[part.key];
            if (v === null || v === undefined || v === '') continue;
            const n = typeof v === 'number' ? v : Number(v);
            if (!Number.isFinite(n) || n < 0 || n > part.max) {
                issues.push({ field: `rows.${i}.${part.key}`, message: `must be 0 to ${part.max}` });
                continue;
            }
            if (Math.round(n * 2) !== n * 2) issues.push({ field: `rows.${i}.${part.key}`, message: 'whole or half marks only' });
            else if (!halves && !Number.isInteger(n)) issues.push({ field: `rows.${i}.${part.key}`, message: 'whole marks only (System Settings → Exams)' });
            clean[part.key] = n;
            total += n;
            any = true;
        }
        return { ...r, marks: clean, total: any ? total : null };
    });
    if (issues.length) throw badRequest(issues.length === 1 ? `A mark ${issues[0].message}` : `${issues.length} marks need attention`, issues);
    const before = state.moderating ? new Map((await db.examMark.findMany({ where: { examSubjectId, studentId: { in: rows.map((r) => r.studentId) } } })).map((m) => [m.studentId, m])) : null;
    const tenantId = getTenantId()!;
    await withTransaction(async (tx) => {
        for (const r of rows) {
            // Nothing typed and present: no row (not "zero").
            if (r.status === 'P' && r.total === null && !Object.keys(r.marks).length) {
                await tx.examMark.deleteMany({ where: { examSubjectId, studentId: r.studentId } });
                continue;
            }
            await tx.examMark.upsert({
                where: { examSubjectId_studentId: { examSubjectId, studentId: r.studentId } },
                create: { tenantId, examSubjectId, studentId: r.studentId, marks: r.marks, status: r.status, total: r.total, enteredBy: userId },
                update: { marks: r.marks, status: r.status, total: r.total, enteredBy: userId },
            });
        }
    });
    if (before) {
        const changed = rows.filter((r) => {
            const b = before.get(r.studentId);
            return !b || b.status !== r.status || JSON.stringify(b.marks) !== JSON.stringify(r.marks);
        });
        if (changed.length) await recordAudit({ action: 'marks_moderated', entity: 'exam', entityId: es.examId, changes: { subject: es.subjectId, section: sectionId, students: changed.length, changes: changed.map((c) => ({ student: c.studentId, from: before.get(c.studentId)?.marks ?? null, to: c.marks, status: c.status })) } });
    }
    return getSheet(examSubjectId, sectionId, userId);
};

const isClassTeacher = async (sectionId: string, staffId: string | null) => !!staffId && !!(await db.section.findFirst({ where: { id: sectionId, classTeacherId: staffId }, select: { id: true } }));

/** The teacher is done: the sheet is locked (blanks must be filled or marked absent first). */
export const submitSheet = async (examSubjectId: string, sectionId: string, userId: string) => {
    const { es } = await loadSheet(examSubjectId, sectionId, userId);
    const students = await sheetTakers(es.exam, sectionId, es.subjectId);
    const entered = await db.examMark.count({ where: { examSubjectId, studentId: { in: students.map((s) => s.student.id) } } });
    if (entered < students.length) throw badRequest(`${students.length - entered} student(s) have no marks yet: enter them, or mark them absent (AB) / not taking (NA)`);
    await db.examSheetLock.upsert({ where: { examSubjectId_sectionId: { examSubjectId, sectionId } }, create: { tenantId: getTenantId()!, examSubjectId, sectionId, submittedBy: userId }, update: { submittedBy: userId, submittedAt: new Date() } });
    return getSheet(examSubjectId, sectionId, userId);
};

/** Opens a submitted sheet again (class teacher of the section, the office, or who may moderate). */
export const unlockSheet = async (examSubjectId: string, sectionId: string, userId: string) => {
    const { p } = await loadSheet(examSubjectId, sectionId, userId);
    if (!(p.any || p.moderate || (await isClassTeacher(sectionId, p.staffId)))) throw forbidden('Only the class teacher or the office can unlock it');
    await db.examSheetLock.deleteMany({ where: { examSubjectId, sectionId } });
    await recordAudit({ action: 'marks_unlocked', entity: 'exam_subject', entityId: examSubjectId, changes: { section: sectionId } });
    return getSheet(examSubjectId, sectionId, userId);
};

// ─── Class teacher: co-scholastic grades, discipline, remarks ────────────────

const loadClassSheet = async (examId: string, sectionId: string, userId: string) => {
    const exam = await loadExam(examId);
    if (!z.uuid().safeParse(sectionId).success) throw notFound('Section not found');
    const section = await db.section.findFirst({ where: { id: sectionId, academicYearId: exam.academicYearId, classId: { in: exam.classIds } }, select: { id: true, name: true, classId: true, classTeacherId: true, schoolClass: { select: { name: true, shortName: true } } } });
    if (!section) throw notFound('Section not found');
    const p = await powers(userId);
    if (!p.any && !p.moderate && !(p.staffId && section.classTeacherId === p.staffId)) throw forbidden('Only the class teacher (or the office) adds these');
    return { exam, section, p };
};

export const getClassSheet = async (examId: string, sectionId: string, userId: string) => {
    const { exam, section, p } = await loadClassSheet(examId, sectionId, userId);
    const [rule, coSubjects, enrol] = await Promise.all([
        ruleFor(section.classId),
        db.classSubject.findMany({ where: { academicYearId: exam.academicYearId, classId: section.classId, subject: { assessment: 'co_scholastic', isActive: true } }, select: { subject: { select: { id: true, name: true } } }, orderBy: { sortOrder: 'asc' } }),
        db.enrolment.findMany({ where: { academicYearId: exam.academicYearId, sectionId, student: { status: 'active' } }, select: { rollNumber: true, student: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } } }, orderBy: [{ rollNumber: 'asc' }, { student: { firstName: 'asc' } }] }),
    ]);
    const notes = new Map((await db.examStudentNote.findMany({ where: { examId, studentId: { in: enrol.map((e) => e.student.id) } } })).map((n) => [n.studentId, n]));
    const areas = [...new Map(coSubjects.map((c) => [c.subject.id, c.subject])).values()];
    return {
        exam: { id: exam.id, name: exam.name, status: exam.status },
        section: sectionLabel(section),
        areas,
        grades: rule.co.map((b) => b.grade),
        edit: editState(exam, p),
        students: enrol.map((e) => {
            const n = notes.get(e.student.id);
            return { id: e.student.id, name: fullName(e.student), roll: e.rollNumber, coGrades: (n?.coGrades ?? {}) as Record<string, string>, discipline: n?.discipline ?? '', remark: n?.remark ?? '' };
        }),
    };
};

export const classSheetSchema = z.strictObject({
    rows: z.array(z.strictObject({ studentId: z.uuid(), coGrades: z.record(z.string(), z.string().max(20)), discipline: z.string().max(20).nullable().optional(), remark: z.string().trim().max(300).nullable().optional() })).max(200),
});

export const saveClassSheet = async (examId: string, sectionId: string, input: z.infer<typeof classSheetSchema>, userId: string) => {
    const { exam, p } = await loadClassSheet(examId, sectionId, userId);
    const state = editState(exam, p);
    if (!state.can) throw forbidden(state.why ?? 'Can’t be changed now');
    const tenantId = getTenantId()!;
    await withTransaction(async (tx) => {
        for (const r of input.rows) {
            const coGrades = Object.fromEntries(Object.entries(r.coGrades).filter(([, g]) => g));
            await tx.examStudentNote.upsert({
                where: { examId_studentId: { examId, studentId: r.studentId } },
                create: { tenantId, examId, studentId: r.studentId, coGrades, discipline: r.discipline || null, remark: r.remark || null, enteredBy: userId },
                update: { coGrades, discipline: r.discipline || null, remark: r.remark || null, enteredBy: userId },
            });
        }
    });
    return getClassSheet(examId, sectionId, userId);
};

// ─── Progress (the office) ───────────────────────────────────────────────────

/** For each section × subject: students who take it and how many have marks. */
export const progress = async (examId: string) => {
    const exam = await loadExam(examId);
    const [sections, subjects] = await Promise.all([
        db.section.findMany({ where: { academicYearId: exam.academicYearId, classId: { in: exam.classIds }, isActive: true }, select: { id: true, name: true, classId: true, schoolClass: { select: { name: true, shortName: true } } }, orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }] }),
        db.examSubject.findMany({ where: { examId }, orderBy: { sortOrder: 'asc' } }),
    ]);
    const names = new Map((await db.subject.findMany({ where: { id: { in: subjects.map((s) => s.subjectId) } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
    const marks = await db.examMark.findMany({ where: { examSubject: { examId } }, select: { examSubjectId: true, studentId: true } });
    const teachers = await db.teachingAssignment.findMany({ where: { academicYearId: exam.academicYearId, sectionId: { in: sections.map((s) => s.id) } }, select: { sectionId: true, subjectId: true, staff: { select: { firstName: true, lastName: true } } } });
    const rows = [];
    for (const sec of sections)
        for (const sub of subjects.filter((x) => x.classId === sec.classId)) {
            const takersList = await takers(exam.academicYearId, sec.id, sub.subjectId);
            const ids = new Set(takersList.map((t) => t.student.id));
            const t = teachers.find((x) => x.sectionId === sec.id && x.subjectId === sub.subjectId);
            rows.push({ examSubjectId: sub.id, sectionId: sec.id, section: sectionLabel(sec), subject: names.get(sub.subjectId) ?? '—', teacher: t ? [t.staff.firstName, t.staff.lastName].filter(Boolean).join(' ') : null, students: ids.size, entered: marks.filter((m) => m.examSubjectId === sub.id && ids.has(m.studentId)).length });
        }
    const total = rows.reduce((a, r) => a + r.students, 0);
    const done = rows.reduce((a, r) => a + r.entered, 0);
    return { exam: { id: exam.id, name: exam.name, status: exam.status }, rows, totals: { sheets: rows.length, complete: rows.filter((r) => r.students && r.entered >= r.students).length, students: total, entered: done } };
};

