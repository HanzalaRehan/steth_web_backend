const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { auth, authenticateResetToken } = require('../middlewares/auth.middleware'); // Updated import
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { upload } = require('../middlewares/upload.middleware');

// Public routes
router.post('/register', userController.registerUser);
router.post('/login', userController.loginUser);
router.post('/google-auth', userController.googleAuthUser);

// Authenticated user routes
router.get('/profile', auth, userController.profileAccess);
router.get('/profile-admin', userController.profileAccessAdmin);
router.post('/password-update', auth, userController.changePass);
router.put('/update-account', auth, userController.updateAccount);

// Route for updating account with profile picture
router.put('/update-account-with-pic', auth, upload.single('profilePicture'), userController.updateAccount);

// Keep your existing profile picture upload route
router.post('/upload-pic', upload.single('profilePicture'), userController.uploadPicture);

router.post('/password-forgot', userController.forgotPass);
router.post('/verify-otp', userController.verifyOtp);
router.post('/set-new-password', authenticateResetToken, userController.setNewPassword);
router.post('/resend-otp', userController.resendOtp);
router.get('/validate-token', userController.auth);

module.exports = router;
