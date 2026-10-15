import { Router } from 'express';
import * as userController from './user.controller';
import { authenticate } from '../../middlewares/authenticate';
import { validate, changePasswordSchema } from '../../middlewares/validate';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.get('/profile', authenticate, userController.getProfile);
router.put('/profile', authenticate, userController.updateProfile);
router.post('/profile/avatar', authenticate, upload.single('avatar'), userController.updateAvatar);
router.post('/change-password', authenticate, validate(changePasswordSchema), userController.changePassword);

// MFA Routes
router.post('/mfa/setup', authenticate, userController.setupMfa);
router.post('/mfa/enable', authenticate, userController.enableMfa);
router.post('/mfa/disable', authenticate, userController.disableMfa);

export default router;

