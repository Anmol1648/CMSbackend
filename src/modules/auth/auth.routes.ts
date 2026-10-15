import { Router } from 'express';
import * as authController from './auth.controller';
import { validate, loginSchema, refreshSchema, forgotPasswordSchema, resetPasswordSchema } from '../../middlewares/validate';
import { authenticated, publicRoute } from '../../middlewares/access';
import { createRateLimiter } from '../../middlewares/rate-limit';

const router = Router();

const loginLimiter = createRateLimiter({ windowInMinutes: 15, maxAttempts: 10, keyPrefix: 'auth' });
const mfaLimiter = createRateLimiter({ windowInMinutes: 15, maxAttempts: 5, keyPrefix: 'mfa' });
const forgotPasswordLimiter = createRateLimiter({ windowInMinutes: 60, maxAttempts: 3, keyPrefix: 'forgot-password' });
const resetPasswordLimiter = createRateLimiter({ windowInMinutes: 15, maxAttempts: 5, keyPrefix: 'reset-password' });

router.post('/login', publicRoute, loginLimiter, validate(loginSchema), authController.login);
router.post('/refresh', publicRoute, validate(refreshSchema), authController.refresh);
router.post('/forgot-password', publicRoute, forgotPasswordLimiter, validate(forgotPasswordSchema), authController.forgotPassword);
router.post('/reset-password', publicRoute, resetPasswordLimiter, validate(resetPasswordSchema), authController.resetPassword);
router.post('/mfa/verify', publicRoute, mfaLimiter, authController.verifyMfa);

// Protected routes
router.post('/logout', authenticated, authController.logout);
router.post('/logout-all', authenticated, authController.logoutAll);

export default router;
