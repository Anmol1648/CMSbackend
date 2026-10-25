import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { validationError } from '../../core/errors';
import { parseListQuery } from '../../core/http/list-query';
import { sendFile } from '../../core/http/files';
import { getSetting } from '../../core/settings';
import { UPLOADS } from '../../core/files';
import { XLSX_MIME } from '../../core/excel';
import { authenticated, can } from '../../middlewares/access';
import { masterValueListSpec, moveSchema } from './masters.schemas';
import * as masters from './masters.service';

export const masterRoutes = Router();

/** Every list, grouped, with counts and whether I may change it. */
masterRoutes.get('/', can('masters.view'), asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await masters.masterCatalogue(req.user!.userId), 'Master lists');
}));

const optionsQuery = z.object({
    parent: z.uuid().optional(),
    include: z
        .string()
        .optional()
        .transform((s) => (s ? s.split(',').filter(Boolean) : []))
        .pipe(z.array(z.uuid()).max(50)),
});

/** Dropdown options for any form (every signed-in user). */
masterRoutes.get('/:key/options', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const q = optionsQuery.safeParse(req.query);
    if (!q.success) throw validationError(q.error);
    successResponse(res, await masters.listOptions(req.params.key, { parentId: q.data.parent, include: q.data.include }), 'Options');
}));

masterRoutes.get('/:key/values', can('masters.view'), asyncHandler(async (req: Request, res: Response) => {
    masters.masterDef(req.params.key);
    successResponse(res, await masters.listValues(req.params.key, parseListQuery(req.query, masterValueListSpec)), 'Options');
}));

masterRoutes.get('/:key/export', can('masters.view'), asyncHandler(async (req: Request, res: Response) => {
    const def = masters.masterDef(req.params.key);
    const q = parseListQuery({ ...req.query, page: '1', pageSize: '1' }, masterValueListSpec);
    const data = await masters.exportValues(def.key, q, await getSetting(UPLOADS.maxExportRows));
    sendFile(res, `${def.key}-${new Date().toISOString().slice(0, 10)}.xlsx`, XLSX_MIME, data);
}));

masterRoutes.get('/:key/values/:id', can('masters.view'), asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await masters.getValue(masters.masterDef(req.params.key).key, req.params.id), 'Option');
}));

// Changing a list needs that list's permission (masters.manage unless the list names another one).
const manage = async (req: Request) => {
    const def = masters.masterDef(req.params.key);
    await masters.assertCanManage(def, req.user!.userId);
    return def;
};

masterRoutes.post('/:key/values', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const def = await manage(req);
    successResponse(res, await masters.createValue(def.key, masters.parseValueInput(req.body)), 'Option added', 201);
}));

masterRoutes.patch('/:key/values/:id', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const def = await manage(req);
    successResponse(res, await masters.updateValue(def.key, req.params.id, masters.parseValueInput(req.body)), 'Option saved');
}));

masterRoutes.post('/:key/values/:id/move', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const def = await manage(req);
    const body = moveSchema.safeParse(req.body ?? {});
    if (!body.success) throw validationError(body.error);
    successResponse(res, await masters.moveValue(def.key, req.params.id, body.data), 'Option moved');
}));

masterRoutes.delete('/:key/values/:id', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const def = await manage(req);
    successResponse(res, await masters.deleteValue(def.key, req.params.id), 'Option deleted');
}));
