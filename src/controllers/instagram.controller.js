/**
 * Author(s): 1. Zainab Raza
 * Description: Instagram Messaging webhook - the second channel for the
 *              support agent, sharing everything below the transport with
 *              WhatsApp.
 *
 *              Instagram differs from WhatsApp in three ways that matter:
 *
 *                Payload shape. Messages arrive under entry[].messaging[]
 *                rather than entry[].changes[].value.messages[], so the
 *                extraction is genuinely different even though everything
 *                after it is identical.
 *
 *                Echoes. Instagram delivers the page's OWN outgoing messages
 *                back to the webhook with is_echo set. Acting on those makes
 *                the agent answer itself, forever. Ignoring them is not an
 *                optimisation - it is what stops an infinite loop.
 *
 *                Identity. Instagram gives a page-scoped user id and nothing
 *                else: no phone, no email. There is no way to prove that
 *                sender owns a Steth account, so an Instagram sender can never
 *                reach 'verified'. They get product and sizing help only, and
 *                the tool layer already refuses account data without a linked
 *                user - see channelIdentity.model.js.
 *
 *              Configuration (all from env, none committed):
 *                INSTAGRAM_VERIFY_TOKEN - shared secret for the handshake
 *                INSTAGRAM_APP_SECRET   - signs inbound webhooks (falls back to
 *                                         META_APP_SECRET; one Meta app usually
 *                                         serves both channels)
 *                INSTAGRAM_TOKEN        - page access token for replies
 *                INSTAGRAM_ACCOUNT_ID   - the Instagram professional account id
 *
 * Date created: August 13th, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 13th, 2026
 * Run: Not directly runnable - mounted by src/routes/channels.routes.js
 */

const crypto = require('crypto');
const channelAgent = require('../services/channelAgent.service');
const { catchAsync } = require('../utils/errorHandler');

const GRAPH_VERSION = 'v21.0';

/**
 * The signing secret for this channel. Instagram and WhatsApp normally live in
 * the same Meta app and share one secret, so a single META_APP_SECRET is
 * accepted rather than forcing the same value to be set twice.
 * @returns {String|undefined} The app secret.
 */
const getAppSecret = () => process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET;

/**
 * Whether the Instagram channel has everything it needs to run.
 * @returns {Object} { ready, missing }
 */
const getInstagramConfig = () => {
    const missing = [];
    if (!process.env.INSTAGRAM_VERIFY_TOKEN) missing.push('INSTAGRAM_VERIFY_TOKEN');
    if (!getAppSecret()) missing.push('INSTAGRAM_APP_SECRET');
    if (!process.env.INSTAGRAM_TOKEN) missing.push('INSTAGRAM_TOKEN');
    if (!process.env.INSTAGRAM_ACCOUNT_ID) missing.push('INSTAGRAM_ACCOUNT_ID');
    return { ready: missing.length === 0, missing };
};

/**
 * Confirms a webhook really came from Meta. Same scheme as WhatsApp: HMAC over
 * the exact bytes received, compared in constant time.
 * @param {Object} req - Express request, with rawBody captured by the parser.
 * @returns {Boolean} True when the signature matches.
 */
const hasValidSignature = (req) => {
    const header = req.get('x-hub-signature-256');
    const secret = getAppSecret();
    if (!header || !secret) return false;

    const raw = req.rawBody || JSON.stringify(req.body);
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');

    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * Sends a reply back through the Instagram Send API.
 * @param {String} recipientId - The sender's page-scoped id.
 * @param {String} body - Message text.
 * @returns {Promise<void>}
 */
const sendInstagramMessage = async (recipientId, body) => {
    const { ready } = getInstagramConfig();
    if (!ready || !body) return;

    const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.INSTAGRAM_ACCOUNT_ID}/messages`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.INSTAGRAM_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                recipient: { id: recipientId },
                // Instagram caps a direct message at 1000 characters, well
                // below WhatsApp - replies have to be trimmed harder.
                message: { text: body.slice(0, 950) }
            })
        }
    );

    if (!res.ok) {
        const detail = await res.text();
        console.error('[instagram] send failed:', res.status, detail.slice(0, 300));
    }
};

/**
 * GET /api/channels/instagram/webhook
 * Meta's subscription handshake.
 */
exports.verifyWebhook = (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
};

/**
 * POST /api/channels/instagram/webhook
 * Inbound direct messages.
 */
exports.receiveWebhook = catchAsync(async (req, res) => {
    if (!hasValidSignature(req)) {
        console.warn('[instagram] rejected a webhook with an invalid signature');
        return res.sendStatus(403);
    }

    // Acknowledge first - Meta retries anything slow, and a retry re-delivers
    // a message we are already answering.
    res.sendStatus(200);

    try {
        for (const entry of req.body.entry || []) {
            for (const event of entry.messaging || []) {
                const message = event.message;
                if (!message) continue;

                // Our own outgoing message, delivered back to us. Acting on it
                // would make the agent reply to itself indefinitely.
                if (message.is_echo) continue;

                const senderId = event.sender?.id;
                if (!senderId) continue;

                // Text only. A photo or voice note would need media handling
                // before the agent could do anything useful with it.
                if (!message.text) {
                    await sendInstagramMessage(
                        senderId,
                        'I can only read text messages at the moment. Could you type it instead?'
                    );
                    continue;
                }

                const result = await channelAgent.handleChannelMessage({
                    channel: 'instagram',
                    handle: senderId,
                    messageId: message.mid,
                    text: message.text
                });

                if (!result.duplicate && result.reply) {
                    await sendInstagramMessage(senderId, result.reply);
                }
            }
        }
    } catch (error) {
        console.error('[instagram] processing failed:', error.message);
    }
});

/**
 * GET /api/channels/instagram/status
 * Whether the channel is configured. Never returns secrets.
 */
exports.status = (req, res) => {
    const { ready, missing } = getInstagramConfig();
    res.status(200).json({
        success: true,
        data: {
            channel: 'instagram',
            ready,
            missing,
            // Instagram senders can order and track their own orders: Meta
            // authenticates the sender id on every signed webhook, so the
            // thread itself is the identity. What they cannot reach is a Steth
            // ACCOUNT - Instagram exposes no phone or email to match on - so
            // account order history and reward points stay out of reach.
            capabilities:
                'products, sizing, ordering and tracking own orders; no account linking (no phone or email exposed by Instagram)'
        }
    });
};

exports.sendInstagramMessage = sendInstagramMessage;
exports.getInstagramConfig = getInstagramConfig;
