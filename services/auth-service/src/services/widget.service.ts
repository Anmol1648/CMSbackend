import { db } from '../models/prisma';
import { AppError } from '../utils/errors';
import { ErrorCode, serviceHandler } from '@shared/core';
import { PrismaClient } from '@prisma/client';

// Raw Prisma client for $queryRawUnsafe (the extended client doesn't expose it directly)
const rawPrisma = new PrismaClient();

// ─── Dangerous SQL Keywords ────────────────────────────────────────────────────
const BLOCKED_KEYWORDS = [
    'INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRUNCATE',
    'ALTER', 'CREATE', 'GRANT', 'REVOKE', 'EXEC',
    'EXECUTE', 'INTO'
];

/**
 * Validates a SQL query string for safety.
 * Blocks any mutation / DDL / DCL keywords.
 */
function validateQuerySafety(query: string): void {
    const upperQuery = query.toUpperCase().replace(/\s+/g, ' ').trim();

    for (const keyword of BLOCKED_KEYWORDS) {
        // Match keyword as a whole word to avoid false positives like "DELETED" matching "DELETE"
        const regex = new RegExp(`\\b${keyword}\\b`);
        if (regex.test(upperQuery)) {
            throw new AppError(
                `Query contains blocked keyword: ${keyword}. Only SELECT queries are allowed.`,
                400,
                ErrorCode.VALIDATION_ERROR
            );
        }
    }

    // Must start with SELECT or WITH (CTE)
    if (!upperQuery.startsWith('SELECT') && !upperQuery.startsWith('WITH')) {
        throw new AppError(
            'Query must start with SELECT or WITH',
            400,
            ErrorCode.VALIDATION_ERROR
        );
    }
}

// ─── Widget CRUD ────────────────────────────────────────────────────────────────

export const getAllWidgets = serviceHandler(async (filters?: {
    widget_type?: string;
    sub_type?: string;
    is_active?: boolean;
}) => {
    const where: any = {};

    if (filters?.widget_type) where.widget_type = filters.widget_type;
    if (filters?.sub_type) where.sub_type = filters.sub_type;
    if (filters?.is_active !== undefined) {
        where.is_active = filters.is_active;
    }

    const widgets = await db.widget.findMany({
        where,
        orderBy: { created_on: 'desc' },
        include: {
            _count: {
                select: { roleMappings: true }
            }
        }
    });

    return widgets;
});

export const getWidgetById = serviceHandler(async (id: string) => {
    const widget = await db.widget.findUnique({
        where: { id },
        include: {
            roleMappings: {
                include: { role: { select: { id: true, name: true, slug: true } } }
            }
        }
    });

    if (!widget) {
        throw new AppError('Widget not found', 404, ErrorCode.NOT_FOUND);
    }

    return widget;
});

export const createWidget = serviceHandler(async (data: {
    title: string;
    widget_type: string;
    sub_type?: string;
    config?: any;
    query: string;
    display_name?: string;
    customization?: any;
    range_enabled?: boolean;
}) => {
    const widget = await db.widget.create({
        data: {
            title: data.title,
            widget_type: data.widget_type,
            sub_type: data.sub_type,
            config: data.config || {},
            query: data.query,
            display_name: data.display_name || data.title,
            customization: data.customization || {},
            range_enabled: data.range_enabled || false,
        }
    });

    return widget;
});

export const updateWidget = serviceHandler(async (id: string, data: {
    title?: string;
    widget_type?: string;
    sub_type?: string;
    config?: any;
    query?: string;
    display_name?: string;
    customization?: any;
    range_enabled?: boolean;
    is_active?: boolean;
}) => {
    const existing = await db.widget.findUnique({ where: { id } });
    if (!existing) {
        throw new AppError('Widget not found', 404, ErrorCode.NOT_FOUND);
    }

    const widget = await db.widget.update({
        where: { id },
        data
    });

    return widget;
});

export const deleteWidget = serviceHandler(async (id: string) => {
    const existing = await db.widget.findUnique({ where: { id } });
    if (!existing) {
        throw new AppError('Widget not found', 404, ErrorCode.NOT_FOUND);
    }

    // Soft delete
    await db.widget.update({
        where: { id },
        data: { is_active: false }
    });

    return { message: 'Widget soft-deleted successfully' };
});

// ─── Preview Query Execution ────────────────────────────────────────────────────

export const previewWidgetQuery = serviceHandler(async (
    query: string,
    params?: Record<string, any>,
    range?: { start?: string; end?: string }
) => {
    // 1. Validate query safety
    validateQuerySafety(query);

    // 2. Substitute parameters (simple {{param}} replacement)
    let processedQuery = query;
    if (params) {
        for (const [key, value] of Object.entries(params)) {
            // Escape single quotes in values to prevent SQL injection
            const sanitizedValue = String(value).replace(/'/g, "''");
            processedQuery = processedQuery.replace(
                new RegExp(`\\{\\{${key}\\}\\}`, 'g'),
                `'${sanitizedValue}'`
            );
        }
    }

    // 3. Substitute range parameters
    if (range) {
        if (range.start) {
            const sanitizedStart = range.start.replace(/'/g, "''");
            processedQuery = processedQuery.replace(/\{\{range_start\}\}/g, `'${sanitizedStart}'`);
        }
        if (range.end) {
            const sanitizedEnd = range.end.replace(/'/g, "''");
            processedQuery = processedQuery.replace(/\{\{range_end\}\}/g, `'${sanitizedEnd}'`);
        }
    }

    // 4. Execute in a read-only context with timeout
    const startTime = Date.now();

    try {
        const result = await rawPrisma.$transaction(async (tx) => {
            // Set read-only mode and statement timeout
            await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 5000');
            await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');

            // Execute the query
            const rows = await tx.$queryRawUnsafe(processedQuery);
            return rows;
        });

        const executionTime = Date.now() - startTime;
        const rows = result as any[];
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

        return {
            columns,
            rows,
            rowCount: rows.length,
            executionTime
        };
    } catch (error: any) {
        const executionTime = Date.now() - startTime;

        // Check for timeout
        if (error.message?.includes('statement timeout') || error.message?.includes('canceling statement')) {
            throw new AppError(
                'Query execution timed out (5 second limit exceeded)',
                408,
                ErrorCode.VALIDATION_ERROR
            );
        }

        throw new AppError(
            `Query execution failed: ${error.message}`,
            400,
            ErrorCode.VALIDATION_ERROR
        );
    }
});
