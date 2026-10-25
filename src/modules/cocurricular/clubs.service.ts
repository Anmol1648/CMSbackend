import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { dayDate, isoOf } from '../attendance/attendance.settings';
import { raiseLater } from '../alerts/deliver';
import { parentsOf, staffOf, studentsOf } from '../alerts/recipients';
import { COCURRICULAR } from './cocurricular.settings';
import { masterNames, myStaffId, myStudents, need, perms, staffNames, studentInfo, thisYear } from './cocurricular.common';

/**
 * Clubs: each has teachers in-charge, the classes that may join and a seat limit. In-charges add
 * members (or accept requests from students and parents), record meetings and activities with
 * attendance and photos, and give a grade / remark for the year (co-scholastic).
 */

export const MEMBER_ROLES: Record<string, string> = { member: 'Member', secretary: 'Secretary', president: 'President' };

type ClubRow = NonNullable<Awaited<ReturnType<typeof db.club.findFirst>>>;

/** May this person run the club (club.manage: any; club.run: the ones they are in-charge of)? */
const mayRun = async (club: ClubRow, userId: string) => {
    const p = await perms(userId);
    if (p['club.manage']) return true;
    if (!p['club.run']) return false;
    const me = await myStaffId(userId);
    return !!me && club.inchargeIds.includes(me);
};
const loadClub = async (id: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Club not found');
    const c = await db.club.findFirst({ where: { id } });
    if (!c) throw notFound('Club not found');
    return c;
};
const runOrThrow = async (id: string, userId: string) => {
    const c = await loadClub(id);
    if (!(await mayRun(c, userId))) throw forbidden('Only the club’s in-charge can do this');
    return c;
};

export const clubOptions = async () => {
    const [categories, classes, staff] = await Promise.all([
        db.masterValue.findMany({ where: { master: 'club_category', isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } }),
        db.schoolClass.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } }),
        db.staff.findMany({ where: { status: 'working' }, orderBy: { firstName: 'asc' }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true } }),
    ]);
    return { categories, classes, staff: staff.map((s) => ({ id: s.id, name: [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' '), code: s.employeeCode })), roles: Object.entries(MEMBER_ROLES).map(([value, label]) => ({ value, label })) };
};

/** Every club with its members this year and waiting requests. */
export const listClubs = async (userId: string) => {
    const p = await need(userId, ['cocurricular.view', 'club.manage', 'club.run']);
    const year = await thisYear();
    const [clubs, counts, me] = await Promise.all([
        db.club.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] }),
        db.clubMember.groupBy({ by: ['clubId', 'status'], where: { academicYearId: year.id, status: { in: ['active', 'requested'] } }, _count: { _all: true } }),
        myStaffId(userId),
    ]);
    const [cats, staff, classes] = await Promise.all([masterNames(clubs.map((c) => c.categoryId)), staffNames(clubs.flatMap((c) => c.inchargeIds)), db.schoolClass.findMany({ select: { id: true, name: true } })]);
    const n = (clubId: string, status: string) => counts.find((c) => c.clubId === clubId && c.status === status)?._count._all ?? 0;
    return {
        clubs: clubs.map((c) => ({
            id: c.id,
            name: c.name,
            description: c.description,
            category: cats.get(c.categoryId ?? '') ?? null,
            incharges: c.inchargeIds.map((i) => staff.get(i) ?? '').filter(Boolean),
            classes: c.classIds.length ? c.classIds.map((i) => classes.find((x) => x.id === i)?.name ?? '').filter(Boolean).join(', ') : 'All classes',
            members: n(c.id, 'active'),
            requests: n(c.id, 'requested'),
            maxMembers: c.maxMembers,
            meets: c.meets,
            isActive: c.isActive,
            mine: !!me && c.inchargeIds.includes(me),
            canRun: !!p['club.manage'] || (!!p['club.run'] && !!me && c.inchargeIds.includes(me)),
        })),
        can: { manage: !!p['club.manage'] },
    };
};

export const clubSchema = z.strictObject({
    name: z.string().trim().min(2, 'is required').max(80),
    description: z.string().trim().max(1000).nullable().optional(),
    categoryId: z.uuid().nullable().optional(),
    inchargeIds: z.array(z.uuid()).max(10).default([]),
    classIds: z.array(z.uuid()).max(100).default([]),
    maxMembers: z.number().int().min(1).max(2000).nullable().optional(),
    meets: z.string().trim().max(120).nullable().optional(),
    openToRequests: z.boolean().default(true),
    isActive: z.boolean().default(true),
});
const clubData = (i: z.infer<typeof clubSchema>) => ({ name: i.name, description: i.description || null, categoryId: i.categoryId ?? null, inchargeIds: i.inchargeIds, classIds: i.classIds, maxMembers: i.maxMembers ?? null, meets: i.meets || null, openToRequests: i.openToRequests, isActive: i.isActive });
const nameTaken = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

export const createClub = async (input: z.infer<typeof clubSchema>, userId: string) => {
    await need(userId, ['club.manage']);
    try {
        const c = await db.club.create({ data: { tenantId: getTenantId()!, ...clubData(input) } });
        await recordAudit({ action: 'club_created', entity: 'club', entityId: c.id, changes: { name: c.name } });
        return getClub(c.id, userId);
    } catch (e) {
        if (nameTaken(e)) throw conflict(`There is already a club called ${input.name}`);
        throw e;
    }
};

export const updateClub = async (id: string, input: z.infer<typeof clubSchema>, userId: string) => {
    await need(userId, ['club.manage']);
    await loadClub(id);
    try {
        await db.club.update({ where: { id }, data: clubData(input) });
    } catch (e) {
        if (nameTaken(e)) throw conflict(`There is already a club called ${input.name}`);
        throw e;
    }
    await recordAudit({ action: 'club_updated', entity: 'club', entityId: id, changes: { name: input.name } });
    return getClub(id, userId);
};

export const deleteClub = async (id: string, userId: string) => {
    await need(userId, ['club.manage']);
    const c = await loadClub(id);
    if (await db.clubMember.count({ where: { clubId: id, status: { in: ['active', 'left'] } } })) throw badRequest(`${c.name} has had members: make it inactive instead`);
    await db.club.delete({ where: { id } });
    await recordAudit({ action: 'club_deleted', entity: 'club', entityId: id, changes: { name: c.name } });
    return { id, deleted: true };
};

/** One club: members and requests this year, meetings. */
export const getClub = async (id: string, userId: string) => {
    const p = await need(userId, ['cocurricular.view', 'club.manage', 'club.run']);
    const c = await loadClub(id);
    const year = await thisYear();
    const [members, meetings, canRun] = await Promise.all([
        db.clubMember.findMany({ where: { clubId: id, academicYearId: year.id, status: { in: ['active', 'requested'] } }, orderBy: { createdAt: 'asc' } }),
        db.clubMeeting.findMany({ where: { clubId: id, academicYearId: year.id }, orderBy: { date: 'desc' } }),
        mayRun(c, userId),
    ]);
    const [info, cats, staff, users] = await Promise.all([
        studentInfo(members.map((m) => m.studentId), year.id),
        masterNames([c.categoryId]),
        staffNames(c.inchargeIds),
        db.user.findMany({ where: { id: { in: members.map((m) => m.requestedBy!).filter(Boolean) } }, select: { id: true, displayName: true } }),
    ]);
    const active = members.filter((m) => m.status === 'active');
    const row = (m: (typeof members)[number]) => {
        const s = info.get(m.studentId);
        const attended = meetings.filter((x) => x.presentIds.includes(m.studentId)).length;
        return { id: m.id, studentId: m.studentId, name: s?.name ?? '', admissionNo: s?.admissionNo ?? '', section: s?.section ?? '', role: m.role, roleLabel: MEMBER_ROLES[m.role] ?? m.role, grade: m.grade, remark: m.remark, attended, requestedBy: users.find((u) => u.id === m.requestedBy)?.displayName ?? null, requestNote: m.requestNote, at: m.createdAt };
    };
    return {
        id: c.id,
        name: c.name,
        description: c.description,
        categoryId: c.categoryId,
        category: cats.get(c.categoryId ?? '') ?? null,
        inchargeIds: c.inchargeIds,
        incharges: c.inchargeIds.map((i) => staff.get(i) ?? '').filter(Boolean),
        classIds: c.classIds,
        maxMembers: c.maxMembers,
        meets: c.meets,
        openToRequests: c.openToRequests,
        isActive: c.isActive,
        members: active.map(row).sort((a, b) => a.section.localeCompare(b.section, 'en', { numeric: true }) || a.name.localeCompare(b.name)),
        requests: members.filter((m) => m.status === 'requested').map(row),
        meetings: meetings.map((x) => ({ id: x.id, date: isoOf(x.date), title: x.title, notes: x.notes, presentIds: x.presentIds, present: x.presentIds.length, photoIds: x.photoIds })),
        can: { run: canRun, manage: !!p['club.manage'] },
    };
};

// ─── Members ─────────────────────────────────────────────────────────────────

/** Checks a student may join: class, seats, and the clubs-per-student limit. */
const checkJoin = async (c: ClubRow, studentIds: string[], yearId: string, extra = 0) => {
    const info = await studentInfo(studentIds, yearId);
    for (const id of studentIds) {
        const s = info.get(id);
        if (!s?.sectionId) throw badRequest('That student isn’t enrolled this year');
        if (c.classIds.length && !c.classIds.includes(s.classId!)) throw badRequest(`${c.name} isn’t open to ${s.name}’s class`);
    }
    if (c.maxMembers) {
        const now = await db.clubMember.count({ where: { clubId: c.id, academicYearId: yearId, status: 'active', studentId: { notIn: studentIds } } });
        if (now + studentIds.length + extra > c.maxMembers) throw badRequest(`${c.name} has room for ${Math.max(0, c.maxMembers - now)} more (of ${c.maxMembers})`);
    }
    const { max } = await getSettings({ max: COCURRICULAR.maxClubs });
    if (max) {
        const other = await db.clubMember.groupBy({ by: ['studentId'], where: { academicYearId: yearId, status: 'active', studentId: { in: studentIds }, clubId: { not: c.id } }, _count: { _all: true } });
        const full = other.find((o) => o._count._all >= max);
        if (full) throw badRequest(`${info.get(full.studentId)?.name ?? 'A student'} is already in ${max} club${max === 1 ? '' : 's'} (System Settings → Co-curricular)`);
    }
    return info;
};

export const addMembersSchema = z.strictObject({ studentIds: z.array(z.uuid()).min(1).max(200) });
export const addMembers = async (id: string, input: z.infer<typeof addMembersSchema>, userId: string) => {
    const c = await runOrThrow(id, userId);
    const year = await thisYear();
    const ids = [...new Set(input.studentIds)];
    await checkJoin(c, ids, year.id);
    for (const studentId of ids) {
        await db.clubMember.upsert({
            where: { clubId_academicYearId_studentId: { clubId: id, academicYearId: year.id, studentId } },
            create: { tenantId: getTenantId()!, clubId: id, academicYearId: year.id, studentId, status: 'active', joinedAt: new Date() },
            update: { status: 'active', joinedAt: new Date() },
        });
    }
    await recordAudit({ action: 'club_members_added', entity: 'club', entityId: id, changes: { students: ids.length } });
    return getClub(id, userId);
};

export const memberSchema = z.strictObject({
    role: z.enum(Object.keys(MEMBER_ROLES) as [string, ...string[]]).optional(),
    /** active = accept a request; refused = refuse it; left = remove from the club. */
    status: z.enum(['active', 'refused', 'left']).optional(),
    grade: z.string().trim().max(10).nullable().optional(),
    remark: z.string().trim().max(300).nullable().optional(),
});
export const updateMember = async (memberId: string, input: z.infer<typeof memberSchema>, userId: string) => {
    const m = await db.clubMember.findFirst({ where: { id: memberId } });
    if (!m) throw notFound('Not found');
    const c = await runOrThrow(m.clubId, userId);
    if (input.status === 'active' && m.status !== 'active') await checkJoin(c, [m.studentId], m.academicYearId);
    await db.clubMember.update({ where: { id: memberId }, data: { ...(input.role ? { role: input.role } : {}), ...(input.status ? { status: input.status, ...(input.status === 'active' ? { joinedAt: new Date() } : {}) } : {}), ...(input.grade !== undefined ? { grade: input.grade || null } : {}), ...(input.remark !== undefined ? { remark: input.remark || null } : {}) } });
    // A request answered: the student and parents are told.
    if (m.status === 'requested' && (input.status === 'active' || input.status === 'refused')) {
        const s = (await studentInfo([m.studentId], m.academicYearId)).get(m.studentId);
        raiseLater('club_request_answered', { parent: () => parentsOf([m.studentId]), student: () => studentsOf([m.studentId]) }, { club: c.name, student: s?.name ?? '', answer: input.status === 'active' ? 'accepted' : 'not accepted this time' }, { dedupe: `club-answer:${m.id}:${input.status}` });
    }
    return getClub(m.clubId, userId);
};

// ─── Meetings ────────────────────────────────────────────────────────────────

export const meetingSchema = z.strictObject({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    title: z.string().trim().min(2, 'is required').max(150),
    notes: z.string().trim().max(3000).nullable().optional(),
    presentIds: z.array(z.uuid()).max(2000).default([]),
    photoIds: z.array(z.uuid()).max(10).default([]),
});
const meetingData = async (clubId: string, yearId: string, i: z.infer<typeof meetingSchema>) => {
    const members = new Set((await db.clubMember.findMany({ where: { clubId, academicYearId: yearId, status: 'active' }, select: { studentId: true } })).map((m) => m.studentId));
    return { date: dayDate(i.date), title: i.title, notes: i.notes || null, presentIds: i.presentIds.filter((x) => members.has(x)), photoIds: i.photoIds };
};

export const addMeeting = async (clubId: string, input: z.infer<typeof meetingSchema>, userId: string) => {
    await runOrThrow(clubId, userId);
    const year = await thisYear();
    await db.clubMeeting.create({ data: { tenantId: getTenantId()!, clubId, academicYearId: year.id, recordedBy: userId, ...(await meetingData(clubId, year.id, input)) } });
    return getClub(clubId, userId);
};

export const updateMeeting = async (meetingId: string, input: z.infer<typeof meetingSchema>, userId: string) => {
    const x = await db.clubMeeting.findFirst({ where: { id: meetingId } });
    if (!x) throw notFound('Not found');
    await runOrThrow(x.clubId, userId);
    await db.clubMeeting.update({ where: { id: meetingId }, data: await meetingData(x.clubId, x.academicYearId, input) });
    return getClub(x.clubId, userId);
};

export const deleteMeeting = async (meetingId: string, userId: string) => {
    const x = await db.clubMeeting.findFirst({ where: { id: meetingId } });
    if (!x) throw notFound('Not found');
    await runOrThrow(x.clubId, userId);
    await db.clubMeeting.delete({ where: { id: meetingId } });
    return getClub(x.clubId, userId);
};

/** A photo of a meeting, for those who may see the club (or its members' families). */
export const meetingPhoto = async (meetingId: string, fileId: string, userId: string) => {
    const x = await db.clubMeeting.findFirst({ where: { id: meetingId } });
    if (!x || !x.photoIds.includes(fileId)) throw notFound('Not found');
    const p = await perms(userId);
    if (p['cocurricular.view'] || p['club.manage'] || p['club.run']) return fileId;
    const kids = (await myStudents(userId)).map((k) => k.id);
    if (p['cocurricular.mine'] && (await db.clubMember.count({ where: { clubId: x.clubId, studentId: { in: kids }, status: 'active' } }))) return fileId;
    throw forbidden();
};

// ─── Requests (students and parents) ─────────────────────────────────────────

export const requestSchema = z.strictObject({ studentId: z.uuid(), note: z.string().trim().max(300).nullable().optional() });

export const requestJoin = async (clubId: string, input: z.infer<typeof requestSchema>, userId: string) => {
    await need(userId, ['cocurricular.mine']);
    if (!(await myStudents(userId)).some((k) => k.id === input.studentId)) throw forbidden();
    const c = await loadClub(clubId);
    if (!c.isActive || !c.openToRequests) throw badRequest(`${c.name} doesn’t take requests: ask the teacher in-charge`);
    const year = await thisYear();
    const existing = await db.clubMember.findFirst({ where: { clubId, academicYearId: year.id, studentId: input.studentId } });
    if (existing?.status === 'active') throw badRequest('Already a member');
    if (existing?.status === 'requested') throw badRequest('Already asked: waiting for the teacher');
    const info = await checkJoin(c, [input.studentId], year.id);
    await db.clubMember.upsert({
        where: { clubId_academicYearId_studentId: { clubId, academicYearId: year.id, studentId: input.studentId } },
        create: { tenantId: getTenantId()!, clubId, academicYearId: year.id, studentId: input.studentId, status: 'requested', requestedBy: userId, requestNote: input.note || null },
        update: { status: 'requested', requestedBy: userId, requestNote: input.note || null },
    });
    const s = info.get(input.studentId);
    raiseLater('club_request', { incharge: () => staffOf(c.inchargeIds) }, { club: c.name, student: s?.name ?? '', section: s?.section ?? '', note: input.note ?? '' }, { dedupe: `club-request:${clubId}:${input.studentId}:${Date.now()}` });
    return { requested: true };
};

export const cancelRequest = async (memberId: string, userId: string) => {
    await need(userId, ['cocurricular.mine']);
    const m = await db.clubMember.findFirst({ where: { id: memberId, status: 'requested' } });
    if (!m || !(await myStudents(userId)).some((k) => k.id === m.studentId)) throw notFound('Not found');
    await db.clubMember.delete({ where: { id: memberId } });
    return { cancelled: true };
};

/** Clubs a student could ask to join now (open, their class, not in it yet). */
export const openClubsFor = async (studentId: string, classId: string | null, yearId: string) => {
    const [clubs, mine] = await Promise.all([
        db.club.findMany({ where: { isActive: true, openToRequests: true }, orderBy: { name: 'asc' } }),
        db.clubMember.findMany({ where: { studentId, academicYearId: yearId, status: { in: ['active', 'requested'] } }, select: { clubId: true } }),
    ]);
    const cats = await masterNames(clubs.map((c) => c.categoryId));
    const taken = new Set(mine.map((m) => m.clubId));
    return clubs.filter((c) => !taken.has(c.id) && (!c.classIds.length || (classId && c.classIds.includes(classId)))).map((c) => ({ id: c.id, name: c.name, description: c.description, category: cats.get(c.categoryId ?? '') ?? null, meets: c.meets }));
};
