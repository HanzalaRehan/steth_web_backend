/**
 * Author(s): 1. Zainab Raza
 * Description: The loyalty programme rule catalogue - the single source of
 *              truth for every way a customer can earn points, and the only
 *              file that needs editing when the business changes the numbers.
 *
 *              Every rule declares what it is worth, how often it can be
 *              earned, and (for purchase rules) the PKR threshold that
 *              qualifies. The service layer reads this catalogue and never
 *              hardcodes a value, so retuning the programme is a config
 *              change rather than a code change.
 *
 *              !! PROVISIONAL VALUES !!
 *              Point values are seeded from the reference programme we were
 *              given, and the PKR thresholds are placeholders converted from
 *              its USD tiers. Both are pending sign-off from the business
 *              side - see PENDING_BUSINESS_SIGN_OFF at the bottom, which
 *              lists exactly what still needs a decision. Nothing outside
 *              this file has to change once those numbers land.
 *
 *              Cadence semantics:
 *                ONCE       - claimable a single time, ever
 *                ANNUAL     - once per calendar year (birthday, anniversary)
 *                REPEATABLE - earned many times, each occurrence keyed by the
 *                             thing that triggered it (a product reviewed, a
 *                             purchase milestone reached)
 *
 *              Trigger semantics - how a rule is actually granted:
 *                SELF_DECLARED - customer taps "I followed you on Instagram".
 *                                We cannot verify social follows without
 *                                platform APIs, so these are claim-based and
 *                                capped at ONCE, exactly like the reference
 *                                programme.
 *                DERIVED       - computed from data we already hold (orders,
 *                                reviews, birthday, signup date). Awarded by
 *                                the sync pass, never claimed by the client.
 *                INTEGRATION   - granted by another part of the codebase
 *                                calling the rewards service directly.
 *
 * Date created: August 3rd, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 3rd, 2026
 * Run: Not directly runnable - imported by src/services/rewards.service.js
 */

const CADENCE = {
    ONCE: 'once',
    ANNUAL: 'annual',
    REPEATABLE: 'repeatable'
};

const TRIGGER = {
    SELF_DECLARED: 'self-declared',
    DERIVED: 'derived',
    INTEGRATION: 'integration'
};

const CATEGORY = {
    ENGAGEMENT: 'engagement',
    CELEBRATION: 'celebration',
    PURCHASE: 'purchase'
};

// PKR thresholds for the purchase rules. PLACEHOLDERS - the reference
// programme is priced in USD ($200 / $75) and the business has not yet fixed
// the PKR equivalents. Converted at roughly PKR 280/USD and rounded to a
// sensible retail number; expect these to move.
const ORDER_VALUE_THRESHOLD_PKR = 56000;      // reference: $200+ single order
const RECURRING_PURCHASE_THRESHOLD_PKR = 21000; // reference: $75+ per purchase

// How many qualifying purchases between each recurring bonus payout.
const RECURRING_PURCHASE_INTERVAL = 3;        // reference: every 3rd purchase

// Where each social reward sends the customer before it pays out. The card
// opens this, so the customer is actually taken to the page they're being paid
// to follow rather than collecting points for a click that did nothing.
//
// We still cannot verify the follow itself - no platform exposes that without
// per-user OAuth - so the reward stays trust-based and strictly one-time. What
// this fixes is the action, not the verification.
//
// !! PLACEHOLDER HANDLES - swap for Steth's real accounts before launch !!
const SOCIAL_URLS = {
    facebook: 'https://www.facebook.com/stethofficial',
    instagram: 'https://www.instagram.com/stethofficial',
    tiktok: 'https://www.tiktok.com/@stethofficial'
};

// How long earned points stay spendable. Shown on the rewards page against
// every activity row and as the headline "expires on" date. PLACEHOLDER -
// one year matches the reference programme, but the business has not signed
// off on an expiry policy for us yet.
const POINTS_EXPIRY_DAYS = 365;

// Window for the "second order quickly" bonus, and the size/period of the
// order-count milestone.
const SECOND_ORDER_WINDOW_DAYS = 30;
const ORDER_COUNT_MILESTONE = 5;
const ORDER_COUNT_WINDOW_DAYS = 365;

/**
 * The catalogue. Keys are stable identifiers written into the points ledger -
 * renaming one orphans every historical transaction that references it, so
 * treat them as permanent.
 */
const REWARD_RULES = {
    // --- Joining --------------------------------------------------------
    // Paid once for having an account at all. Derived from the account's own
    // creation date rather than granted by the registration controller, so
    // every customer who signed up before the programme launched is credited
    // the first time they open the rewards page - no backfill script, and
    // registration keeps working exactly as it does today.
    SIGN_UP: {
        key: 'SIGN_UP',
        label: 'Sign Up',
        description: 'Create an account and start earning points.',
        points: 200,
        cadence: CADENCE.ONCE,
        trigger: TRIGGER.DERIVED,
        category: CATEGORY.ENGAGEMENT
    },

    // --- Engagement: opt-ins and social follows -------------------------
    SUBSCRIBE_EMAIL: {
        key: 'SUBSCRIBE_EMAIL',
        label: 'Subscribe to Emails',
        description: 'Get Steth news and drops straight to your inbox.',
        points: 100,
        cadence: CADENCE.ONCE,
        trigger: TRIGGER.SELF_DECLARED,
        category: CATEGORY.ENGAGEMENT
    },
    // Replaces the reference programme's "Subscribe to SMS" - WhatsApp is
    // the channel that actually matters for our market.
    SUBSCRIBE_WHATSAPP: {
        key: 'SUBSCRIBE_WHATSAPP',
        label: 'Subscribe to WhatsApp',
        description: 'Order updates and early access on WhatsApp.',
        points: 100,
        cadence: CADENCE.ONCE,
        trigger: TRIGGER.SELF_DECLARED,
        category: CATEGORY.ENGAGEMENT,
        // Opting in needs a number to message.
        requiresWhatsappNumber: true
    },
    FOLLOW_FACEBOOK: {
        key: 'FOLLOW_FACEBOOK',
        label: 'Like Steth on Facebook',
        description: 'Follow along on Facebook.',
        points: 10,
        cadence: CADENCE.ONCE,
        trigger: TRIGGER.SELF_DECLARED,
        category: CATEGORY.ENGAGEMENT,
        actionUrl: SOCIAL_URLS.facebook
    },
    FOLLOW_INSTAGRAM: {
        key: 'FOLLOW_INSTAGRAM',
        label: 'Follow Steth on Instagram',
        description: 'Follow along on Instagram.',
        points: 10,
        cadence: CADENCE.ONCE,
        trigger: TRIGGER.SELF_DECLARED,
        category: CATEGORY.ENGAGEMENT,
        actionUrl: SOCIAL_URLS.instagram
    },
    FOLLOW_TIKTOK: {
        key: 'FOLLOW_TIKTOK',
        label: 'Follow Steth on TikTok',
        description: 'Follow along on TikTok.',
        points: 10,
        cadence: CADENCE.ONCE,
        trigger: TRIGGER.SELF_DECLARED,
        category: CATEGORY.ENGAGEMENT,
        actionUrl: SOCIAL_URLS.tiktok
    },
    // Granted by the size feature when a customer completes the size quiz -
    // the quiz owns the interaction, the rewards service owns the points.
    SIZING_QUIZ: {
        key: 'SIZING_QUIZ',
        label: 'Take Our Sizing Quiz',
        description: 'Tell us your fit and we will size you every time.',
        points: 100,
        cadence: CADENCE.ONCE,
        trigger: TRIGGER.INTEGRATION,
        category: CATEGORY.ENGAGEMENT,
        // An internal route rather than an external URL: the card sends the
        // customer to the quiz, and the quiz itself grants the reward. Once
        // earned the card goes inert like any other one-time reward - but the
        // quiz stays open, and "What's my size?" on a product page is
        // unlimited either way, because neither pays out twice.
        actionPath: '/size-quiz'
    },
    // Repeatable, but keyed per product so a customer earns once for each
    // product they review rather than farming one product over and over.
    PRODUCT_REVIEW: {
        key: 'PRODUCT_REVIEW',
        label: 'Post a Product Review',
        description: 'Review a product you have bought.',
        points: 200,
        cadence: CADENCE.REPEATABLE,
        trigger: TRIGGER.DERIVED,
        category: CATEGORY.ENGAGEMENT
    },

    // --- Celebration: annual, automatic --------------------------------
    BIRTHDAY: {
        key: 'BIRTHDAY',
        label: 'Celebrate Your Birthday',
        description: 'Points from us on your birthday, every year.',
        points: 500,
        cadence: CADENCE.ANNUAL,
        trigger: TRIGGER.DERIVED,
        category: CATEGORY.CELEBRATION,
        // Needs User.dateOfBirth - surfaced to the storefront so the page can
        // prompt for a missing birthday instead of silently never paying out.
        requiresDateOfBirth: true
    },
    LOYALTY_ANNIVERSARY: {
        key: 'LOYALTY_ANNIVERSARY',
        label: 'Celebrate Loyalty Anniversary',
        description: 'Every year since you joined Steth.',
        points: 250,
        cadence: CADENCE.ANNUAL,
        trigger: TRIGGER.DERIVED,
        category: CATEGORY.CELEBRATION
    },

    // --- Purchase milestones: all derived from order history ------------
    HIGH_VALUE_ORDER: {
        key: 'HIGH_VALUE_ORDER',
        label: `Place a PKR ${ORDER_VALUE_THRESHOLD_PKR.toLocaleString('en-PK')}+ Order`,
        description: 'A bonus on your first big basket.',
        points: 300,
        cadence: CADENCE.ONCE,
        trigger: TRIGGER.DERIVED,
        category: CATEGORY.PURCHASE,
        thresholdPkr: ORDER_VALUE_THRESHOLD_PKR
    },
    SECOND_ORDER: {
        key: 'SECOND_ORDER',
        label: 'Place Your 2nd Order',
        description: 'Come back for a second round.',
        points: 200,
        cadence: CADENCE.ONCE,
        trigger: TRIGGER.DERIVED,
        category: CATEGORY.PURCHASE
    },
    SECOND_ORDER_FAST: {
        key: 'SECOND_ORDER_FAST',
        label: `Place Your 2nd Order Within ${SECOND_ORDER_WINDOW_DAYS} Days`,
        description: 'Order again quickly and earn extra. Stacks with the 2nd order bonus.',
        points: 500,
        cadence: CADENCE.ONCE,
        trigger: TRIGGER.DERIVED,
        category: CATEGORY.PURCHASE,
        windowDays: SECOND_ORDER_WINDOW_DAYS
    },
    ORDER_COUNT_MILESTONE: {
        key: 'ORDER_COUNT_MILESTONE',
        label: `Place ${ORDER_COUNT_MILESTONE} Orders in 1 Year`,
        description: 'For our most loyal customers.',
        points: 1000,
        cadence: CADENCE.ONCE,
        trigger: TRIGGER.DERIVED,
        category: CATEGORY.PURCHASE,
        orderCount: ORDER_COUNT_MILESTONE,
        windowDays: ORDER_COUNT_WINDOW_DAYS
    },
    RECURRING_PURCHASE: {
        key: 'RECURRING_PURCHASE',
        label: `Every ${RECURRING_PURCHASE_INTERVAL}rd Purchase of PKR ${RECURRING_PURCHASE_THRESHOLD_PKR.toLocaleString('en-PK')}+`,
        description: 'A standing bonus that keeps paying out.',
        points: 300,
        cadence: CADENCE.REPEATABLE,
        trigger: TRIGGER.DERIVED,
        category: CATEGORY.PURCHASE,
        thresholdPkr: RECURRING_PURCHASE_THRESHOLD_PKR,
        interval: RECURRING_PURCHASE_INTERVAL
    }
};

// Deliberately NOT implemented: the reference programme's paid membership
// tier ("Join All-Access", 200 points). It was the one item excluded from
// the brief, and it needs a subscription/billing product behind it that this
// codebase does not have. Adding it later means adding a rule here plus a
// membership check - no change to the engine.

// Everything the business still has to decide. Surfaced through the admin
// endpoint so the values in use are visible without reading the source.
const PENDING_BUSINESS_SIGN_OFF = [
    'All point values below are provisional, carried over from the reference programme.',
    `HIGH_VALUE_ORDER threshold: PKR ${ORDER_VALUE_THRESHOLD_PKR} (placeholder for the $200 tier).`,
    `RECURRING_PURCHASE threshold: PKR ${RECURRING_PURCHASE_THRESHOLD_PKR} (placeholder for the $75 tier).`,
    `Points expiry: ${POINTS_EXPIRY_DAYS} days after earning (placeholder - no expiry policy signed off yet).`,
    'Social profile URLs are placeholder handles - replace with Steth\'s real accounts before launch.',
    'Redemption rate (points -> PKR off an order) is not defined here - see issue #22.'
];

/**
 * Looks up a rule by key.
 * @param {String} key - Rule key, e.g. 'SUBSCRIBE_EMAIL'.
 * @returns {Object|null} The rule definition, or null if the key is unknown.
 */
const getRule = (key) => REWARD_RULES[key] || null;

/**
 * All rules as an array, for catalogue responses.
 * @returns {Array<Object>} Every rule definition.
 */
const listRules = () => Object.values(REWARD_RULES);

/**
 * The rules a customer can claim directly from the rewards page.
 * @returns {Array<Object>} Self-declared rules only.
 */
const listClaimableRules = () => listRules().filter((rule) => rule.trigger === TRIGGER.SELF_DECLARED);

module.exports = {
    CADENCE,
    TRIGGER,
    CATEGORY,
    REWARD_RULES,
    PENDING_BUSINESS_SIGN_OFF,
    ORDER_VALUE_THRESHOLD_PKR,
    RECURRING_PURCHASE_THRESHOLD_PKR,
    POINTS_EXPIRY_DAYS,
    RECURRING_PURCHASE_INTERVAL,
    SECOND_ORDER_WINDOW_DAYS,
    ORDER_COUNT_MILESTONE,
    ORDER_COUNT_WINDOW_DAYS,
    getRule,
    listRules,
    listClaimableRules
};
