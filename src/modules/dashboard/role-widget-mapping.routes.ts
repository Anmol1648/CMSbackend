import { Router } from 'express';
import { hasRole } from '../../middlewares/access';
import * as widgetController from './widget.controller';

const router = Router();

// Role Widget Mapping routes
router.get('/role/:roleId', hasRole('super-admin'), widgetController.getMappingsForRole);
router.post('/', hasRole('super-admin'), widgetController.upsertMapping);
router.put('/:id', hasRole('super-admin'), widgetController.updateMapping);
router.post('/reorder', hasRole('super-admin'), widgetController.reorderWidgets);
router.delete('/:id', hasRole('super-admin'), widgetController.deleteMapping);

export default router;
