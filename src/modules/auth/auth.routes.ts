import { Router } from 'express';
import * as authController from './auth.controller';
import { validate, loginSchema, refreshSchema, forgotPasswordSchema, resetPasswordSchema } from '../../middlewares/validate';
import { authenticate } from '../../middlewares/authenticate';
import { createRateLimiter } from '../../middlewares/rate-limit';

const router = Router();

const loginLimiter = createRateLimiter({ windowInMinutes: 15, maxAttempts: 10, keyPrefix: 'auth' });
const mfaLimiter = createRateLimiter({ windowInMinutes: 15, maxAttempts: 5, keyPrefix: 'mfa' });
const forgotPasswordLimiter = createRateLimiter({ windowInMinutes: 60, maxAttempts: 3, keyPrefix: 'forgot-password' });
const resetPasswordLimiter = createRateLimiter({ windowInMinutes: 15, maxAttempts: 5, keyPrefix: 'reset-password' });

router.post('/login', loginLimiter, validate(loginSchema), authController.login);
router.post('/refresh', validate(refreshSchema), authController.refresh);
router.post('/forgot-password', forgotPasswordLimiter, validate(forgotPasswordSchema), authController.forgotPassword);
router.post('/reset-password', resetPasswordLimiter, validate(resetPasswordSchema), authController.resetPassword);
router.post('/mfa/verify', mfaLimiter, authController.verifyMfa);

// Protected routes
router.post('/logout', authenticate, authController.logout);
router.post('/logout-all', authenticate, authController.logoutAll);

export default router;
