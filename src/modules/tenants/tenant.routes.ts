import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { asyncHandler, AppError, ErrorCode } from '../../core/index';
import { db } from '../../db/prisma';

/**
 * Tenants (schools) live as rows in the one shared database — no database is created per tenant.
 * Interim module kept on the existing `tenants` table; the foundation redesign replaces it with a Prisma model.
 * Mounted behind authenticate + requireRole('super-admin').
 */

const router = Router();

const SAFE_COLUMNS = `id, name, slug, domain, status, "createdAt", "updatedAt"`;

const createSchema = z.object({
    name: z.string().trim().min(1),
    slug: z.string().trim().regex(/^[a-z0-9-]+$/, 'Slug may contain lowercase letters, numbers and hyphens'),
    domain: z.string().trim().min(1),
});

const statusSchema = z.object({ status: z.enum(['active', 'suspended']) });

const findTenant = async (id: string) => {
    const rows = await db.$queryRawUnsafe<any[]>(`SELECT ${SAFE_COLUMNS} FROM tenants WHERE id::text = $1`, id);
    if (!rows.length) throw new AppError('Tenant not found', 404, ErrorCode.NOT_FOUND);
    return rows[0];
};

// GET /api/tenants — list all
router.get('/', asyncHandler(async (req: Request, res: Response) => {
    const tenants = await db.$queryRawUnsafe<any[]>(`SELECT ${SAFE_COLUMNS} FROM tenants ORDER BY "createdAt"`);
    res.json({ success: true, data: tenants });
}));

// POST /api/tenants — onboard a new school
router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message || 'Missing required fields', 400, ErrorCode.VALIDATION_ERROR);
    const { name, slug, domain } = parsed.data;

    const clash = await db.$queryRawUnsafe<any[]>(`SELECT 1 FROM tenants WHERE slug = $1 OR domain = $2`, slug, domain);
    if (clash.length) throw new AppError('A tenant with this slug or domain already exists', 409, ErrorCode.VALIDATION_ERROR);

    const rows = await db.$queryRawUnsafe<any[]>(
        `INSERT INTO tenants (id, name, slug, domain, status, db_host, db_name, db_credentials_encrypted, "createdAt", "updatedAt")
         VALUES ($1::uuid, $2, $3, $4, 'active', 'shared', 'shared', '', NOW(), NOW())
         RETURNING ${SAFE_COLUMNS}`,
        crypto.randomUUID(), name, slug, domain
    );
    res.status(201).json({ success: true, data: rows[0] });
}));

// GET /api/tenants/:id — detail + health status
router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
    const tenant = await findTenant(req.params.id);
    res.json({ success: true, data: { ...tenant, isHealthy: tenant.status === 'active' } });
}));

// POST /api/tenants/:id/migrate — kept for the existing UI; migrations run once for the shared database
router.post('/:id/migrate', asyncHandler(async (req: Request, res: Response) => {
    await findTenant(req.params.id);
    res.json({ success: true, message: 'All schools share one database; migrations are applied once with `npm run db:migrate`.' });
}));

// PATCH /api/tenants/:id/status — activate/suspend
router.patch('/:id/status', asyncHandler(async (req: Request, res: Response) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('Invalid status', 400, ErrorCode.VALIDATION_ERROR);
    await findTenant(req.params.id);
    await db.$executeRawUnsafe(
        `UPDATE tenants SET status = $1::"enum_tenants_status", "updatedAt" = NOW() WHERE id::text = $2`,
        parsed.data.status, req.params.id
    );
    res.json({ success: true, data: { id: req.params.id, status: parsed.data.status } });
}));

export default router;
