import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db, TenantContextError, tenantSql, Prisma } from '../src/core/db';
import { runAsSystem, runAsTenant } from '../src/core/context';
import { comparePassword } from '../src/core/password';
import { AppError } from '../src/core/errors';
import { DEFAULT_ROLES } from '../src/modules/tenants';
import { makeTenant, resetDatabase } from './helpers';

let a: Awaited<ReturnType<typeof makeTenant>>;
let b: Awaited<ReturnType<typeof makeTenant>>;

beforeAll(async () => {
    await resetDatabase();
    a = await makeTenant('alpha', 'Alpha School', 'alpha.test.in');
    b = await makeTenant('beta', 'Beta School');
});

describe('creating a school', () => {
    it('creates the profile, the default roles and a Super Admin who must change the password', async () => {
        await runAsTenant(a.tenant.id, async () => {
            const profile = await db.schoolProfile.findFirstOrThrow();
            expect(profile).toMatchObject({ legalName: 'Alpha School', timeZone: 'Asia/Kolkata', academicYearStartMonth: 4 });

            const roles = await db.role.findMany({ orderBy: { slug: 'asc' } });
            expect(roles.map((r) => r.slug).sort()).toEqual(DEFAULT_ROLES.map((r) => r.slug).sort());
            expect(roles.filter((r) => r.isSystem).map((r) => r.slug)).toEqual(['super-admin']);

            const admin = await db.user.findFirstOrThrow({ include: { roles: { include: { role: true } } } });
            expect(admin).toMatchObject({ username: 'admin', kind: 'admin', mustChangePassword: true, status: 'active' });
            expect(admin.roles.map((r) => r.role.slug)).toEqual(['super-admin']);
            expect(a.admin.temporaryPassword).toMatch(/^[a-z]{4}-[2-9]{4}-[a-z]{4}$/);
            expect(await comparePassword(a.admin.temporaryPassword, admin.passwordHash)).toBe(true);
        });
    });

    it('refuses a taken code or domain', async () => {
        await expect(makeTenant('alpha', 'Another')).rejects.toMatchObject({ statusCode: 409 });
        await expect(makeTenant('gamma', 'Gamma', 'alpha.test.in')).rejects.toMatchObject({ statusCode: 409 });
    });

    it('validates the input with field details', async () => {
        try {
            await makeTenant('Bad Code!', 'X');
            throw new Error('should have thrown');
        } catch (e) {
            const err = e as AppError;
            expect(err.statusCode).toBe(400);
            expect(err.details?.map((d) => d.field)).toEqual(expect.arrayContaining(['code', 'name']));
        }
    });
});

describe('school separation', () => {
    it('the same username can exist in two schools', async () => {
        expect(a.admin.username).toBe(b.admin.username);
        expect(a.admin.id).not.toBe(b.admin.id);
    });

    it('reads and counts only see the current school', async () => {
        await runAsTenant(a.tenant.id, async () => {
            const users = await db.user.findMany();
            expect(users.map((u) => u.id)).toEqual([a.admin.id]);
            expect(await db.role.count()).toBe(DEFAULT_ROLES.length);
            // Asking for the other school's row explicitly still returns nothing.
            expect(await db.user.findUnique({ where: { id: b.admin.id } })).toBeNull();
            expect(await db.user.findFirst({ where: { tenantId: b.tenant.id } })).toBeNull();
        });
    });

    it("can't change or delete the other school's rows", async () => {
        await runAsTenant(a.tenant.id, async () => {
            await expect(db.user.update({ where: { id: b.admin.id }, data: { displayName: 'hacked' } })).rejects.toMatchObject({ code: 'P2025' });
            const removed = await db.role.deleteMany({ where: { slug: 'guardian', tenantId: b.tenant.id } });
            expect(removed.count).toBe(0);
            // …and it must not be redirected to this school's own rows either.
            expect(await db.role.count({ where: { slug: 'guardian' } })).toBe(1);
            await db.user.updateMany({ data: { displayName: 'Alpha Admin (edited)' } });
        });
        await runAsTenant(b.tenant.id, async () => {
            const bAdmin = await db.user.findUniqueOrThrow({ where: { id: b.admin.id } });
            expect(bAdmin.displayName).toBe('Beta School Admin');
            expect(await db.role.count({ where: { slug: 'guardian' } })).toBe(1);
        });
    });

    it("can't create rows for another school", async () => {
        await runAsTenant(a.tenant.id, async () => {
            await expect(
                db.role.create({ data: { tenantId: b.tenant.id, name: 'X', slug: 'x' } })
            ).rejects.toBeInstanceOf(TenantContextError);
            await expect(
                db.user.update({ where: { id: a.admin.id }, data: { tenantId: b.tenant.id } as Prisma.UserUncheckedUpdateInput })
            ).rejects.toBeInstanceOf(TenantContextError);
        });
    });

    it('refuses to touch school data with no school in context (fails closed)', async () => {
        await expect(db.user.findMany()).rejects.toBeInstanceOf(TenantContextError);
        await expect(db.role.count()).rejects.toBeInstanceOf(TenantContextError);
    });

    it('system context sees every school (platform work only)', async () => {
        const all = await runAsSystem(() => db.user.count());
        expect(all).toBe(2);
    });

    it('raw SQL through tenantSql gets the current school', async () => {
        const rows = await runAsTenant(b.tenant.id, () =>
            tenantSql<{ username: string; tenant_id: string }>((tenantId) => Prisma.sql`SELECT username, tenant_id::text FROM users WHERE tenant_id = ${tenantId}::uuid`)
        );
        expect(rows).toEqual([{ username: 'admin', tenant_id: b.tenant.id }]);
    });
});

describe('soft delete and audit columns', () => {
    it('hides soft-deleted rows unless the query asks for them', async () => {
        await runAsTenant(a.tenant.id, async () => {
            await db.role.updateMany({ where: { slug: 'guardian' }, data: { deletedAt: new Date() } });
            expect(await db.role.findFirst({ where: { slug: 'guardian' } })).toBeNull();
            expect(await db.role.count()).toBe(DEFAULT_ROLES.length - 1);
            expect(await db.role.findFirst({ where: { slug: 'guardian', deletedAt: { not: null } } })).not.toBeNull();
            await db.role.updateMany({ where: { slug: 'guardian', deletedAt: { not: null } }, data: { deletedAt: null } });
        });
    });

    it('fills createdBy / updatedBy from the signed-in user', async () => {
        const actor = { id: a.admin.id, tenantId: a.tenant.id };
        await runAsTenant(a.tenant.id, async () => {
            const role = await db.role.create({ data: { name: 'Librarian', slug: 'librarian' } });
            expect(role).toMatchObject({ tenantId: a.tenant.id, createdBy: a.admin.id, updatedBy: a.admin.id });
            await db.role.delete({ where: { id: role.id } });
        }, actor);
    });
});

describe('database rules', () => {
    it('rejects an upper-case username even if code forgets to lower-case it', async () => {
        await runAsTenant(a.tenant.id, async () => {
            await expect(
                db.user.create({ data: { kind: 'staff', username: 'MixedCase', displayName: 'X', passwordHash: 'x' } })
            ).rejects.toThrow(/users_username_lower_check/);
        });
    });

    it('rejects an academic year start month outside 1–12', async () => {
        await runAsTenant(a.tenant.id, async () => {
            await expect(
                db.schoolProfile.update({ where: { tenantId: a.tenant.id }, data: { academicYearStartMonth: 13 } })
            ).rejects.toThrow(/academic_year_start_month_check/);
        });
    });
});

describe('raw SQL guard', () => {
    it('raw SQL is used only inside src/core/db', () => {
        const root = path.join(__dirname, '..', 'src');
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.ts') && !full.includes(path.join('src', 'core', 'db'))) {
                    if (/\$(queryRaw|executeRaw)(Unsafe)?\b/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(root, full));
                }
            }
        };
        walk(root);
        expect(offenders).toEqual([]);
    });
});
