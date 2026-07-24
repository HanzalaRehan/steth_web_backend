const express = require('express');
const router = express.Router();
const analyticsDashboardController = require('../controllers/analyticsDashboard.controller');
const { auth, authorize } = require('../middlewares/auth.middleware');

// Marketing dashboard - gated to Admin + Marketer (B.3), reusing the
// existing generic authorize() role gate rather than a new middleware.
const marketingGate = [auth, authorize('admin', 'marketer')];

router.get('/kpis', marketingGate, analyticsDashboardController.getKpis);
router.get('/funnel', marketingGate, analyticsDashboardController.getFunnel);
router.get('/top-pages', marketingGate, analyticsDashboardController.getTopPages);
router.get('/top-searches', marketingGate, analyticsDashboardController.getTopSearches);
router.get('/replay-sessions', marketingGate, analyticsDashboardController.getReplaySessions);
router.get('/sessions/:sessionId/replay', marketingGate, analyticsDashboardController.getReplayForSession);

module.exports = router;
