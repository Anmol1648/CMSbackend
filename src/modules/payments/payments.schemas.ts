import { z } from 'zod';
import type { ListSpec } from '../../core/http/list-query';

export const onlinePaymentFilters = {
    status: z.enum(['created', 'paid', 'failed']),
    purpose: z.enum(['fees', 'registration']),
    /** Paid, with something to check (e.g. more than was due). */
    attention: z.enum(['yes']),
};

export const onlinePaymentListSpec: ListSpec<typeof onlinePaymentFilters> = {
    sortable: ['createdAt'],
    defaultSort: 'createdAt',
    defaultOrder: 'desc',
    search: true,
    filters: onlinePaymentFilters,
    maxPageSize: 200,
};
