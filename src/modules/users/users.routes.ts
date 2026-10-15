import { Router, Request, Response } from 'express';
import { asyncHandler, successResponse } from '../../core/index';
import { validationError } from '../../core/errors';
import { parseListQuery } from '../../core/http/list-query';
import { can } from '../../middlewares/access';
import { createUserSchema, updateUserSchema, userListSpec } from './users.schemas';
import * as users from './user-admin.service';

export const userRoutes = Router();

userRoutes.get('/', can('user.view'), asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await users.listUsers(parseListQuery(req.query, userListSpec)), 'Users');
}));

userRoutes.get('/:id', can('user.view'), asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await users.getUser(req.params.id), 'User');
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
