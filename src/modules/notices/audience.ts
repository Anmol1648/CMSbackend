import { z } from 'zod';
import { db } from '../../core/db';
import { getSettings } from '../../core/settings';
import { currentYear } from '../academic/years.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { NOTICES } from './notices.settings';

/**
 * Who a notice or event is for: everyone, all staff or some roles, and students / parents of the
 * whole school or of some classes / sections. The same rules decide what a person sees and who is
 * counted in "read by 28 of 34".
 */

export interface Audience {
    forEveryone: boolean;
    forAllStaff: boolean;
    roleIds: string[];
    forStudents: boolean;
    forParents: boolean;
    classIds: string[];
    sectionIds: string[];
}

const ids = z.array(z.uuid()).max(200).default([]);
export const audienceFields = {
    forEveryone: z.boolean().default(false),
    forAllStaff: z.boolean().default(false),
    roleIds: ids,
    forStudents: z.boolean().default(false),
    forParents: z.boolean().default(false),
    classIds: ids,
    sectionIds: ids,
};
export const hasAudience = (a: Audience) => a.forEveryone || a.forAllStaff || a.roleIds.length > 0 || a.forStudents || a.forParents;

/** The classes and sections a student or a parent's children are in this session. */
type Group = { sectionIds: string[]; classIds: string[]; labels: string[] };

export interface Viewer {
    userId: string;
    staff: boolean;
    roleIds: Set<string>;
    student: Group | null;
    parent: Group | null;
}

const groupOf = async (studentIds: string[]): Promise<Group | null> => {
    const year = await currentYear();
    if (!year || !studentIds.length) return null;
    const rows = await db.enrolment.findMany({
        where: { academicYearId: year.id, studentId: { in: studentIds }, student: { status: 'active' } },
        select: { sectionId: true, section: { select: { classId: true, name: true, schoolClass: { select: { name: true, shortName: true } } } } },
    });
    return { sectionIds: rows.map((r) => r.sectionId), classIds: rows.map((r) => r.section.classId), labels: rows.map((r) => sectionLabel(r.section)) };
};

/** What decides which notices a person sees. */
export const viewerOf = async (userId: string): Promise<Viewer> => {
    const u = await db.user.findFirst({ where: { id: userId }, select: { kind: true, roles: { select: { roleId: true } } } });
    const { families } = await getSettings({ families: NOTICES.families });
    const v: Viewer = { userId, staff: u?.kind === 'staff' || u?.kind === 'admin', roleIds: new Set(u?.roles.map((r) => r.roleId) ?? []), student: null, parent: null };
    if (!families) return v;
    if (u?.kind === 'student') {
        const s = await db.student.findFirst({ where: { userId }, select: { id: true } });
        v.student = s ? await groupOf([s.id]) : null;
    }
    if (u?.kind === 'guardian') {
        const families = (await db.guardian.findMany({ where: { userId }, select: { familyId: true } })).map((g) => g.familyId);
        const children = families.length ? (await db.student.findMany({ where: { familyId: { in: families }, status: 'active' }, select: { id: true } })).map((s) => s.id) : [];
        v.parent = await groupOf(children);
    }
    return v;
};

const inGroup = (a: Audience, g: Group | null) =>
    !!g && g.sectionIds.length > 0 && ((!a.classIds.length && !a.sectionIds.length) || g.sectionIds.some((s) => a.sectionIds.includes(s)) || g.classIds.some((c) => a.classIds.includes(c)));

/** Is the notice / event meant for this person. */
export const meantFor = (a: Audience, v: Viewer) => {
    if (a.forEveryone && (v.staff || v.student || v.parent)) return true;
    if (v.staff && (a.forAllStaff || a.forEveryone || a.roleIds.some((r) => v.roleIds.has(r)))) return true;
    if ((a.forStudents || a.forEveryone) && inGroup(a, v.student)) return true;
    return (a.forParents || a.forEveryone) && inGroup(a, v.parent);
};

// ─── Everyone in the school (for read counts) ────────────────────────────────

export interface Member {
    userId: string;
    name: string;
    /** "Staff", "VII-B students", "VII-B parents". */
    group: string;
    kind: 'staff' | 'student' | 'parent';
    roleIds: string[];
    sectionIds: string[];
    classIds: string[];
}

/** Every person with a login who could be sent a notice, once (then filtered per notice). */
export const population = async (): Promise<Member[]> => {
    const year = await currentYear();
    const { families } = await getSettings({ families: NOTICES.families });
    const users = await db.user.findMany({ where: { status: 'active', kind: { in: ['staff', 'admin'] } }, select: { id: true, displayName: true, roles: { select: { roleId: true } } } });
    const out: Member[] = users.map((u) => ({ userId: u.id, name: u.displayName, group: 'Staff', kind: 'staff', roleIds: u.roles.map((r) => r.roleId), sectionIds: [], classIds: [] }));
    if (!year || !families) return out;
    const enrol = await db.enrolment.findMany({
        where: { academicYearId: year.id, student: { status: 'active' } },
        select: { sectionId: true, section: { select: { classId: true, name: true, schoolClass: { select: { name: true, shortName: true } } } }, student: { select: { userId: true, familyId: true, firstName: true, middleName: true, lastName: true, user: { select: { status: true, displayName: true } } } } },
    });
    const byFamily = new Map<string, typeof enrol>();
    for (const e of enrol) {
        if (e.student.userId && e.student.user?.status === 'active')
            out.push({ userId: e.student.userId, name: e.student.user.displayName, group: `${sectionLabel(e.section)} students`, kind: 'student', roleIds: [], sectionIds: [e.sectionId], classIds: [e.section.classId] });
        if (e.student.familyId) byFamily.set(e.student.familyId, [...(byFamily.get(e.student.familyId) ?? []), e]);
    }
    const guardians = await db.guardian.findMany({ where: { userId: { not: null }, familyId: { in: [...byFamily.keys()] } }, select: { userId: true, familyId: true, user: { select: { status: true, displayName: true } } } });
    const seen = new Set<string>();
    for (const g of guardians) {
        if (!g.userId || g.user?.status !== 'active' || seen.has(g.userId)) continue;
        seen.add(g.userId);
        const kids = byFamily.get(g.familyId) ?? [];
        out.push({ userId: g.userId, name: g.user.displayName, group: `${kids.map((k) => sectionLabel(k.section)).join(', ')} parents`, kind: 'parent', roleIds: [], sectionIds: kids.map((k) => k.sectionId), classIds: kids.map((k) => k.section.classId) });
    }
    return out;
};

/** The people a notice / event is meant for. */
export const membersOf = (a: Audience, everyone: Member[]) =>
    everyone.filter((m) => {
        const g = { sectionIds: m.sectionIds, classIds: m.classIds, labels: [] };
        if (m.kind === 'staff') return a.forEveryone || a.forAllStaff || a.roleIds.some((r) => m.roleIds.includes(r));
        if (m.kind === 'student') return (a.forEveryone || a.forStudents) && inGroup(a, g);
        return (a.forEveryone || a.forParents) && inGroup(a, g);
    });

/** "Everyone", "All staff · VII-B parents"… */
export const describeAudience = async (a: Audience) => {
    if (a.forEveryone) return 'Everyone';
    const [roles, classes, sections] = await Promise.all([
        a.roleIds.length ? db.role.findMany({ where: { id: { in: a.roleIds } }, select: { name: true } }) : [],
        a.classIds.length ? db.schoolClass.findMany({ where: { id: { in: a.classIds } }, select: { name: true } }) : [],
        a.sectionIds.length ? db.section.findMany({ where: { id: { in: a.sectionIds } }, select: { name: true, schoolClass: { select: { name: true, shortName: true } } } }) : [],
    ]);
    const where = [...classes.map((c) => c.name), ...sections.map(sectionLabel)];
    const of = where.length ? ` of ${where.join(', ')}` : '';
    return [a.forAllStaff ? 'All staff' : roles.length ? roles.map((r) => r.name).join(', ') : null, a.forStudents ? `Students${of}` : null, a.forParents ? `Parents${of}` : null].filter(Boolean).join(' · ') || 'Nobody';
};

/** Roles, classes and this session's sections, for the "who is it for" picker. */
export const audienceOptions = async () => {
    const year = await currentYear();
    const [roles, classes, sections] = await Promise.all([
        db.role.findMany({ where: { slug: { notIn: ['student', 'guardian'] } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
        db.schoolClass.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { sortOrder: 'asc' } }),
        year
            ? db.section.findMany({ where: { academicYearId: year.id, isActive: true }, select: { id: true, classId: true, name: true, schoolClass: { select: { name: true, shortName: true } } }, orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }] })
            : [],
    ]);
    return { roles, classes, sections: sections.map((s) => ({ id: s.id, classId: s.classId, label: sectionLabel(s) })) };
};

export const pickAudience = (x: Audience): Audience => ({ forEveryone: x.forEveryone, forAllStaff: x.forAllStaff, roleIds: x.roleIds, forStudents: x.forStudents, forParents: x.forParents, classIds: x.classIds, sectionIds: x.sectionIds });
