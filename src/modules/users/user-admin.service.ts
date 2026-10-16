import type { Prisma, UserKind, UserStatus } from '@prisma/client';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { generateTemporaryPassword, hashPassword } from '../../core/password';
import { ListQuery, listResult, toOrderBy } from '../../core/http/list-query';
import { buildWorkbook } from '../../core/excel';
import { createLogin, revokeUserSessions, sendWelcomeEmail } from '../auth';
import { normalizeEmail, normalizeMobile } from '../auth/identity';
import { getUserAccess, invalidateAccess } from '../rbac/access.service';
import type { userFilters } from './users.schemas';
import { avatarPath } from './avatar';

/** Managing other people's sign-in accounts (Users screen). */

const userSelect = {
    id: true,
    username: true,
    displayName: true,
    email: true,
    mobile: true,
    kind: true,
    status: true,
    mustChangePassword: true,
    mfaEnabled: true,
    lockedUntil: true,
    lastLoginAt: true,
    avatarFileId: true,
    createdAt: true,
    updatedAt: true,
    roles: { select: { role: { select: { id: true, slug: true, name: true, isSystem: true } } } },
} satisfies Prisma.UserSelect;

type Row = Prisma.UserGetPayload<{ select: typeof userSelect }>;

const present = ({ roles, lockedUntil, avatarFileId, ...u }: Row) => ({
    ...u,
    avatarUrl: avatarPath({ id: u.id, avatarFileId }),
    locked: !!lockedUntil && lockedUntil.getTime() > Date.now(),
    lockedUntil: lockedUntil && lockedUntil.getTime() > Date.now() ? lockedUntil : null,
    roles: roles.map((r) => r.role),
    isSuperAdmin: roles.some((r) => r.role.isSystem),
});

type Filters = ListQuery<typeof userFilters>['filters'];

const userWhere = (q: Pick<ListQuery<typeof userFilters>, 'filters' | 'search'>): Prisma.UserWhereInput => {
    const f: Filters = q.filters;
    return {
        ...(f.kind ? { kind: f.kind } : {}),
        ...(f.status ? { status: f.status } : {}),
        ...(f.role ? { roles: { some: { role: { slug: f.role } } } } : {}),
        ...(q.search
            ? {
                  OR: [
                      { displayName: { contains: q.search, mode: 'insensitive' } },
                      { username: { contains: q.search.toLowerCase() } },
                      { email: { contains: q.search.toLowerCase() } },
                      { mobile: { contains: q.search.replace(/[^\d+]/g, '') || q.search } },
                  ],
              }
            : {}),
    };
};

export const listUsers = async (q: ListQuery<typeof userFilters>) => {
    const where = userWhere(q);
    const [rows, total] = await Promise.all([
        db.user.findMany({ where, select: userSelect, orderBy: toOrderBy(q), skip: q.skip, take: q.take }),
        db.user.count({ where }),
    ]);
    return listResult(rows.map(present), total, q);
};

const KIND_LABEL: Record<string, string> = { admin: 'Administrator', staff: 'Staff', student: 'Student', guardian: 'Parent / guardian' };

/** The same list as an Excel file (same filters, every page), capped by the export limit. */
export const exportUsers = async (q: ListQuery<typeof userFilters>, maxRows: number) => {
    const rows = (await db.user.findMany({ where: userWhere(q), select: userSelect, orderBy: toOrderBy(q), take: maxRows })).map(present);
    const data = await buildWorkbook('Users', [
        { header: 'Name', width: 28, value: (u) => u.displayName },
        { header: 'Username', width: 22, value: (u) => u.username },
        { header: 'Type', value: (u) => KIND_LABEL[u.kind] },
        { header: 'Email', width: 30, value: (u) => u.email },
        { header: 'Mobile', value: (u) => u.mobile },
        { header: 'Roles', width: 30, value: (u) => u.roles.map((r) => r.name).join(', ') },
        { header: 'Status', value: (u) => (u.status === 'active' ? 'Active' : 'Disabled') },
        { header: 'Last sign-in', width: 20, value: (u) => u.lastLoginAt },
        { header: 'Created', width: 20, value: (u) => u.createdAt },
    ], rows);
    await recordAudit({ action: 'export', entity: 'user', changes: { rows: rows.length } });
    return data;
};

export const getUser = async (id: string) => {
    const row = await db.user.findUnique({ where: { id }, select: userSelect });
    if (!row) throw notFound('User not found');
    return present(row);
};

const activeSuperAdmins = (excludingUserId?: string) =>
    db.user.count({
        where: { status: 'active', ...(excludingUserId ? { id: { not: excludingUserId } } : {}), roles: { some: { role: { isSystem: true } } } },
    });

/** Only Super Admins may hand out the Super Admin role or change a Super Admin's account. */
export const guardSuperAdminChanges = async (actorId: string, roleIds: string[] | undefined, targetIsSuperAdmin: boolean) => {
    const actor = await getUserAccess(actorId);
    if (actor.isSuperAdmin) return;
    if (targetIsSuperAdmin) throw forbidden('Only a Super Admin can change a Super Admin’s account');
    if (roleIds?.length) {
        const system = await db.role.count({ where: { id: { in: roleIds }, isSystem: true } });
        if (system) throw forbidden('Only a Super Admin can give the Super Admin role');
    }
};

const checkRoles = async (roleIds: string[]) => {
    const found = await db.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, slug: true } });
    if (found.length !== new Set(roleIds).size) throw badRequest('Some roles were not found', [{ field: 'roleIds', message: 'contains an unknown role' }]);
    return found;
};

const checkUnique = async (field: 'email' | 'mobile', value: string | null, exceptId?: string) => {
    if (!value) return;
    const other = await db.user.findFirst({ where: { [field]: value, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    if (other) throw conflict(`Another account already uses this ${field === 'email' ? 'email address' : 'mobile number'}`);
};

export interface CreateUserInput {
    kind: UserKind;
    displayName: string;
    username?: string;
    email?: string | null;
    mobile?: string | null;
    roleIds: string[];
}

export const createUser = async (input: CreateUserInput, actorId: string) => {
    await guardSuperAdminChanges(actorId, input.roleIds, false);
    const roles = await checkRoles(input.roleIds);
    if (input.username) {
        const wanted = input.username.trim().toLowerCase();
        if (await db.user.findFirst({ where: { username: wanted }, select: { id: true } })) throw conflict(`The username "${wanted}" is taken`);
    }
    const login = await withTransaction((tx) =>
        createLogin(
            {
                kind: input.kind,
                displayName: input.displayName,
                email: input.email,
                mobile: input.mobile,
                usernameCandidates: input.username ? [input.username] : [],
                roleSlugs: roles.map((r) => r.slug),
            },
            tx
        )
    );
    await sendWelcomeEmail(login);
    return { user: await getUser(login.user.id), temporaryPassword: login.temporaryPassword, emailed: !!login.welcome };
};

export interface UpdateUserInput {
    displayName?: string;
    email?: string | null;
    mobile?: string | null;
    status?: UserStatus;
    roleIds?: string[];
}

export const updateUser = async (id: string, input: UpdateUserInput, actorId: string) => {
    const before = await getUser(id);
    await guardSuperAdminChanges(actorId, input.roleIds, before.isSuperAdmin);

    const email = input.email === undefined ? undefined : input.email ? normalizeEmail(input.email) : null;
    const mobile = input.mobile === undefined ? undefined : input.mobile ? normalizeMobile(input.mobile) : null;
    if (email !== undefined) await checkUnique('email', email, id);
    if (mobile !== undefined) await checkUnique('mobile', mobile, id);

    if (input.status === 'disabled' && id === actorId) throw badRequest('You can’t disable your own account');
    const roles = input.roleIds ? await checkRoles(input.roleIds) : undefined;
    const loses = (input.status === 'disabled' && before.status === 'active') || (roles && before.isSuperAdmin && !(await db.role.count({ where: { id: { in: input.roleIds! }, isSystem: true } })));
    if (before.isSuperAdmin && loses && (await activeSuperAdmins(id)) === 0) {
        throw conflict('This is the only active Super Admin. Make someone else Super Admin first.');
    }

    const tenantId = getTenantId()!;
    await withTransaction(async (tx) => {
        await tx.user.update({
            where: { id },
            data: {
                ...(input.displayName !== undefined ? { displayName: input.displayName.trim() } : {}),
                ...(email !== undefined ? { email } : {}),
                ...(mobile !== undefined ? { mobile } : {}),
                ...(input.status !== undefined ? { status: input.status } : {}),
            },
        });
        if (roles) {
            await tx.userRole.deleteMany({ where: { userId: id } });
            if (roles.length) await tx.userRole.createMany({ data: roles.map((r) => ({ tenantId, userId: id, roleId: r.id, assignedBy: actorId })) });
        }
    });

    if (input.status === 'disabled' && before.status === 'active') await revokeUserSessions(id, 'admin');
    if (roles) await invalidateAccess(id);

    const after = await getUser(id);
    const changes: Record<string, unknown> = {};
    for (const k of ['displayName', 'email', 'mobile', 'status'] as const) if (before[k] !== after[k]) changes[k] = [before[k], after[k]];
    const roleNames = (u: typeof before) => u.roles.map((r) => r.name).sort().join(', ');
    if (roleNames(before) !== roleNames(after)) changes.roles = [roleNames(before), roleNames(after)];
    if (Object.keys(changes).length) await recordAudit({ action: roles && Object.keys(changes).length === 1 && changes.roles ? 'role_change' : 'update', entity: 'user', entityId: id, changes });
    return after;
};

/** A new one-time password for someone else; signs them out everywhere. */
export const resetUserPassword = async (id: string, actorId: string) => {
    const user = await getUser(id);
    await guardSuperAdminChanges(actorId, undefined, user.isSuperAdmin);
    const temporaryPassword = generateTemporaryPassword();
    await db.user.update({
        where: { id },
        data: { passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
    });
    await revokeUserSessions(id, 'admin');
    await recordAudit({ action: 'password_reset', entity: 'user', entityId: id, changes: { by: 'admin' } });
    return { temporaryPassword };
};

export const unlockUser = async (id: string, actorId: string) => {
    const user = await getUser(id);
    await guardSuperAdminChanges(actorId, undefined, user.isSuperAdmin);
    await db.user.update({ where: { id }, data: { failedLoginCount: 0, lockedUntil: null } });
    await recordAudit({ action: 'unlock', entity: 'user', entityId: id });
    return getUser(id);
};

/** Turns off two-step sign-in for someone who lost their phone. */
export const resetUserMfa = async (id: string, actorId: string) => {
    const user = await getUser(id);
    await guardSuperAdminChanges(actorId, undefined, user.isSuperAdmin);
    if (!user.mfaEnabled) throw conflict('Two-step sign-in is already off for this user');
    await db.user.update({ where: { id }, data: { mfaEnabled: false, mfaSecretEnc: null } });
    await recordAudit({ action: 'mfa_disabled', entity: 'user', entityId: id, changes: { by: 'admin' } });
    return getUser(id);
};
