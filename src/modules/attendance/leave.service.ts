import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { getUserAccess } from '../rbac/access.service';
import { currentYear } from '../academic/years.service';
import { scopeWhere as studentScope, fullName } from '../students/students.service';
import { ATTENDANCE, dayDate, isoOf, todayIST } from './attendance.settings';
import { schoolDays } from './calendar.service';
import { leaveStatus, markableSections, statuses } from './student-attendance.service';

/**
 * Student leave: a parent or the student asks (or the office records it), the class teacher or the
 * office approves. Approved leave puts Leave / Medical leave in the registers of those days.
 */

const ISO = z.iso.date();
const day = (d: Date) => isoOf(d);
const show = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

const present = async (rows: Prisma.StudentLeaveGetPayload<{ include: { student: { select: { id: true; firstName: true; middleName: true; lastName: true; admissionNo: true } } } }>[]) => {
    const users = new Map(
        (await db.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.appliedBy, r.decidedBy]).filter((x): x is string => !!x))] } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName])
    );
    const year = await currentYear();
    const sections = year
        ? new Map(
              (
                  await db.enrolment.findMany({
                      where: { academicYearId: year.id, studentId: { in: rows.map((r) => r.studentId) } },
                      select: { studentId: true, rollNumber: true, section: { select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } } } } },
                  })
              ).map((e) => [e.studentId, e])
          )
        : new Map();
    const schoolDaysOf = await Promise.all(rows.map((r) => schoolDays(day(r.fromDate), day(r.toDate), 'students')));
    return rows.map((r, i) => {
        const e = sections.get(r.studentId);
        return {
            id: r.id,
            student: { id: r.student.id, name: fullName(r.student), admissionNo: r.student.admissionNo, section: e ? `${e.section.schoolClass.shortName ?? e.section.schoolClass.name}-${e.section.name}` : null, roll: e?.rollNumber ?? null },
            from: day(r.fromDate),
            to: day(r.toDate),
            days: schoolDaysOf[i].length,
            kind: r.kind,
            reason: r.reason,
            status: r.status,
            appliedBy: r.appliedBy ? (users.get(r.appliedBy) ?? null) : null,
            appliedAt: r.createdAt,
            decidedBy: r.decidedBy ? (users.get(r.decidedBy) ?? null) : null,
            decidedAt: r.decidedAt,
            decisionNote: r.decisionNote,
        };
    });
};
const studentSelect = { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } } as const;

/** May the person decide on this student's leave (class teacher / anyone who marks their section). */
const mayDecide = async (userId: string, studentId: string) => {
    const scope = await markableSections(userId);
    if (scope === 'all') return true;
    const year = await currentYear();
    if (!year) return false;
    const e = await db.enrolment.findFirst({ where: { studentId, academicYearId: year.id }, select: { sectionId: true, section: { select: { classTeacher: { select: { userId: true } } } } } });
    return !!e && (e.section.classTeacher?.userId === userId || scope.includes(e.sectionId));
};

// ─── Asking ──────────────────────────────────────────────────────────────────

export const applySchema = z
    .strictObject({
        student: z.uuid(),
        from: ISO,
        to: ISO,
        kind: z.enum(['leave', 'medical']).default('leave'),
        reason: z.string().trim().min(3, 'is too short').max(500),
    })
    .refine((x) => x.to >= x.from, { message: '“To” is before “from”', path: ['to'] });

/** A parent / student asks for leave (or the office records it for a student). */
export const applyLeave = async (input: z.infer<typeof applySchema>, userId: string) => {
    const a = await getUserAccess(userId);
    const office = !!a.permissions['attendance.mark_any'];
    if (!office) {
        if (!a.permissions['attendance.mine']) throw forbidden();
        const s = await getSettings({ online: ATTENDANCE.leaveOnline });
        if (!s.online) throw forbidden('Leave is asked for at the school office (it is switched off in the app)');
        const mine = await db.student.findFirst({ where: { id: input.student, ...(await studentScope({ userId, scope: 'own', sensitive: false })) }, select: { id: true } });
        if (!mine) throw forbidden('You can ask leave only for your own child');
    }
    const student = await db.student.findFirst({ where: { id: input.student }, ...studentSelect });
    if (!student) throw notFound('Student not found');
    const { backDays } = await getSettings({ backDays: ATTENDANCE.leaveBackDays });
    const earliest = isoOf(new Date(dayDate(todayIST()).getTime() - backDays * 86_400_000));
    if (!office && input.from < earliest) throw badRequest(`Leave can be asked for up to ${backDays} days back. Ask the school office for older days.`, [{ field: 'from', message: 'is too far back' }]);
    if (dayDate(input.to).getTime() - dayDate(input.from).getTime() > 90 * 86_400_000) throw badRequest('At most 90 days at a time', [{ field: 'to', message: 'is too far from “from”' }]);
    if (!(await schoolDays(input.from, input.to, 'students')).length) throw badRequest('There are no school days in those dates', [{ field: 'from', message: 'has no school days' }]);
    const overlap = await db.studentLeave.findFirst({ where: { studentId: student.id, status: { in: ['pending', 'approved'] }, fromDate: { lte: dayDate(input.to) }, toDate: { gte: dayDate(input.from) } }, select: { fromDate: true, toDate: true, status: true } });
    if (overlap) throw conflict(`There is already ${overlap.status === 'approved' ? 'approved' : 'a pending request for'} leave from ${show(day(overlap.fromDate))} to ${show(day(overlap.toDate))}`);
    const row = await db.studentLeave.create({ data: { tenantId: getTenantId()!, studentId: student.id, fromDate: dayDate(input.from), toDate: dayDate(input.to), kind: input.kind, reason: input.reason, appliedBy: userId } });
    await recordAudit({ action: 'student_leave_asked', entity: 'student_leave', entityId: row.id, changes: { student: fullName(student), from: input.from, to: input.to, kind: input.kind } });
    // The office's own entry needs no second step.
    if (office) return decideLeave(row.id, { approve: true, note: 'Recorded by the office' }, userId);
    return (await present([{ ...row, student }]))[0];
};

/** A student's leave requests (for the student, their parent, or anyone who may see them). */
export const leavesOf = async (studentId: string) =>
    present(await db.studentLeave.findMany({ where: { studentId }, include: { student: studentSelect }, orderBy: { fromDate: 'desc' }, take: 50 }));

/** The asker cancels a request still waiting (or approved leave that hasn't started yet). */
export const cancelLeave = async (id: string, userId: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Leave request not found');
    const r = await db.studentLeave.findFirst({ where: { id } });
    if (!r) throw notFound('Leave request not found');
    const a = await getUserAccess(userId);
    if (r.appliedBy !== userId && !a.permissions['attendance.mark_any']) throw forbidden('Only the person who asked can cancel it');
    if (!(r.status === 'pending' || (r.status === 'approved' && day(r.fromDate) > todayIST()))) throw badRequest('Only a request still waiting, or leave that hasn’t started, can be cancelled');
    await db.studentLeave.update({ where: { id }, data: { status: 'cancelled' } });
    await recordAudit({ action: 'student_leave_cancelled', entity: 'student_leave', entityId: id });
};

// ─── Deciding ────────────────────────────────────────────────────────────────

export const listQuery = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'all']).default('pending') });

/** Requests for the sections the person looks after (all of them for the office). */
export const leaveRequests = async (q: z.infer<typeof listQuery>, userId: string) => {
    const scope = await markableSections(userId);
    const year = await currentYear();
    let studentIds: string[] | null = null;
    if (scope !== 'all') {
        studentIds = year ? (await db.enrolment.findMany({ where: { academicYearId: year.id, sectionId: { in: scope } }, select: { studentId: true } })).map((e) => e.studentId) : [];
    }
    const rows = await db.studentLeave.findMany({
        where: { ...(q.status === 'all' ? {} : { status: q.status }), ...(studentIds ? { studentId: { in: studentIds } } : {}) },
        include: { student: studentSelect },
        orderBy: q.status === 'pending' ? { fromDate: 'asc' } : { updatedAt: 'desc' },
        take: 200,
    });
    return present(rows);
};

export const decideSchema = z.strictObject({ approve: z.boolean(), note: z.string().trim().max(300).optional() });

/** Approves (the registers of those days get Leave / Medical leave) or turns down a request. */
export const decideLeave = async (id: string, input: z.infer<typeof decideSchema>, userId: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Leave request not found');
    const r = await db.studentLeave.findFirst({ where: { id }, include: { student: studentSelect } });
    if (!r) throw notFound('Leave request not found');
    if (!(await mayDecide(userId, r.studentId))) throw forbidden('Only the class teacher or the office can decide this');
    if (r.status !== 'pending') throw badRequest('This request has already been decided');
    const status = leaveStatus(await statuses(), r.kind);
    await withTransaction(async (tx) => {
        await tx.studentLeave.update({ where: { id }, data: { status: input.approve ? 'approved' : 'rejected', decidedBy: userId, decidedAt: new Date(), decisionNote: input.note || null } });
        // Registers already marked for those days now show the leave.
        if (input.approve && status) await tx.attendanceMark.updateMany({ where: { studentId: r.studentId, sheet: { date: { gte: r.fromDate, lte: r.toDate } } }, data: { statusId: status.id } });
    });
    await recordAudit({ action: input.approve ? 'student_leave_approved' : 'student_leave_rejected', entity: 'student_leave', entityId: id, changes: { student: fullName(r.student), from: day(r.fromDate), to: day(r.toDate) } });
    return (await present([await db.studentLeave.findFirstOrThrow({ where: { id }, include: { student: studentSelect } })]))[0];
};

/** The leave of the person's own child (or of the student themself), and whether they can ask online. */
export const myLeaves = async (studentId: string, userId: string) => {
    if (!z.uuid().safeParse(studentId).success) throw notFound('Student not found');
    const mine = await db.student.findFirst({ where: { id: studentId, ...(await studentScope({ userId, scope: 'own', sensitive: false })) }, select: { id: true } });
    if (!mine) throw forbidden();
    const s = await getSettings({ online: ATTENDANCE.leaveOnline, backDays: ATTENDANCE.leaveBackDays });
    return { canAsk: s.online, backDays: s.backDays, leaves: await leavesOf(studentId) };
};
