/**
 * Author(s): 1. Zainab Raza
 * Description: Server-side conversation history for the messaging channels.
 *
 *              The website widget keeps its own history in the browser, which
 *              is why the agent service is stateless. WhatsApp and Instagram
 *              have no client to hold anything - Meta posts one message at a
 *              time and expects a reply - so the history has to live here or
 *              every message would arrive with no memory of the last one.
 *
 *              Two things this also carries, both of which matter for orders:
 *
 *                handledMessageIds - Meta retries a webhook until it gets a
 *                                    200, and a retry must never re-run the
 *                                    agent. Without this a delivery retry
 *                                    could place a second order.
 *                expiresAt         - conversations are transient. A stale
 *                                    thread resurfacing weeks later would
 *                                    confuse the agent with irrelevant
 *                                    context, so they age out.
 *
 * Date created: August 13th, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 13th, 2026
 * Run: Not directly runnable - imported by src/services/channelAgent.service.js
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Long enough that a customer can carry on the next day, short enough that a
// months-old thread does not come back to life.
const CONVERSATION_TTL_DAYS = 7;

// Replayed to the model on every turn, so it has to stay bounded. Older turns
// are dropped from the front.
const MAX_STORED_MESSAGES = 40;

// Meta retries for a while; keeping the last few ids is enough to spot one.
const MAX_HANDLED_IDS = 50;

const conversationSchema = new Schema({
    channel: {
        type: String,
        required: true,
        enum: ['whatsapp', 'instagram']
    },
    handle: {
        type: String,
        required: true,
        trim: true
    },
    // Provider-format messages, exactly as the LLM adapter returns them - the
    // shape differs per provider, so this is deliberately not normalised.
    messages: {
        type: Array,
        default: []
    },
    handledMessageIds: {
        type: [String],
        default: []
    },
    lastMessageAt: { type: Date, default: Date.now },
    expiresAt: {
        type: Date,
        default: () => new Date(Date.now() + CONVERSATION_TTL_DAYS * 24 * 60 * 60 * 1000)
    }
}, { timestamps: true });

conversationSchema.index({ channel: 1, handle: 1 }, { unique: true });

// Mongo removes the document itself once expiresAt passes - no cleanup job.
conversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

conversationSchema.statics.MAX_STORED_MESSAGES = MAX_STORED_MESSAGES;
conversationSchema.statics.MAX_HANDLED_IDS = MAX_HANDLED_IDS;
conversationSchema.statics.CONVERSATION_TTL_DAYS = CONVERSATION_TTL_DAYS;

module.exports = mongoose.model('Conversation', conversationSchema);
