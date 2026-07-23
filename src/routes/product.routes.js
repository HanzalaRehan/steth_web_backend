const express = require('express');
const router = express.Router();
const { auth, isAdmin } = require('../middlewares/auth.middleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { upload } = require('../middlewares/upload.middleware');
const catchAsync = require('../utils/errorHandler');

const {
    getAllProducts,
    getProduct,
    createProduct,
    updateProduct,
    deleteProduct,
    getProductColorDetails,
    getColorInventory,
    updateInventory,
    uploadDefaultImages,
    uploadColorImages,
    uploadVariantImages,
    setPrimaryColorImage,
    getProductImagesByColor,
    getCustomersAlsoBoughtProducts,
    addToCustomersAlsoBought,
    removeFromCustomersAlsoBought,
    fixStock
} = require('../controllers/product.controller');

// Base product routes
router.get('/', getAllProducts);
router.post('/', auth, isAdmin, createProduct);

// "Customers Also Bought" management (MUST come before `/:id` routes)
router.get('/cob', getCustomersAlsoBoughtProducts);
router.put('/customers-also-bought/add', auth, isAdmin, addToCustomersAlsoBought);
router.put('/customers-also-bought/remove', auth, isAdmin, removeFromCustomersAlsoBought);

// Parameterized routes (must come after static routes)
router.get('/:id', getProduct);
router.put('/:id', auth, isAdmin, updateProduct);
router.delete('/:id', auth, isAdmin, deleteProduct);

// Color-specific routes
router.post('/:id/images/default', auth, isAdmin, upload.array('images', 10), uploadDefaultImages);
router.post('/:id/images/color/:color', auth, isAdmin, upload.array('images', 10), uploadColorImages);
router.post('/:id/images/variant/:color/:gender', auth, isAdmin, upload.array('images', 10), uploadVariantImages);
router.get('/:id/images', getProductImagesByColor);

// Inventory management
router.post('/:id/inventory', auth, isAdmin, updateInventory);

// Primary image management
router.patch('/:id/images/color/:color/:imageId/primary', auth, isAdmin, setPrimaryColorImage);
// In your routes file or controller
router.get('/fix-product/:id', auth, isAdmin, fixStock);

module.exports = router;