import { Router, Request, Response } from 'express';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, validationError } from '../../core/errors';
import { parseListQuery } from '../../core/http/list-query';
import { authenticated, can } from '../../middlewares/access';
import { createUserSchema, updateUserSchema, userListSpec } from './users.schemas';
import * as users from './user-admin.service';
import { getSetting } from '../../core/settings';
import { UPLOADS } from '../../core/files';
import { XLSX_MIME } from '../../core/excel';
import { sendFile, upload } from '../../core/http/files';
import { readAvatar, removeAvatar, setAvatar } from './avatar';
import './users.import';

export const userRoutes = Router();

userRoutes.get('/', can('user.view'), asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await users.listUsers(parseListQuery(req.query, userListSpec)), 'Users');
}));

userRoutes.get('/export', can('user.view'), asyncHandler(async (req: Request, res: Response) => {
    const q = parseListQuery({ ...req.query, page: '1', pageSize: '1' }, userListSpec);
    const data = await users.exportUsers(q, await getSetting(UPLOADS.maxExportRows));
    sendFile(res, `users-${new Date().toISOString().slice(0, 10)}.xlsx`, XLSX_MIME, data);
}));

userRoutes.get('/:id', can('user.view'), asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await users.getUser(req.params.id), 'User');
}));

// Photos: anyone signed in at the school may see them; changing one is part of editing the user.
userRoutes.get('/:id/avatar', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const { file, data } = await readAvatar(req.params.id);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true, cacheSeconds: 86_400 });
}));

userRoutes.post('/:id/avatar', can('user.update'), upload.single('image'), asyncHandler(async (req: Request, res: Response) => {
    const target = await users.getUser(req.params.id);
    await users.guardSuperAdminChanges(req.user!.userId, undefined, target.isSuperAdmin && target.id !== req.user!.userId);
    if (!req.file) throw badRequest('Choose a photo (PNG, JPG or WebP)');
    successResponse(res, { avatarUrl: await setAvatar(target.id, { data: req.file.buffer, originalName: req.file.originalname }) }, 'Photo saved');
}));

userRoutes.delete('/:id/avatar', can('user.update'), asyncHandler(async (req: Request, res: Response) => {
    const target = await users.getUser(req.params.id);
    await users.guardSuperAdminChanges(req.user!.userId, undefined, target.isSuperAdmin && target.id !== req.user!.userId);
    successResponse(res, { avatarUrl: await removeAvatar(target.id) }, 'Photo removed');
}));

userRoutes.post('/', can('user.create'), asyncHandler(async (req: Request, res: Response) => {
    const parsed = createUserSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw validationError(parsed.error);
    successResponse(res, await users.createUser(parsed.data, req.user!.userId), 'User created', 201);
}));

userRoutes.patch('/:id', can('user.update'), asyncHandler(async (req: Request, res: Response) => {
    const parsed = updateUserSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw validationError(parsed.error);
    successResponse(res, await users.updateUser(req.params.id, parsed.data, req.user!.userId), 'User saved');
}));

userRoutes.post('/:id/reset-password', can('user.reset_password'), asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await users.resetUserPassword(req.params.id, req.user!.userId), 'New one-time password created');
}));

userRoutes.post('/:id/unlock', can('user.reset_password'), asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await users.unlockUser(req.params.id, req.user!.userId), 'Account unlocked');
}));

userRoutes.post('/:id/reset-mfa', can('user.reset_password'), asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await users.resetUserMfa(req.params.id, req.user!.userId), 'Two-step sign-in turned off');
}));
