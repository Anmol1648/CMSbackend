import { Router } from 'express';
import * as rbacController from './rbac.controller';
import { authenticated, can } from '../../middlewares/access';

const router = Router();

// My data (logged-in user)
router.get('/my-permissions', authenticated, rbacController.getMyPermissions);
router.get('/my-menus', authenticated, rbacController.getMyMenus);

// Permissions CRUD
router.get('/permissions', can('role.read'), rbacController.getAllPermissions);
router.post('/permissions', can('role.create'), rbacController.createPermission);
router.put('/permissions/:id', can('role.update'), rbacController.updatePermission);
router.delete('/permissions/:id', can('role.delete'), rbacController.deletePermission);

// Menus CRUD
router.get('/menus', can('role.read'), rbacController.getMenus);
router.post('/menus', can('role.create'), rbacController.createMenu);
router.put('/menus/:id', can('role.update'), rbacController.updateMenu);
router.delete('/menus/:id', can('role.delete'), rbacController.deleteMenu);

// Roles CRUD
router.get('/roles', can('role.read'), rbacController.getRoles);
router.post('/roles', can('role.create'), rbacController.createRole);
router.put('/roles/:id', can('role.update'), rbacController.updateRole);
router.delete('/roles/:id', can('role.delete'), rbacController.deleteRole);
router.post('/roles/:id/clone', can('role.create'), rbacController.cloneRole);

// Role Assignments
router.put('/roles/:id/permissions', can('role.update'), rbacController.assignPermissions);
router.put('/roles/:id/menus', can('role.update'), rbacController.assignMenus);
router.get('/roles/:id/menus', can('role.read'), rbacController.getRoleMenus);
router.get('/roles/:id/permissions', can('role.read'), rbacController.getRolePermissions);

// Simulation
router.get('/roles/:id/simulate', can('role.read'), rbacController.simulateRole);

// User Management
router.get('/users', can('user.read'), rbacController.getUsers);
router.get('/users/:userId/roles', can('user.read'), rbacController.getUserRoles);
router.put('/users/:userId/roles', can('role.update'), rbacController.assignRoleToUser);
router.patch('/users/:userId/status', can('user.update'), rbacController.toggleUserStatus);

export default router;
