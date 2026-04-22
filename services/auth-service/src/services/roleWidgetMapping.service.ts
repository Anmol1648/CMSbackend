import { db } from '../models/prisma';
import { AppError } from '../utils/errors';
import { ErrorCode, serviceHandler } from '@shared/core';

// ─── Get Mappings For Role ──────────────────────────────────────────────────────

export const getMappingsForRole = serviceHandler(async (roleId: string) => {
    const mappings = await db.roleWidgetMapping.findMany({
        where: { role_id: roleId },
        include: {
            widget: {
                select: {
                    id: true,
                    title: true,
                    widget_type: true,
                    sub_type: true,
                    display_name: true,
                    is_active: true,
                    config: true,
                    customization: true,
                    range_enabled: true,
                }
            }
        },
        orderBy: { display_order: 'asc' }
    });

    return mappings;
});

// ─── Get Widgets For User (Dashboard) ───────────────────────────────────────────

export const getWidgetsForUser = serviceHandler(async (userId: string, roleIds: string[]) => {
    if (!roleIds || roleIds.length === 0) {
        return [];
    }

    // Get all widget mappings for the user's roles, merged with widget details
    const mappings = await db.roleWidgetMapping.findMany({
        where: {
            role_id: { in: roleIds },
            enabled: true,
            widget: {
                is_active: true
            }
        },
        include: {
            widget: true
        },
        orderBy: { display_order: 'asc' }
    });

    // Deduplicate widgets (if user has multiple roles with same widget)
    const seenWidgetIds = new Set<string>();
    const uniqueMappings = mappings.filter(m => {
        if (seenWidgetIds.has(m.widget_id)) return false;
        seenWidgetIds.add(m.widget_id);
        return true;
    });

    // Merge widget definition + mapping config
    return uniqueMappings.map(m => ({
        ...m.widget,
        mapping: {
            id: m.id,
            display_order: m.display_order,
            height: m.height,
            width: m.width,
            enabled: m.enabled,
        }
    }));
});

// ─── Upsert Mapping ─────────────────────────────────────────────────────────────

export const upsertMapping = serviceHandler(async (
    roleId: string,
    widgetId: string,
    config: {
        enabled?: boolean;
        display_order?: number;
        height?: number;
        width?: number;
    }
) => {
    // Verify the widget exists
    const widget = await db.widget.findUnique({ where: { id: widgetId } });
    if (!widget) {
        throw new AppError('Widget not found', 404, ErrorCode.NOT_FOUND);
    }

    // Verify the role exists
    const role = await db.role.findUnique({ where: { id: roleId } });
    if (!role) {
        throw new AppError('Role not found', 404, ErrorCode.RBAC_ROLE_NOT_FOUND);
    }

    const mapping = await db.roleWidgetMapping.upsert({
        where: {
            role_id_widget_id: { role_id: roleId, widget_id: widgetId }
        },
        create: {
            role_id: roleId,
            widget_id: widgetId,
            enabled: config.enabled ?? true,
            display_order: config.display_order ?? 0,
            height: config.height ?? 1,
            width: config.width ?? 1,
        },
        update: {
            enabled: config.enabled,
            display_order: config.display_order,
            height: config.height,
            width: config.width,
        },
        include: {
            widget: { select: { id: true, title: true, widget_type: true } }
        }
    });

    return mapping;
});

// ─── Delete Mapping ─────────────────────────────────────────────────────────────

export const deleteMappingById = serviceHandler(async (id: string) => {
    const existing = await db.roleWidgetMapping.findUnique({ where: { id } });
    if (!existing) {
        throw new AppError('Mapping not found', 404, ErrorCode.NOT_FOUND);
    }

    await db.roleWidgetMapping.delete({ where: { id } });
    return { message: 'Mapping deleted successfully' };
});

// ─── Reorder Widgets ────────────────────────────────────────────────────────────

export const reorderWidgets = serviceHandler(async (roleId: string, orderedIds: string[]) => {
    // Bulk update display_order based on array position
    const updates = orderedIds.map((mappingId, index) =>
        db.roleWidgetMapping.update({
            where: { id: mappingId },
            data: { display_order: index }
        })
    );

    await db.$transaction(updates);
    return { message: 'Widget order updated successfully' };
});

// ─── Update Dimensions ──────────────────────────────────────────────────────────

export const updateDimensions = serviceHandler(async (
    mappingId: string,
    height: number,
    width: number
) => {
    const existing = await db.roleWidgetMapping.findUnique({ where: { id: mappingId } });
    if (!existing) {
        throw new AppError('Mapping not found', 404, ErrorCode.NOT_FOUND);
    }

    const mapping = await db.roleWidgetMapping.update({
        where: { id: mappingId },
        data: { height, width }
    });

    return mapping;
});
