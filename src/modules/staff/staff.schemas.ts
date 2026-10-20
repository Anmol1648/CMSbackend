import { z } from 'zod';
import type { ListSpec } from '../../core/http/list-query';

export const staffFilters = {
    department: z.uuid(),
    designation: z.uuid(),
    type: z.uuid(),
    status: z.enum(['working', 'relieved', 'retired', 'suspended']),
};

export const staffListSpec: ListSpec<typeof staffFilters> = {
    sortable: ['name', 'code', 'joiningDate'],
    defaultSort: 'name',
    search: true,
    filters: staffFilters,
    maxPageSize: 200,
};
