// studentVerification.routes.js
const express = require('express');
const router = express.Router();
const { auth, isAdmin } = require('../middlewares/auth.middleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const studentVerificationController = require('../controllers/studentVerification.controller');
const { upload } = require('../middlewares/upload.middleware');

// Student verification routes
router.post('/submit', auth, upload.single('studentIdImage'), studentVerificationController.submitVerification);
router.get('/status', auth, studentVerificationController.checkVerificationStatus);

// Admin routes for managing verification requests
router.get('/pending', auth, isAdmin, studentVerificationController.getPendingVerifications);
router.post('/:verificationId/approve', auth, isAdmin, studentVerificationController.approveVerification);
router.post('/:verificationId/reject', auth, isAdmin, studentVerificationController.rejectVerification);

module.exports = router;