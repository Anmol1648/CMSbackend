import { Router } from 'express';
import * as dashboardController from '../controllers/dashboard.controller';

const router = Router();

// User-scoped dashboard widgets
router.get('/widgets', dashboardController.getMyDashboardWidgets);

export default router;
