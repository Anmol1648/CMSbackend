import { Router } from 'express';
import * as widgetController from '../controllers/widget.controller';

const router = Router();

// Role Widget Mapping routes
router.get('/role/:roleId', widgetController.getMappingsForRole);
router.post('/', widgetController.upsertMapping);
router.put('/:id', widgetController.updateMapping);
router.post('/reorder', widgetController.reorderWidgets);
router.delete('/:id', widgetController.deleteMapping);

export default router;
