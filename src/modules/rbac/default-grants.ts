import type { DataScope } from '@prisma/client';
import { db, Tx } from '../../core/db';
import { findPermissionDef } from '../../core/registry/permissions';

/**
 * Starting permissions of the default roles (least privilege). Schools edit them freely afterwards.
 * Modules add their own entries here as they are built (e.g. Teacher → attendance.mark, scope assigned).
 * Super Admin isn't listed: it always has everything.
 */
export const DEFAULT_GRANTS: Record<string, { key: string; scope?: DataScope }[]> = {
    'school-admin': [
        { key: 'school_profile.update' },
        { key: 'user.view' },
        { key: 'user.create' },
        { key: 'user.update' },
        { key: 'user.reset_password' },
        { key: 'role.view' },
        { key: 'masters.view' },
        { key: 'masters.manage' },
        { key: 'academic.view' },
        { key: 'academic.manage' },
    ],
    principal: [{ key: 'user.view' }, { key: 'role.view' }, { key: 'masters.view' }, { key: 'academic.view' }, { key: 'academic.manage' }],
    teacher: [],
    'class-teacher': [],
    'office-staff': [{ key: 'masters.view' }, { key: 'academic.view' }],
    accountant: [],
    student: [],
    guardian: [],
};

/**
 * Adds the default grants that are missing for the current school's default roles. Never removes
 * anything, so it is safe to run again after a module adds new defaults.
 */
export const applyDefaultGrants = async (tenantId: string, client: typeof db | Tx = db) => {
    // tenantId explicitly: this also runs inside runAsSystem (creating a school), where scoping is off.
    const roles = await client.role.findMany({ where: { tenantId, slug: { in: Object.keys(DEFAULT_GRANTS) } }, select: { id: true, slug: true } });
    // One statement for every role (creating a school runs this inside a time-limited transaction).
    const data = roles.flatMap((role) =>
        (DEFAULT_GRANTS[role.slug] ?? []).filter((g) => findPermissionDef(g.key)).map((g) => ({ tenantId, roleId: role.id, permissionKey: g.key, scope: g.scope ?? ('all' as const) }))
    );
    if (!data.length) return 0;
    return (await client.rolePermission.createMany({ data, skipDuplicates: true })).count;
};
