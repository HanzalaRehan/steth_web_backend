/**
 * Author(s): 1. Zainab Raza
 * Description: The loyalty programme engine. Owns every way points are
 *              credited, and is the only module that writes to the reward
 *              ledger. Controllers call it; it never touches req/res, so it
 *              can be unit tested and reused (the size quiz grants its reward
 *              through awardRule, not by touching rewardPoints itself).
 *
 *              Two ways a rule pays out:
 *
 *                Claimed  - the customer taps "I follow you on Instagram".
 *                           Social follows cannot be verified without
 *                           platform APIs, so these are trust-based and
 *                           strictly one-time (see rewardRules.js).
 *
 *                Derived  - computed from data we already hold. syncDerived-
 *                           Rewards() re-derives every purchase milestone,
 *                           birthday, anniversary and review reward from the
 *                           orders/products/user documents themselves.
 *
 *              Why derived rather than event-driven: the sync pass is
 *              idempotent and stateless, so it can run any time (when the
 *              customer opens the rewards page, after checkout, from a cron
 *              if one is ever added) and always converges on the same answer.
 *              That means no scheduler, no queue and no Redis are needed for
 *              the programme to be correct, and orders placed before this
 *              feature existed are credited retroactively the first time a
 *              customer opens the page - no backfill migration.
 *
 *              Double-crediting is prevented by the unique index on the
 *              ledger, not by checking first and writing after - see
 *              rewardTransaction.model.js. awardRule() inserts and treats a
 *              duplicate-key error as "already earned", so concurrent calls
 *              cannot both pay out.
 *
 *              Key functions:
 *                - awardRule           : idempotent single award
 *                - claimRule           : self-declared rules + their opt-in side effects
 *                - syncDerivedRewards  : re-derive everything data-driven
 *                - getRewardsSummary   : balance, per-rule status, history
 *
 * Date created: August 3rd, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 3rd, 2026
 * Run: Not directly runnable - imported by src/controllers/rewards.controller.js
 */

const mongoose = require('mongoose');
const RewardTransaction = require('../models/rewardTransaction.model');
const User = require('../models/user.model');
const Order = require('../models/order.model');
const Product = require('../models/product.model');
const Subscriber = require('../models/Subscriber');
const emailService = require('../utils/emailService');
const {
    CADENCE,
    TRIGGER,
    REWARD_RULES,
    POINTS_EXPIRY_DAYS,
    POINT_VALUE_PKR,
    getRule,
    listRules
} = require('../config/rewardRules');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// The whole no-double-crediting guarantee rests on the ledger's unique index
// existing. Mongoose builds indexes asynchronously after the model is
// registered, so on a cold start a request can arrive before the build has
// finished - and every award in that window would be a silent duplicate.
// Model.init() resolves once the indexes are actually in place; the promise is
// cached, so this is a one-time wait on the first award and free thereafter.
let ledgerIndexesReady = null;
const ensureLedgerIndexes = () => {
    if (!ledgerIndexesReady) ledgerIndexesReady = RewardTransaction.init();
    return ledgerIndexesReady;
};

// Cancelled orders never count toward any milestone. Everything else does,
// matching how order.controller.js already credits its per-order points at
// creation time rather than waiting for delivery.
const MILESTONE_ORDER_FILTER = { orderStatus: { $ne: 'Cancelled' } };

/**
 * The occurrence key for a rule, given its cadence. See the ledger model for
 * why this shape matters.
 * @param {Object} rule - Rule definition from the catalogue.
 * @param {String} [explicit] - Caller-supplied key, required for REPEATABLE.
 * @param {Date} [when] - Date the award relates to (ANNUAL rules).
 * @returns {String} The occurrence key.
 */
const buildOccurrenceKey = (rule, explicit, when = new Date()) => {
    if (rule.cadence === CADENCE.ANNUAL) return String(when.getFullYear());
    if (rule.cadence === CADENCE.REPEATABLE) return String(explicit);
    return 'once';
};

/**
 * Credits a rule to a customer exactly once per occurrence.
 *
 * The ledger insert comes first and is the gate: if the unique index rejects
 * it, the customer already has this award and the balance is left alone. Only
 * a successful insert increments User.rewardPoints, so the balance can never
 * be credited twice for one occurrence.
 *
 * @param {ObjectId|String} userId - Customer earning the points.
 * @param {String} ruleKey - Key from the rule catalogue.
 * @param {Object} [options]
 * @param {String} [options.occurrenceKey] - Required for REPEATABLE rules.
 * @param {Date} [options.when] - Date the award relates to (ANNUAL rules).
 * @param {Object} [options.meta] - Order/product/admin context for the ledger.
 * @returns {Promise<Object>} { awarded, alreadyEarned, points, ruleKey, occurrenceKey }
 * @throws {Error} If the rule key is not in the catalogue.
 */
const awardRule = async (userId, ruleKey, options = {}) => {
    const rule = getRule(ruleKey);
    if (!rule) throw new Error(`Unknown reward rule: ${ruleKey}`);

    if (rule.cadence === CADENCE.REPEATABLE && !options.occurrenceKey) {
        throw new Error(`Rule ${ruleKey} is repeatable and requires an occurrenceKey`);
    }

    const occurrenceKey = buildOccurrenceKey(rule, options.occurrenceKey, options.when);
    const points = rule.points;
    const awardedAt = options.when || new Date();

    // Stamped from the policy in force right now, so a later change to
    // POINTS_EXPIRY_DAYS never moves the expiry of points already earned.
    const expiresAt = new Date(awardedAt.getTime() + POINTS_EXPIRY_DAYS * MS_PER_DAY);

    // Never insert before the uniqueness guarantee is actually enforceable.
    await ensureLedgerIndexes();

    try {
        await RewardTransaction.create({
            user: userId,
            ruleKey,
            occurrenceKey,
            points,
            type: 'earn',
            description: rule.label,
            meta: options.meta || {},
            awardedAt,
            expiresAt
        });
    } catch (error) {
        // The unique index did its job - this occurrence is already paid.
        if (error && error.code === RewardTransaction.DUPLICATE_KEY_ERROR) {
            return { awarded: false, alreadyEarned: true, points: 0, ruleKey, occurrenceKey };
        }
        throw error;
    }

    // Ledger row exists, so the balance must follow. If this update were to
    // fail the row would be orphaned, so we undo it rather than leave the
    // customer with history they were never paid for. (This codebase runs no
    // transactions anywhere - see the note in order.controller.js createOrder
    // - so compensating here matches the existing pattern.)
    try {
        await User.findByIdAndUpdate(userId, { $inc: { rewardPoints: points } });
    } catch (error) {
        await RewardTransaction.deleteOne({ user: userId, ruleKey, occurrenceKey });
        throw error;
    }

    return { awarded: true, alreadyEarned: false, points, ruleKey, occurrenceKey };
};

// Accepts an international number and stores one canonical form, so the same
// phone cannot be claimed twice by writing it differently (+92 300 1234567 vs
// 00923001234567 vs 03001234567 with spaces).
const PAKISTAN_LOCAL_PREFIX = '0';
const PAKISTAN_COUNTRY_CODE = '92';

/**
 * Normalises a customer-entered phone number to E.164 (+<country><number>).
 *
 * @param {String} raw - Whatever the customer typed.
 * @returns {String} Canonical +... form.
 * @throws {Error} If it cannot be a real mobile number.
 */
const normaliseWhatsappNumber = (raw) => {
    const trimmed = String(raw || '').trim();
    if (!trimmed) throw new Error('A WhatsApp number is required to subscribe.');

    let digits = trimmed.replace(/[\s()-]/g, '');
    if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;

    // A local Pakistani number (03001234567) is the common case on our
    // storefront, so accept it and expand rather than rejecting it.
    if (digits.startsWith(PAKISTAN_LOCAL_PREFIX) && !digits.startsWith('+')) {
        digits = `+${PAKISTAN_COUNTRY_CODE}${digits.slice(1)}`;
    }
    if (!digits.startsWith('+')) digits = `+${digits}`;

    if (!/^\+[1-9]\d{7,14}$/.test(digits)) {
        throw new Error('That does not look like a valid WhatsApp number. Include the country code, e.g. +92 300 1234567.');
    }

    return digits;
};

/**
 * EXTENSION POINT - WhatsApp number verification.
 *
 * Subscribing currently records intent, never proof of ownership: a customer
 * can type any number, including someone else's. That is tolerable only
 * because nothing sends WhatsApp messages yet.
 *
 * Before the first message is ever sent, this needs a one-time code delivered
 * to the number and confirmed back, which then sets
 * marketingOptIns.whatsappVerified. The WhatsApp Business channel (task 3) is
 * what makes that possible - it is the same API that would do the sending.
 *
 * Until then the rule for anything that sends is: require BOTH
 * marketingOptIns.whatsapp AND marketingOptIns.whatsappVerified. Never select
 * recipients on the number alone.
 */

/**
 * Handles the rules a customer claims themselves, applying the opt-in side
 * effect that goes with them before the points are credited.
 *
 * @param {ObjectId|String} userId - Customer claiming.
 * @param {String} ruleKey - Key from the catalogue.
 * @param {Object} [payload] - { whatsappNumber } for the WhatsApp opt-in.
 * @returns {Promise<Object>} awardRule's result.
 * @throws {Error} If the rule is unknown, not self-claimable, or the payload
 *                 is missing something the rule requires.
 */
const claimRule = async (userId, ruleKey, payload = {}) => {
    const rule = getRule(ruleKey);
    if (!rule) throw new Error(`Unknown reward rule: ${ruleKey}`);

    if (rule.trigger !== TRIGGER.SELF_DECLARED) {
        throw new Error(`${ruleKey} is awarded automatically and cannot be claimed directly.`);
    }

    // Record the consent before paying for it, so we never hand out points
    // for an opt-in we failed to store.
    if (ruleKey === 'SUBSCRIBE_WHATSAPP') {
        const whatsappNumber = normaliseWhatsappNumber(payload.whatsappNumber);

        // One account may not claim a number another account already holds.
        // Without this, several accounts could each point at one victim's
        // number and there would be no single record to revoke.
        const takenBy = await User.findOne({
            'marketingOptIns.whatsappNumber': whatsappNumber,
            _id: { $ne: userId }
        }).select('_id');

        if (takenBy) {
            throw new Error('That number is already subscribed on another account.');
        }

        await User.findByIdAndUpdate(userId, {
            $set: {
                'marketingOptIns.whatsapp': true,
                'marketingOptIns.whatsappNumber': whatsappNumber,
                // Deliberately NOT verified. Typing a number proves intent,
                // not ownership - see the extension point below.
                'marketingOptIns.whatsappVerified': false
            }
        });
    }

    if (ruleKey === 'SUBSCRIBE_EMAIL') {
        const user = await User.findById(userId).select('email');
        if (!user) throw new Error('User not found');

        // Actually subscribe them. The opt-in flag on the user is not enough:
        // send-bulk-email reads the Subscriber collection, so a customer paid
        // for subscribing would never have received anything without this.
        // Upsert rather than insert - the same person may have subscribed
        // through the newsletter footer already, and that must not fail the
        // claim or create a duplicate.
        const subscription = await Subscriber.updateOne(
            { email: user.email },
            { $setOnInsert: { email: user.email, createdAt: new Date() } },
            { upsert: true }
        );

        // Match what the newsletter footer does, so it doesn't matter which
        // route a customer subscribed through. Only on a genuinely new
        // subscriber - someone already on the list should not be welcomed
        // again just because they claimed the reward later.
        if (subscription.upsertedCount > 0) {
            try {
                await emailService.sendWelcomeEmail(user.email);
            } catch (error) {
                // Never fail the claim over the welcome email. They are on the
                // list either way, and the points are already theirs; a mail
                // outage must not cost them the reward.
                console.error('Rewards: welcome email failed for', user.email, '-', error.message);
            }
        }

        await User.findByIdAndUpdate(userId, { $set: { 'marketingOptIns.email': true } });
    }

    return awardRule(userId, ruleKey, {});
};

/**
 * Every non-cancelled order for a customer, oldest first. The single read
 * that all five purchase milestones are derived from.
 * @param {ObjectId|String} userId - Customer.
 * @returns {Promise<Array>} Lean order docs with just the fields needed.
 */
const getMilestoneOrders = (userId) =>
    Order.find({ user: userId, ...MILESTONE_ORDER_FILTER })
        .select('_id total createdAt')
        .sort({ createdAt: 1 })
        .lean();

/**
 * Purchase milestones, all derived from order history.
 * @param {ObjectId|String} userId - Customer.
 * @returns {Promise<Array<Object>>} Results of each award attempted.
 */
const evaluatePurchaseRules = async (userId) => {
    const orders = await getMilestoneOrders(userId);
    const results = [];

    if (!orders.length) return results;

    // Place Your 2nd Order.
    if (orders.length >= 2) {
        results.push(await awardRule(userId, 'SECOND_ORDER', {
            meta: { order: orders[1]._id },
            when: orders[1].createdAt
        }));

        // ...and the faster variant. Stacks with the rule above by design:
        // the reference programme lists them as two separate rewards.
        const gapDays = (new Date(orders[1].createdAt) - new Date(orders[0].createdAt)) / MS_PER_DAY;
        if (gapDays <= REWARD_RULES.SECOND_ORDER_FAST.windowDays) {
            results.push(await awardRule(userId, 'SECOND_ORDER_FAST', {
                meta: { order: orders[1]._id },
                when: orders[1].createdAt
            }));
        }
    }

    // A single order at or above the high-value threshold, once ever.
    const bigOrder = orders.find((order) => order.total >= REWARD_RULES.HIGH_VALUE_ORDER.thresholdPkr);
    if (bigOrder) {
        results.push(await awardRule(userId, 'HIGH_VALUE_ORDER', {
            meta: { order: bigOrder._id },
            when: bigOrder.createdAt
        }));
    }

    // N orders inside any rolling window, not per calendar year - a customer
    // who orders across a year boundary still qualifies. Sliding window over
    // the date-sorted list.
    const { orderCount, windowDays } = REWARD_RULES.ORDER_COUNT_MILESTONE;
    for (let i = 0; i + orderCount - 1 < orders.length; i += 1) {
        const first = new Date(orders[i].createdAt);
        const last = new Date(orders[i + orderCount - 1].createdAt);
        if ((last - first) / MS_PER_DAY <= windowDays) {
            results.push(await awardRule(userId, 'ORDER_COUNT_MILESTONE', {
                meta: { order: orders[i + orderCount - 1]._id },
                when: last
            }));
            break;
        }
    }

    // Every Nth qualifying purchase. Each payout is its own occurrence, keyed
    // by the milestone number, so a customer on their 9th qualifying order has
    // three separate ledger rows and re-running sync adds nothing.
    const { thresholdPkr, interval } = REWARD_RULES.RECURRING_PURCHASE;
    const qualifying = orders.filter((order) => order.total >= thresholdPkr);
    const payouts = Math.floor(qualifying.length / interval);
    for (let milestone = 1; milestone <= payouts; milestone += 1) {
        const triggeringOrder = qualifying[milestone * interval - 1];
        results.push(await awardRule(userId, 'RECURRING_PURCHASE', {
            occurrenceKey: String(milestone),
            meta: { order: triggeringOrder._id },
            when: triggeringOrder.createdAt
        }));
    }

    return results;
};

/**
 * The one-off joining reward. Derived from the account's creation date rather
 * than granted at registration, which means customers who signed up before
 * the programme existed are credited the first time they open the rewards
 * page - and the registration controller stays untouched.
 * @param {Object} user - The user document.
 * @returns {Promise<Array<Object>>} Result of the award attempt.
 */
const evaluateSignUpRule = async (user) => [
    await awardRule(user._id, 'SIGN_UP', { when: user.createdAt || new Date() })
];

/**
 * Claws back points whose expiry date has passed.
 *
 * Runs lazily as part of the sync rather than on a schedule, so it needs no
 * cron or queue: any customer who looks at their balance gets an accurate
 * one, and a customer who never looks cannot spend expired points either,
 * because checkout reads the balance this sweep maintains.
 *
 * Each swept batch is marked with expiredAt so it can never be deducted
 * twice, and a matching 'adjust' row is written so the history explains the
 * drop rather than the balance silently falling.
 *
 * @param {ObjectId|String} userId - Customer.
 * @returns {Promise<Object>} { pointsExpired, batches }
 */
const expireStalePoints = async (userId) => {
    const now = new Date();

    const stale = await RewardTransaction.find({
        user: userId,
        type: 'earn',
        expiredAt: null,
        expiresAt: { $ne: null, $lte: now }
    });

    if (!stale.length) return { pointsExpired: 0, batches: 0 };

    const pointsExpired = stale.reduce((sum, tx) => sum + tx.points, 0);

    // Mark first: if the balance update below fails, the next sweep will not
    // double-deduct, and the worst case is points that outlive their expiry.
    // The opposite ordering risks charging a customer twice for one batch.
    await RewardTransaction.updateMany(
        { _id: { $in: stale.map((tx) => tx._id) } },
        { $set: { expiredAt: now } }
    );

    // Never drive the balance negative - points may already have been spent
    // at checkout, in which case there is nothing left to expire.
    const user = await User.findById(userId).select('rewardPoints');
    const deduction = Math.min(pointsExpired, user ? user.rewardPoints : 0);

    if (deduction > 0) {
        await User.findByIdAndUpdate(userId, { $inc: { rewardPoints: -deduction } });
        await RewardTransaction.create({
            user: userId,
            ruleKey: 'POINTS_EXPIRED',
            occurrenceKey: `expiry-${now.toISOString()}`,
            points: -deduction,
            type: 'adjust',
            description: 'Points expired',
            awardedAt: now,
            expiresAt: null
        });
    }

    return { pointsExpired: deduction, batches: stale.length };
};

/**
 * Birthday and signup-anniversary rewards. Both are annual and only pay once
 * the date has actually passed this year, so nobody is paid in advance.
 * @param {Object} user - The user document.
 * @returns {Promise<Array<Object>>} Results of each award attempted.
 */
const evaluateCelebrationRules = async (user) => {
    const results = [];
    const now = new Date();
    const year = now.getFullYear();

    if (user.dateOfBirth) {
        const birthday = new Date(user.dateOfBirth);
        const thisYearsBirthday = new Date(year, birthday.getMonth(), birthday.getDate());
        if (thisYearsBirthday <= now) {
            results.push(await awardRule(user._id, 'BIRTHDAY', { when: thisYearsBirthday }));
        }
    }

    // Anniversary of joining. Skips the signup year itself - the first
    // anniversary is a year after joining, not the day you joined.
    if (user.createdAt) {
        const joined = new Date(user.createdAt);
        const thisYearsAnniversary = new Date(year, joined.getMonth(), joined.getDate());
        if (year > joined.getFullYear() && thisYearsAnniversary <= now) {
            results.push(await awardRule(user._id, 'LOYALTY_ANNIVERSARY', { when: thisYearsAnniversary }));
        }
    }

    return results;
};

/**
 * One award per product the customer has written a review for.
 *
 * Derived from the embedded Product.ratings array, which is where reviews
 * live in this codebase. Nothing writes to that array yet, so this pays out
 * as soon as a review endpoint lands - no change needed here.
 *
 * @param {ObjectId|String} userId - Customer.
 * @returns {Promise<Array<Object>>} Results of each award attempted.
 */
const evaluateReviewRules = async (userId) => {
    const reviewed = await Product.find(
        { ratings: { $elemMatch: { userId, review: { $exists: true, $ne: '' } } } }
    ).select('_id').lean();

    const results = [];
    for (const product of reviewed) {
        results.push(await awardRule(userId, 'PRODUCT_REVIEW', {
            occurrenceKey: String(product._id),
            meta: { product: product._id }
        }));
    }
    return results;
};

/**
 * Re-derives every data-driven reward for a customer and credits whatever is
 * newly qualified. Safe to call as often as you like - repeat runs award
 * nothing because each occurrence is already in the ledger.
 *
 * @param {ObjectId|String} userId - Customer.
 * @returns {Promise<Object>} { newlyAwarded: [...], pointsAwarded: Number }
 */
const syncDerivedRewards = async (userId) => {
    const user = await User.findById(userId).select('_id dateOfBirth createdAt');
    if (!user) throw new Error('User not found');

    const results = [
        ...await evaluateSignUpRule(user),
        ...await evaluatePurchaseRules(userId),
        ...await evaluateCelebrationRules(user),
        ...await evaluateReviewRules(userId)
    ];

    // Sweep last, so points that were awarded and expired in the same pass
    // (possible for a customer returning after more than a year) settle
    // correctly rather than expiring before they are credited.
    const expiry = await expireStalePoints(userId);

    const newlyAwarded = results.filter((result) => result.awarded);

    return {
        newlyAwarded,
        pointsAwarded: newlyAwarded.reduce((sum, result) => sum + result.points, 0),
        pointsExpired: expiry.pointsExpired
    };
};

/**
 * Everything the rewards page needs: the balance, the catalogue annotated
 * with what this customer has already earned, and recent history.
 *
 * Runs a sync first so the page never shows a stale "not earned yet" for a
 * milestone the customer already hit.
 *
 * @param {ObjectId|String} userId - Customer.
 * @param {Object} [options]
 * @param {Number} [options.historyLimit=25] - How many ledger rows to return.
 * @returns {Promise<Object>} Balance, per-rule status, history and totals.
 */
const getRewardsSummary = async (userId, options = {}) => {
    const historyLimit = options.historyLimit || 25;

    const sync = await syncDerivedRewards(userId);

    const [user, transactions, pointsEarningOrders] = await Promise.all([
        User.findById(userId).select('rewardPoints dateOfBirth marketingOptIns username'),
        RewardTransaction.find({ user: userId }).sort({ awardedAt: -1 }).lean(),
        // Points earned per order are credited by order.controller.js straight
        // to the balance and were never ledger rows. They are read here purely
        // so the activity table is complete - deliberately NOT written into the
        // ledger, which would double-credit a balance checkout already updated.
        Order.find({ user: userId, pointsEarned: { $gt: 0 }, ...MILESTONE_ORDER_FILTER })
            .select('orderId pointsEarned createdAt')
            .lean()
    ]);

    // Count earned occurrences per rule so the page can show "claimed" on
    // one-time rules and "earned 3 times" on repeatable ones.
    const earnedByRule = transactions.reduce((acc, tx) => {
        acc[tx.ruleKey] = acc[tx.ruleKey] || { count: 0, points: 0, lastAwardedAt: null };
        acc[tx.ruleKey].count += 1;
        acc[tx.ruleKey].points += tx.points;
        if (!acc[tx.ruleKey].lastAwardedAt || tx.awardedAt > acc[tx.ruleKey].lastAwardedAt) {
            acc[tx.ruleKey].lastAwardedAt = tx.awardedAt;
        }
        return acc;
    }, {});

    const rules = listRules().map((rule) => {
        const earned = earnedByRule[rule.key];
        const thisYear = String(new Date().getFullYear());

        // "Can they earn this right now?" - one-time rules are spent once,
        // annual rules reset each year, repeatable rules always stay open.
        let available = true;
        if (rule.cadence === CADENCE.ONCE) {
            available = !earned;
        } else if (rule.cadence === CADENCE.ANNUAL) {
            available = !transactions.some((tx) => tx.ruleKey === rule.key && tx.occurrenceKey === thisYear);
        }

        return {
            key: rule.key,
            label: rule.label,
            description: rule.description,
            points: rule.points,
            cadence: rule.cadence,
            trigger: rule.trigger,
            category: rule.category,
            claimable: rule.trigger === TRIGGER.SELF_DECLARED && available,
            available,
            timesEarned: earned ? earned.count : 0,
            pointsEarned: earned ? earned.points : 0,
            lastAwardedAt: earned ? earned.lastAwardedAt : null,
            // Lets the page prompt for what is missing rather than showing a
            // reward the customer can never actually earn.
            blockedBy: rule.requiresDateOfBirth && !user.dateOfBirth ? 'dateOfBirth' : null,
            // Where the card sends the customer before it pays out:
            // actionUrl leaves the site, actionPath stays inside it.
            actionUrl: rule.actionUrl || null,
            actionPath: rule.actionPath || null
        };
    });

    // One activity feed from two sources: programme rewards (the ledger) and
    // per-order earnings (the orders themselves), merged newest-first.
    const ledgerActivity = transactions.map((tx) => ({
        ruleKey: tx.ruleKey,
        description: tx.description,
        points: tx.points,
        type: tx.type,
        awardedAt: tx.awardedAt,
        expiresAt: tx.expiresAt || null,
        expired: Boolean(tx.expiredAt)
    }));

    const orderActivity = pointsEarningOrders.map((order) => ({
        ruleKey: 'ORDER_POINTS',
        description: order.orderId ? `Order ${order.orderId}` : 'Order',
        points: order.pointsEarned,
        type: 'earn',
        awardedAt: order.createdAt,
        expiresAt: new Date(new Date(order.createdAt).getTime() + POINTS_EXPIRY_DAYS * MS_PER_DAY),
        expired: false
    }));

    const history = [...ledgerActivity, ...orderActivity]
        .sort((a, b) => new Date(b.awardedAt) - new Date(a.awardedAt));

    // The headline "your points expire on" date: the soonest expiry still
    // ahead of us among points that have not already been swept.
    const upcomingExpiries = history
        .filter((entry) => entry.type === 'earn' && !entry.expired && entry.expiresAt)
        .map((entry) => new Date(entry.expiresAt))
        .filter((date) => date > new Date())
        .sort((a, b) => a - b);

    return {
        username: user.username,
        balance: user.rewardPoints,
        // What the balance is actually worth to spend, so the page can show a
        // value rather than a bare point count.
        pointValuePkr: POINT_VALUE_PKR,
        balanceValuePkr: user.rewardPoints * POINT_VALUE_PKR,
        lifetimeEarned: history
            .filter((entry) => entry.type === 'earn')
            .reduce((sum, entry) => sum + entry.points, 0),
        nextExpiryDate: upcomingExpiries.length ? upcomingExpiries[0] : null,
        justAwarded: sync.newlyAwarded,
        pointsJustAwarded: sync.pointsAwarded,
        pointsJustExpired: sync.pointsExpired,
        rules,
        history: history.slice(0, historyLimit)
    };
};

module.exports = {
    awardRule,
    claimRule,
    syncDerivedRewards,
    getRewardsSummary,
    evaluatePurchaseRules,
    evaluateCelebrationRules,
    evaluateReviewRules,
    evaluateSignUpRule,
    expireStalePoints,
    buildOccurrenceKey
};
