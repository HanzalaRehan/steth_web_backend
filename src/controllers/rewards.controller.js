/**
 * Author(s): 1. Zainab Raza
 * Description: HTTP layer for the loyalty programme. Thin on purpose - all
 *              the rules and point arithmetic live in rewards.service.js, so
 *              these handlers only validate input and shape responses.
 *
 *              Endpoints:
 *                GET  /api/rewards/catalogue - public list of ways to earn,
 *                                              for the rewards landing page
 *                GET  /api/rewards/me        - balance, per-rule status and
 *                                              history for the signed-in
 *                                              customer (runs a sync first)
 *                POST /api/rewards/claim     - claim a self-declared reward
 *                                              (social follows, opt-ins)
 *                POST /api/rewards/sync      - re-derive purchase/celebration
 *                                              rewards on demand
 *                POST /api/rewards/birthday  - save a date of birth so the
 *                                              birthday reward can pay out
 *                GET  /api/rewards/config    - admin view of the values in
 *                                              use and what is still pending
 *                                              business sign-off
 *
 * Date created: August 3rd, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 3rd, 2026
 * Run: Not directly runnable - mounted by src/routes/rewards.routes.js
 */

const User = require('../models/user.model');
const rewardsService = require('../services/rewards.service');
const { catchAsync } = require('../utils/errorHandler');
const {
    listRules,
    listClaimableRules,
    getRule,
    PENDING_BUSINESS_SIGN_OFF
} = require('../config/rewardRules');

/**
 * GET /api/rewards/catalogue
 * Public. Everything a visitor can see about the programme before signing in,
 * so the rewards page renders from the same catalogue the engine pays from.
 */
exports.getCatalogue = catchAsync(async (req, res) => {
    res.status(200).json({
        success: true,
        data: {
            currency: 'PKR',
            rules: listRules().map((rule) => ({
                key: rule.key,
                label: rule.label,
                description: rule.description,
                points: rule.points,
                cadence: rule.cadence,
                category: rule.category,
                claimable: rule.trigger === 'self-declared',
                // Where the card should send the customer before it pays out:
                // actionUrl leaves the site, actionPath stays inside it.
                actionUrl: rule.actionUrl || null,
                actionPath: rule.actionPath || null
            }))
        }
    });
});

/**
 * GET /api/rewards/me
 * The signed-in customer's rewards page payload. Syncs derived rewards first,
 * so a customer who qualified for a milestone before this feature shipped
 * sees it credited the first time they open the page.
 */
exports.getMyRewards = catchAsync(async (req, res) => {
    const summary = await rewardsService.getRewardsSummary(req.user._id);

    res.status(200).json({
        success: true,
        message: summary.pointsJustAwarded > 0
            ? `You just earned ${summary.pointsJustAwarded} points!`
            : undefined,
        data: summary
    });
});

/**
 * POST /api/rewards/claim
 * Claims a self-declared reward. Body: { ruleKey, whatsappNumber? }.
 * Returns 200 with awarded:false when the reward was already claimed - not an
 * error, just nothing more to pay.
 */
exports.claimReward = catchAsync(async (req, res) => {
    const { ruleKey, whatsappNumber } = req.body;

    if (!ruleKey) {
        return res.status(400).json({ success: false, message: 'A ruleKey is required.' });
    }

    const rule = getRule(ruleKey);
    if (!rule) {
        return res.status(404).json({
            success: false,
            message: `Unknown reward: ${ruleKey}.`,
            claimable: listClaimableRules().map((entry) => entry.key)
        });
    }

    let result;
    try {
        result = await rewardsService.claimRule(req.user._id, ruleKey, { whatsappNumber });
    } catch (error) {
        // claimRule throws for the caller's mistakes - wrong rule type, or a
        // missing WhatsApp number - which are all 400s, not 500s.
        return res.status(400).json({ success: false, message: error.message });
    }

    res.status(200).json({
        success: true,
        message: result.awarded
            ? `You earned ${result.points} points for ${rule.label}.`
            : `You have already claimed ${rule.label}.`,
        data: result
    });
});

/**
 * POST /api/rewards/sync
 * Re-derives purchase, celebration and review rewards on demand. Exposed as
 * its own route so checkout (or an admin tool) can trigger a re-check right
 * after an order without waiting for the customer to open the rewards page.
 */
exports.syncRewards = catchAsync(async (req, res) => {
    const result = await rewardsService.syncDerivedRewards(req.user._id);

    res.status(200).json({
        success: true,
        message: result.pointsAwarded > 0
            ? `You just earned ${result.pointsAwarded} points!`
            : 'No new rewards yet.',
        data: result
    });
});

/**
 * POST /api/rewards/birthday
 * Saves a date of birth, then immediately syncs so a customer whose birthday
 * has already passed this year is paid straight away rather than waiting a
 * full year. Body: { dateOfBirth }.
 */
exports.setDateOfBirth = catchAsync(async (req, res) => {
    const { dateOfBirth } = req.body;

    if (!dateOfBirth) {
        return res.status(400).json({ success: false, message: 'A dateOfBirth is required.' });
    }

    const parsed = new Date(dateOfBirth);
    if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ success: false, message: 'dateOfBirth must be a valid date.' });
    }
    if (parsed > new Date()) {
        return res.status(400).json({ success: false, message: 'dateOfBirth cannot be in the future.' });
    }

    // Set once. Allowing edits would let a customer collect a birthday reward,
    // change the date and collect again - the ledger's annual key is the year,
    // not the date, so it would not stop them.
    const existing = await User.findById(req.user._id).select('dateOfBirth');
    if (existing.dateOfBirth) {
        return res.status(409).json({
            success: false,
            message: 'Your date of birth is already set. Contact support if it needs changing.'
        });
    }

    await User.findByIdAndUpdate(req.user._id, { $set: { dateOfBirth: parsed } });
    const sync = await rewardsService.syncDerivedRewards(req.user._id);

    res.status(200).json({
        success: true,
        message: sync.pointsAwarded > 0
            ? `Saved - and you earned ${sync.pointsAwarded} points!`
            : 'Saved. Your birthday reward will land on your next birthday.',
        data: sync
    });
});

/**
 * GET /api/rewards/config
 * Admin-only. Shows the point values and PKR thresholds currently in force
 * plus everything still awaiting a business decision, so the programme can be
 * reviewed without reading the source.
 */
exports.getConfig = catchAsync(async (req, res) => {
    res.status(200).json({
        success: true,
        data: {
            currency: 'PKR',
            rules: listRules(),
            pendingBusinessSignOff: PENDING_BUSINESS_SIGN_OFF
        }
    });
});
