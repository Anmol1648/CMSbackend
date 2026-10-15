import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, validationError } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { saveSettings, settingsSnapshot } from '../../core/settings';
import { can } from '../../middlewares/access';

/** System Settings: every module's settings in one generated screen. */

export const settingsRoutes = Router();

settingsRoutes.get('/', can('settings.view'), asyncHandler(async (_req: Request, res: Response) => {
    successResponse(res, await settingsSnapshot(), 'System settings');
}));

const saveInput = z.strictObject({ changes: z.record(z.string(), z.unknown()) });

settingsRoutes.patch('/', can('settings.update'), asyncHandler(async (req: Request, res: Response) => {
    const parsed = saveInput.safeParse(req.body ?? {});
    if (!parsed.success) throw validationError(parsed.error);
    if (!Object.keys(parsed.data.changes).length) throw badRequest('Nothing to save');
    let diff: Record<string, [unknown, unknown]>;
    try {
        diff = await saveSettings(parsed.data.changes, req.user!.userId);
    } catch (err) {
        const issues = (err as { issues?: { field: string; message: string }[] }).issues;
        if (issues) throw badRequest(issues.length === 1 ? `${issues[0].field} ${issues[0].message}` : 'Some settings are not valid', issues);
        throw err;
    }
    if (Object.keys(diff).length) await recordAudit({ action: 'setting_change', entity: 'settings', changes: diff });
    successResponse(res, await settingsSnapshot(), Object.keys(diff).length ? 'Settings saved' : 'Nothing changed');
}));
