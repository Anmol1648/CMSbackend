import { Tenant, TenantStatus } from '@prisma/client';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { runAsSystem } from '../../core/context';
import { conflict, validationError } from '../../core/errors';
import { generateTemporaryPassword, hashPassword } from '../../core/password';
import { DEFAULT_ROLES, SUPER_ADMIN_SLUG } from './default-roles';

/**
 * Schools (tenants). A school is a row here; all its data lives in the shared tables with its tenant_id.
 */

export const createTenantSchema = z.object({
    code: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'use 2–40 lowercase letters, numbers or hyphens'),
    name: z.string().trim().min(2).max(200),
    domain: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'must be a host name like erp.school.in')
        .optional(),
    admin: z.object({
        displayName: z.string().trim().min(2).max(120),
        username: z
            .string()
            .trim()
            .toLowerCase()
            .regex(/^[a-z0-9._-]{3,64}$/, 'use 3–64 letters, numbers, dots, dashes or underscores'),
        email: z.string().trim().toLowerCase().email().optional(),
    }),
});

export type CreateTenantInput = z.input<typeof createTenantSchema>;

export interface CreatedTenant {
    tenant: Tenant;
    admin: { id: string; username: string; temporaryPassword: string };
}

/** Creates a school with its profile, default roles and first Super Admin (one transaction). */
export const createTenant = async (input: CreateTenantInput): Promise<CreatedTenant> => {
    const parsed = createTenantSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    const data = parsed.data;
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    return runAsSystem(async () => {
        const clash = await db.tenant.findFirst({
            where: { OR: [{ code: data.code }, ...(data.domain ? [{ domain: data.domain }] : [])] },
            select: { code: true },
        });
        if (clash) throw conflict(clash.code === data.code ? `School code "${data.code}" is taken` : `Domain "${data.domain}" is taken`);

        return withTransaction(async (tx) => {
            const tenant = await tx.tenant.create({ data: { code: data.code, name: data.name, domain: data.domain } });
            await tx.schoolProfile.create({ data: { tenantId: tenant.id, legalName: data.name } });

            await tx.role.createMany({
                data: DEFAULT_ROLES.map((r) => ({
                    tenantId: tenant.id,
                    slug: r.slug,
                    name: r.name,
                    description: r.description,
                    isSystem: r.isSystem ?? false,
                    defaultFor: r.defaultFor ?? null,
                })),
            });
            const superAdmin = await tx.role.findUniqueOrThrow({ where: { tenantId_slug: { tenantId: tenant.id, slug: SUPER_ADMIN_SLUG } } });

            const admin = await tx.user.create({
                data: {
                    tenantId: tenant.id,
                    kind: 'admin',
                    username: data.admin.username,
                    email: data.admin.email,
                    displayName: data.admin.displayName,
                    passwordHash,
                    mustChangePassword: true,
                },
            });
            await tx.userRole.create({ data: { tenantId: tenant.id, userId: admin.id, roleId: superAdmin.id } });

            return { tenant, admin: { id: admin.id, username: admin.username, temporaryPassword } };
        });
    });
};

// ─── Lookups (cached briefly in-process; tiny and read on every request) ─────

export interface TenantRef {
    id: string;
    code: string;
    status: TenantStatus;
}

const TTL_MS = 60_000;
const byKey = new Map<string, { value: TenantRef | null; at: number }>();

const cached = async (key: string, load: () => Promise<TenantRef | null>): Promise<TenantRef | null> => {
    const hit = byKey.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = await load();
    byKey.set(key, { value, at: Date.now() });
    return value;
};

const select = { id: true, code: true, status: true } as const;

export const findTenantByDomain = (domain: string) =>
    cached(`domain:${domain}`, () => runAsSystem(() => db.tenant.findUnique({ where: { domain }, select })));

export const findTenantByCode = (code: string) =>
    cached(`code:${code}`, () => runAsSystem(() => db.tenant.findUnique({ where: { code }, select })));

export const findTenantById = (id: string) =>
    cached(`id:${id}`, () => runAsSystem(() => db.tenant.findUnique({ where: { id }, select })));

/** Drops cached lookups (after a status or domain change, and in tests). */
export const clearTenantCache = () => byKey.clear();
