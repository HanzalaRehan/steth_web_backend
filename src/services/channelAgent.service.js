/**
 * Author(s): 1. Zainab Raza
 * Description: The bridge between a messaging channel and the support agent.
 *
 *              Every inbound WhatsApp or Instagram message goes through
 *              handleChannelMessage, which does the four things a webhook
 *              cannot sensibly do itself:
 *
 *                1. Deduplicates. Meta retries a webhook until it gets a 200,
 *                   so the same message id can arrive several times. Re-running
 *                   the agent on a retry could place a second order.
 *                2. Resolves who is speaking - see channelIdentity.model.js.
 *                   A phone number is not a login, so what the agent may do
 *                   depends on whether that handle has been proven.
 *                3. Loads and saves conversation history, because there is no
 *                   client here to hold it.
 *                4. Calls the same agent the website calls. Nothing about the
 *                   agent changes per channel.
 *
 *              Key functions:
 *                - resolveIdentity       : handle -> who this is, and what they may do
 *                - handleChannelMessage  : the full inbound path
 *
 * Date created: August 13th, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 13th, 2026
 * Run: Not directly runnable - imported by the channel webhook controllers
 */

const ChannelIdentity = require('../models/channelIdentity.model');
const Conversation = require('../models/conversation.model');
const User = require('../models/user.model');
const supportAgent = require('./supportAgent.service');

/**
 * Finds or creates the identity behind a channel handle, and links it to a
 * Steth account when one provably belongs to the same person.
 *
 * Linking only ever happens on a *verified* WhatsApp number matched against a
 * number the account itself verified. Matching on an unverified number would
 * hand a stranger's order history to whoever typed that number into a form.
 *
 * @param {String} channel - 'whatsapp' or 'instagram'.
 * @param {String} handle - Phone number (E.164) or Instagram scoped id.
 * @param {Object} [profile] - { displayName } from the webhook payload.
 * @returns {Promise<Object>} The ChannelIdentity document.
 */
const resolveIdentity = async (channel, handle, profile = {}) => {
    let identity = await ChannelIdentity.findOne({ channel, handle });

    if (!identity) {
        identity = await ChannelIdentity.create({
            channel,
            handle,
            displayName: profile.displayName,
            status: 'unverified'
        });
    }

    // A WhatsApp sender is talking from the number itself, which is stronger
    // evidence than anything typed into a form: the platform delivered the
    // message from that handset. If an account has verified this same number,
    // they are the same person.
    if (channel === 'whatsapp' && identity.status !== 'linked') {
        const owner = await User.findOne({
            'marketingOptIns.whatsappNumber': handle,
            'marketingOptIns.whatsappVerified': true
        }).select('_id email');

        if (owner) {
            identity.user = owner._id;
            identity.status = 'linked';
            identity.verifiedAt = identity.verifiedAt || new Date();
        }
    }

    if (profile.displayName && !identity.displayName) identity.displayName = profile.displayName;
    identity.lastSeenAt = new Date();
    await identity.save();

    return identity;
};

/**
 * The context handed to the agent's tools for this sender.
 *
 * userId is only ever set for a linked identity, which is what stops an
 * unproven handle reading someone's orders - the tools already refuse without
 * it, so this is the single place that decides.
 *
 * @param {Object} identity - ChannelIdentity document.
 * @returns {Promise<Object>} Tool context.
 */
const buildContext = async (identity) => {
    const context = {
        channel: identity.channel,
        userId: null,
        email: null,
        // Lets order tools serve a verified customer who has no website
        // account - their address lives on the identity instead.
        channelIdentityId: identity._id,
        identityStatus: identity.status
    };

    if (identity.status === 'linked' && identity.user) {
        const user = await User.findById(identity.user).select('email');
        context.userId = identity.user;
        context.email = user ? user.email : null;
    }

    return context;
};

/**
 * Processes one inbound message, end to end.
 *
 * @param {Object} params
 * @param {String} params.channel - 'whatsapp' | 'instagram'.
 * @param {String} params.handle - Sender's phone number or scoped id.
 * @param {String} params.messageId - Platform message id, for deduplication.
 * @param {String} params.text - What they said.
 * @param {Object} [params.profile] - { displayName }.
 * @returns {Promise<Object>} { reply, duplicate, identityStatus }
 */
const handleChannelMessage = async ({ channel, handle, messageId, text, profile = {} }) => {
    const conversation =
        (await Conversation.findOne({ channel, handle })) ||
        (await Conversation.create({ channel, handle, messages: [] }));

    // Guard against Meta's retries before anything else happens - the whole
    // point is that a retry must not reach the agent.
    if (messageId && conversation.handledMessageIds.includes(messageId)) {
        return { reply: null, duplicate: true, identityStatus: null };
    }

    const identity = await resolveIdentity(channel, handle, profile);
    const context = await buildContext(identity);

    const result = await supportAgent.handleMessage({
        message: text,
        history: conversation.messages,
        context
    });

    // Record the id first: if saving history fails we would rather lose the
    // transcript than re-run an order on the retry.
    if (messageId) {
        conversation.handledMessageIds = [
            ...conversation.handledMessageIds,
            messageId
        ].slice(-Conversation.MAX_HANDLED_IDS);
    }

    conversation.messages = result.history.slice(-Conversation.MAX_STORED_MESSAGES);
    conversation.lastMessageAt = new Date();
    conversation.expiresAt = new Date(
        Date.now() + Conversation.CONVERSATION_TTL_DAYS * 24 * 60 * 60 * 1000
    );
    await conversation.save();

    return {
        reply: result.reply,
        duplicate: false,
        identityStatus: identity.status,
        toolsUsed: result.toolsUsed,
        escalated: result.escalated
    };
};

module.exports = {
    resolveIdentity,
    buildContext,
    handleChannelMessage
};
