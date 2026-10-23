import { db } from '../../core/db';
import { currentYear } from '../academic/years.service';
import { fullName } from '../students/students.service';

/** The people messages go to, with what each can be reached on. */

export interface Recipient {
    userId: string | null;
    name: string;
    email: string | null;
    mobile: string | null;
    kind: 'staff' | 'student' | 'parent' | 'other';
}

const clean = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);
const staffName = (s: { firstName: string; middleName?: string | null; lastName?: string | null }) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');

/** Active logins of these users (for in-app), with their email / mobile. */
const usersById = async (ids: string[]) => {
    const list = [...new Set(ids.filter(Boolean))];
    if (!list.length) return new Map<string, { email: string | null; mobile: string | null; displayName: string }>();
    const rows = await db.user.findMany({ where: { id: { in: list }, status: 'active' }, select: { id: true, email: true, mobile: true, displayName: true } });
    return new Map(rows.map((u) => [u.id, u]));
};

/** Students themselves (their own login / email / mobile). */
export const studentsOf = async (studentIds: string[]): Promise<(Recipient & { studentIds: string[] })[]> => {
    if (!studentIds.length) return [];
    const rows = await db.student.findMany({ where: { id: { in: studentIds } }, select: { id: true, firstName: true, middleName: true, lastName: true, email: true, mobile: true, userId: true } });
    const users = await usersById(rows.map((r) => r.userId!).filter(Boolean));
    return rows.map((s) => ({ userId: s.userId && users.has(s.userId) ? s.userId : null, name: fullName(s), email: clean(s.email), mobile: clean(s.mobile), kind: 'student' as const, studentIds: [s.id] }));
};

/** The guardians of these students (every guardian with a login, email or mobile; the primary first). */
export const parentsOf = async (studentIds: string[]): Promise<(Recipient & { studentIds: string[] })[]> => {
    if (!studentIds.length) return [];
    const kids = await db.student.findMany({ where: { id: { in: studentIds }, familyId: { not: null } }, select: { id: true, familyId: true } });
    const byFamily = new Map<string, string[]>();
    for (const k of kids) byFamily.set(k.familyId!, [...(byFamily.get(k.familyId!) ?? []), k.id]);
    const guardians = await db.guardian.findMany({ where: { familyId: { in: [...byFamily.keys()] } }, select: { name: true, email: true, mobile: true, userId: true, familyId: true, isPrimary: true }, orderBy: [{ isPrimary: 'desc' }] });
    const users = await usersById(guardians.map((g) => g.userId!).filter(Boolean));
    const out = new Map<string, Recipient & { studentIds: string[] }>();
    for (const g of guardians) {
        const userId = g.userId && users.has(g.userId) ? g.userId : null;
        const email = clean(g.email) ?? (userId ? clean(users.get(userId)!.email) : null);
        const mobile = clean(g.mobile);
        if (!userId && !email && !mobile) continue;
        const id = userId ?? email ?? mobile!;
        const prev = out.get(id);
        const ids = byFamily.get(g.familyId) ?? [];
        if (prev) prev.studentIds = [...new Set([...prev.studentIds, ...ids])];
        else out.set(id, { userId, name: g.name, email, mobile, kind: 'parent', studentIds: ids });
    }
    return [...out.values()];
};

/** Staff members (working), by staff id. */
export const staffOf = async (staffIds: string[]): Promise<Recipient[]> => {
    if (!staffIds.length) return [];
    const rows = await db.staff.findMany({ where: { id: { in: staffIds }, status: 'working' }, select: { firstName: true, middleName: true, lastName: true, email: true, mobile: true, userId: true } });
    const users = await usersById(rows.map((r) => r.userId!).filter(Boolean));
    return rows.map((s) => ({ userId: s.userId && users.has(s.userId) ? s.userId : null, name: staffName(s), email: clean(s.email) ?? (s.userId ? clean(users.get(s.userId)?.email) : null), mobile: clean(s.mobile), kind: 'staff' as const }));
};

/** Users by id (any kind): their login, and the email / mobile of their staff or guardian record. */
export const usersOf = async (userIds: string[]): Promise<Recipient[]> => {
    const users = await usersById(userIds);
    if (!users.size) return [];
    const ids = [...users.keys()];
    const [staff, guardians, students] = await Promise.all([
        db.staff.findMany({ where: { userId: { in: ids } }, select: { userId: true, firstName: true, middleName: true, lastName: true, email: true, mobile: true } }),
        db.guardian.findMany({ where: { userId: { in: ids } }, select: { userId: true, name: true, email: true, mobile: true } }),
        db.student.findMany({ where: { userId: { in: ids } }, select: { userId: true, email: true, mobile: true } }),
    ]);
    return ids.map((id) => {
        const u = users.get(id)!;
        const s = staff.find((x) => x.userId === id);
        if (s) return { userId: id, name: staffName(s), email: clean(s.email) ?? clean(u.email), mobile: clean(s.mobile) ?? clean(u.mobile), kind: 'staff' as const };
        const g = guardians.find((x) => x.userId === id);
        if (g) return { userId: id, name: g.name, email: clean(g.email) ?? clean(u.email), mobile: clean(g.mobile) ?? clean(u.mobile), kind: 'parent' as const };
        const st = students.find((x) => x.userId === id);
        if (st) return { userId: id, name: u.displayName, email: clean(st.email) ?? clean(u.email), mobile: clean(st.mobile) ?? clean(u.mobile), kind: 'student' as const };
        return { userId: id, name: u.displayName, email: clean(u.email), mobile: clean(u.mobile), kind: 'other' as const };
    });
};

/** Everyone whose role has a permission (e.g. leave.approve_all), as recipients. */
export const holdersOf = async (permissionKey: string): Promise<Recipient[]> => {
    const roles = await db.rolePermission.findMany({ where: { permissionKey }, select: { roleId: true } });
    if (!roles.length) return [];
    const users = await db.user.findMany({ where: { status: 'active', roles: { some: { roleId: { in: roles.map((r) => r.roleId) } } } }, select: { id: true } });
    return usersOf(users.map((u) => u.id));
};

/** The class teachers of the sections these students are in (current session). */
export const classTeachersOf = async (studentIds: string[]): Promise<Recipient[]> => {
    const year = await currentYear();
    if (!year || !studentIds.length) return [];
    const rows = await db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: studentIds } }, select: { section: { select: { classTeacherId: true } } } });
    return staffOf([...new Set(rows.map((r) => r.section.classTeacherId!).filter(Boolean))]);
};

/** The current sections of these students (to file an alert under, for the log's Assigned scope). */
export const sectionsOfStudents = async (studentIds: string[]) => {
    const year = await currentYear();
    if (!year || !studentIds.length) return [];
    const rows = await db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: studentIds } }, select: { sectionId: true } });
    return [...new Set(rows.map((r) => r.sectionId))];
};

/** A recipient's id for de-duplicating (one person, many records). */
export const recipientId = (r: Recipient) => r.userId ?? r.email?.toLowerCase() ?? r.mobile ?? r.name;
