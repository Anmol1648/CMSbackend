import { Router } from 'express';
import { authenticated } from '../../middlewares/access';
import * as dashboardController from './dashboard.controller';

const router = Router();

// User-scoped dashboard widgets
router.get('/widgets', authenticated, dashboardController.getMyDashboardWidgets);

export default router;
