const express = require('express');
const router = express.Router();
const discountCodeController = require('../controllers/discountCode.controller');
const { auth, isAdmin } = require('../middlewares/auth.middleware');

router.get('/', auth, isAdmin, discountCodeController.getAllDiscountCodes);
router.post('/', auth, isAdmin, discountCodeController.createDiscountCode);
router.put('/:id', auth, isAdmin, discountCodeController.updateDiscountCode);
router.delete('/:id', auth, isAdmin, discountCodeController.deleteDiscountCode);

module.exports = router;
