import { Request, Response } from 'express';
import { asyncHandler, successResponse, ErrorCode } from '../../core/index';
import { AppError } from '../../core/errors';
import * as roleWidgetMappingService from './role-widget-mapping.service';
import { db } from '../../db/prisma';

// ─── Dashboard: User-Scoped Widgets ─────────────────────────────────────────────

export const getMyDashboardWidgets = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    const tenantId = req.user?.tenantId;

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
