import { db } from '../../core/db';
import { forbidden } from '../../core/errors';
import { currentYear } from '../academic/years.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { readPhoto } from '../students/student-files.service';

/**
 * "My children" for the app's home header: a parent's children (through their family), or the
 * student themselves, with this session's class and their photo.
 */

const mine = (userId: string) => ({ status: 'active' as const, OR: [{ userId }, { family: { guardians: { some: { userId } } } }] });

export const myChildren = async (userId: string) => {
    const students = await db.student.findMany({ where: mine(userId), select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, photoFileId: true }, orderBy: { firstName: 'asc' } });
    const year = await currentYear();
    const enrol = year
        ? await db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: students.map((s) => s.id) } }, select: { studentId: true, rollNumber: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } })
        : [];
    return students.map((s) => {
        const e = enrol.find((x) => x.studentId === s.id);
        return {
            id: s.id,
            name: fullName(s),
            firstName: s.firstName,
            admissionNo: s.admissionNo,
            section: e ? sectionLabel(e.section) : null,
            rollNumber: e?.rollNumber ?? null,
            photoUrl: s.photoFileId ? `mobile/children/${s.id}/photo?v=${s.photoFileId}` : null,
        };
    });
};

/** A child's photo, only for their own parent (or the student). */
export const childPhoto = async (userId: string, studentId: string) => {
    if (!(await db.student.count({ where: { id: studentId, ...mine(userId) } }))) throw forbidden('Not your child');
    return readPhoto(studentId);
};
