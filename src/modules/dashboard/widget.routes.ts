import { Router } from 'express';
import { hasRole } from '../../middlewares/access';
import * as widgetController from './widget.controller';

const router = Router();

// Widget CRUD
router.get('/', hasRole('super-admin'), widgetController.getAllWidgets);
router.get('/:id', hasRole('super-admin'), widgetController.getWidgetById);
router.post('/', hasRole('super-admin'), widgetController.createWidget);
router.put('/:id', hasRole('super-admin'), widgetController.updateWidget);
router.delete('/:id', hasRole('super-admin'), widgetController.deleteWidget);

// Preview endpoint
router.post('/preview', hasRole('super-admin'), widgetController.previewQuery);

export default router;
