import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { cache } from '../src/core/cache';
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

/** A school for tests; without the starter lists and academic set-up unless asked (they slow every test down). */
export const makeTenant = (code: string, name: string, domain?: string, options: { starterData?: boolean } = {}): Promise<CreatedTenant> =>
    createTenant({ code, name, domain, admin: { username: 'admin', displayName: `${name} Admin` } }, { starterData: options.starterData ?? false });

/** A staff record (optionally linked to a login), e.g. to be a class teacher. */
export const makeStaff = (tenantId: string, firstName: string, userId?: string) =>
    runAsTenant(tenantId, () => db.staff.create({ data: { tenantId, employeeCode: `T-${firstName}`, joiningDate: new Date('2020-04-01'), firstName, userId: userId ?? null } }));

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

/** A signed access token for a user (with a made-up session id; no sign-in needed). */
export const tokenFor = (user: { id: string; tenantId: string }) =>
    `Bearer ${generateAccessToken({ userId: user.id, tenantId: user.tenantId, sessionId: randomUUID() })}`;

/** Gives a user a known password (and optionally clears "must change password"). */
export const setPasswordFor = (user: { id: string; tenantId: string }, password: string, mustChangePassword = false) =>
    runAsTenant(user.tenantId, async () =>
        db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password), mustChangePassword } })
    );

/** The refresh-token cookie value from a response (undefined if none / cleared). */
export const refreshCookieFrom = (res: { headers: Record<string, unknown> }): string | undefined => {
    const raw = res.headers['set-cookie'];
    const cookies = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    const c = cookies.find((x) => x.startsWith('cms_rt='));
    const value = c?.split(';')[0].slice('cms_rt='.length);
    return value ? decodeURIComponent(value) : undefined;
};

export const resetRateLimits = () => cache.delPrefix('ratelimit:');

export const suspendTenant = (id: string) =>
    runAsSystem(async () => {
        await db.tenant.update({ where: { id }, data: { status: 'suspended' } });
        clearTenantCache();
    });
