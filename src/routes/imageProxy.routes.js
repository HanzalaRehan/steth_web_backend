const express = require('express');
const router = express.Router();
const { auth, isAdmin } = require('../middlewares/auth.middleware');
const { proxyImage } = require('../controllers/imageProxy.controller');

// Used by the admin Student Approval screen to display a proof-of-enrollment
// document image without a browser CORS failure. Admin-only: these documents
// are student PII.
router.get('/', auth, isAdmin, proxyImage);

module.exports = router;
