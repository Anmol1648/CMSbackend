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
import { dayOff } from '../attendance/calendar.service';
import { takers } from '../exams/marks.service';
import { HOMEWORK } from './homework.settings';
import { alertChecked, alertNewHomework } from './homework.alerts';

/**
 * Homework: a teacher gives it to a section in a subject (Subject Teachers, or any subject of their
 * own class), students hand it in online (or it is checked in class), the teacher checks it. Students
 * and parents see their own; the class teacher and the principal see the day's diary.
 */

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date');
const staffName = (s: { firstName: string; middleName?: string | null; lastName?: string | null }) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');

// ─── Who may do what ─────────────────────────────────────────────────────────

export const powers = async (userId: string) => {
    const a = await getUserAccess(userId);
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    return {
        give: !!a.permissions['homework.give'],
        giveAll: a.permissions['homework.give'] === 'all',
        check: !!a.permissions['homework.check'],
        view: !!a.permissions['homework.view'],
        viewAll: a.permissions['homework.view'] === 'all',
        mine: !!a.permissions['homework.mine'],
        staffId: staff?.id ?? null,
    };
};
type Powers = Awaited<ReturnType<typeof powers>>;

/** Per section, the subjects a teacher gives homework in ('all' = every subject: their own class). */
const teachable = async (p: Powers, yearId: string) => {
    const out = new Map<string, Set<string> | 'all'>();
    if (!p.staffId) return out;
    const [own, teach] = await Promise.all([
        db.section.findMany({ where: { academicYearId: yearId, classTeacherId: p.staffId }, select: { id: true } }),
        db.teachingAssignment.findMany({ where: { academicYearId: yearId, staffId: p.staffId }, select: { sectionId: true, subjectId: true } }),
    ]);
    for (const t of teach) {
        const cur = out.get(t.sectionId);
        if (cur !== 'all') out.set(t.sectionId, new Set([...(cur ?? []), t.subjectId]));
    }
    for (const s of own) out.set(s.id, 'all');
    return out;
};

const mayGive = async (p: Powers, yearId: string, sectionId: string, subjectId: string) => {
    if (!p.give) return false;
    if (p.giveAll) return true;
    const t = (await teachable(p, yearId)).get(sectionId);
    return t === 'all' || !!t?.has(subjectId);
};

/** Sections whose homework a person sees: 'all', or the ones they teach / class-teach. */
const viewable = async (p: Powers, yearId: string): Promise<'all' | Set<string>> => {
    if (p.viewAll || p.giveAll) return 'all';
    return new Set((await teachable(p, yearId)).keys());
};

// ─── Giving ──────────────────────────────────────────────────────────────────

/** The sections and subjects a teacher can give homework in (this session). */
export const giveOptions = async (userId: string) => {
    const p = await powers(userId);
    const year = await currentYear();
    if (!year || !p.give) return { yearId: year?.id ?? null, sections: [] };
    const t = p.giveAll ? null : await teachable(p, year.id);
    const sections = await db.section.findMany({
        where: { academicYearId: year.id, isActive: true, ...(t ? { id: { in: [...t.keys()] } } : {}) },
        select: { id: true, classId: true, name: true, schoolClass: { select: { name: true, shortName: true } } },
        orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
    });
    const cs = await db.classSubject.findMany({ where: { academicYearId: year.id, classId: { in: [...new Set(sections.map((s) => s.classId))] } }, select: { classId: true, subject: { select: { id: true, name: true, isActive: true } } }, orderBy: { sortOrder: 'asc' } });
    return {
        yearId: year.id,
        sections: sections.map((s) => {
            const allowed = t?.get(s.id);
            const subjects = cs.filter((c) => c.classId === s.classId && c.subject.isActive && (!t || allowed === 'all' || allowed?.has(c.subject.id))).map((c) => c.subject);
            return { id: s.id, label: sectionLabel(s), subjects: [...new Map(subjects.map((x) => [x.id, { id: x.id, name: x.name }])).values()] };
        }),
    };
};

export const giveSchema = z.strictObject({
    sectionIds: z.array(z.uuid()).min(1, 'choose a section').max(30),
    subjectId: z.uuid('choose the subject'),
    typeId: z.uuid().nullable().optional(),
    title: z.string().trim().min(1, 'is required').max(200),
    details: z.string().trim().max(10_000).default(''),
    attachmentIds: z.array(z.uuid()).max(10).default([]),
    givenOn: ISO,
    dueOn: ISO,
    mode: z.enum(['online', 'class']),
    /** draft: kept for later; now: students see it now; later: from publishAt. */
    publish: z.enum(['draft', 'now', 'later']),
    publishAt: z.coerce.date().nullable().optional(),
});
export type GiveInput = z.infer<typeof giveSchema>;

const checkRules = async (input: Pick<GiveInput, 'givenOn' | 'dueOn' | 'mode' | 'publish' | 'publishAt'>, sectionIds: string[], exceptId?: string) => {
    if (input.dueOn < input.givenOn) throw badRequest('The due date is before the day it is given', [{ field: 'dueOn', message: 'is before the given date' }]);
    const s = await getSettings({ onHolidays: HOMEWORK.onHolidays, maxPerDay: HOMEWORK.maxPerDay, online: HOMEWORK.online });
    if (input.mode === 'online' && !s.online) throw badRequest('Handing in online is switched off (System Settings → Homework)', [{ field: 'mode', message: 'is switched off' }]);
    if (!s.onHolidays) {
        const off = await dayOff(input.dueOn, 'students');
        if (off) throw badRequest(`The due date is not a school day: ${off}`, [{ field: 'dueOn', message: 'is not a school day' }]);
    }
    if (input.publish === 'later' && !(input.publishAt && input.publishAt > new Date())) throw badRequest('Choose when students see it', [{ field: 'publishAt', message: 'must be later than now' }]);
    if (s.maxPerDay > 0) {
        const counts = await db.homework.groupBy({ by: ['sectionId'], where: { sectionId: { in: sectionIds }, dueOn: dayDate(input.dueOn), status: 'published', ...(exceptId ? { id: { not: exceptId } } : {}) }, _count: { _all: true } });
        const full = counts.filter((c) => c._count._all >= s.maxPerDay);
        if (full.length) {
            const names = await db.section.findMany({ where: { id: { in: full.map((f) => f.sectionId) } }, select: { name: true, schoolClass: { select: { name: true, shortName: true } } } });
            throw badRequest(`${names.map(sectionLabel).join(', ')} already ${full.length === 1 ? 'has' : 'have'} ${s.maxPerDay} homework due that day (System Settings → Homework)`, [{ field: 'dueOn', message: 'has too much homework' }]);
        }
    }
};

const visibleNow = (h: { status: string; publishAt: Date | null }) => h.status === 'published' && (!h.publishAt || h.publishAt <= new Date());

export const giveHomework = async (input: GiveInput, userId: string) => {
    const p = await powers(userId);
    const year = await currentYear();
    if (!year) throw badRequest('No current academic year is set (Academic setup)');
    for (const sectionId of input.sectionIds) if (!(await mayGive(p, year.id, sectionId, input.subjectId))) throw forbidden('You don’t teach this subject in one of these sections (Subject Teachers)');
    const sections = await db.section.findMany({ where: { id: { in: input.sectionIds }, academicYearId: year.id }, select: { id: true, classId: true } });
    if (sections.length !== input.sectionIds.length) throw badRequest('Choose sections of this session');
    const cs = await db.classSubject.count({ where: { academicYearId: year.id, subjectId: input.subjectId, classId: { in: [...new Set(sections.map((s) => s.classId))] } } });
    if (!cs) throw badRequest('This subject isn’t taught in that class', [{ field: 'subjectId', message: 'is not a subject of the class' }]);
    await checkRules(input, input.sectionIds);
    if (input.attachmentIds.length && (await db.file.count({ where: { id: { in: input.attachmentIds }, uploadedBy: userId } })) !== input.attachmentIds.length) throw badRequest('Upload the attachments again');
    const tenantId = getTenantId()!;
    const ids: string[] = [];
    for (const sectionId of input.sectionIds) {
        const h = await db.homework.create({
            data: {
                tenantId,
                academicYearId: year.id,
                sectionId,
                subjectId: input.subjectId,
                typeId: input.typeId ?? null,
                title: input.title,
                details: input.details,
                attachmentIds: input.attachmentIds,
                givenOn: dayDate(input.givenOn),
                dueOn: dayDate(input.dueOn),
                mode: input.mode,
                status: input.publish === 'draft' ? 'draft' : 'published',
                publishAt: input.publish === 'later' ? input.publishAt! : input.publish === 'now' ? new Date() : null,
                staffId: p.staffId,
                createdBy: userId,
            },
        });
        ids.push(h.id);
        if (input.publish === 'now') alertNewHomework(h.id);
    }
    await recordAudit({ action: 'homework_given', entity: 'homework', entityId: ids[0], changes: { title: input.title, sections: input.sectionIds.length, due: input.dueOn, publish: input.publish } });
    return { ids };
};

const loadForStaff = async (id: string, userId: string, need: 'view' | 'edit' | 'check') => {
    const h = await db.homework.findFirst({ where: { id } });
    if (!h) throw notFound('Homework not found');
    const p = await powers(userId);
    const own = !!p.staffId && h.staffId === p.staffId;
    const canEdit = own || (await mayGive(p, h.academicYearId, h.sectionId, h.subjectId) && (p.giveAll || own));
    if (need === 'edit' && !(canEdit && p.give)) throw forbidden('Only the teacher who gave it can change it');
    if (need === 'check' && !(p.check && (own || (await mayGive(p, h.academicYearId, h.sectionId, h.subjectId))))) throw forbidden('You can check the homework of your own subjects');
    if (need === 'view') {
        const v = await viewable(p, h.academicYearId);
        if (!own && v !== 'all' && !v.has(h.sectionId)) throw forbidden();
    }
    return { h, p, canEdit: canEdit && p.give, canCheck: p.check && (own || (await mayGive(p, h.academicYearId, h.sectionId, h.subjectId))) };
};

export const updateSchema = giveSchema.omit({ sectionIds: true });
export const updateHomework = async (id: string, input: z.infer<typeof updateSchema>, userId: string) => {
    const { h } = await loadForStaff(id, userId, 'edit');
    if (input.subjectId !== h.subjectId) throw badRequest('The subject can’t be changed; give it again for the other subject', [{ field: 'subjectId', message: 'can’t change' }]);
    await checkRules(input, [h.sectionId], id);
    const wasVisible = visibleNow(h);
    await db.homework.update({
        where: { id },
        data: {
            typeId: input.typeId ?? null,
            title: input.title,
            details: input.details,
            attachmentIds: input.attachmentIds,
            givenOn: dayDate(input.givenOn),
            dueOn: dayDate(input.dueOn),
            mode: input.mode,
            status: input.publish === 'draft' ? 'draft' : 'published',
            publishAt: input.publish === 'later' ? input.publishAt! : input.publish === 'now' ? (h.publishAt && h.publishAt <= new Date() ? h.publishAt : new Date()) : null,
            updatedBy: userId,
        },
    });
    if (!wasVisible && input.publish === 'now') alertNewHomework(id);
    await recordAudit({ action: 'homework_changed', entity: 'homework', entityId: id, changes: { title: input.title, due: input.dueOn } });
    return getHomework(id, userId);
};

export const deleteHomework = async (id: string, userId: string) => {
    const { h } = await loadForStaff(id, userId, 'edit');
    await db.homework.delete({ where: { id } });
    await recordAudit({ action: 'homework_deleted', entity: 'homework', entityId: id, changes: { title: h.title } });
    return { id, deleted: true };
};

// ─── Lists ───────────────────────────────────────────────────────────────────

export const listQuery = z.object({
    section: z.uuid().optional(),
    subject: z.uuid().optional(),
    from: ISO.optional(),
    to: ISO.optional(),
    mine: z.enum(['1', '0']).optional(),
    status: z.enum(['draft', 'published', 'scheduled']).optional(),
    page: z.coerce.number().int().min(1).default(1),
});

const names = async (rows: { sectionId: string; subjectId: string; staffId: string | null; typeId: string | null }[]) => {
    const [secs, subs, staff, types] = await Promise.all([
        db.section.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.sectionId))] } }, select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } } } }),
        db.subject.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.subjectId))] } }, select: { id: true, name: true } }),
        db.staff.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.staffId!).filter(Boolean))] } }, select: { id: true, firstName: true, middleName: true, lastName: true } }),
        db.masterValue.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.typeId!).filter(Boolean))] } }, select: { id: true, name: true } }),
    ]);
    return {
        section: new Map(secs.map((s) => [s.id, sectionLabel(s)])),
        subject: new Map(subs.map((s) => [s.id, s.name])),
        staff: new Map(staff.map((s) => [s.id, staffName(s)])),
        type: new Map(types.map((t) => [t.id, t.name])),
    };
};

const stateOf = (h: { status: string; publishAt: Date | null }) => (h.status === 'draft' ? 'draft' : h.publishAt && h.publishAt > new Date() ? 'scheduled' : 'published');

export const listHomework = async (q: z.infer<typeof listQuery>, userId: string) => {
    const p = await powers(userId);
    const year = await currentYear();
    if (!year) return { rows: [], total: 0, page: 1, pages: 1, canGive: p.give };
    const v = await viewable(p, year.id);
    const own: Prisma.HomeworkWhereInput = p.staffId ? { staffId: p.staffId } : { id: { in: [] } };
    const scope: Prisma.HomeworkWhereInput = q.mine === '1' || (!p.view && !p.giveAll) ? own : v === 'all' ? {} : { OR: [{ sectionId: { in: [...v] } }, own] };
    const now = new Date();
    const where: Prisma.HomeworkWhereInput = {
        academicYearId: year.id,
        ...scope,
        ...(q.section ? { sectionId: q.section } : {}),
        ...(q.subject ? { subjectId: q.subject } : {}),
        ...(q.from || q.to ? { givenOn: { ...(q.from ? { gte: dayDate(q.from) } : {}), ...(q.to ? { lte: dayDate(q.to) } : {}) } } : {}),
        ...(q.status === 'draft' ? { status: 'draft' } : q.status === 'scheduled' ? { status: 'published', publishAt: { gt: now } } : q.status === 'published' ? { status: 'published', OR: [{ publishAt: null }, { publishAt: { lte: now } }] } : {}),
    };
    const take = 25;
    const [rows, total] = await Promise.all([db.homework.findMany({ where, orderBy: [{ givenOn: 'desc' }, { createdAt: 'desc' }], skip: (q.page - 1) * take, take }), db.homework.count({ where })]);
    const n = await names(rows);
    const subs = rows.length ? await db.homeworkSubmission.groupBy({ by: ['homeworkId', 'status'], where: { homeworkId: { in: rows.map((r) => r.id) } }, _count: { _all: true } }) : [];
    const out = [];
    for (const h of rows) {
        const students = (await takers(h.academicYearId, h.sectionId, h.subjectId)).length;
        const c = (s: string[]) => subs.filter((x) => x.homeworkId === h.id && s.includes(x.status)).reduce((a, x) => a + x._count._all, 0);
        out.push({
            id: h.id,
            title: h.title,
            section: n.section.get(h.sectionId) ?? '',
            sectionId: h.sectionId,
            subject: n.subject.get(h.subjectId) ?? '',
            type: h.typeId ? (n.type.get(h.typeId) ?? null) : null,
            by: h.staffId ? (n.staff.get(h.staffId) ?? null) : null,
            mine: !!p.staffId && h.staffId === p.staffId,
            givenOn: isoOf(h.givenOn),
            dueOn: isoOf(h.dueOn),
            mode: h.mode,
            state: stateOf(h),
            students,
            handedIn: c(['submitted', 'late', 'checked', 'redo', 'done']),
            toCheck: c(['submitted', 'late']),
            checked: c(['checked', 'done']),
        });
    }
    return { rows: out, total, page: q.page, pages: Math.max(1, Math.ceil(total / take)), canGive: p.give };
};

const filesOf = async (ids: string[]) => (ids.length ? (await db.file.findMany({ where: { id: { in: ids } }, select: { id: true, originalName: true, mimeType: true } })).map((f) => ({ id: f.id, name: f.originalName, type: f.mimeType })) : []);

/** One homework with every student of the section (for the teacher). */
export const getHomework = async (id: string, userId: string) => {
    const { h, canEdit, canCheck } = await loadForStaff(id, userId, 'view');
    const n = await names([h]);
    const list = await takers(h.academicYearId, h.sectionId, h.subjectId);
    const subs = new Map((await db.homeworkSubmission.findMany({ where: { homeworkId: id } })).map((s) => [s.studentId, s]));
    const grades = await db.masterValue.findMany({ where: { master: 'homework_grade' }, select: { id: true, name: true } });
    const gradeName = new Map(grades.map((g) => [g.id, g.name]));
    const allFiles = await filesOf([...h.attachmentIds, ...[...subs.values()].flatMap((s) => s.fileIds)]);
    const fileMap = new Map(allFiles.map((f) => [f.id, f]));
    return {
        id: h.id,
        title: h.title,
        details: h.details,
        section: n.section.get(h.sectionId) ?? '',
        sectionId: h.sectionId,
        subject: n.subject.get(h.subjectId) ?? '',
        subjectId: h.subjectId,
        typeId: h.typeId,
        type: h.typeId ? (n.type.get(h.typeId) ?? null) : null,
        by: h.staffId ? (n.staff.get(h.staffId) ?? null) : null,
        givenOn: isoOf(h.givenOn),
        dueOn: isoOf(h.dueOn),
        mode: h.mode,
        state: stateOf(h),
        publishAt: h.publishAt,
        attachments: h.attachmentIds.map((f) => fileMap.get(f)).filter(Boolean),
        canEdit,
        canCheck,
        students: list.map((t) => {
            const s = subs.get(t.student.id);
            return {
                id: t.student.id,
                name: fullName(t.student),
                admissionNo: t.student.admissionNo,
                roll: t.rollNumber,
                status: s?.status ?? 'pending',
                answer: s?.answer ?? null,
                files: (s?.fileIds ?? []).map((f) => fileMap.get(f)).filter(Boolean),
                submittedAt: s?.submittedAt ?? null,
                checkedAt: s?.checkedAt ?? null,
                gradeId: s?.gradeId ?? null,
                grade: s?.gradeId ? (gradeName.get(s.gradeId) ?? null) : null,
                remark: s?.remark ?? null,
            };
        }),
    };
};

// ─── Checking ────────────────────────────────────────────────────────────────

export const checkSchema = z.strictObject({
    rows: z
        .array(
            z.strictObject({
                studentId: z.uuid(),
                status: z.enum(['checked', 'redo', 'done', 'not_done', 'pending']),
                gradeId: z.uuid().nullable().optional(),
                remark: z.string().trim().max(500).nullable().optional(),
            })
        )
        .max(300),
});

export const checkHomework = async (id: string, input: z.infer<typeof checkSchema>, userId: string) => {
    const { h } = await loadForStaff(id, userId, 'check');
    const on = new Set((await takers(h.academicYearId, h.sectionId, h.subjectId)).map((t) => t.student.id));
    if (input.rows.some((r) => !on.has(r.studentId))) throw badRequest('A student is not in this homework’s section');
    const grades = new Map((await db.masterValue.findMany({ where: { master: 'homework_grade' }, select: { id: true, extra: true } })).map((g) => [g.id, !!((g.extra ?? {}) as Record<string, unknown>).redo]));
    if (input.rows.some((r) => r.gradeId && !grades.has(r.gradeId))) throw badRequest('Choose a grade from the list (Masters → Homework grades)');
    const current = new Map((await db.homeworkSubmission.findMany({ where: { homeworkId: id, studentId: { in: input.rows.map((r) => r.studentId) } } })).map((s) => [s.studentId, s]));
    const tenantId = getTenantId()!;
    const told: { studentId: string; status: string; gradeId: string | null; remark: string | null }[] = [];
    for (const r of input.rows) {
        const prev = current.get(r.studentId);
        // A "redo" grade sends it back.
        const status = r.gradeId && grades.get(r.gradeId) ? 'redo' : r.status;
        if (status === 'pending') {
            if (prev && !prev.submittedAt) await db.homeworkSubmission.delete({ where: { id: prev.id } });
            else if (prev) await db.homeworkSubmission.update({ where: { id: prev.id }, data: { status: prev.submittedAt && prev.submittedAt > new Date(`${isoOf(h.dueOn)}T23:59:59+05:30`) ? 'late' : 'submitted', checkedAt: null, checkedBy: null, gradeId: null, remark: null } });
            continue;
        }
        const same = prev && prev.status === status && (prev.gradeId ?? null) === (r.gradeId ?? null) && (prev.remark ?? null) === (r.remark ?? null);
        if (same) continue;
        const data = { status, gradeId: r.gradeId ?? null, remark: r.remark || null, checkedAt: new Date(), checkedBy: userId };
        if (prev) await db.homeworkSubmission.update({ where: { id: prev.id }, data });
        else await db.homeworkSubmission.create({ data: { tenantId, homeworkId: id, studentId: r.studentId, ...data } });
        if (status === 'checked' || status === 'redo') told.push({ studentId: r.studentId, status, gradeId: data.gradeId, remark: data.remark });
    }
    for (const t of told) alertChecked(id, t.studentId, t.status, t.gradeId, t.remark);
    await recordAudit({ action: 'homework_checked', entity: 'homework', entityId: id, changes: { title: h.title, students: input.rows.length } });
    return getHomework(id, userId);
};

// ─── Students and parents ────────────────────────────────────────────────────

/** The students a person sees homework of: themselves, or their children (this session). */
const myStudents = async (userId: string) => {
    const year = await currentYear();
    if (!year) return [];
    const students = await db.student.findMany({
        where: { status: 'active', OR: [{ userId }, { family: { guardians: { some: { userId } } } }] },
        select: { id: true, userId: true, firstName: true, middleName: true, lastName: true, enrolments: { where: { academicYearId: year.id }, select: { sectionId: true, optionalSubjectIds: true, section: { select: { classId: true, streamId: true, name: true, schoolClass: { select: { name: true, shortName: true } } } } } } },
    });
    return students.filter((s) => s.enrolments.length).map((s) => ({ id: s.id, self: s.userId === userId, name: fullName(s), yearId: year.id, ...s.enrolments[0] }));
};

/** Homework of the subjects a student takes (optional subjects only if chosen). */
const homeworkFor = async (st: Awaited<ReturnType<typeof myStudents>>[number], sinceDays: number) => {
    const now = new Date();
    const rows = await db.homework.findMany({
        where: { sectionId: st.sectionId, status: 'published', OR: [{ publishAt: null }, { publishAt: { lte: now } }], dueOn: { gte: dayDate(isoOf(new Date(Date.now() - sinceDays * 86_400_000))) } },
        orderBy: [{ dueOn: 'asc' }],
    });
    const optional = new Set(
        (await db.classSubject.findMany({ where: { academicYearId: st.yearId, classId: st.section.classId, isOptional: true, OR: [{ streamId: null }, { streamId: st.section.streamId }] }, select: { subjectId: true } })).map((c) => c.subjectId)
    );
    return rows.filter((h) => !optional.has(h.subjectId) || st.optionalSubjectIds.includes(h.subjectId));
};

export const myHomework = async (userId: string) => {
    const { days, online, lateAllowed, lateDays, parentsSubmit } = await getSettings({ days: HOMEWORK.showDays, online: HOMEWORK.online, lateAllowed: HOMEWORK.lateAllowed, lateDays: HOMEWORK.lateDays, parentsSubmit: HOMEWORK.parentsSubmit });
    const students = await myStudents(userId);
    const today = todayIST();
    const out = [];
    for (const st of students) {
        const list = await homeworkFor(st, days);
        const n = await names(list);
        const subs = new Map((await db.homeworkSubmission.findMany({ where: { studentId: st.id, homeworkId: { in: list.map((h) => h.id) } } })).map((s) => [s.homeworkId, s]));
        const grades = new Map((await db.masterValue.findMany({ where: { master: 'homework_grade' }, select: { id: true, name: true } })).map((g) => [g.id, g.name]));
        const files = new Map((await filesOf([...list.flatMap((h) => h.attachmentIds), ...[...subs.values()].flatMap((s) => s.fileIds)])).map((f) => [f.id, f]));
        out.push({
            student: { id: st.id, name: st.name, section: sectionLabel(st.section) },
            canSubmit: online && (st.self || parentsSubmit),
            homework: list.map((h) => {
                const s = subs.get(h.id);
                const due = isoOf(h.dueOn);
                const lastDay = lateAllowed ? isoOf(new Date(h.dueOn.getTime() + lateDays * 86_400_000)) : due;
                const open = h.mode === 'online' && today <= lastDay && (!s || ['submitted', 'late', 'redo'].includes(s.status));
                return {
                    id: h.id,
                    title: h.title,
                    details: h.details,
                    subject: n.subject.get(h.subjectId) ?? '',
                    type: h.typeId ? (n.type.get(h.typeId) ?? null) : null,
                    by: h.staffId ? (n.staff.get(h.staffId) ?? null) : null,
                    givenOn: isoOf(h.givenOn),
                    dueOn: due,
                    mode: h.mode,
                    attachments: h.attachmentIds.map((f) => files.get(f)).filter(Boolean),
                    status: s?.status ?? 'pending',
                    answer: s?.answer ?? null,
                    files: (s?.fileIds ?? []).map((f) => files.get(f)).filter(Boolean),
                    submittedAt: s?.submittedAt ?? null,
                    grade: s?.gradeId ? (grades.get(s.gradeId) ?? null) : null,
                    remark: s?.remark ?? null,
                    open,
                    late: today > due,
                };
            }),
        });
    }
    return out;
};

export const submitSchema = z.strictObject({ student: z.uuid(), answer: z.string().trim().max(10_000).nullable().optional(), fileIds: z.array(z.uuid()).max(20).default([]) });

export const submitHomework = async (id: string, input: z.infer<typeof submitSchema>, userId: string) => {
    const st = (await myStudents(userId)).find((s) => s.id === input.student);
    if (!st) throw forbidden();
    const s = await getSettings({ online: HOMEWORK.online, lateAllowed: HOMEWORK.lateAllowed, lateDays: HOMEWORK.lateDays, parentsSubmit: HOMEWORK.parentsSubmit, maxFiles: HOMEWORK.maxFiles, days: HOMEWORK.showDays });
    if (!s.online) throw badRequest('Handing in online is switched off');
    if (!st.self && !s.parentsSubmit) throw forbidden('Only the student can hand it in (System Settings → Homework)');
    const h = (await homeworkFor(st, s.days)).find((x) => x.id === id);
    if (!h) throw notFound('Homework not found');
    if (h.mode !== 'online') throw badRequest('This homework is checked in class, not handed in online');
    if (!input.answer && !input.fileIds.length) throw badRequest('Write the answer or attach a file');
    if (input.fileIds.length > s.maxFiles) throw badRequest(`At most ${s.maxFiles} files`);
    if (input.fileIds.length && (await db.file.count({ where: { id: { in: input.fileIds }, uploadedBy: userId, purpose: 'homework' } })) !== input.fileIds.length) throw badRequest('Upload the files again');
    const today = todayIST();
    const due = isoOf(h.dueOn);
    const lastDay = s.lateAllowed ? isoOf(new Date(h.dueOn.getTime() + s.lateDays * 86_400_000)) : due;
    if (today > lastDay) throw badRequest(s.lateAllowed ? `It could be handed in until ${lastDay}` : 'The due date has passed');
    const prev = await db.homeworkSubmission.findFirst({ where: { homeworkId: id, studentId: st.id } });
    if (prev && ['checked', 'done', 'not_done'].includes(prev.status)) throw badRequest('It has already been checked');
    const data = { status: today > due ? 'late' : 'submitted', answer: input.answer || null, fileIds: input.fileIds, submittedAt: new Date(), submittedBy: userId, checkedAt: null, checkedBy: null };
    if (prev) await db.homeworkSubmission.update({ where: { id: prev.id }, data });
    else await db.homeworkSubmission.create({ data: { tenantId: getTenantId()!, homeworkId: id, studentId: st.id, ...data } });
    await recordAudit({ action: 'homework_submitted', entity: 'homework', entityId: id, changes: { student: st.name, late: today > due } });
    return myHomework(userId);
};

// ─── Diary ───────────────────────────────────────────────────────────────────

export const diaryQuery = z.object({ section: z.uuid(), date: ISO.optional() });

/** A section's day: homework given that day and homework due that day, every subject. */
export const diary = async (q: z.infer<typeof diaryQuery>, userId: string) => {
    const p = await powers(userId);
    const year = await currentYear();
    if (!year) throw badRequest('No current academic year');
    const v = await viewable(p, year.id);
    if (!p.view || (v !== 'all' && !v.has(q.section))) throw forbidden('You can see the diary of your own sections');
    const date = q.date ?? todayIST();
    const d = dayDate(date);
    const rows = await db.homework.findMany({ where: { sectionId: q.section, status: 'published', OR: [{ givenOn: d }, { dueOn: d }] }, orderBy: { createdAt: 'asc' } });
    const n = await names(rows);
    const subs = rows.length ? await db.homeworkSubmission.groupBy({ by: ['homeworkId'], where: { homeworkId: { in: rows.map((r) => r.id) }, status: { in: ['submitted', 'late', 'checked', 'redo', 'done'] } }, _count: { _all: true } }) : [];
    const show = async (h: (typeof rows)[number]) => ({
        id: h.id,
        title: h.title,
        details: h.details,
        subject: n.subject.get(h.subjectId) ?? '',
        type: h.typeId ? (n.type.get(h.typeId) ?? null) : null,
        by: h.staffId ? (n.staff.get(h.staffId) ?? null) : null,
        givenOn: isoOf(h.givenOn),
        dueOn: isoOf(h.dueOn),
        mode: h.mode,
        students: (await takers(h.academicYearId, h.sectionId, h.subjectId)).length,
        handedIn: subs.find((s) => s.homeworkId === h.id)?._count._all ?? 0,
    });
    const given = [];
    const due = [];
    for (const h of rows) {
        if (isoOf(h.givenOn) === date) given.push(await show(h));
        if (isoOf(h.dueOn) === date) due.push(await show(h));
    }
    return { date, given, due };
};

/** Sections for the diary picker. */
export const diarySections = async (userId: string) => {
    const p = await powers(userId);
    const year = await currentYear();
    if (!year || !p.view) return [];
    const v = await viewable(p, year.id);
    const rows = await db.section.findMany({ where: { academicYearId: year.id, isActive: true, ...(v === 'all' ? {} : { id: { in: [...v] } }) }, select: { id: true, name: true, classTeacherId: true, schoolClass: { select: { name: true, shortName: true } } }, orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }] });
    return rows.map((s) => ({ id: s.id, label: sectionLabel(s), mine: !!p.staffId && s.classTeacherId === p.staffId })).sort((a, b) => Number(b.mine) - Number(a.mine));
};

// ─── Files ───────────────────────────────────────────────────────────────────

/** Whether a person may open a file of a homework (its attachment, or a submission they may see). */
export const mayOpenFile = async (homeworkId: string, fileId: string, userId: string) => {
    const h = await db.homework.findFirst({ where: { id: homeworkId }, select: { id: true, attachmentIds: true } });
    if (!h) return false;
    const sub = await db.homeworkSubmission.findFirst({ where: { homeworkId, fileIds: { has: fileId } }, select: { studentId: true } });
    if (!h.attachmentIds.includes(fileId) && !sub) return false;
    // The student / their parents.
    const mine = await myStudents(userId);
    if (sub && mine.some((s) => s.id === sub.studentId)) return true;
    if (!sub && mine.length) {
        const hw = await db.homework.findFirst({ where: { id: homeworkId }, select: { sectionId: true } });
        if (mine.some((s) => s.sectionId === hw?.sectionId)) return true;
    }
    try {
        await loadForStaff(homeworkId, userId, 'view');
        return true;
    } catch {
        return false;
    }
};
