import { z } from 'zod';
import type { ListSpec } from '../../core/http/list-query';

export const enquiryFilters = {
    year: z.uuid(),
    class: z.uuid(),
    stage: z.uuid(),
    source: z.uuid(),
    /** A staff id, or "none" for enquiries nobody follows up. */
    assigned: z.union([z.uuid(), z.literal('none')]),
    status: z.enum(['open', 'won', 'lost']),
    /** Follow-ups of open enquiries. */
    due: z.enum(['overdue', 'today', 'upcoming', 'none']),
    online: z.enum(['yes', 'no']),
    from: z.iso.date(),
    to: z.iso.date(),
};

export const enquiryListSpec: ListSpec<typeof enquiryFilters> = {
    sortable: ['enquiryDate', 'nextFollowUp', 'studentName', 'enquiryNo'],
    defaultSort: 'enquiryDate',
    defaultOrder: 'desc',
    search: true,
    filters: enquiryFilters,
    maxPageSize: 200,
};
