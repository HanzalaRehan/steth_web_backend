/**
 * Author(s): 1. Zainab Raza
 * Description: A conversation the agent handed over to a human - the support
 *              queue.
 *
 *              This exists so that "a colleague will get back to you" is a
 *              statement of fact rather than a courtesy. Before it, escalation
 *              wrote a console line: the customer was told someone would
 *              follow up, and nobody ever knew. A promise the system cannot
 *              keep is worse than telling them plainly that we cannot help.
 *
 *              Every channel lands here in the same shape, so one queue covers
 *              website chat, WhatsApp and Instagram. `handle` is how to reach
 *              them back - a phone number on WhatsApp, an email for a
 *              signed-in web customer, an Instagram id otherwise.
 *
 *              Deliberately not auto-resolved: an escalation stays open until
 *              a person closes it, because the whole point is that a human,
 *              not this system, decides when the customer has been helped.
 *
 * Date created: August 17th, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 17th, 2026
 * Run: Not directly runnable - written by src/mcp/supportTools.js
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const supportEscalationSchema = new Schema({
    channel: {
        type: String,
        required: true,
        enum: ['website', 'whatsapp', 'instagram', 'test']
    },
    // Why the agent handed over, in its own words. This is what a human reads
    // first, so it is stored verbatim rather than categorised.
    reason: {
        type: String,
        required: true,
        trim: true
    },
    // Whatever identity we have. All optional: an anonymous website visitor
    // with a complaint still deserves a human, even though we can only reply
    // if they left contact details.
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    channelIdentity: { type: Schema.Types.ObjectId, ref: 'ChannelIdentity', default: null },
    handle: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },

    status: {
        type: String,
        enum: ['open', 'in-progress', 'resolved'],
        default: 'open'
    },
    // Whether the notification actually reached anyone. If this is false the
    // escalation is still queued and safe - it just needs someone to look at
    // the queue rather than their inbox.
    notified: { type: Boolean, default: false },
    resolvedAt: Date,
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

// The queue view: oldest open escalations first, which is the order a support
// person should work through them.
supportEscalationSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('SupportEscalation', supportEscalationSchema);
