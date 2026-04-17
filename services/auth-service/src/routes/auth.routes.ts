import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { validate, loginSchema, refreshSchema, forgotPasswordSchema, resetPasswordSchema } from '../middlewares/validation.middleware';
import { protect } from '../middlewares/auth.middleware';

const router = Router();

router.post('/login', validate(loginSchema), authController.login);
router.post('/refresh', validate(refreshSchema), authController.refresh);
router.post('/forgot-password', validate(forgotPasswordSchema), authController.forgotPassword);
router.post('/reset-password', validate(resetPasswordSchema), authController.resetPassword);
router.post('/mfa/verify', authController.verifyMfa);

// Protected routes
router.post('/logout', protect, authController.logout);
router.post('/logout-all', protect, authController.logoutAll);

export default router;


