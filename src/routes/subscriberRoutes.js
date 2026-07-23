const express = require('express');
const multer = require('multer');
const subscriberController = require('../controllers/subscriberController');
const { auth, isAdmin } = require('../middlewares/auth.middleware');

const router = express.Router();

// Configure multer for handling file uploads (memory storage - no disk storage)
const upload = multer({
  storage: multer.memoryStorage(), // Store files in memory temporarily
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit per file
    files: 10 // Maximum 10 files
  },
  fileFilter: (req, file, cb) => {
    // Only allow image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// Add new subscriber
router.post('/subscribe', subscriberController.addSubscriber);

// Send bulk email to all subscribers (with optional image attachments)
router.post('/send-bulk-email', auth, isAdmin, upload.array('images', 10), subscriberController.sendBulkEmail);

module.exports = router;