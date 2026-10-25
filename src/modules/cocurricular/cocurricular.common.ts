import { db } from '../../core/db';
import { badRequest, forbidden } from '../../core/errors';
import { getSetting } from '../../core/settings';
import { getUserAccess } from '../rbac/access.service';
import { currentYear } from '../academic/years.service';
import { ACADEMIC } from '../academic/academic.settings';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';

/** Shared by houses, clubs and competitions: permissions, the year, houses, and students' class and house. */

export const perms = async (userId: string) => (await getUserAccess(userId)).permissions;

export const need = async (userId: string, keys: string[]) => {
    const p = await perms(userId);
    if (!keys.some((k) => p[k])) throw forbidden();
    return p;
};

export const thisYear = async () => {
    const y = await currentYear();
    if (!y) throw badRequest('No current academic year');
    return y;
};

export const housesOn = () => getSetting(ACADEMIC.housesEnabled);

export interface House {
    id: string;
    name: string;
    colour: string;
}
export const houseList = async (withInactive = false): Promise<House[]> => {
    const rows = await db.masterValue.findMany({ where: { master: 'house', ...(withInactive ? {} : { isActive: true }) }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, extra: true } });
    return rows.map((h) => ({ id: h.id, name: h.name, colour: String((h.extra as { colour?: string } | null)?.colour ?? '#64748B') }));
};

export const masterNames = async (ids: (string | null | undefined)[]) => {
    const list = ids.filter((x): x is string => !!x);
    if (!list.length) return new Map<string, string>();
    return new Map((await db.masterValue.findMany({ where: { id: { in: list } }, select: { id: true, name: true } })).map((m) => [m.id, m.name]));
};

/** Students with their name, admission no., section and house this year. */
export const studentInfo = async (ids: string[], yearId: string) => {
    if (!ids.length) return new Map<string, { id: string; name: string; admissionNo: string; section: string; sectionId: string | null; classId: string | null; houseId: string | null; genderId: string | null; familyId: string | null }>();
    const [students, enrol] = await Promise.all([
        db.student.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, genderId: true, familyId: true } }),
        db.enrolment.findMany({ where: { academicYearId: yearId, studentId: { in: ids } }, select: { studentId: true, sectionId: true, houseId: true, section: { select: { name: true, classId: true, schoolClass: { select: { name: true, shortName: true } } } } } }),
    ]);
    return new Map(
        students.map((s) => {
            const e = enrol.find((x) => x.studentId === s.id);
            return [s.id, { id: s.id, name: fullName(s), admissionNo: s.admissionNo, section: e ? sectionLabel(e.section) : '', sectionId: e?.sectionId ?? null, classId: e?.section.classId ?? null, houseId: e?.houseId ?? null, genderId: s.genderId, familyId: s.familyId }];
        })
    );
};

/** The students a parent or student login stands for (own record, or their children). */
export const myStudents = (userId: string) =>
    db.student.findMany({ where: { status: 'active', OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, select: { id: true, firstName: true, middleName: true, lastName: true } });

/** Staff names by id. */
export const staffNames = async (ids: (string | null | undefined)[]) => {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map<string, string>();
    return new Map((await db.staff.findMany({ where: { id: { in: list } }, select: { id: true, firstName: true, middleName: true, lastName: true } })).map((s) => [s.id, [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ')]));
};

export const myStaffId = async (userId: string) => (await db.staff.findFirst({ where: { userId }, select: { id: true } }))?.id ?? null;

/** Students to pick (by name / admission no.) among this year's, optionally of some classes. */
export const searchStudents = async (q: string, classIds: string[] = []) => {
    const t = q.trim();
    if (t.length < 2) return [];
    const year = await thisYear();
    const rows = await db.enrolment.findMany({
        where: { academicYearId: year.id, ...(classIds.length ? { section: { classId: { in: classIds } } } : {}), student: { status: 'active', OR: [{ firstName: { startsWith: t, mode: 'insensitive' } }, { lastName: { startsWith: t, mode: 'insensitive' } }, { admissionNo: { contains: t, mode: 'insensitive' } }] } },
        take: 15,
        select: { houseId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } }, student: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } } },
    });
    return rows.map((r) => ({ id: r.student.id, name: fullName(r.student), admissionNo: r.student.admissionNo, section: sectionLabel(r.section), houseId: r.houseId }));
};

export const DAY = 86_400_000;
