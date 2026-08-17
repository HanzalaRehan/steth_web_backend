/**
 * Author(s): 1. Zainab Raza
 * Description: Messaging channel webhooks, mounted at /api/channels by
 *              src/server.js.
 *
 *              These are public by necessity - Meta calls them, and Meta has
 *              no Steth account. Authenticity comes from the signature check
 *              in the controller, not from middleware, which is why these
 *              routes carry no auth and must never be given any other purpose.
 *
 * Date created: August 13th, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 13th, 2026
 * Run: Not directly runnable - mounted by src/server.js
 */

const express = require('express');
const router = express.Router();
const whatsappController = require('../controllers/whatsapp.controller');
const instagramController = require('../controllers/instagram.controller');

// Meta's subscription handshake, then the message firehose.
router.get('/whatsapp/webhook', whatsappController.verifyWebhook);
router.post('/whatsapp/webhook', whatsappController.receiveWebhook);

router.get('/instagram/webhook', instagramController.verifyWebhook);
router.post('/instagram/webhook', instagramController.receiveWebhook);

// Diagnostics - reports whether each channel is configured, never any secret.
router.get('/whatsapp/status', whatsappController.status);
router.get('/instagram/status', instagramController.status);

module.exports = router;
