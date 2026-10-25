import JSZip from 'jszip';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { runAsSystem, runAsTenant } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { cache } from '../../core/cache';
import { logger } from '../../core/logger';
import { encryptSecret } from '../../core/encryption';
import { generateTemporaryPassword, hashPassword } from '../../core/password';
import { setSetting } from '../../core/settings';
import { forgetSchoolMail, SCHOOL_MAIL, sendMail, escapeHtml } from '../../core/mail';
import { storageFor } from '../../core/files/storage';
import { env } from '../../config/env';
import { clearTenantCache, createTenant, SUPER_ADMIN_SLUG } from '../tenants';
import { moduleKeys, PRODUCT_MODULES } from './catalogue';
import { setupProgress } from './onboarding';
import { platformLog } from './platform-log';
import { exportMenu, menuSaveSchema, saveMenu } from '../settings/menu-setup.service';

/**
 * The platform console's work: schools (add, change, plans and modules, limits, suspend, help the
 * admin, own mail server, export, delete), plans, platform staff, the log and notices to schools.
 * Everything here runs outside any one school (runAsSystem), or inside the school it is about.
 */

const sys = <T>(fn: () => Promise<T>) => runAsSystem(fn);
const DAY = 86_400_000;
const monthStart = () => new Date(`${new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 8)}01T00:00:00+05:30`);
const limitsSchema = z.strictObject({ maxStudents: z.number().int().min(0).max(1_000_000).optional(), aiMonthly: z.number().int().min(0).max(10_000_000).optional(), storageMb: z.number().int().min(0).max(10_000_000).optional() });
const modulesSchema = z.array(z.string().refine((k) => moduleKeys.has(k), 'is not a module')).max(PRODUCT_MODULES.length);
const hostSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'must be a host name like erp.school.in');

/** After a school's status, domain or modules change: forget cached lookups and access. */
const refreshSchool = async (tenantId: string) => {
    clearTenantCache();
    await cache.delPrefix(`access:${tenantId}:`).catch(() => undefined);
    await cache.delPrefix(`dash:${tenantId}:`).catch(() => undefined);
};

const schoolAddress = (t: { code: string; domain: string | null }) => (t.domain ? `https://${t.domain}` : env.PLATFORM_DOMAIN ? `https://${t.code}.${env.PLATFORM_DOMAIN}` : null);

// ─── Schools ─────────────────────────────────────────────────────────────────

/** Every school with its usage (students, staff, logins, files, AI this month, last sign-in). */
export const listSchools = async () =>
    sys(async () => {
        const [tenants, students, staff, users, files, ai, last, plans] = await Promise.all([
            db.tenant.findMany({ orderBy: { name: 'asc' }, select: { id: true, code: true, name: true, domain: true, status: true, city: true, planId: true, modulesAll: true, modules: true, limits: true, deleteAfter: true, createdAt: true } }),
            db.student.groupBy({ by: ['tenantId'], where: { status: 'active' }, _count: { _all: true } }),
            db.staff.groupBy({ by: ['tenantId'], where: { status: 'working' }, _count: { _all: true } }),
            db.user.groupBy({ by: ['tenantId'], where: { status: 'active' }, _count: { _all: true } }),
            db.file.groupBy({ by: ['tenantId'], _sum: { sizeBytes: true } }),
            db.aiUsage.groupBy({ by: ['tenantId'], where: { createdAt: { gte: monthStart() }, ok: true }, _count: { _all: true } }),
            db.user.groupBy({ by: ['tenantId'], _max: { lastLoginAt: true } }),
            db.platformPlan.findMany({ select: { id: true, name: true } }),
        ]);
        const n = <T extends { tenantId: string }>(rows: T[], id: string) => rows.find((r) => r.tenantId === id);
        return tenants.map((t) => ({
            ...t,
            address: schoolAddress(t),
            plan: plans.find((p) => p.id === t.planId)?.name ?? null,
            students: n(students, t.id)?._count._all ?? 0,
            staff: n(staff, t.id)?._count._all ?? 0,
            users: n(users, t.id)?._count._all ?? 0,
            storageMb: Math.round(((n(files, t.id)?._sum.sizeBytes ?? 0) / 1024 / 1024) * 10) / 10,
            aiThisMonth: n(ai, t.id)?._count._all ?? 0,
            lastSignIn: n(last, t.id)?._max.lastLoginAt ?? null,
        }));
    });

const findSchool = async (id: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('School not found');
    const t = await sys(() => db.tenant.findUnique({ where: { id } }));
    if (!t) throw notFound('School not found');
    return t;
};

/** One school: details, usage, setup progress, admins, its own mail server (without the password). */
export const getSchool = async (id: string) => {
    const t = await findSchool(id);
    const usage = (await listSchools()).find((s) => s.id === id)!;
    const details = await runAsTenant(id, async () => {
        const [profile, admins, setup, mail] = await Promise.all([
            db.schoolProfile.findFirst({ select: { legalName: true, city: true, state: true, phone: true, email: true, board: true } }),
            db.user.findMany({ where: { roles: { some: { role: { slug: { in: [SUPER_ADMIN_SLUG, 'school-admin'] } } } } }, select: { id: true, username: true, displayName: true, email: true, status: true, lastLoginAt: true, lockedUntil: true }, orderBy: { createdAt: 'asc' } }),
            setupProgress(),
            db.tenantSetting.findMany({ where: { key: { in: ['mail.host', 'mail.port', 'mail.user', 'mail.from'] } }, select: { key: true, value: true } }),
        ]);
        const m = Object.fromEntries(mail.map((x) => [x.key.slice(5), String(x.value ?? '')]));
        return { profile, admins, setup, mail: m.host ? { host: m.host, port: m.port, user: m.user, from: m.from } : null };
    });
    return { ...t, ...usage, ...details };
};

export const createSchoolSchema = z.strictObject({
    code: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'use 2–40 lowercase letters, numbers or hyphens'),
    name: z.string().trim().min(2).max(200),
    domain: hostSchema.nullable().optional(),
    city: z.string().trim().max(80).nullable().optional(),
    contactName: z.string().trim().max(120).nullable().optional(),
    contactEmail: z.string().trim().toLowerCase().email().nullable().optional(),
    contactPhone: z.string().trim().max(20).nullable().optional(),
    planId: z.uuid().nullable().optional(),
    starterData: z.boolean().default(true),
    admin: z.strictObject({ displayName: z.string().trim().min(2).max(120), username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,64}$/), email: z.string().trim().toLowerCase().email().nullable().optional() }),
});

/** Adds a school (with its roles, starter lists and first admin), puts it on a plan, and emails the admin. */
export const createSchool = async (input: z.infer<typeof createSchoolSchema>, by: string, ip?: string) => {
    const plan = input.planId ? await sys(() => db.platformPlan.findUnique({ where: { id: input.planId! } })) : null;
    if (input.planId && !plan) throw badRequest('Plan not found');
    const created = await createTenant({ code: input.code, name: input.name, domain: input.domain ?? undefined, admin: { displayName: input.admin.displayName, username: input.admin.username, email: input.admin.email ?? undefined } }, { starterData: input.starterData });
    const t = await sys(() =>
        db.tenant.update({
            where: { id: created.tenant.id },
            data: { city: input.city ?? null, contactName: input.contactName ?? null, contactEmail: input.contactEmail ?? null, contactPhone: input.contactPhone ?? null, ...(plan ? { planId: plan.id, modulesAll: false, modules: plan.modules, limits: plan.limits as Prisma.InputJsonValue } : {}) },
        })
    );
    await platformLog(by, 'school_created', { tenantId: t.id, schoolName: t.name, details: { code: t.code, plan: plan?.name ?? 'all modules' }, ip });
    const address = schoolAddress(t);
    let emailed = false;
    if (input.admin.email) {
        try {
            await runAsTenant(t.id, () =>
                sendMail({
                    to: input.admin.email!,
                    subject: `Your ${t.name} ERP is ready`,
                    text: `Hello ${input.admin.displayName},\n\nYour school's ERP is ready.\n\nAddress: ${address ?? '(ask Klytos)'}\nSchool code: ${t.code}\nUsername: ${created.admin.username}\nOne-time password: ${created.admin.temporaryPassword}\n\nYou will choose your own password when you first sign in.\n\nKlytos`,
                    html: `<p>Hello ${escapeHtml(input.admin.displayName)},</p><p>Your school's ERP is ready.</p><p>Address: <b>${escapeHtml(address ?? '(ask Klytos)')}</b><br>School code: <b>${escapeHtml(t.code)}</b><br>Username: <b>${escapeHtml(created.admin.username)}</b><br>One-time password: <b>${escapeHtml(created.admin.temporaryPassword)}</b></p><p>You will choose your own password when you first sign in.</p><p>Klytos</p>`,
                })
            );
            emailed = true;
        } catch (err) {
            logger.warn('Welcome email failed', { error: (err as Error).message });
        }
    }
    return { id: t.id, code: t.code, address, admin: created.admin, emailed };
};

export const updateSchoolSchema = z.strictObject({
    name: z.string().trim().min(2).max(200),
    domain: hostSchema.nullable(),
    city: z.string().trim().max(80).nullable(),
    contactName: z.string().trim().max(120).nullable(),
    contactEmail: z.string().trim().toLowerCase().email().nullable(),
    contactPhone: z.string().trim().max(20).nullable(),
    notes: z.string().trim().max(2000).nullable(),
    planId: z.uuid().nullable(),
    modulesAll: z.boolean(),
    modules: modulesSchema,
    limits: limitsSchema,
});
export const updateSchool = async (id: string, input: z.infer<typeof updateSchoolSchema>, by: string, ip?: string) => {
    const before = await findSchool(id);
    if (input.domain && input.domain !== before.domain && (await sys(() => db.tenant.findFirst({ where: { domain: input.domain!, id: { not: id } } })))) throw conflict(`${input.domain} is used by another school`);
    const t = await sys(() => db.tenant.update({ where: { id }, data: { ...input, limits: input.limits as Prisma.InputJsonValue } }));
    await refreshSchool(id);
    const changed = (Object.keys(input) as (keyof typeof input)[]).filter((k) => JSON.stringify(input[k]) !== JSON.stringify((before as Record<string, unknown>)[k]));
    await platformLog(by, 'school_updated', { tenantId: id, schoolName: t.name, details: { changed, modules: input.modulesAll ? 'all' : input.modules, limits: input.limits }, ip });
    return getSchool(id);
};

const codeSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'use 2–40 lowercase letters, numbers or hyphens');
export const changeCodeSchema = z.strictObject({ code: codeSchema, keepOld: z.boolean().default(true), notify: z.boolean().default(true) });
/**
 * A new school code (and so a new <code>.<PLATFORM_DOMAIN> address). No data changes: every row
 * points at the school's id. With keepOld, the old code and address keep leading to the school and
 * the sign-in page moves people to the new ones; the old code stays reserved until removed.
 */
export const changeCode = async (id: string, input: z.infer<typeof changeCodeSchema>, by: string, ip?: string) => {
    const t = await findSchool(id);
    if (input.code === t.code) throw badRequest('That is already its code');
    const clash = await sys(() => db.tenant.findFirst({ where: { id: { not: id }, OR: [{ code: input.code }, { oldCodes: { has: input.code } }] }, select: { name: true } }));
    if (clash) throw conflict(`"${input.code}" is used by ${clash.name}`);
    const oldCodes = [...t.oldCodes.filter((c) => c !== input.code), ...(input.keepOld ? [t.code] : [])];
    const saved = await sys(() => db.tenant.update({ where: { id }, data: { code: input.code, oldCodes } }));
    await refreshSchool(id);
    await platformLog(by, 'school_code_changed', { tenantId: id, schoolName: t.name, details: { from: t.code, to: saved.code, oldStillWorks: input.keepOld }, ip });
    let emailed: string | null = null;
    if (input.notify && t.contactEmail) {
        const address = schoolAddress(saved);
        try {
            await runAsTenant(id, () =>
                sendMail({
                    to: t.contactEmail!,
                    subject: `${t.name}: new ERP school code`,
                    text: `Hello${t.contactName ? ` ${t.contactName}` : ''},

Your school's ERP code has changed from ${t.code} to ${saved.code}.${address ? `
New address: ${address}` : ''}

${input.keepOld ? 'The old code and address still work and lead to the new ones.' : 'The old code and address no longer work.'} Nothing else has changed: all your data, users and passwords are the same.

Klytos`,
                    html: `<p>Hello${t.contactName ? ` ${escapeHtml(t.contactName)}` : ''},</p><p>Your school's ERP code has changed from <b>${escapeHtml(t.code)}</b> to <b>${escapeHtml(saved.code)}</b>.${address ? `<br>New address: <b>${escapeHtml(address)}</b>` : ''}</p><p>${input.keepOld ? 'The old code and address still work and lead to the new ones.' : 'The old code and address no longer work.'} Nothing else has changed: all your data, users and passwords are the same.</p><p>Klytos</p>`,
                })
            );
            emailed = t.contactEmail;
        } catch (err) {
            logger.warn('Code change email failed', { error: (err as Error).message });
        }
    }
    return { ...(await getSchool(id)), emailed };
};

/** Stops an old code (and its address) leading to the school; another school may then take it. */
export const removeOldCode = async (id: string, code: string, by: string, ip?: string) => {
    const t = await findSchool(id);
    if (!t.oldCodes.includes(code)) throw notFound('Not an old code of this school');
    await sys(() => db.tenant.update({ where: { id }, data: { oldCodes: t.oldCodes.filter((c) => c !== code) } }));
    await refreshSchool(id);
    await platformLog(by, 'school_old_code_removed', { tenantId: id, schoolName: t.name, details: { code }, ip });
    return getSchool(id);
};

export const statusSchema = z.strictObject({ status: z.enum(['active', 'suspended']), reason: z.string().trim().max(300).nullable().optional() });
/** Suspends (nobody can sign in; nothing is deleted) or reactivates (also cancels a requested deletion). */
export const setStatus = async (id: string, input: z.infer<typeof statusSchema>, by: string, ip?: string) => {
    const t = await findSchool(id);
    await sys(() => db.tenant.update({ where: { id }, data: input.status === 'active' ? { status: 'active', suspendedReason: null, deleteAfter: null } : { status: 'suspended', suspendedReason: input.reason || null } }));
    await refreshSchool(id);
    await platformLog(by, input.status === 'active' ? 'school_reactivated' : 'school_suspended', { tenantId: id, schoolName: t.name, details: { reason: input.reason ?? null }, ip });
    return getSchool(id);
};

/** A new one-time password for one of the school's admins (unlocked; they choose their own at sign-in). */
export const resetAdminPassword = async (id: string, userId: string, by: string, ip?: string) => {
    const t = await findSchool(id);
    const password = generateTemporaryPassword();
    const passwordHash = await hashPassword(password);
    const u = await runAsTenant(id, async () => {
        const user = await db.user.findFirst({ where: { id: userId, roles: { some: { role: { slug: { in: [SUPER_ADMIN_SLUG, 'school-admin'] } } } } }, select: { id: true, username: true } });
        if (!user) throw notFound('Not an admin of this school');
        await db.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null, status: 'active' } });
        return user;
    });
    await platformLog(by, 'school_admin_password_reset', { tenantId: id, schoolName: t.name, details: { username: u.username }, ip });
    return { username: u.username, password };
};

export const mailSchema = z.strictObject({ host: z.string().trim().min(3).max(200), port: z.number().int().min(1).max(65535), user: z.string().trim().min(1).max(200), password: z.string().min(1).max(500).optional(), from: z.string().trim().email().nullable().optional() }).nullable();
/** The school's own mail server (null = send through the platform). */
export const setMail = async (id: string, input: z.infer<typeof mailSchema>, by: string, ip?: string) => {
    const t = await findSchool(id);
    await runAsTenant(id, async () => {
        if (!input) {
            for (const def of Object.values(SCHOOL_MAIL)) await setSetting(def, undefined);
            return;
        }
        await setSetting(SCHOOL_MAIL.host, input.host);
        await setSetting(SCHOOL_MAIL.port, String(input.port));
        await setSetting(SCHOOL_MAIL.user, input.user);
        await setSetting(SCHOOL_MAIL.from, input.from ?? '');
        if (input.password) await setSetting(SCHOOL_MAIL.pass, encryptSecret(input.password));
    });
    forgetSchoolMail(id);
    await platformLog(by, input ? 'school_mail_set' : 'school_mail_removed', { tenantId: id, schoolName: t.name, details: input ? { host: input.host, user: input.user } : {}, ip });
    return getSchool(id);
};

// ─── Export and delete ───────────────────────────────────────────────────────

/** Every table that holds a school's rows, as Prisma client names. */
const schoolTables = () => Prisma.dmmf.datamodel.models.filter((m) => m.name !== 'Tenant' && m.fields.some((f) => f.name === 'tenantId')).map((m) => ({ model: m.name, client: m.name[0].toLowerCase() + m.name.slice(1) }));
type Delegate = { findMany: (a: object) => Promise<Record<string, unknown>[]>; deleteMany: (a: object) => Promise<{ count: number }> };
const delegate = (client: string) => (db as unknown as Record<string, Delegate>)[client];

/** All of a school's data: one JSON file per table and every uploaded file, in a zip. */
export const exportSchool = async (id: string, by: string, ip?: string) => {
    const t = await findSchool(id);
    const zip = new JSZip();
    const counts: Record<string, number> = {};
    await sys(async () => {
        for (const { model, client } of schoolTables()) {
            const rows = await delegate(client).findMany({ where: { tenantId: id } });
            if (!rows.length) continue;
            counts[model] = rows.length;
            zip.file(`data/${model}.json`, JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
        }
        const files = await db.file.findMany({ where: { tenantId: id, deletedAt: null }, select: { id: true, provider: true, storageKey: true, originalName: true } });
        let missing = 0;
        for (const f of files) {
            try {
                zip.file(`files/${f.id}-${f.originalName.replace(/[\\/:*?"<>|]/g, '_')}`, await storageFor(f.provider).get(f.storageKey));
            } catch {
                missing++;
            }
        }
        counts.files = files.length - missing;
    });
    zip.file('README.txt', `${t.name} (${t.code}): all data, exported ${new Date().toISOString()}.\n\ndata/<Table>.json: every row of each table.\nfiles/: uploaded files (photos, documents, logos), named <file id>-<name>; the "File" table says what each one is.\n\nRows per table:\n${Object.entries(counts).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n`);
    await platformLog(by, 'school_exported', { tenantId: id, schoolName: t.name, details: { tables: Object.keys(counts).length }, ip });
    return { filename: `${t.code}-export-${new Date().toISOString().slice(0, 10)}.zip`, data: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) };
};

export const deleteRequestSchema = z.strictObject({ confirmCode: z.string().trim().min(2).max(40) });
/** Asks for a suspended school to be deleted: everything goes after 30 days (reactivating cancels it). */
export const requestDelete = async (id: string, input: z.infer<typeof deleteRequestSchema>, by: string, ip?: string) => {
    const t = await findSchool(id);
    if (input.confirmCode.toLowerCase() !== t.code) throw badRequest('Type the school code to confirm');
    if (t.status !== 'suspended') throw badRequest('Suspend the school first');
    const after = new Date(Date.now() + 30 * DAY);
    await sys(() => db.tenant.update({ where: { id }, data: { deleteAfter: after } }));
    await platformLog(by, 'school_delete_requested', { tenantId: id, schoolName: t.name, details: { after: after.toISOString().slice(0, 10) }, ip });
    return getSchool(id);
};
export const cancelDelete = async (id: string, by: string, ip?: string) => {
    const t = await findSchool(id);
    await sys(() => db.tenant.update({ where: { id }, data: { deleteAfter: null } }));
    await platformLog(by, 'school_delete_cancelled', { tenantId: id, schoolName: t.name, ip });
    return getSchool(id);
};

/** Removes a school and everything it has (tables in passes until nothing blocks, then its files). */
const purgeSchool = async (id: string) => {
    const t = await findSchool(id);
    await sys(async () => {
        const files = await db.file.findMany({ where: { tenantId: id }, select: { provider: true, storageKey: true } });
        for (const f of files) await storageFor(f.provider).remove(f.storageKey).catch(() => undefined);
        let left = schoolTables();
        for (let pass = 0; pass < 30 && left.length; pass++) {
            const next: typeof left = [];
            for (const tb of left) {
                try {
                    await delegate(tb.client).deleteMany({ where: { tenantId: id } });
                } catch {
                    next.push(tb); // rows of another table still point at these: try again next pass
                }
            }
            left = next;
        }
        if (left.length) throw new Error(`Could not delete ${left.map((x) => x.model).join(', ')}`);
        await db.tenant.delete({ where: { id } });
    });
    await refreshSchool(id);
    await platformLog(null, 'school_deleted', { tenantId: id, schoolName: t.name, details: { code: t.code } });
};

/** Daily: schools whose deletion date has passed. */
export const purgeDueSchools = async () => {
    const due = await sys(() => db.tenant.findMany({ where: { status: 'suspended', deleteAfter: { lt: new Date() } }, select: { id: true, name: true } }));
    for (const t of due) {
        try {
            await purgeSchool(t.id);
        } catch (err) {
            logger.error('School deletion failed', { school: t.name, error: (err as Error).message });
        }
    }
    return due.length;
};

// ─── Plans ───────────────────────────────────────────────────────────────────

export const planSchema = z.strictObject({ name: z.string().trim().min(2).max(60), description: z.string().trim().max(300).default(''), modules: modulesSchema, limits: limitsSchema, sortOrder: z.number().int().min(0).max(999).default(0), isActive: z.boolean().default(true) });
export const listPlans = async () => {
    const [plans, counts] = await Promise.all([sys(() => db.platformPlan.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })), sys(() => db.tenant.groupBy({ by: ['planId'], _count: { _all: true } }))]);
    return { modules: PRODUCT_MODULES.map(({ key, label, description }) => ({ key, label, description })), plans: plans.map((p) => ({ ...p, schools: counts.find((c) => c.planId === p.id)?._count._all ?? 0 })) };
};
export const savePlan = async (id: string | null, input: z.infer<typeof planSchema>, by: string, ip?: string) => {
    const data = { ...input, limits: input.limits as Prisma.InputJsonValue };
    const p = id ? await sys(() => db.platformPlan.update({ where: { id }, data })) : await sys(() => db.platformPlan.create({ data }));
    await platformLog(by, id ? 'plan_updated' : 'plan_created', { details: { name: p.name, modules: p.modules, limits: p.limits }, ip });
    return listPlans();
};
/** Puts every school on this plan onto its current modules and limits. */
export const applyPlanToSchools = async (id: string, by: string, ip?: string) => {
    const p = await sys(() => db.platformPlan.findUnique({ where: { id } }));
    if (!p) throw notFound('Plan not found');
    const schools = await sys(() => db.tenant.findMany({ where: { planId: id }, select: { id: true } }));
    await sys(() => db.tenant.updateMany({ where: { planId: id }, data: { modulesAll: false, modules: p.modules, limits: p.limits as Prisma.InputJsonValue } }));
    for (const s of schools) await refreshSchool(s.id);
    await platformLog(by, 'plan_applied', { details: { name: p.name, schools: schools.length }, ip });
    return { schools: schools.length };
};
export const deletePlan = async (id: string, by: string, ip?: string) => {
    const p = await sys(() => db.platformPlan.findUnique({ where: { id } }));
    if (!p) throw notFound('Plan not found');
    if (await sys(() => db.tenant.count({ where: { planId: id } }))) throw badRequest('Schools are on this plan: move them first, or switch the plan off');
    await sys(() => db.platformPlan.delete({ where: { id } }));
    await platformLog(by, 'plan_deleted', { details: { name: p.name }, ip });
    return listPlans();
};

// ─── Menu templates ──────────────────────────────────────────────────────────

export const listMenuTemplates = () => sys(() => db.platformMenuTemplate.findMany({ orderBy: { name: 'asc' } }));

export const templateFromSchoolSchema = z.strictObject({ name: z.string().trim().min(2).max(60), description: z.string().trim().max(300).default('') });
/** Saves a school's current menu names and places as a template. */
export const templateFromSchool = async (schoolId: string, input: z.infer<typeof templateFromSchoolSchema>, by: string, ip?: string) => {
    const t = await findSchool(schoolId);
    const menu = await runAsTenant(schoolId, exportMenu);
    if (!menu.items.length && !menu.groups.length) throw badRequest(`${t.name} uses the built-in menu: there is nothing to save`);
    const existing = await sys(() => db.platformMenuTemplate.findUnique({ where: { name: input.name } }));
    const data = { name: input.name, description: input.description, items: menu.items as Prisma.InputJsonValue, groups: menu.groups as Prisma.InputJsonValue };
    if (existing) await sys(() => db.platformMenuTemplate.update({ where: { id: existing.id }, data }));
    else await sys(() => db.platformMenuTemplate.create({ data }));
    await platformLog(by, 'menu_template_saved', { tenantId: schoolId, schoolName: t.name, details: { name: input.name, items: menu.items.length, groups: menu.groups.length }, ip });
    return listMenuTemplates();
};

/** Applies a template to a school (its menu set-up is replaced; the school can change it afterwards). */
export const applyMenuTemplate = async (schoolId: string, templateId: string | null, by: string, ip?: string) => {
    const t = await findSchool(schoolId);
    const tpl = templateId ? await sys(() => db.platformMenuTemplate.findUnique({ where: { id: templateId } })) : null;
    if (templateId && !tpl) throw notFound('Template not found');
    const input = menuSaveSchema.parse({ groups: (tpl?.groups ?? []) as unknown[], items: (tpl?.items ?? []) as unknown[] });
    await runAsTenant(schoolId, () => saveMenu(input, null));
    await platformLog(by, tpl ? 'menu_template_applied' : 'menu_reset', { tenantId: schoolId, schoolName: t.name, details: { template: tpl?.name ?? 'built-in' }, ip });
    return { ok: true };
};

export const deleteMenuTemplate = async (id: string, by: string, ip?: string) => {
    const tpl = await sys(() => db.platformMenuTemplate.findUnique({ where: { id } }));
    if (!tpl) throw notFound('Template not found');
    await sys(() => db.platformMenuTemplate.delete({ where: { id } }));
    await platformLog(by, 'menu_template_deleted', { details: { name: tpl.name }, ip });
    return listMenuTemplates();
};

// ─── Platform staff ──────────────────────────────────────────────────────────

const staffOut = (u: { id: string; email: string; name: string; role: string; status: string; mfaEnabled: boolean; lastLoginAt: Date | null; createdAt: Date }) => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, mfaEnabled: u.mfaEnabled, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt });
export const listStaff = async () => (await sys(() => db.platformUser.findMany({ orderBy: { name: 'asc' } }))).map(staffOut);
export const staffSchema = z.strictObject({ email: z.string().trim().toLowerCase().email().max(200), name: z.string().trim().min(2).max(120), role: z.enum(['owner', 'support']), status: z.enum(['active', 'disabled']).default('active') });
/** Adds a console user (a one-time password, shown once) or changes one. */
export const saveStaff = async (id: string | null, input: z.infer<typeof staffSchema>, by: string, ip?: string) => {
    if (id) {
        const u = await sys(() => db.platformUser.findUnique({ where: { id } }));
        if (!u) throw notFound('Not found');
        if (id === by && (input.status !== 'active' || input.role !== u.role)) throw forbidden('You can’t change your own role or switch yourself off');
        if (u.role === 'owner' && (input.role !== 'owner' || input.status !== 'active') && (await sys(() => db.platformUser.count({ where: { role: 'owner', status: 'active' } }))) <= 1) throw badRequest('There must always be an active owner');
        await sys(() => db.platformUser.update({ where: { id }, data: input }));
        await platformLog(by, 'platform_user_updated', { details: { email: input.email, role: input.role, status: input.status }, ip });
        return { password: null as string | null };
    }
    if (await sys(() => db.platformUser.findUnique({ where: { email: input.email } }))) throw conflict('That email is already a console user');
    const password = generateTemporaryPassword();
    const passwordHash = await hashPassword(password);
    await sys(() => db.platformUser.create({ data: { ...input, passwordHash, mustChangePassword: true } }));
    await platformLog(by, 'platform_user_created', { details: { email: input.email, role: input.role }, ip });
    return { password };
};
/** A new one-time password and a fresh authenticator set-up at their next sign-in. */
export const resetStaff = async (id: string, by: string, ip?: string) => {
    const u = await sys(() => db.platformUser.findUnique({ where: { id } }));
    if (!u) throw notFound('Not found');
    const password = generateTemporaryPassword();
    const passwordHash = await hashPassword(password);
    await sys(() => db.platformUser.update({ where: { id }, data: { passwordHash, mustChangePassword: true, mfaEnabled: false, mfaSecretEnc: null, failedLogins: 0, lockedUntil: null } }));
    await platformLog(by, 'platform_user_reset', { details: { email: u.email }, ip });
    return { password };
};

// ─── Log and notices ─────────────────────────────────────────────────────────

export const logQuery = z.object({ tenantId: z.uuid().optional(), page: z.coerce.number().int().min(1).default(1) });
export const listLog = async (q: z.infer<typeof logQuery>) => {
    const where = q.tenantId ? { tenantId: q.tenantId } : {};
    const [rows, total, users] = await Promise.all([sys(() => db.platformLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50, skip: (q.page - 1) * 50 })), sys(() => db.platformLog.count({ where })), sys(() => db.platformUser.findMany({ select: { id: true, name: true } }))]);
    return { total, rows: rows.map((r) => ({ ...r, by: users.find((u) => u.id === r.userId)?.name ?? (r.userId ? '—' : 'System') })) };
};

export const noticeSchema = z.strictObject({ kind: z.enum(['banner', 'news']), title: z.string().trim().min(2).max(120), body: z.string().trim().max(3000).default(''), audience: z.enum(['all', 'admins']).default('all'), startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }).nullable().optional() });
export const listNotices = () => sys(() => db.platformNotice.findMany({ orderBy: { startsAt: 'desc' }, take: 100 }));
export const saveNotice = async (id: string | null, input: z.infer<typeof noticeSchema>, by: string, ip?: string) => {
    const data = { ...input, startsAt: new Date(input.startsAt), endsAt: input.endsAt ? new Date(input.endsAt) : null };
    if (id) await sys(() => db.platformNotice.update({ where: { id }, data }));
    else await sys(() => db.platformNotice.create({ data: { ...data, createdBy: by } }));
    await platformLog(by, id ? 'notice_updated' : 'notice_created', { details: { kind: input.kind, title: input.title }, ip });
    return listNotices();
};
export const deleteNotice = async (id: string, by: string, ip?: string) => {
    await sys(() => db.platformNotice.delete({ where: { id } }));
    await platformLog(by, 'notice_deleted', { details: { id }, ip });
    return listNotices();
};

/** For a school's signed-in people: the banner on now and the "What's new" notes of the last 30 days. */
export const noticesFor = async (isAdmin: boolean) => {
    const now = new Date();
    const rows = await sys(() => db.platformNotice.findMany({ where: { startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }], ...(isAdmin ? {} : { audience: 'all' }) }, orderBy: { startsAt: 'desc' }, take: 20 }));
    return { banners: rows.filter((r) => r.kind === 'banner').map(({ id, title, body }) => ({ id, title, body })), news: rows.filter((r) => r.kind === 'news' && r.startsAt.getTime() > now.getTime() - 30 * DAY).map(({ id, title, body, startsAt }) => ({ id, title, body, startsAt })) };
};
