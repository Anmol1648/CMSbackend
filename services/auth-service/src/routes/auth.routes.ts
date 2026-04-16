import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { validate, loginSchema, refreshSchema } from '../middlewares/validation.middleware';

const router = Router();

router.post('/login', validate(loginSchema), authController.login);
router.post('/refresh', validate(refreshSchema), authController.refresh);

export default router;

