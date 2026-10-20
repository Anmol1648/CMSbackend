import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { assertYearOpen, currentYear } from '../academic/years.service';
import { staffName } from './staff.service';

/** Who teaches which subject to which section, per year (the timetable builds on this). */

const label = (s: { name: string; schoolClass: { shortName: string | null; name: string }; stream?: { name: string } | null }) =>
    `${s.schoolClass.shortName ?? s.schoolClass.name}-${s.name}${s.stream ? ` (${s.stream.name})` : ''}`;

/** The grid of one class in a year: its sections, its subjects (per stream) and who teaches each. */
export const assignmentGrid = async (yearId: string, classId: string) => {
    const [sections, classSubjects, assignments] = await Promise.all([
        db.section.findMany({
            where: { academicYearId: yearId, classId, isActive: true },
            include: { schoolClass: { select: { name: true, shortName: true } }, stream: { select: { id: true, name: true } }, classTeacher: { select: { id: true, firstName: true, lastName: true } } },
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        }),
        db.classSubject.findMany({ where: { academicYearId: yearId, classId }, include: { subject: { select: { id: true, name: true, code: true } } }, orderBy: { sortOrder: 'asc' } }),
        db.teachingAssignment.findMany({ where: { academicYearId: yearId, section: { classId } }, include: { staff: { select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true } } } }),
    ]);
    // One row per subject; a stream subject only applies to that stream's sections.
    const subjects = new Map<string, { id: string; name: string; code: string | null; streamIds: (string | null)[] }>();
    for (const cs of classSubjects) {
        const s = subjects.get(cs.subject.id) ?? { ...cs.subject, streamIds: [] };
        s.streamIds.push(cs.streamId);
        subjects.set(cs.subject.id, s);
    }
    return {
        sections: sections.map((s) => ({ id: s.id, label: label(s), streamId: s.streamId, classTeacher: s.classTeacher ? { id: s.classTeacher.id, name: staffName(s.classTeacher) } : null })),
        subjects: [...subjects.values()].map((s) => ({ id: s.id, name: s.name, code: s.code, appliesTo: sections.filter((sec) => s.streamIds.includes(null) || s.streamIds.includes(sec.streamId)).map((sec) => sec.id) })),
        cells: assignments.map((a) => ({ sectionId: a.sectionId, subjectId: a.subjectId, staff: { id: a.staff.id, name: staffName(a.staff), code: a.staff.employeeCode } })),
    };
};

export const assignSchema = z.strictObject({
    sectionId: z.uuid('choose a section'),
    subjectId: z.uuid('choose a subject'),
    /** Empty = nobody teaches it yet. */
    staffId: z.uuid('choose a teacher').nullable(),
});

export const setAssignment = async (input: z.infer<typeof assignSchema>) => {
    const section = await db.section.findUnique({ where: { id: input.sectionId }, include: { schoolClass: { select: { name: true } } } });
    if (!section) throw notFound('Section not found');
    await assertYearOpen(section.academicYearId);
    const taught = await db.classSubject.findFirst({
        where: { academicYearId: section.academicYearId, classId: section.classId, subjectId: input.subjectId, OR: [{ streamId: null }, ...(section.streamId ? [{ streamId: section.streamId }] : [])] },
        include: { subject: { select: { name: true } } },
    });
    if (!taught) throw badRequest(`${section.schoolClass.name} ${section.name} doesn't study this subject (Configuration → Subjects)`);
    const existing = await db.teachingAssignment.findUnique({ where: { sectionId_subjectId: { sectionId: input.sectionId, subjectId: input.subjectId } } });
    if (!input.staffId) {
        if (existing) await db.teachingAssignment.delete({ where: { id: existing.id } });
    } else {
        const staff = await db.staff.findFirst({ where: { id: input.staffId, status: 'working' }, select: { id: true } });
        if (!staff) throw badRequest('Choose a working staff member', [{ field: 'staffId', message: 'is not a working staff member' }]);
        if (existing) await db.teachingAssignment.update({ where: { id: existing.id }, data: { staffId: input.staffId } });
        else await db.teachingAssignment.create({ data: { tenantId: getTenantId()!, academicYearId: section.academicYearId, sectionId: input.sectionId, subjectId: input.subjectId, staffId: input.staffId } });
    }
    await recordAudit({ action: 'teacher_assigned', entity: 'section', entityId: input.sectionId, changes: { subject: taught.subject.name, teacher: [existing?.staffId ?? null, input.staffId] } });
    return assignmentGrid(section.academicYearId, section.classId);
};

/** Copies subject teachers from another year (sections matched by class and name); filled cells stay. */
export const copyAssignments = async (toYearId: string, fromYearId: string) => {
    if (toYearId === fromYearId) throw badRequest('Choose a different year to copy from');
    await assertYearOpen(toYearId);
    const [from, toSections, existing] = await Promise.all([
        db.teachingAssignment.findMany({ where: { academicYearId: fromYearId, staff: { status: 'working' } }, include: { section: { select: { classId: true, name: true } } } }),
        db.section.findMany({ where: { academicYearId: toYearId }, select: { id: true, classId: true, name: true } }),
        db.teachingAssignment.findMany({ where: { academicYearId: toYearId }, select: { sectionId: true, subjectId: true } }),
    ]);
    const target = new Map(toSections.map((s) => [`${s.classId}|${s.name.toLowerCase()}`, s.id]));
    const taken = new Set(existing.map((e) => `${e.sectionId}|${e.subjectId}`));
    const tenantId = getTenantId()!;
    const data = from.flatMap((a) => {
        const sectionId = target.get(`${a.section.classId}|${a.section.name.toLowerCase()}`);
        return sectionId && !taken.has(`${sectionId}|${a.subjectId}`) ? [{ tenantId, academicYearId: toYearId, sectionId, subjectId: a.subjectId, staffId: a.staffId }] : [];
    });
    if (!from.length) throw conflict('That year has no subject teachers to copy');
    const r = data.length ? await db.teachingAssignment.createMany({ data, skipDuplicates: true }) : { count: 0 };
    await recordAudit({ action: 'copy', entity: 'teaching', entityId: toYearId, changes: { from: fromYearId, assignments: r.count } });
    return { copied: r.count };
};

/** A teacher's own classes this year: sections they are class teacher of, and what they teach where. */
export const myTeaching = async (userId: string) => {
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    const year = await currentYear();
    if (!staff || !year) return { classTeacherOf: [], teaches: [] };
    const [ct, teaches] = await Promise.all([
        db.section.findMany({ where: { classTeacherId: staff.id, academicYearId: year.id }, include: { schoolClass: { select: { name: true, shortName: true } }, stream: { select: { name: true } } } }),
        db.teachingAssignment.findMany({
            where: { staffId: staff.id, academicYearId: year.id },
            include: { section: { include: { schoolClass: { select: { name: true, shortName: true, sortOrder: true } }, stream: { select: { name: true } } } }, subject: { select: { id: true, name: true } } },
        }),
    ]);
    return {
        classTeacherOf: ct.map((s) => ({ id: s.id, label: label(s) })),
        teaches: teaches
            .sort((a, b) => a.section.schoolClass.sortOrder - b.section.schoolClass.sortOrder || a.section.name.localeCompare(b.section.name))
            .map((a) => ({ section: { id: a.section.id, label: label(a.section) }, subject: a.subject })),
    };
};
