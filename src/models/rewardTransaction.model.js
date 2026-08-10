/**
 * Author(s): 1. Zainab Raza
 * Description: Append-only ledger of loyalty point movements - one document
 *              per award. Gives the programme three things the single
 *              User.rewardPoints balance cannot provide on its own:
 *
 *                1. Idempotency. The compound unique index on
 *                   (user, ruleKey, occurrenceKey) is what actually stops a
 *                   rule paying out twice. Awarding is "insert and let the
 *                   index reject the duplicate" rather than "read, check,
 *                   then write", so two concurrent requests cannot both pass
 *                   the check and both credit points.
 *                2. History. The rewards page has to show customers what they
 *                   earned and when.
 *                3. Auditability. If a balance ever looks wrong, the ledger
 *                   explains how it got there.
 *
 *              User.rewardPoints stays the authoritative spendable balance -
 *              checkout already reads and decrements it (order.controller.js),
 *              and this model does not change that. The ledger records
 *              earnings alongside it; it does not replace it.
 *
 *              occurrenceKey is what makes the index meaningful, and its
 *              shape follows the rule's cadence:
 *                ONCE       -> 'once'          (one row, ever)
 *                ANNUAL     -> '2026'          (one row per calendar year)
 *                REPEATABLE -> the id of the thing that triggered it, e.g. a
 *                              product id for a review, or the milestone
 *                              index for a recurring purchase bonus
 *
 * Date created: August 3rd, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 3rd, 2026
 * Run: Not directly runnable - imported by src/services/rewards.service.js
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { REWARD_RULES } = require('../config/rewardRules');

const RULE_KEYS = Object.keys(REWARD_RULES);

const rewardTransactionSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    // Which catalogue rule paid out. Not an enum of RULE_KEYS on purpose:
    // if a rule is ever retired from the catalogue, its historical rows must
    // still load rather than failing validation on read.
    ruleKey: {
        type: String,
        required: true
    },
    // Disambiguates repeat awards of the same rule - see the header note.
    occurrenceKey: {
        type: String,
        required: true,
        default: 'once'
    },
    points: {
        type: Number,
        required: true
    },
    // 'earn' is all this feature writes today. 'adjust' exists for manual
    // admin corrections; 'redeem' is reserved so that when redemption is
    // specified (issue #22) spending lands in the same ledger instead of a
    // second one.
    type: {
        type: String,
        enum: ['earn', 'redeem', 'adjust'],
        default: 'earn'
    },
    // Human-readable label captured at award time. Stored rather than looked
    // up so history stays accurate even after the catalogue's wording or
    // point values change.
    description: {
        type: String,
        trim: true
    },
    // Free-form context for the award: the order that triggered it, the
    // product reviewed, the admin who adjusted it.
    meta: {
        order: { type: Schema.Types.ObjectId, ref: 'Order' },
        product: { type: Schema.Types.ObjectId, ref: 'Product' },
        awardedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        note: String
    },
    awardedAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

// The heart of the idempotency guarantee. Any second attempt to award the
// same rule occurrence to the same customer fails with a duplicate-key error,
// which the service treats as "already earned" rather than an error.
rewardTransactionSchema.index(
    { user: 1, ruleKey: 1, occurrenceKey: 1 },
    { unique: true }
);

// Backs the history feed on the rewards page (newest first).
rewardTransactionSchema.index({ user: 1, awardedAt: -1 });

// Exposed so the service can recognise the duplicate-key error by code
// without importing driver internals.
rewardTransactionSchema.statics.DUPLICATE_KEY_ERROR = 11000;
rewardTransactionSchema.statics.RULE_KEYS = RULE_KEYS;

module.exports = mongoose.model('RewardTransaction', rewardTransactionSchema);
