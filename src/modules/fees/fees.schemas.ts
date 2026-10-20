import { z } from 'zod';
import type { ListSpec } from '../../core/http/list-query';

export const receiptFilters = {
    from: z.iso.date(),
    to: z.iso.date(),
    mode: z.enum(['cash', 'upi', 'cheque', 'dd', 'bank_transfer', 'card', 'online']),
    status: z.enum(['active', 'cancelled']),
    year: z.uuid(),
    class: z.uuid(),
    student: z.uuid(),
    /** Who collected it (user id). */
    collector: z.uuid(),
};

export const receiptListSpec: ListSpec<typeof receiptFilters> = {
    sortable: ['date', 'receiptNo', 'amount'],
    defaultSort: 'date',
    defaultOrder: 'desc',
    search: true,
    filters: receiptFilters,
    maxPageSize: 200,
};

export const duesQuerySchema = z.object({
    year: z.uuid().optional(),
    class: z.uuid().optional(),
    section: z.uuid().optional(),
    /** Dues as on this day (default today). */
    asOf: z.iso.date().optional(),
    /** all = everyone with something to pay; overdue = only past-due amounts. */
    show: z.enum(['overdue', 'all', 'everyone']).default('overdue'),
    search: z.string().trim().max(100).optional(),
});

export const collectionQuerySchema = z.object({
    from: z.iso.date(),
    to: z.iso.date(),
});
