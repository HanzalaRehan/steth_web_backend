/**
 * Author(s): 1. Zainab Raza
 * Description: Controller for the size recommendation feature. Serves both
 *              customer-facing entry points, which are deliberately the same
 *              engine with different wrappers:
 *
 *                "What's My Size?"  -> POST /api/size/recommend
 *                     Public and stateless-friendly. Answers instantly for
 *                     guests; if a logged-in customer calls it, the answer is
 *                     saved to their profile too. No points.
 *
 *                "Take the Size Quiz" -> POST /api/size/quiz
 *                     Authenticated. Same inputs, same engine, same answer,
 *                     but it always persists and pays out loyalty points the
 *                     first time a customer completes it.
 *
 *              The remaining endpoints are the data-collection half that the
 *              future recommendation model will train on: the saved profile
 *              (with the sizes the customer actually orders, aggregated from
 *              their order history) and fit feedback / exchange reporting.
 *
 *              Points handling follows the existing reward-points convention -
 *              User.rewardPoints is the single balance field, exactly as
 *              order.controller.js already credits and debits it. No second
 *              points ledger is introduced here.
 *
 *              Key functions:
 *                - getSizeChart      : GET  /api/size/chart
 *                - whatsMySize       : POST /api/size/recommend
 *                - submitSizeQuiz    : POST /api/size/quiz
 *                - getMySizeProfile  : GET  /api/size/profile
 *                - submitFitFeedback : POST /api/size/fit-feedback
 *
 * Date created: August 3rd, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 3rd, 2026
 * Run: Not directly runnable - mounted by src/routes/size.routes.js
 */

const SizeProfile = require('../models/sizeProfile.model');
const User = require('../models/user.model');
const Order = require('../models/order.model');
const { catchAsync } = require('../utils/errorHandler');
const { SIZES, TOP_CHART, PANTS_CHART, PANTS_LENGTH_ADJUSTMENT_INCHES } = require('../utils/sizeChart');
const { recommendSize, FIT_PREFERENCES } = require('../utils/sizeRecommendation');

// Loyalty points paid for completing the size quiz, once per customer.
// Kept as a named constant rather than an inline number because the rewards
// programme rules are still being finalised on the business side (issue #22) -
// when they land, this is the one line to change.
const SIZE_QUIZ_REWARD_POINTS = 50;

// Tag written onto every recommendation this version of the code produces, so
// rule-era rows stay distinguishable once a trained model starts writing here.
const ENGINE_VERSION = 'rules-v1';

// Measurement inputs accepted from the request body, and the sane bounds they
// have to fall inside. Anything outside these is a typo (cm entered instead of
// inches, lbs instead of kg) and is rejected with a clear message rather than
// silently producing a nonsense size.
const MEASUREMENT_BOUNDS = {
    chest: { min: 20, max: 80, label: 'Chest' },
    waist: { min: 18, max: 80, label: 'Waist' },
    hip: { min: 20, max: 80, label: 'Hip' },
    heightInches: { min: 36, max: 90, label: 'Height' },
    weightKg: { min: 25, max: 250, label: 'Weight' }
};

/**
 * Pulls the measurement fields out of a request body, coercing to numbers and
 * dropping anything absent. Returns validation errors instead of throwing so
 * the caller decides the response shape.
 * @param {Object} body - Raw req.body.
 * @returns {Object} { measurements, errors } - errors is an array of strings.
 */
const parseMeasurements = (body = {}) => {
    const measurements = {};
    const errors = [];

    Object.keys(MEASUREMENT_BOUNDS).forEach((field) => {
        const raw = body[field];
        if (raw === undefined || raw === null || raw === '') return;

        const value = Number(raw);
        const { min, max, label } = MEASUREMENT_BOUNDS[field];

        if (Number.isNaN(value)) {
            errors.push(`${label} must be a number.`);
            return;
        }
        if (value < min || value > max) {
            errors.push(`${label} must be between ${min} and ${max}.`);
            return;
        }
        measurements[field] = value;
    });

    return { measurements, errors };
};

/**
 * Runs the engine and shapes the result for storage. Shared by both entry
 * points so "What's My Size?" and the quiz can never diverge.
 * @param {Object} measurements - Validated measurement values.
 * @param {String} fitPreference - 'regular' or 'loose'.
 * @param {String} source - 'quiz' or 'whats-my-size'.
 * @returns {Object} Recommendation payload plus source/engineVersion metadata.
 */
const buildRecommendation = (measurements, fitPreference, source) => {
    const recommendation = recommendSize({ ...measurements, fitPreference });
    return { ...recommendation, source, engineVersion: ENGINE_VERSION };
};

/**
 * Upserts a customer's size profile: refreshes `latest` and appends to the
 * append-only submissions log.
 * @param {ObjectId} userId - Owning user.
 * @param {Object} measurements - Validated measurement values.
 * @param {Object} recommendation - Result of buildRecommendation.
 * @returns {Promise<Object>} The saved SizeProfile document.
 */
const saveSubmission = async (userId, measurements, recommendation) => {
    const submittedAt = new Date();

    return SizeProfile.findOneAndUpdate(
        { user: userId },
        {
            $set: {
                latest: { measurements, recommendation, updatedAt: submittedAt }
            },
            $push: {
                submissions: { measurements, recommendation, submittedAt }
            }
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );
};

/**
 * Pays the one-time quiz completion bonus. Idempotent: the quizCompleted flag
 * on the profile is the guard, so replaying the endpoint tops up nothing.
 * @param {Object} profile - The customer's SizeProfile document.
 * @param {ObjectId} userId - Owning user.
 * @returns {Promise<Object>} { pointsAwarded, alreadyCompleted, totalPoints }
 */
const awardQuizPoints = async (profile, userId) => {
    if (profile.quizCompleted) {
        const user = await User.findById(userId).select('rewardPoints');
        return {
            pointsAwarded: 0,
            alreadyCompleted: true,
            totalPoints: user ? user.rewardPoints : 0
        };
    }

    // Mirrors how order.controller.js credits points - increment the single
    // User.rewardPoints balance rather than introducing a parallel ledger.
    const user = await User.findByIdAndUpdate(
        userId,
        { $inc: { rewardPoints: SIZE_QUIZ_REWARD_POINTS } },
        { new: true }
    ).select('rewardPoints');

    profile.quizCompleted = true;
    profile.quizPointsAwarded = SIZE_QUIZ_REWARD_POINTS;
    profile.quizCompletedAt = new Date();
    await profile.save();

    return {
        pointsAwarded: SIZE_QUIZ_REWARD_POINTS,
        alreadyCompleted: false,
        totalPoints: user ? user.rewardPoints : SIZE_QUIZ_REWARD_POINTS
    };
};

/**
 * Counts which sizes a customer actually buys, straight from their delivered
 * and in-flight orders. Derived on read instead of denormalised onto the
 * profile so it can never fall out of sync with the orders themselves, and so
 * historical orders placed before this feature existed are included for free.
 * @param {ObjectId} userId - Owning user.
 * @returns {Promise<Object>} { totalItems, bySize, mostOrderedSize }
 */
const getOrderedSizeStats = async (userId) => {
    const rows = await Order.aggregate([
        { $match: { user: userId, orderStatus: { $ne: 'Cancelled' } } },
        { $unwind: '$items' },
        { $group: { _id: '$items.size', count: { $sum: '$items.quantity' } } },
        { $sort: { count: -1 } }
    ]);

    const bySize = rows.reduce((acc, row) => {
        if (row._id) acc[row._id] = row.count;
        return acc;
    }, {});

    return {
        totalItems: rows.reduce((sum, row) => sum + row.count, 0),
        bySize,
        mostOrderedSize: rows.length && rows[0]._id ? rows[0]._id : null
    };
};

/**
 * GET /api/size/chart
 * Serves the published size charts so the storefront renders the same numbers
 * the engine sizes against, instead of hardcoding them in the frontend.
 */
exports.getSizeChart = catchAsync(async (req, res) => {
    res.status(200).json({
        success: true,
        data: {
            sizes: SIZES,
            top: TOP_CHART,
            pants: PANTS_CHART,
            unit: 'inches',
            // Served so the form can bound its own inputs to exactly what this
            // API accepts. Duplicating these numbers in the frontend would let
            // the two drift, and the customer would meet a rejection the form
            // told them was fine.
            measurementBounds: MEASUREMENT_BOUNDS,
            notes: [
                'All size measurements are in inches',
                `Lengths are adjustable upto ${PANTS_LENGTH_ADJUSTMENT_INCHES}"`
            ]
        }
    });
});

/**
 * POST /api/size/recommend  ("What's My Size?")
 * Public. Answers for guests without storing anything; for a logged-in
 * customer it also saves the result to their profile. Awards no points - that
 * is the quiz's job.
 */
exports.whatsMySize = catchAsync(async (req, res) => {
    const { measurements, errors } = parseMeasurements(req.body);

    if (errors.length) {
        return res.status(400).json({ success: false, message: errors[0], errors });
    }

    const fitPreference = FIT_PREFERENCES.includes(req.body.fitPreference)
        ? req.body.fitPreference
        : 'regular';

    let recommendation;
    try {
        recommendation = buildRecommendation(measurements, fitPreference, 'whats-my-size');
    } catch (error) {
        // The engine throws only when the input combination is unusable.
        return res.status(400).json({ success: false, message: error.message });
    }

    // Guests get the answer and nothing is stored. Logged-in customers get the
    // same answer, saved - which is what makes their next visit personalised.
    let saved = false;
    if (req.user) {
        await saveSubmission(req.user._id, measurements, recommendation);
        saved = true;
    }

    res.status(200).json({
        success: true,
        message: `We recommend size ${recommendation.recommendedSize}`,
        data: { ...recommendation, saved }
    });
});

/**
 * POST /api/size/quiz  ("Take the Size Quiz")
 * Authenticated. Identical engine and response to whatsMySize, but always
 * persists and pays the one-time loyalty bonus.
 */
exports.submitSizeQuiz = catchAsync(async (req, res) => {
    const { measurements, errors } = parseMeasurements(req.body);

    if (errors.length) {
        return res.status(400).json({ success: false, message: errors[0], errors });
    }

    const fitPreference = FIT_PREFERENCES.includes(req.body.fitPreference)
        ? req.body.fitPreference
        : 'regular';

    let recommendation;
    try {
        recommendation = buildRecommendation(measurements, fitPreference, 'quiz');
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }

    const profile = await saveSubmission(req.user._id, measurements, recommendation);
    const rewards = await awardQuizPoints(profile, req.user._id);

    res.status(200).json({
        success: true,
        message: rewards.alreadyCompleted
            ? `We recommend size ${recommendation.recommendedSize}. You've already claimed the points for this quiz.`
            : `We recommend size ${recommendation.recommendedSize}. You earned ${rewards.pointsAwarded} reward points!`,
        data: { ...recommendation, saved: true, rewards }
    });
});

/**
 * GET /api/size/profile
 * The customer's saved size, plus the behavioural data we have gathered on
 * them so far - what they actually order and how those orders fit.
 */
exports.getMySizeProfile = catchAsync(async (req, res) => {
    const profile = await SizeProfile.findOne({ user: req.user._id });
    const orderedSizes = await getOrderedSizeStats(req.user._id);

    if (!profile) {
        return res.status(200).json({
            success: true,
            message: 'No size profile yet',
            data: {
                hasProfile: false,
                latest: null,
                quizCompleted: false,
                orderedSizes,
                fitFeedbackCount: 0
            }
        });
    }

    res.status(200).json({
        success: true,
        data: {
            hasProfile: Boolean(profile.latest && profile.latest.recommendation),
            latest: profile.latest || null,
            quizCompleted: profile.quizCompleted,
            quizPointsAwarded: profile.quizPointsAwarded,
            submissionCount: profile.submissions.length,
            orderedSizes,
            fitFeedbackCount: profile.fitFeedback.length
        }
    });
});

/**
 * POST /api/size/fit-feedback
 * Records how a size actually fitted, including exchanges for the wrong size.
 * This is the ground truth the recommendation model will be trained on, so it
 * is captured even though nothing reads it back yet beyond the profile count.
 */
exports.submitFitFeedback = catchAsync(async (req, res) => {
    const { orderId, productId, garment, sizeOrdered, outcome, wasExchanged, sizeExchangedFor, comment } = req.body;

    if (!['top', 'pants'].includes(garment)) {
        return res.status(400).json({ success: false, message: 'Garment must be either "top" or "pants".' });
    }
    if (!SIZES.includes(sizeOrdered)) {
        return res.status(400).json({ success: false, message: `Size ordered must be one of: ${SIZES.join(', ')}.` });
    }
    if (!['too-small', 'just-right', 'too-large'].includes(outcome)) {
        return res.status(400).json({
            success: false,
            message: 'Outcome must be one of: too-small, just-right, too-large.'
        });
    }
    if (sizeExchangedFor && !SIZES.includes(sizeExchangedFor)) {
        return res.status(400).json({ success: false, message: `Size exchanged for must be one of: ${SIZES.join(', ')}.` });
    }

    // Only accept feedback against an order the caller actually placed -
    // otherwise the training set could be poisoned with other people's orders.
    if (orderId) {
        const order = await Order.findOne({ _id: orderId, user: req.user._id }).select('_id');
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found for this account.' });
        }
    }

    const feedback = {
        order: orderId || undefined,
        product: productId || undefined,
        garment,
        sizeOrdered,
        outcome,
        wasExchanged: Boolean(wasExchanged),
        sizeExchangedFor: sizeExchangedFor || null,
        comment: comment || undefined,
        recordedAt: new Date()
    };

    const profile = await SizeProfile.findOneAndUpdate(
        { user: req.user._id },
        { $push: { fitFeedback: feedback } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({
        success: true,
        message: 'Thanks - your fit feedback helps us size you better next time.',
        data: { fitFeedbackCount: profile.fitFeedback.length }
    });
});

// Exported for unit tests and for reuse by any future admin/reporting endpoint.
exports.SIZE_QUIZ_REWARD_POINTS = SIZE_QUIZ_REWARD_POINTS;
exports.parseMeasurements = parseMeasurements;
exports.getOrderedSizeStats = getOrderedSizeStats;
