import { Router, Request, Response, NextFunction } from 'express';
import * as rbacController from '../controllers/rbac.controller';
import { protect } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/rbac.middleware';

const router = Router();

// ─── Internal Gateway Routes ────────────────────────────────────────────────
const internalGuard = (req: Request, res: Response, next: NextFunction) => {
    const secret = process.env.INTERNAL_SECRET || '';
    if (secret && req.headers['x-internal-secret'] !== secret) {
        return res.status(403).json({ error: 'Internal forbidden access' });
    }
    next();
};

router.get('/internal/permissions', internalGuard, rbacController.getInternalPermissions);
router.get('/internal/field-permissions/:modelName', internalGuard, rbacController.getInternalFieldPermissions);

// ─── Protected Routes (JWT required) ────────────────────────────────────────
router.use(protect);

// My data (logged-in user)
router.get('/my-permissions', rbacController.getMyPermissions);
router.get('/my-menus', rbacController.getMyMenus);

// Permissions CRUD
router.get('/permissions', requirePermission('role', 'read'), rbacController.getAllPermissions);
router.post('/permissions', requirePermission('role', 'create'), rbacController.createPermission);
router.put('/permissions/:id', requirePermission('role', 'update'), rbacController.updatePermission);
router.delete('/permissions/:id', requirePermission('role', 'delete'), rbacController.deletePermission);

// Menus CRUD
router.get('/menus', requirePermission('role', 'read'), rbacController.getMenus);
router.post('/menus', requirePermission('role', 'create'), rbacController.createMenu);
router.put('/menus/:id', requirePermission('role', 'update'), rbacController.updateMenu);
router.delete('/menus/:id', requirePermission('role', 'delete'), rbacController.deleteMenu);

// Roles CRUD
router.get('/roles', requirePermission('role', 'read'), rbacController.getRoles);
router.post('/roles', requirePermission('role', 'create'), rbacController.createRole);
router.put('/roles/:id', requirePermission('role', 'update'), rbacController.updateRole);
router.delete('/roles/:id', requirePermission('role', 'delete'), rbacController.deleteRole);
router.post('/roles/:id/clone', requirePermission('role', 'create'), rbacController.cloneRole);

// Role Assignments
router.put('/roles/:id/permissions', requirePermission('role', 'update'), rbacController.assignPermissions);
router.put('/roles/:id/menus', requirePermission('role', 'update'), rbacController.assignMenus);
router.get('/roles/:id/menus', requirePermission('role', 'read'), rbacController.getRoleMenus);
router.get('/roles/:id/permissions', requirePermission('role', 'read'), rbacController.getRolePermissions);

// Simulation
router.get('/roles/:id/simulate', requirePermission('role', 'read'), rbacController.simulateRole);

// User Management
router.get('/users', requirePermission('user', 'read'), rbacController.getUsers);
router.get('/users/:userId/roles', requirePermission('user', 'read'), rbacController.getUserRoles);
router.put('/users/:userId/roles', requirePermission('role', 'update'), rbacController.assignRoleToUser);
router.patch('/users/:userId/status', requirePermission('user', 'update'), rbacController.toggleUserStatus);

export default router;
