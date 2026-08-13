/**
 * Author(s): 1. Zainab Raza
 * Description: Who a messaging-channel sender actually is.
 *
 *              WhatsApp gives us a phone number and Instagram gives us a
 *              scoped user id. Neither is a login, so this collection is the
 *              bridge between "the person messaging us" and a Steth account -
 *              and, where there is no account, the place their details live so
 *              they can still order.
 *
 *              Three states a sender can be in:
 *
 *                unverified  - we have seen this handle but nothing proves who
 *                              owns it. Product and sizing help only. Never
 *                              order history, points, or ordering.
 *                verified    - they proved control of the handle (WhatsApp OTP)
 *                              but have no website account. They can order:
 *                              the delivery address is captured in chat and
 *                              kept here.
 *                linked      - verified AND matched to a User. Full access to
 *                              their orders, points and saved addresses.
 *
 *              Instagram cannot reach 'verified' on its own - the platform
 *              exposes no phone or email to check against - so Instagram
 *              senders stay unverified unless they also verify a phone.
 *
 * Date created: August 13th, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 13th, 2026
 * Run: Not directly runnable - imported by the channel webhook controllers
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const channelIdentitySchema = new Schema({
    channel: {
        type: String,
        required: true,
        enum: ['whatsapp', 'instagram']
    },
    // The platform's own id for this person: an E.164 phone number for
    // WhatsApp, a page-scoped id for Instagram.
    handle: {
        type: String,
        required: true,
        trim: true
    },
    status: {
        type: String,
        enum: ['unverified', 'verified', 'linked'],
        default: 'unverified'
    },
    user: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    displayName: { type: String, trim: true },

    // Set once the sender proves control of the handle.
    verifiedAt: Date,

    // Where a channel-only customer's orders go. Only used when there is no
    // linked account - a linked customer's saved addresses are authoritative,
    // because those were entered somewhere reviewable.
    deliveryAddress: {
        fullName: String,
        addressLine1: String,
        addressLine2: String,
        city: String,
        state: String,
        postalCode: String,
        country: { type: String, default: 'Pakistan' },
        phoneNumber: String
    },

    lastSeenAt: { type: Date, default: Date.now }
}, { timestamps: true });

// One identity per handle per channel - the lookup every inbound message makes.
channelIdentitySchema.index({ channel: 1, handle: 1 }, { unique: true });

module.exports = mongoose.model('ChannelIdentity', channelIdentitySchema);
