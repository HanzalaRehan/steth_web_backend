const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const heroImageController = require('../controllers/heroImageController');
const { auth, isAdmin } = require('../middlewares/auth.middleware');

// Create uploads directory if it doesn't exist
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer for file upload
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

// File filter to only allow images
const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Not an image! Please upload only images.'), false);
    }
};

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
    },
    fileFilter: fileFilter
});

// Error handling middleware for multer
const handleMulterError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: 'File size too large. Maximum size is 10MB.'
            });
        }
        return res.status(400).json({
            success: false,
            message: err.message
        });
    }
    next(err);
};

// Specific page image routes
router.get('/home', heroImageController.getHomePageImages);
router.get('/mens', heroImageController.getMensPageImages);
router.get('/womens', heroImageController.getWomensPageImages);

// Routes for single image upload
router.post('/:pageType/:viewType',
    auth,
    isAdmin,
    upload.single('image'),
    handleMulterError,
    heroImageController.uploadImage
);

// Routes for uploading both web and mobile images for a page
router.post('/:pageType',
    auth,
    isAdmin,
    upload.fields([
        { name: 'webImage', maxCount: 1 },
        { name: 'mobileImage', maxCount: 1 }
    ]),
    handleMulterError,
    heroImageController.uploadPageImages
);

// Get all images
router.get('/', heroImageController.getAllImages);

// Get images by page type
router.get('/:pageType', heroImageController.getImagesByPage);

// Delete image
router.delete('/:pageType/:viewType', auth, isAdmin, heroImageController.deleteImage);

module.exports = router; 