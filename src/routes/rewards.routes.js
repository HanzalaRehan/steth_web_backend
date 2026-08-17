/**
 * Author(s): 1. Zainab Raza
 * Description: Routes for the loyalty programme, mounted at /api/rewards by
 *              src/server.js.
 *
 *              The catalogue is public so the rewards landing page can render
 *              for signed-out visitors; everything that touches a balance
 *              requires auth. The config view is admin-only because it
 *              exposes the provisional values still pending business sign-off.
 *
 * Date created: August 3rd, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 3rd, 2026
 * Run: Not directly runnable - mounted by src/server.js
 */

const express = require('express');
const router = express.Router();
const rewardsController = require('../controllers/rewards.controller');
const { auth, isAdmin } = require('../middlewares/auth.middleware');

// Public - the "ways to earn" grid on the rewards page.
router.get('/catalogue', rewardsController.getCatalogue);

// Authenticated customer endpoints.
router.get('/me', auth, rewardsController.getMyRewards);
router.post('/claim', auth, rewardsController.claimReward);
router.post('/sync', auth, rewardsController.syncRewards);
router.post('/birthday', auth, rewardsController.setDateOfBirth);

// WhatsApp number ownership - the gate on both marketing consent and on
// matching an inbound WhatsApp message to this account.
router.post('/whatsapp/verify/start', auth, rewardsController.startWhatsappVerification);
router.post('/whatsapp/verify/confirm', auth, rewardsController.confirmWhatsappVerification);

// Admin - current values plus what still needs a business decision.
router.get('/config', auth, isAdmin, rewardsController.getConfig);

module.exports = router;
