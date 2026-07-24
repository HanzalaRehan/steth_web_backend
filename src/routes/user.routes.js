const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { auth, isAdmin, authenticateResetToken } = require('../middlewares/auth.middleware'); // Updated import
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
router.get('/profile-admin', auth, isAdmin, userController.profileAccessAdmin);

// EXTENSION POINT (issue #22 - Rewards redemption mechanics, pending
// finalized program rules from the business side - do not build this
// speculatively). Once rules exist, a redemption endpoint belongs here,
// e.g.:
//   router.post('/redeem-points', auth, userController.redeemPoints);
// It would validate the requested redemption against req.user.rewardPoints
// (same field the shell already reads-only displays via GET /profile
// above) and decrement it - mirroring how order.controller.js's
// createOrder already deducts rewardPoints when points are spent at
// checkout, rather than inventing a second points-spending code path.
router.post('/password-update', auth, userController.changePass);
router.put('/update-account', auth, userController.updateAccount);

// Route for updating account with profile picture
router.put('/update-account-with-pic', auth, upload.single('profilePicture'), userController.updateAccount);

// Keep your existing profile picture upload route
router.post('/upload-pic', auth, isAdmin, upload.single('profilePicture'), userController.uploadPicture);

router.post('/password-forgot', userController.forgotPass);
router.post('/verify-otp', userController.verifyOtp);
router.post('/verify-registration-otp', userController.verifyRegistrationOtp);
router.post('/set-new-password', authenticateResetToken, userController.setNewPassword);
router.post('/resend-otp', userController.resendOtp);
router.get('/validate-token', userController.auth);

module.exports = router;
