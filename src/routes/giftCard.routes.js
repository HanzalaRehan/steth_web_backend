const express = require('express');
const router = express.Router();
const { purchaseGiftCard, validateGiftCard } = require('../controllers/giftCard.controller');

// Both public - purchase is guest-accessible (basic version, no auth wiring
// yet - see giftCard.controller.js), validate is a read-only balance/status
// check the checkout flow needs before an order exists.
router.post('/purchase', purchaseGiftCard);
router.post('/validate', validateGiftCard);

module.exports = router;
