import { z } from 'zod';
import { badRequest, FieldIssue } from '../errors';
import { ListResult } from '../response';

/**
 * Standard list query: ?page=1&pageSize=25&sort=name&order=asc&search=ram&filter[status]=active
 * Each list declares what may be sorted and filtered; anything else is rejected (no column names
 * from the request ever reach SQL).
 */

export interface ListSpec<F extends Record<string, z.ZodTypeAny> = Record<string, never>> {
    /** API field names that may be used in `sort`. */
    sortable: readonly string[];
    defaultSort: string;
    defaultOrder?: 'asc' | 'desc';
    /** filter[key]=value, each value parsed by its schema (use z.coerce for numbers/booleans). */
    filters?: F;
    /** Allow ?search= (the service decides which fields it searches). */
    search?: boolean;
    defaultPageSize?: number;
    maxPageSize?: number;
}

export interface ListQuery<F extends Record<string, z.ZodTypeAny> = Record<string, never>> {
    page: number;
    pageSize: number;
    skip: number;
    take: number;
    sort: string;
    order: 'asc' | 'desc';
    search?: string;
    filters: Partial<{ [K in keyof F]: z.infer<F[K]> }>;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const one = (value: unknown): string | undefined => {
    if (Array.isArray(value)) value = value[value.length - 1];
    return typeof value === 'string' ? value : undefined;
};

export const parseListQuery = <F extends Record<string, z.ZodTypeAny> = Record<string, never>>(
    query: Record<string, unknown>,
    spec: ListSpec<F>
): ListQuery<F> => {
    const issues: FieldIssue[] = [];
    const maxPageSize = spec.maxPageSize ?? MAX_PAGE_SIZE;

    const page = Number(one(query.page) ?? 1);
    if (!Number.isInteger(page) || page < 1) issues.push({ field: 'page', message: 'must be a whole number from 1' });

    const pageSize = Number(one(query.pageSize) ?? spec.defaultPageSize ?? DEFAULT_PAGE_SIZE);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > maxPageSize) {
        issues.push({ field: 'pageSize', message: `must be a whole number from 1 to ${maxPageSize}` });
    }

    const sort = one(query.sort) ?? spec.defaultSort;
    if (!spec.sortable.includes(sort)) issues.push({ field: 'sort', message: `can be one of: ${spec.sortable.join(', ')}` });

    const orderRaw = (one(query.order) ?? spec.defaultOrder ?? 'asc').toLowerCase();
    if (orderRaw !== 'asc' && orderRaw !== 'desc') issues.push({ field: 'order', message: 'must be asc or desc' });

    let search: string | undefined;
    const searchRaw = one(query.search)?.trim();
    if (searchRaw) {
        if (!spec.search) issues.push({ field: 'search', message: 'is not supported for this list' });
        else if (searchRaw.length > 100) issues.push({ field: 'search', message: 'must be at most 100 characters' });
        else search = searchRaw;
    }

    const filters: Record<string, unknown> = {};
    const filterRaw = query.filter;
    if (filterRaw !== undefined) {
        if (typeof filterRaw !== 'object' || filterRaw === null || Array.isArray(filterRaw)) {
            issues.push({ field: 'filter', message: 'use filter[field]=value' });
        } else {
            for (const [key, value] of Object.entries(filterRaw as Record<string, unknown>)) {
                const schema = spec.filters?.[key];
                if (!schema) {
                    const allowed = Object.keys(spec.filters ?? {});
                    issues.push({ field: `filter.${key}`, message: allowed.length ? `can filter by: ${allowed.join(', ')}` : 'this list has no filters' });
                    continue;
                }
                const parsed = schema.safeParse(one(value) ?? value);
                if (parsed.success) filters[key] = parsed.data;
                else issues.push({ field: `filter.${key}`, message: parsed.error.issues[0]?.message ?? 'is invalid' });
            }
        }
    }

    if (issues.length) throw badRequest('Invalid list query', issues);

    return {
        page,
        pageSize,
        skip: (page - 1) * pageSize,
        take: pageSize,
        sort,
        order: orderRaw as 'asc' | 'desc',
        search,
        filters: filters as ListQuery<F>['filters'],
    };
};

/** Prisma orderBy for the chosen sort; `map` translates API names to nested Prisma paths if they differ. */
export const toOrderBy = (q: Pick<ListQuery<any>, 'sort' | 'order'>, map: Record<string, (order: 'asc' | 'desc') => object> = {}) =>
    map[q.sort] ? map[q.sort](q.order) : { [q.sort]: q.order };

export const listResult = <T>(items: T[], total: number, q: Pick<ListQuery<any>, 'page' | 'pageSize'>): ListResult<T> => ({
    items,
    total,
    page: q.page,
    pageSize: q.pageSize,
});
