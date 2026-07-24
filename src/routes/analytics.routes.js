const express = require('express');
const router = express.Router();
const { analyticsController } = require('../controllers/analytics.controller');

// Public, cookie-identified ingestion endpoints - no auth required since
// most traffic is anonymous. Never block or 500 the caller (see controller).
router.post('/events', analyticsController.ingestEvents);
router.post('/replay', analyticsController.ingestReplay);

module.exports = router;
