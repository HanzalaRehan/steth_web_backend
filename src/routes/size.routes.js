/**
 * Author(s): 1. Zainab Raza
 * Description: Routes for the size recommendation feature, mounted at
 *              /api/size by src/server.js.
 *
 *              Two customer-facing entry points share one engine:
 *                POST /recommend - "What's My Size?", public. Uses optional
 *                                  auth so guests get an instant answer while
 *                                  logged-in customers also get it saved.
 *                POST /quiz      - "Take the Size Quiz", authenticated. Same
 *                                  answer, plus one-time loyalty points.
 *
 *              Plus the supporting endpoints: the published chart for the
 *              storefront to render, the customer's saved profile, and fit /
 *              exchange feedback capture.
 *
 * Date created: August 3rd, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 3rd, 2026
 * Run: Not directly runnable - mounted by src/server.js
 */

const express = require('express');
const router = express.Router();
const sizeController = require('../controllers/size.controller');
const { auth, attachUserIfPresent } = require('../middlewares/auth.middleware');

// Public - the storefront renders the same chart the engine sizes against.
router.get('/chart', sizeController.getSizeChart);

// Public with optional auth: never rejects, but a valid token means the
// result is persisted to the customer's size profile. Awards no points.
router.post('/recommend', attachUserIfPresent, sizeController.whatsMySize);

// Authenticated - always persists and pays the one-time completion bonus.
router.post('/quiz', auth, sizeController.submitSizeQuiz);

// Authenticated - the customer's saved size and the data gathered on them.
router.get('/profile', auth, sizeController.getMySizeProfile);

// Authenticated - ground-truth fit outcomes and wrong-size exchanges. This is
// the training data for the model that will eventually replace the rules.
router.post('/fit-feedback', auth, sizeController.submitFitFeedback);

module.exports = router;
