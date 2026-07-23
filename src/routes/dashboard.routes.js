const express = require('express');
const router = express.Router();
const orderController = require('../controllers/order.controller');
const productController = require('../controllers/product.controller');
const { auth, isAdmin } = require('../middlewares/auth.middleware');

router.get('/stats', auth, isAdmin, orderController.getOrderStats);
router.get('/bestselling', auth, isAdmin, orderController.getBestSellingProducts);
router.get('/student-verifications', auth, isAdmin, orderController.getRecentStudentVerifications);
router.get('/product-stats', auth, isAdmin, productController.getProductStats);

module.exports = router;