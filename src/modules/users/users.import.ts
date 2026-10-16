import type { UserKind } from '@prisma/client';
import { db, withTransaction } from '../../core/db';
import type { ParsedRow } from '../../core/excel';
import { createLogin, sendWelcomeEmail } from '../auth';
import { normalizeMobile } from '../auth/identity';
import { getUserAccess } from '../rbac/access.service';
import { registerImport } from '../imports/import.service';

/** Users from Excel: name, type, email, mobile, username, roles. Each gets a one-time password. */

const KINDS: Record<string, UserKind> = { Administrator: 'admin', Staff: 'staff', Student: 'student', 'Parent / guardian': 'guardian' };
const KIND_HELP: Record<UserKind, string> = {
    admin: 'Office and management accounts.',
    staff: 'Teachers and other staff.',
    student: 'A student’s own login.',
    guardian: 'A parent’s or guardian’s login.',
};

interface Ctx {
    emails: Set<string>;
    mobiles: Set<string>;
    usernames: Set<string>;
    roles: Map<string, { id: string; slug: string; isSystem: boolean }>;
    actorIsSuperAdmin: boolean;
}

registerImport<Ctx>({
    kind: 'users',
    label: 'Users',
    permission: 'user.create',
    columns: async () => {
        const roles = await db.role.findMany({ orderBy: { name: 'asc' }, select: { name: true, description: true, defaultFor: true } });
        const label = Object.fromEntries(Object.entries(KINDS).map(([l, k]) => [k, l]));
        const defaultsFor = (k: UserKind) => roles.filter((r) => r.defaultFor === k).map((r) => r.name);
        const kindHelp = Object.fromEntries(
            Object.entries(KINDS).map(([l, k]) => [l, `${KIND_HELP[k]}${defaultsFor(k).length ? ` Gets the role ${defaultsFor(k).join(', ')} if Roles is empty.` : ''}`])
        );
        const roleHelp = Object.fromEntries(
            roles.map((r) => [r.name, [r.description, r.defaultFor ? `Given to every new ${label[r.defaultFor]} login when Roles is empty.` : null].filter(Boolean).join(' ')])
        );
        return [
            { key: 'displayName', header: 'Name', type: 'text', required: true, max: 120, help: "The person's full name", example: 'Riya Sharma' },
            { key: 'kind', header: 'Type', type: 'choice', required: true, choices: Object.keys(KINDS), choiceHelp: kindHelp, example: 'Staff' },
            { key: 'email', header: 'Email', type: 'email', unique: true, help: 'Optional. Sign-in details are emailed if set.', example: 'riya@school.in' },
            { key: 'mobile', header: 'Mobile', type: 'mobile', unique: true, help: 'Optional. Can be used to sign in.', example: '9876543210' },
            { key: 'username', header: 'Username', type: 'text', unique: true, max: 64, help: 'Optional. Made from the name if empty (e.g. riya.sharma).', example: '' },
            { key: 'roles', header: 'Roles', type: 'list', choices: roles.map((r) => r.name), choiceHelp: roleHelp, help: 'Optional. Several are separated by commas. Empty = the default role for the type. Roles and what they can do: Setup → Roles & Permissions.', example: 'Teacher, Class Teacher' },
        ];
    },
    prepare: async (actorUserId) => {
        const users = await db.user.findMany({ where: { deletedAt: undefined }, select: { email: true, mobile: true, username: true } });
        const roles = await db.role.findMany({ select: { id: true, name: true, slug: true, isSystem: true } });
        return {
            emails: new Set(users.map((u) => u.email).filter((e): e is string => !!e)),
            mobiles: new Set(users.map((u) => u.mobile).filter((m): m is string => !!m)),
            usernames: new Set(users.map((u) => u.username)),
            roles: new Map(roles.map((r) => [r.name.toLowerCase(), r])),
            actorIsSuperAdmin: (await getUserAccess(actorUserId)).isSuperAdmin,
        };
    },
    check: (row: ParsedRow, ctx) => {
        const v = row.values;
        if (v.email && ctx.emails.has(String(v.email))) row.issues.push({ field: 'Email', message: 'is already used by another account' });
        if (v.mobile && ctx.mobiles.has(normalizeMobile(String(v.mobile)))) row.issues.push({ field: 'Mobile', message: 'is already used by another account' });
        if (v.username) {
            const u = String(v.username).toLowerCase();
            if (!/^[a-z0-9._-]{3,64}$/.test(u)) row.issues.push({ field: 'Username', message: 'use 3–64 letters, numbers, dots, dashes or underscores' });
            else if (ctx.usernames.has(u)) row.issues.push({ field: 'Username', message: 'is taken' });
        }
        for (const name of (v.roles as string[] | null) ?? []) {
            const role = ctx.roles.get(name.toLowerCase());
            if (role?.isSystem && !ctx.actorIsSuperAdmin) row.issues.push({ field: 'Roles', message: 'only a Super Admin can give the Super Admin role' });
        }
    },
    importRow: async (row, ctx) => {
        const v = row.values;
        const roleSlugs = ((v.roles as string[] | null) ?? []).map((n) => ctx.roles.get(n.toLowerCase())!.slug);
        const login = await withTransaction((tx) =>
            createLogin(
                {
                    kind: KINDS[String(v.kind)],
                    displayName: String(v.displayName),
                    email: (v.email as string | null) ?? null,
                    mobile: (v.mobile as string | null) ?? null,
                    usernameCandidates: v.username ? [String(v.username)] : [],
                    roleSlugs,
                },
                tx
            )
        );
        await sendWelcomeEmail(login);
        ctx.usernames.add(login.user.username);
        if (login.user.email) ctx.emails.add(login.user.email);
        if (login.user.mobile) ctx.mobiles.add(login.user.mobile);
        return { Name: login.user.displayName, Username: login.user.username, 'One-time password': login.temporaryPassword, Email: login.welcome ? 'Being sent' : 'No email address' };
    },
});
