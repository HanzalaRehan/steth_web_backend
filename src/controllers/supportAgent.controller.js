/**
 * Author(s): 1. Zainab Raza
 * Description: HTTP layer for the customer support agent - the website
 *              channel. WhatsApp and Instagram will add their own webhook
 *              controllers that call the same service, so nothing
 *              channel-specific belongs here beyond the transport.
 *
 *              Endpoints:
 *                POST /api/support/chat   - send a message, get a reply
 *                GET  /api/support/status - is the agent configured and ready
 *
 *              Identity comes from the auth token, never from the request
 *              body. A signed-in customer gets their orders and points; an
 *              anonymous visitor gets product and sizing help only. Letting
 *              the body carry a userId would let anyone read anyone's orders
 *              by typing an id - see the security note in
 *              src/mcp/supportTools.js.
 *
 * Date created: August 13th, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 13th, 2026
 * Run: Not directly runnable - mounted by src/routes/supportAgent.routes.js
 */

const supportAgent = require('../services/supportAgent.service');
const { catchAsync } = require('../utils/errorHandler');

// A conversation is replayed to the model on every turn, so history has to be
// bounded or a long chat grows without limit. Keeps the last N messages.
const MAX_HISTORY_MESSAGES = 40;

/**
 * POST /api/support/chat
 * Body: { message, history? }. History is client-held so the agent stays
 * stateless - which is what lets the same service back a webhook, where there
 * is no session to hang state off.
 */
exports.chat = catchAsync(async (req, res) => {
    const { message, history } = req.body;

    if (!message || !String(message).trim()) {
        return res.status(400).json({ success: false, message: 'A message is required.' });
    }

    const status = supportAgent.getAgentStatus();
    if (!status.ready) {
        return res.status(503).json({
            success: false,
            message: 'The support agent is not configured.',
            missing: status.missing
        });
    }

    // attachUserIfPresent populates req.user when a valid token is sent, so a
    // signed-out visitor still gets a useful agent - just without account data.
    const context = {
        userId: req.user ? req.user._id : null,
        email: req.user ? req.user.email : null,
        channel: 'website'
    };

    const trimmedHistory = Array.isArray(history) ? history.slice(-MAX_HISTORY_MESSAGES) : [];

    let result;
    try {
        result = await supportAgent.handleMessage({
            message: String(message).trim(),
            history: trimmedHistory,
            context
        });
    } catch (error) {
        // A provider outage should read as "support is down", not a stack trace.
        console.error('[support-agent] chat failed:', error.message);
        return res.status(502).json({
            success: false,
            message: 'The support agent is unavailable right now. Please try again shortly.'
        });
    }

    res.status(200).json({
        success: true,
        data: {
            reply: result.reply,
            history: result.history.slice(-MAX_HISTORY_MESSAGES),
            toolsUsed: result.toolsUsed,
            escalated: result.escalated,
            identified: Boolean(context.userId)
        }
    });
});

/**
 * GET /api/support/status
 * Public readiness check - lets the widget hide itself rather than offering a
 * chat that cannot answer.
 */
exports.status = catchAsync(async (req, res) => {
    const status = supportAgent.getAgentStatus();
    res.status(200).json({
        success: true,
        data: {
            ready: status.ready,
            provider: status.provider,
            // Not the key, just which one is missing, so a developer can see
            // what to set without exposing anything.
            missing: status.missing
        }
    });
});
