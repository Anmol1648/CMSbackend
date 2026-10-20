import { z } from 'zod';
import { db, withTransaction, Tx } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { createLogin, sendWelcomeEmail } from '../auth/account.service';
import { normalizeMobile } from '../auth/identity';
import { STUDENTS } from './students.settings';

/** Families: the parents / guardians that siblings share. */

const id = z.uuid('choose one from the list').nullable().optional();

export const guardianSchema = z.strictObject({
    relationId: id,
    name: z.string().trim().min(1, 'is required').max(120, 'must be at most 120 characters'),
    mobile: z.union([z.literal('').transform(() => null), z.string().trim().regex(/^\+?[0-9][0-9 ()-]{5,19}$/, 'is not a valid mobile number'), z.null()]).optional(),
    email: z.union([z.literal('').transform(() => null), z.string().trim().toLowerCase().email('is not a valid email'), z.null()]).optional(),
    occupationId: id,
    qualificationId: id,
    incomeRangeId: id,
    aadhaar: z
        .union([z.literal('').transform(() => null), z.string().transform((s) => s.replace(/[\s-]/g, '')).pipe(z.string().regex(/^\d{12}$/, 'must be 12 digits')), z.null()])
        .optional(),
    isPrimary: z.boolean().optional(),
});
export type GuardianInput = z.infer<typeof guardianSchema>;

const MASTER_OF: Record<string, string> = { relationId: 'relation', occupationId: 'occupation', qualificationId: 'qualification', incomeRangeId: 'income_range' };

const checkMasters = async (g: Partial<GuardianInput>, client: typeof db | Tx) => {
    for (const [field, master] of Object.entries(MASTER_OF)) {
        const v = (g as Record<string, string | null | undefined>)[field];
        if (v && !(await client.masterValue.findFirst({ where: { id: v, master }, select: { id: true } }))) {
            throw badRequest(`Choose a ${master.replace('_', ' ')} from the list`, [{ field, message: 'is not an option of its list' }]);
        }
    }
};

const clean = <T extends Partial<GuardianInput>>(g: T): T => ({ ...g, ...(g.mobile ? { mobile: normalizeMobile(g.mobile) } : {}) });

/** Adds guardians to a family; the first one (or the one marked) is the main contact. */
export const createGuardians = async (familyId: string, list: GuardianInput[], client: typeof db | Tx) => {
    const tenantId = getTenantId()!;
    const hasPrimary = (await client.guardian.count({ where: { familyId, isPrimary: true } })) > 0;
    const marked = list.findIndex((g) => g.isPrimary);
    const primaryAt = hasPrimary ? -1 : marked >= 0 ? marked : 0;
    const created = [];
    for (const [i, g] of list.entries()) {
        await checkMasters(g, client);
        created.push(await client.guardian.create({ data: { tenantId, familyId, ...clean(g), isPrimary: i === primaryAt, sortOrder: (i + 1) * 10 } }));
    }
    return created;
};

const familyOf = async (studentId: string) => {
    const s = await db.student.findUnique({ where: { id: studentId }, select: { familyId: true } });
    if (!s) throw notFound('Student not found');
    return s.familyId;
};

/** Adds a parent / guardian to a student's family (creating the family if needed). */
export const addGuardian = async (studentId: string, input: GuardianInput) => {
    let familyId = await familyOf(studentId);
    const created = await withTransaction(async (tx) => {
        if (!familyId) {
            familyId = (await tx.family.create({ data: { tenantId: getTenantId()! } })).id;
            await tx.student.update({ where: { id: studentId }, data: { familyId } });
        }
        if (input.isPrimary) await tx.guardian.updateMany({ where: { familyId }, data: { isPrimary: false } });
        const [g] = await createGuardians(familyId, [input], tx);
        return g;
    });
    await recordAudit({ action: 'guardian_added', entity: 'student', entityId: studentId, changes: { name: created.name } });
    return created;
};

export const updateGuardian = async (guardianId: string, input: Partial<GuardianInput>) => {
    const g = await db.guardian.findUnique({ where: { id: guardianId } });
    if (!g) throw notFound('Parent / guardian not found');
    await checkMasters(input, db);
    await withTransaction(async (tx) => {
        if (input.isPrimary) await tx.guardian.updateMany({ where: { familyId: g.familyId, id: { not: guardianId } }, data: { isPrimary: false } });
        await tx.guardian.update({ where: { id: guardianId }, data: clean(input) });
    });
    return db.guardian.findUniqueOrThrow({ where: { id: guardianId } });
};

export const removeGuardian = async (guardianId: string) => {
    const g = await db.guardian.findUnique({ where: { id: guardianId } });
    if (!g) throw notFound('Parent / guardian not found');
    const { required } = await getSettings({ required: STUDENTS.requiredFields });
    if (required.includes('guardian') && (await db.guardian.count({ where: { familyId: g.familyId } })) === 1) {
        throw conflict('A student needs at least one parent or guardian (System Settings → Students). Add another one first.');
    }
    if (g.userId) await db.user.update({ where: { id: g.userId }, data: { status: 'disabled' } });
    await db.guardian.delete({ where: { id: guardianId } });
    if (g.isPrimary) {
        const next = await db.guardian.findFirst({ where: { familyId: g.familyId }, orderBy: { sortOrder: 'asc' } });
        if (next) await db.guardian.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
    return { id: guardianId, deleted: true };
};

/** Families matching a parent's mobile or name, to link a new student as a sibling. */
export const searchFamilies = async (q: string) => {
    const term = q.trim();
    if (term.length < 3) return [];
    const digits = term.replace(/\D/g, '');
    const families = await db.family.findMany({
        where: { guardians: { some: { OR: [{ name: { contains: term, mode: 'insensitive' } }, ...(digits.length >= 4 ? [{ mobile: { contains: digits } }] : [])] } } },
        take: 10,
        include: {
            guardians: { select: { name: true, mobile: true, relation: { select: { name: true } } }, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
            students: { select: { id: true, firstName: true, lastName: true, admissionNo: true, status: true } },
        },
    });
    return families.map((f) => ({
        id: f.id,
        guardians: f.guardians.map((g) => ({ name: g.name, mobile: g.mobile, relation: g.relation?.name ?? null })),
        students: f.students.map((s) => ({ id: s.id, name: [s.firstName, s.lastName].filter(Boolean).join(' '), admissionNo: s.admissionNo, status: s.status })),
    }));
};

/** Moves a student into another family (a sibling's); an emptied family is removed. */
export const linkFamily = async (studentId: string, familyId: string) => {
    const old = await familyOf(studentId);
    if (!(await db.family.findUnique({ where: { id: familyId }, select: { id: true } }))) throw badRequest('That family was not found');
    if (old === familyId) return;
    await withTransaction(async (tx) => {
        await tx.student.update({ where: { id: studentId }, data: { familyId } });
        if (old && !(await tx.student.count({ where: { familyId: old } }))) await tx.family.delete({ where: { id: old } });
    });
    await recordAudit({ action: 'family_linked', entity: 'student', entityId: studentId, changes: { from: old, to: familyId } });
};

/** A parent login (one per parent: it shows all their children). */
export const addParentLogin = async (guardianId: string) => {
    const { mode } = await getSettings({ mode: STUDENTS.parentLogin });
    if (mode === 'off') throw forbidden('Parent logins are switched off (System Settings → Students)');
    const g = await db.guardian.findUnique({ where: { id: guardianId } });
    if (!g) throw notFound('Parent / guardian not found');
    if (g.userId) throw conflict(`${g.name} already has a login`);
    if (!g.mobile && !g.email) throw badRequest('Add a mobile number or email first, so the parent can sign in and reset the password');
    const login = await withTransaction(async (tx) => {
        const l = await createLogin({ kind: 'guardian', displayName: g.name, email: g.email, mobile: g.mobile, usernameCandidates: [g.mobile ?? '', g.name] }, tx);
        await tx.guardian.update({ where: { id: guardianId }, data: { userId: l.user.id } });
        return l;
    });
    await sendWelcomeEmail(login);
    return { username: login.user.username, temporaryPassword: login.temporaryPassword, emailed: !!login.welcome };
};

/**
 * Logins for the main contact of every family that has none yet (for a school switching parent
 * logins on later). A batch at a time; the caller repeats while `remaining` > 0. Parents without a
 * mobile or email, or whose mobile / email another login already uses, are skipped and listed.
 */
export const addParentLoginsBatch = async (batch = 40) => {
    const { mode } = await getSettings({ mode: STUDENTS.parentLogin });
    if (mode === 'off') throw forbidden('Parent logins are switched off (System Settings → Students)');
    const where = { isPrimary: true, userId: null, family: { students: { some: { status: 'active' as const } } } };
    const candidates = await db.guardian.findMany({ where, orderBy: { name: 'asc' }, take: batch * 3 });
    const created: { for: string; username: string; temporaryPassword: string; emailed: boolean }[] = [];
    const skipped: { for: string; reason: string }[] = [];
    for (const g of candidates) {
        if (created.length >= batch) break;
        if (!g.mobile && !g.email) {
            skipped.push({ for: g.name, reason: 'no mobile or email' });
            continue;
        }
        const taken = await db.user.findFirst({ where: { OR: [...(g.mobile ? [{ mobile: g.mobile }] : []), ...(g.email ? [{ email: g.email }] : [])] }, select: { id: true } });
        if (taken) {
            skipped.push({ for: g.name, reason: 'mobile or email already used by another login' });
            continue;
        }
        const login = await withTransaction(async (tx) => {
            const l = await createLogin({ kind: 'guardian', displayName: g.name, email: g.email, mobile: g.mobile, usernameCandidates: [g.mobile ?? '', g.name] }, tx);
            await tx.guardian.update({ where: { id: g.id }, data: { userId: l.user.id } });
            return l;
        });
        await sendWelcomeEmail(login);
        created.push({ for: g.name, username: login.user.username, temporaryPassword: login.temporaryPassword, emailed: !!login.welcome });
    }
    // Parents that can never get one this way are not "remaining".
    const remaining = (await db.guardian.count({ where: { ...where, OR: [{ mobile: { not: null } }, { email: { not: null } }] } })) - skipped.filter((x) => x.reason !== 'no mobile or email').length;
    await recordAudit({ action: 'parent_logins_created', entity: 'school', changes: { created: created.length } });
    return { created, skipped, remaining: Math.max(0, remaining) };
};
