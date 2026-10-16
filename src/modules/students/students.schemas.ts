import { z } from 'zod';
import type { ListSpec } from '../../core/http/list-query';

export const studentFilters = {
    year: z.uuid(),
    class: z.uuid(),
    section: z.uuid(),
    house: z.uuid(),
    gender: z.uuid(),
    category: z.uuid(),
    caste: z.uuid(),
    status: z.enum(['active', 'left', 'passed_out', 'struck_off']),
};

export const studentListSpec: ListSpec<typeof studentFilters> = {
    sortable: ['name', 'admissionNo', 'admissionDate', 'class', 'roll'],
    defaultSort: 'roll',
    search: true,
    filters: studentFilters,
    maxPageSize: 200,
};
