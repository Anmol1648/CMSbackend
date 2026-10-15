import type { Prisma } from '@prisma/client';
import { db } from '../../core/db';
import { runAsSystem, runAsTenant } from '../../core/context';
import { getSetting } from '../../core/settings';
import { logger } from '../../core/logger';
import { ListQuery, listResult } from '../../core/http/list-query';
import { AUDIT } from './audit.permissions';
import type { auditFilters } from './audit.schemas';

/** Reading the audit trail, and removing records past the retention period. */

const userNames = async (ids: (string | null)[]) => {
    const unique = [...new Set(ids.filter((i): i is string => !!i))];
    if (!unique.length) return new Map<string, { displayName: string; username: string }>();
    // Naming `deletedAt` turns off the automatic "hide deleted" filter: removed users still show by name.
    const users = await db.user.findMany({ where: { id: { in: unique }, deletedAt: undefined }, select: { id: true, displayName: true, username: true } });
    return new Map(users.map((u) => [u.id, { displayName: u.displayName, username: u.username }]));
};

const present = async (rows: { id: bigint; userId: string | null; [k: string]: unknown }[]) => {
    const names = await userNames(rows.map((r) => r.userId));
    return rows.map((r) => ({ ...r, id: r.id.toString(), user: r.userId ? names.get(r.userId) ?? null : null }));
};

export const listAudit = async (q: ListQuery<typeof auditFilters>) => {
    const f = q.filters;
    const at: Prisma.DateTimeFilter = {};
    if (f.from) at.gte = new Date(`${f.from}T00:00:00`);
    if (f.to) at.lt = new Date(new Date(`${f.to}T00:00:00`).getTime() + 86_400_000);
    const where: Prisma.AuditLogWhereInput = {
        ...(Object.keys(at).length ? { at } : {}),
        ...(f.action ? { action: f.action } : {}),
        ...(f.entity ? { entity: f.entity } : {}),
        ...(f.entityId ? { entityId: f.entityId } : {}),
        ...(f.userId ? { userId: f.userId } : {}),
    };
    const [rows, total] = await Promise.all([
        db.auditLog.findMany({ where, orderBy: [{ at: q.order }, { id: q.order }], skip: q.skip, take: q.take }),
        db.auditLog.count({ where }),
    ]);
    return listResult(await present(rows), total, q);
};

/** Values for the filter dropdowns: which actions, record types and people appear in the trail. */
export const auditFacets = async () => {
    const [actions, entities, users] = await Promise.all([
        db.auditLog.groupBy({ by: ['action'], _count: { _all: true }, orderBy: { action: 'asc' } }),
        db.auditLog.groupBy({ by: ['entity'], _count: { _all: true }, orderBy: { entity: 'asc' } }),
        db.auditLog.groupBy({ by: ['userId'], _count: { _all: true } }),
    ]);
    const names = await userNames(users.map((u) => u.userId));
    return {
        actions: actions.map((a) => ({ value: a.action, count: a._count._all })),
        entities: entities.map((e) => ({ value: e.entity, count: e._count._all })),
        users: users
            .filter((u) => u.userId && names.has(u.userId))
            .map((u) => ({ value: u.userId!, label: names.get(u.userId!)!.displayName, count: u._count._all }))
            .sort((a, b) => a.label.localeCompare(b.label)),
    };
};

/** The latest history of one record (shown on its page). */
export const recordHistory = async (entity: string, entityId: string, take = 20) =>
    present(await db.auditLog.findMany({ where: { entity, entityId }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take }));

/** Deletes each school's records older than its retention setting. */
export const purgeOldAuditRecords = async () => {
    const tenants = await runAsSystem(() => db.tenant.findMany({ select: { id: true } }));
    let removed = 0;
    for (const t of tenants) {
        removed += await runAsTenant(t.id, async () => {
            const days = await getSetting(AUDIT.retentionDays);
            const res = await db.auditLog.deleteMany({ where: { at: { lt: new Date(Date.now() - days * 86_400_000) } } });
            return res.count;
        });
    }
    if (removed) logger.info(`Removed ${removed} audit records past their retention period`);
    return removed;
};
