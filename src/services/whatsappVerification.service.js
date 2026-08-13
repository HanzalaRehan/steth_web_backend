/**
 * Author(s): 1. Zainab Raza
 * Description: One-time-code verification for WhatsApp numbers - the thing
 *              that turns "someone typed this number into a form" into "this
 *              person controls this number".
 *
 *              Two problems depend on it:
 *
 *                Consent. The loyalty programme pays for subscribing to
 *                WhatsApp, but anyone can type a stranger's number. Nothing
 *                may be sent to a number until its owner confirms it, which is
 *                why marketingOptIns.whatsappVerified exists and why nothing
 *                set it until now.
 *
 *                Identity. A WhatsApp message arrives with a phone number, not
 *                a login. Matching that against an account is only safe if the
 *                account proved it owns the number - otherwise claiming a
 *                number would hand over someone else's order history.
 *
 *              The code is delivered through the same WhatsApp Cloud API that
 *              carries the agent's replies, so no separate SMS provider is
 *              needed. When credentials are absent the code is logged instead
 *              of sent, which makes the whole flow testable before the Meta
 *              account exists.
 *
 *              Key functions:
 *                - startVerification    : issue and send a code
 *                - confirmVerification  : check a code and mark the number verified
 *
 * Date created: August 13th, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 13th, 2026
 * Run: Not directly runnable - imported by src/controllers/rewards.controller.js
 */

const crypto = require('crypto');
const User = require('../models/user.model');
const ChannelIdentity = require('../models/channelIdentity.model');
const { sendWhatsappMessage, getWhatsappConfig } = require('../controllers/whatsapp.controller');

// Short enough that a leaked code is stale quickly, long enough that a
// customer can switch apps, read it and come back.
const CODE_TTL_MINUTES = 10;

// A six-digit code is 1-in-a-million per guess; the attempt limit is what
// actually makes that safe, since without one an attacker could simply try
// every code.
const MAX_ATTEMPTS = 5;

// Stops someone using us to send repeated WhatsApp messages to a number that
// is not theirs - the harassment vector, not the security one.
const RESEND_COOLDOWN_SECONDS = 60;

/**
 * A cryptographically random six-digit code.
 * Math.random is unsuitable here - it is predictable enough to guess.
 * @returns {String} Six digits, zero-padded.
 */
const generateCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

/**
 * Codes are stored hashed, never in clear. A leaked database should not hand
 * over the ability to verify other people's numbers.
 * @param {String} code - The plain code.
 * @returns {String} SHA-256 hash.
 */
const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

/**
 * Issues a code and sends it to the number.
 *
 * @param {ObjectId} userId - The account claiming the number.
 * @param {String} whatsappNumber - Canonical E.164 number.
 * @returns {Promise<Object>} { sent, delivery, retryAfterSeconds?, devCode? }
 * @throws {Error} If the number is already verified on another account.
 */
const startVerification = async (userId, whatsappNumber) => {
    // One verified number per account, so a single number cannot be used to
    // reach several accounts' order histories.
    const takenBy = await User.findOne({
        'marketingOptIns.whatsappNumber': whatsappNumber,
        'marketingOptIns.whatsappVerified': true,
        _id: { $ne: userId }
    }).select('_id');

    if (takenBy) throw new Error('That number is already verified on another account.');

    const user = await User.findById(userId).select('marketingOptIns username');
    if (!user) throw new Error('Account not found.');

    const pending = user.marketingOptIns?.whatsappVerification;
    if (pending?.sentAt) {
        const elapsed = (Date.now() - new Date(pending.sentAt).getTime()) / 1000;
        if (elapsed < RESEND_COOLDOWN_SECONDS) {
            return { sent: false, retryAfterSeconds: Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed) };
        }
    }

    const code = generateCode();

    await User.findByIdAndUpdate(userId, {
        $set: {
            'marketingOptIns.whatsappNumber': whatsappNumber,
            // Claiming a new number drops any previous verification - the
            // customer is no longer asserting the old one.
            'marketingOptIns.whatsappVerified': false,
            'marketingOptIns.whatsappVerification': {
                codeHash: hashCode(code),
                expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000),
                attempts: 0,
                sentAt: new Date()
            }
        }
    });

    const { ready } = getWhatsappConfig();
    const body = `Your Steth verification code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes. If you did not ask for this, ignore this message.`;

    if (ready) {
        await sendWhatsappMessage(whatsappNumber, body);
        return { sent: true, delivery: 'whatsapp' };
    }

    // No credentials yet. Log it so the flow is fully testable before the Meta
    // account exists - and return it only outside production, so a deployed
    // server can never hand a code to whoever asked for it.
    console.log(`[whatsapp-verification] code for ${whatsappNumber}: ${code}`);
    return {
        sent: false,
        delivery: 'not-configured',
        devCode: process.env.NODE_ENV === 'production' ? undefined : code
    };
};

/**
 * Checks a submitted code and, if it matches, marks the number verified and
 * links any WhatsApp conversation already running from it.
 *
 * @param {ObjectId} userId - The account verifying.
 * @param {String} code - What the customer typed.
 * @returns {Promise<Object>} { verified, reason? }
 */
const confirmVerification = async (userId, code) => {
    const user = await User.findById(userId).select('marketingOptIns');
    const pending = user?.marketingOptIns?.whatsappVerification;

    if (!pending?.codeHash) return { verified: false, reason: 'no-pending-code' };
    if (new Date(pending.expiresAt) < new Date()) return { verified: false, reason: 'expired' };
    if (pending.attempts >= MAX_ATTEMPTS) return { verified: false, reason: 'too-many-attempts' };

    // Count the attempt before comparing, so a wrong guess always costs one
    // even if the request is abandoned mid-flight.
    await User.findByIdAndUpdate(userId, { $inc: { 'marketingOptIns.whatsappVerification.attempts': 1 } });

    if (hashCode(code) !== pending.codeHash) return { verified: false, reason: 'incorrect' };

    await User.findByIdAndUpdate(userId, {
        $set: {
            'marketingOptIns.whatsapp': true,
            'marketingOptIns.whatsappVerified': true,
            'marketingOptIns.whatsappVerifiedAt': new Date()
        },
        // The code has done its job; keeping it around is only risk.
        $unset: { 'marketingOptIns.whatsappVerification': '' }
    });

    // If this person already messaged us from that number, that conversation
    // is now provably theirs - link it so the agent can see their orders
    // without them having to say anything else.
    await ChannelIdentity.findOneAndUpdate(
        { channel: 'whatsapp', handle: user.marketingOptIns.whatsappNumber },
        { $set: { user: userId, status: 'linked', verifiedAt: new Date() } }
    );

    return { verified: true };
};

module.exports = {
    CODE_TTL_MINUTES,
    MAX_ATTEMPTS,
    RESEND_COOLDOWN_SECONDS,
    startVerification,
    confirmVerification
};
