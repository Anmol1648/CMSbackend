import { Request, Response } from 'express';
import { asyncHandler, successResponse, ErrorCode } from '@shared/core';
import { AppError } from '../utils/errors';
import * as roleWidgetMappingService from '../services/roleWidgetMapping.service';
import { db } from '../models/prisma';

// ─── Dashboard: User-Scoped Widgets ─────────────────────────────────────────────

export const getMyDashboardWidgets = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user?.userId || req.headers['x-user-id'] as string;
    const tenantId = (req as any).user?.tenantId || req.headers['x-tenant-id'] as string;

    if (!userId || !tenantId) {
        throw new AppError('Missing user or tenant context', 400, ErrorCode.VALIDATION_ERROR);
    }

    // Get user's role IDs
    const userRoles = await db.userRole.findMany({
        where: { user_id: userId, tenant_id: { in: [tenantId, 'system'] } },
        select: { role_id: true }
    });

    const roleIds = userRoles.map(ur => ur.role_id);
    const widgets = await roleWidgetMappingService.getWidgetsForUser(userId, roleIds);

    return successResponse(res, widgets, 'Dashboard widgets retrieved');
});
