import { Router } from 'express';
import * as userController from './user.controller';
import { authenticated } from '../../middlewares/access';
import { validate, changePasswordSchema } from '../../middlewares/validate';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.get('/profile', authenticated, userController.getProfile);
router.put('/profile', authenticated, userController.updateProfile);
router.post('/profile/avatar', authenticated, upload.single('avatar'), userController.updateAvatar);
router.post('/change-password', authenticated, validate(changePasswordSchema), userController.changePassword);

// MFA Routes
router.post('/mfa/setup', authenticated, userController.setupMfa);
router.post('/mfa/enable', authenticated, userController.enableMfa);
router.post('/mfa/disable', authenticated, userController.disableMfa);

export default router;

