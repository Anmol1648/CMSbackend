import { Request, Response } from 'express';
import { asyncHandler, successResponse } from '@shared/core';
import * as widgetService from '../services/widget.service';
import * as roleWidgetMappingService from '../services/roleWidgetMapping.service';

// ─── Widget CRUD ────────────────────────────────────────────────────────────────

export const getAllWidgets = asyncHandler(async (req: Request, res: Response) => {
    const { widget_type, sub_type, is_active } = req.query;

    const filters: any = {};
    if (widget_type) filters.widget_type = widget_type as string;
    if (sub_type) filters.sub_type = sub_type as string;
    if (is_active !== undefined) filters.is_active = is_active === 'true';

    const widgets = await widgetService.getAllWidgets(filters);
    return successResponse(res, widgets, 'Widgets retrieved');
});

export const getWidgetById = asyncHandler(async (req: Request, res: Response) => {
    const widget = await widgetService.getWidgetById(req.params.id);
    return successResponse(res, widget, 'Widget retrieved');
});

export const createWidget = asyncHandler(async (req: Request, res: Response) => {
    const widget = await widgetService.createWidget(req.body);
    return successResponse(res, widget, 'Widget created successfully', 201);
});

export const updateWidget = asyncHandler(async (req: Request, res: Response) => {
    const widget = await widgetService.updateWidget(req.params.id, req.body);
    return successResponse(res, widget, 'Widget updated successfully');
});

export const deleteWidget = asyncHandler(async (req: Request, res: Response) => {
    const result = await widgetService.deleteWidget(req.params.id);
    return successResponse(res, result, result.message);
});

export const previewQuery = asyncHandler(async (req: Request, res: Response) => {
    const { query, params, range } = req.body;

    if (!query || typeof query !== 'string') {
        return res.status(400).json({
            status: 'error',
            error: { code: 'VALIDATION_ERROR', message: 'Query string is required' },
            timestamp: new Date().toISOString()
        });
    }

    const result = await widgetService.previewWidgetQuery(query, params, range);
    return successResponse(res, result, 'Query executed successfully');
});

// ─── Role Widget Mapping ────────────────────────────────────────────────────────

export const getMappingsForRole = asyncHandler(async (req: Request, res: Response) => {
    const mappings = await roleWidgetMappingService.getMappingsForRole(req.params.roleId);
    return successResponse(res, mappings, 'Role widget mappings retrieved');
});

export const upsertMapping = asyncHandler(async (req: Request, res: Response) => {
    const { role_id, widget_id, ...config } = req.body;
    const mapping = await roleWidgetMappingService.upsertMapping(role_id, widget_id, config);
    return successResponse(res, mapping, 'Mapping saved successfully');
});

export const updateMapping = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { enabled, height, width, display_order } = req.body;

    // If dimensions are being updated
    if (height !== undefined && width !== undefined) {
        const mapping = await roleWidgetMappingService.updateDimensions(id, height, width);
        return successResponse(res, mapping, 'Mapping dimensions updated');
    }

    // Otherwise do a generic upsert-style update via the mapping record
    const existing = await (await import('../models/prisma')).db.roleWidgetMapping.findUnique({ where: { id } });
    if (!existing) {
        return res.status(404).json({
            status: 'error',
            error: { code: 'NOT_FOUND', message: 'Mapping not found' },
            timestamp: new Date().toISOString()
        });
    }

    const mapping = await (await import('../models/prisma')).db.roleWidgetMapping.update({
        where: { id },
        data: { enabled, height, width, display_order }
    });

    return successResponse(res, mapping, 'Mapping updated');
});

export const reorderWidgets = asyncHandler(async (req: Request, res: Response) => {
    const { role_id, ordered_ids } = req.body;
    const result = await roleWidgetMappingService.reorderWidgets(role_id, ordered_ids);
    return successResponse(res, result, result.message);
});

export const deleteMapping = asyncHandler(async (req: Request, res: Response) => {
    const result = await roleWidgetMappingService.deleteMappingById(req.params.id);
    return successResponse(res, result, result.message);
});
