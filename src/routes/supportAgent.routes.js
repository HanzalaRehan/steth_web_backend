/**
 * Author(s): 1. Zainab Raza
 * Description: Routes for the customer support agent, mounted at
 *              /api/support by src/server.js.
 *
 *              Chat uses optional auth: the widget must work for signed-out
 *              visitors browsing the catalogue, while a signed-in customer
 *              gets their own orders and points. The agent's tool layer
 *              decides what an unidentified caller may see - the route just
 *              passes on whoever the token says this is.
 *
 * Date created: August 13th, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 13th, 2026
 * Run: Not directly runnable - mounted by src/server.js
 */

const express = require('express');
const router = express.Router();
const supportAgentController = require('../controllers/supportAgent.controller');
const { attachUserIfPresent } = require('../middlewares/auth.middleware');

// Public readiness check for the widget.
router.get('/status', supportAgentController.status);

// Optional auth - never rejects, but a valid token unlocks account answers.
router.post('/chat', attachUserIfPresent, supportAgentController.chat);

module.exports = router;
