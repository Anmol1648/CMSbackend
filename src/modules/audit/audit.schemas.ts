import { z } from 'zod';
import type { ListSpec } from '../../core/http/list-query';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date like 2026-10-15');

export const auditFilters = {
    from: day,
    to: day,
    action: z.string().regex(/^[a-z_]{2,40}$/),
    entity: z.string().regex(/^[a-z_]{2,40}$/),
    entityId: z.string().min(1).max(100),
    userId: z.string().uuid(),
};

export const auditListSpec: ListSpec<typeof auditFilters> = {
    sortable: ['at'],
    defaultSort: 'at',
    defaultOrder: 'desc',
    filters: auditFilters,
    defaultPageSize: 50,
};
