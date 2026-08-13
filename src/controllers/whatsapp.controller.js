/**
 * Author(s): 1. Zainab Raza
 * Description: WhatsApp Cloud API webhook - the channel Steth actually wants
 *              the support agent on.
 *
 *              Meta pushes messages here rather than us polling, so this file
 *              is transport only: verify the request really came from Meta,
 *              pull out who sent what, hand it to the channel service, and
 *              send the reply back through the Graph API. All of the thinking
 *              lives in the agent, which knows nothing about WhatsApp.
 *
 *              Endpoints:
 *                GET  /api/channels/whatsapp/webhook - Meta's subscription
 *                     handshake. Echoes hub.challenge when the verify token
 *                     matches.
 *                POST /api/channels/whatsapp/webhook - inbound messages.
 *
 *              Two things that look odd but are deliberate:
 *
 *                - The POST replies 200 immediately and processes afterwards.
 *                  Meta retries anything slower than a few seconds, and a
 *                  retry would re-deliver a message we are already answering.
 *                  Deduplication in the channel service is the safety net;
 *                  answering fast is what stops it being needed.
 *                - The signature check uses the raw body, not the parsed one.
 *                  Re-serialising JSON changes the bytes and the HMAC will
 *                  never match.
 *
 *              Configuration (all from env, none committed):
 *                WHATSAPP_VERIFY_TOKEN   - shared secret for the handshake
 *                WHATSAPP_APP_SECRET     - signs inbound webhooks
 *                WHATSAPP_TOKEN          - Graph API access token
 *                WHATSAPP_PHONE_NUMBER_ID- which number replies come from
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
 * Whether the WhatsApp channel has everything it needs to run.
 * @returns {Object} { ready, missing }
 */
const getWhatsappConfig = () => {
    const required = [
        'WHATSAPP_VERIFY_TOKEN',
        'WHATSAPP_APP_SECRET',
        'WHATSAPP_TOKEN',
        'WHATSAPP_PHONE_NUMBER_ID'
    ];
    const missing = required.filter((key) => !process.env[key]);
    return { ready: missing.length === 0, missing };
};

/**
 * Confirms a webhook really came from Meta.
 *
 * Without this, anyone who discovers the URL can post messages that look like
 * they came from any customer - and the agent would act on them, including
 * reading order history.
 *
 * @param {Object} req - Express request, with rawBody captured by the parser.
 * @returns {Boolean} True when the signature matches.
 */
const hasValidSignature = (req) => {
    const header = req.get('x-hub-signature-256');
    if (!header || !process.env.WHATSAPP_APP_SECRET) return false;

    // Signed over the exact bytes Meta sent.
    const raw = req.rawBody || JSON.stringify(req.body);
    const expected =
        'sha256=' +
        crypto.createHmac('sha256', process.env.WHATSAPP_APP_SECRET).update(raw).digest('hex');

    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    // Constant-time, so a wrong signature cannot be discovered byte by byte.
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * Sends a reply back to the customer through the Graph API.
 * @param {String} to - Recipient's phone number.
 * @param {String} body - Message text.
 * @returns {Promise<void>}
 */
const sendWhatsappMessage = async (to, body) => {
    const { ready } = getWhatsappConfig();
    if (!ready || !body) return;

    const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to,
                type: 'text',
                // WhatsApp caps a text message at 4096 characters.
                text: { body: body.slice(0, 4000) }
            })
        }
    );

    if (!res.ok) {
        const detail = await res.text();
        console.error('[whatsapp] send failed:', res.status, detail.slice(0, 300));
    }
};

/**
 * GET /api/channels/whatsapp/webhook
 * Meta's one-time subscription handshake.
 */
exports.verifyWebhook = (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
        // Must be echoed back as plain text, not JSON.
        return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
};

/**
 * POST /api/channels/whatsapp/webhook
 * Inbound messages.
 */
exports.receiveWebhook = catchAsync(async (req, res) => {
    if (!hasValidSignature(req)) {
        console.warn('[whatsapp] rejected a webhook with an invalid signature');
        return res.sendStatus(403);
    }

    // Acknowledge before doing any work - see the header note on retries.
    res.sendStatus(200);

    try {
        for (const entry of req.body.entry || []) {
            for (const change of entry.changes || []) {
                const value = change.value || {};
                const contacts = value.contacts || [];

                for (const message of value.messages || []) {
                    // Only text for now. Images and voice notes would need
                    // transcription or media download before the agent could
                    // do anything useful with them.
                    if (message.type !== 'text') {
                        await sendWhatsappMessage(
                            message.from,
                            'I can only read text messages at the moment. Could you type it instead?'
                        );
                        continue;
                    }

                    const profile = contacts.find((c) => c.wa_id === message.from);

                    const result = await channelAgent.handleChannelMessage({
                        channel: 'whatsapp',
                        handle: message.from,
                        messageId: message.id,
                        text: message.text.body,
                        profile: { displayName: profile?.profile?.name }
                    });

                    if (!result.duplicate && result.reply) {
                        await sendWhatsappMessage(message.from, result.reply);
                    }
                }
            }
        }
    } catch (error) {
        // Already acknowledged, so there is nothing to return - but a silent
        // failure here means a customer is left without a reply.
        console.error('[whatsapp] processing failed:', error.message);
    }
});

/**
 * GET /api/channels/whatsapp/status
 * Whether the channel is configured, for diagnostics. Never returns secrets.
 */
exports.status = (req, res) => {
    const { ready, missing } = getWhatsappConfig();
    res.status(200).json({ success: true, data: { channel: 'whatsapp', ready, missing } });
};

exports.sendWhatsappMessage = sendWhatsappMessage;
exports.getWhatsappConfig = getWhatsappConfig;
