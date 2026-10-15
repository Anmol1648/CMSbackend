import { Prisma } from '@prisma/client';
import { db } from '../src/core/db';
import { runAsSystem, runAsTenant } from '../src/core/context';
import { generateAccessToken } from '../src/config/jwt';
import { createTenant, clearTenantCache, CreatedTenant } from '../src/modules/tenants';
import { hashPassword } from '../src/core/password';

const tables = Prisma.dmmf.datamodel.models.map((m) => `"${m.dbName ?? m.name}"`).join(', ');

/** Empties every table of the test database (refuses anywhere else). */
export const resetDatabase = async () => {
    const [{ name }] = await db.$queryRawUnsafe<{ name: string }[]>('SELECT current_database() AS name');
    if (name !== 'cms_test') throw new Error(`refusing to reset database "${name}"`);
    await db.$executeRawUnsafe(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
    clearTenantCache();
};

export const makeTenant = (code: string, name: string, domain?: string): Promise<CreatedTenant> =>
    createTenant({ code, name, domain, admin: { username: 'admin', displayName: `${name} Admin` } });

/** Adds a staff user holding the given role (by slug) to a school. */
export const makeUser = async (tenantId: string, username: string, roleSlug: string) =>
    runAsTenant(tenantId, async () => {
        const role = await db.role.findUniqueOrThrow({ where: { tenantId_slug: { tenantId, slug: roleSlug } } });
        const user = await db.user.create({
            data: { tenantId, kind: 'staff', username, displayName: username, passwordHash: await hashPassword('test-pass-123') },
        });
        await db.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
        return user;
    });

export const tokenFor = (user: { id: string; tenantId: string }) => `Bearer ${generateAccessToken({ userId: user.id, tenantId: user.tenantId })}`;

export const suspendTenant = (id: string) =>
    runAsSystem(async () => {
        await db.tenant.update({ where: { id }, data: { status: 'suspended' } });
        clearTenantCache();
    });
