const express = require('express');
const router = express.Router();
const affiliateController = require('../controllers/affiliate.controller');
const { auth, isAdmin } = require('../middlewares/auth.middleware');

router.get('/requests', auth, isAdmin, affiliateController.getAllRequests);
router.post('/requests', auth, isAdmin, affiliateController.createRequest);
router.post('/requests/:id/approve', auth, isAdmin, affiliateController.approveRequest);
router.post('/requests/:id/reject', auth, isAdmin, affiliateController.rejectRequest);

router.get('/partners', auth, isAdmin, affiliateController.getAllPartners);
router.put('/partners/:id/status', auth, isAdmin, affiliateController.updatePartnerStatus);

module.exports = router;
