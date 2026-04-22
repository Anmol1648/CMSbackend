import { Router } from 'express';
import * as widgetController from '../controllers/widget.controller';

const router = Router();

// Widget CRUD
router.get('/', widgetController.getAllWidgets);
router.get('/:id', widgetController.getWidgetById);
router.post('/', widgetController.createWidget);
router.put('/:id', widgetController.updateWidget);
router.delete('/:id', widgetController.deleteWidget);

// Preview endpoint
router.post('/preview', widgetController.previewQuery);

export default router;
