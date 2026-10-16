import { z } from 'zod';
import type { ListSpec } from '../../core/http/list-query';

export const masterValueFilters = {
    parent: z.uuid(),
    status: z.enum(['active', 'inactive']),
};

export const masterValueListSpec: ListSpec<typeof masterValueFilters> = {
    // "default" = the list's own order (by hand, or by name).
    sortable: ['default', 'name', 'code', 'updatedAt'],
    defaultSort: 'default',
    search: true,
    filters: masterValueFilters,
};

export const moveSchema = z.strictObject({ direction: z.enum(['up', 'down']) });
