/**
 * Author(s): 1. Zainab Raza
 * Description: Per-user size profile - the data-collection half of the size
 *              recommendation feature. One document per user, holding their
 *              latest measurements and recommendation plus an append-only
 *              history of every submission and every piece of fit feedback.
 *
 *              This exists as its own collection rather than as fields on
 *              user.model.js because it is a growing training set, not account
 *              data: the history arrays are written far more often than the
 *              user document is read, and keeping them separate means the
 *              auth path (which loads the full user on every request via
 *              auth.middleware.js) never pays for them.
 *
 *              What each part is for:
 *                latest        - what "What's My Size?" answered most recently,
 *                                served back as the customer's saved size
 *                submissions[] - every quiz/lookup ever run, with the inputs
 *                                and the rule engine's answer, so the future
 *                                model can learn what customers were told
 *                fitFeedback[] - ground truth: exchanges and post-purchase
 *                                "too tight / too loose" reports. This is the
 *                                label column the model will actually train on
 *                quizCompleted - reward-points guard, so the loyalty bonus for
 *                                completing the quiz can only ever be paid once
 *
 * Date created: August 3rd, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 3rd, 2026
 * Run: Not directly runnable - imported by src/controllers/size.controller.js
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { SIZES } = require('../utils/sizeChart');
const { FIT_PREFERENCES, CONFIDENCE } = require('../utils/sizeRecommendation');

const CONFIDENCE_LEVELS = Object.values(CONFIDENCE);

// The raw customer answers. Every field is optional because the engine accepts
// several different input combinations (chest+waist, waist only, or just
// height+weight) - validation of "is this combination usable" lives in the
// engine, not here, so there is exactly one place that decides.
const measurementsSchema = new Schema({
    chest: { type: Number, min: 0 },
    waist: { type: Number, min: 0 },
    hip: { type: Number, min: 0 },
    heightInches: { type: Number, min: 0 },
    weightKg: { type: Number, min: 0 }
}, { _id: false });

// A frozen copy of what the engine returned. Stored rather than recomputed so
// that retuning the rules later never rewrites history - we need to know what
// the customer was actually shown at the time they bought.
const recommendationSchema = new Schema({
    recommendedSize: { type: String, enum: SIZES },
    baseSize: { type: String, enum: SIZES },
    fitPreference: { type: String, enum: FIT_PREFERENCES, default: 'regular' },
    adjustedForFit: { type: Boolean, default: false },
    confidence: { type: String, enum: CONFIDENCE_LEVELS },
    breakdown: {
        top: { type: String, enum: [...SIZES, null], default: null },
        pants: { type: String, enum: [...SIZES, null], default: null },
        basis: { type: String }
    },
    notes: [String],
    // Which entry point produced this: the points-earning quiz or the quick
    // storefront lookup. Same engine either way - this is purely for analysis.
    source: {
        type: String,
        enum: ['quiz', 'whats-my-size'],
        default: 'whats-my-size'
    },
    // Rule engine today, model later. Lets us tell rule-era rows apart from
    // model-era rows in the same collection once the model ships.
    engineVersion: { type: String, default: 'rules-v1' }
}, { _id: false });

const sizeProfileSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true
    },
    latest: {
        measurements: measurementsSchema,
        recommendation: recommendationSchema,
        updatedAt: Date
    },
    submissions: [{
        measurements: measurementsSchema,
        recommendation: recommendationSchema,
        submittedAt: { type: Date, default: Date.now }
    }],
    fitFeedback: [{
        order: { type: Schema.Types.ObjectId, ref: 'Order' },
        product: { type: Schema.Types.ObjectId, ref: 'Product' },
        // Which half of the set this was about - top and pants can fit
        // differently on the same person, which is exactly the signal we want.
        garment: { type: String, enum: ['top', 'pants'], required: true },
        sizeOrdered: { type: String, enum: SIZES, required: true },
        // The label. 'too-small'/'too-large' are the ones worth learning from;
        // 'just-right' is the positive class and matters just as much.
        outcome: {
            type: String,
            enum: ['too-small', 'just-right', 'too-large'],
            required: true
        },
        // True when this came off an actual exchange rather than a volunteered
        // review - a much stronger signal, so the model can weight it higher.
        wasExchanged: { type: Boolean, default: false },
        sizeExchangedFor: { type: String, enum: [...SIZES, null], default: null },
        comment: { type: String, trim: true, maxlength: 500 },
        recordedAt: { type: Date, default: Date.now }
    }],
    // Reward-points bookkeeping for the quiz. Guarded so replaying the quiz
    // endpoint cannot farm points - see awardQuizPoints in size.controller.js.
    quizCompleted: { type: Boolean, default: false },
    quizPointsAwarded: { type: Number, default: 0, min: 0 },
    quizCompletedAt: Date
}, { timestamps: true });

// `user` is already indexed by its own `unique: true` above - re-declaring it
// here would create a duplicate. This second index serves the eventual
// training-set export ("pull everyone we sized as an L").
sizeProfileSchema.index({ 'latest.recommendation.recommendedSize': 1 });

module.exports = mongoose.model('SizeProfile', sizeProfileSchema);
