const mongoose = require('mongoose');
const crypto = require('crypto');
const Schema = mongoose.Schema;

// code is a random unguessable secret (unlike the sequential ORDER-YYYYMMDD-xxx
// / SHIP-YYYYMMDD-xxx IDs used elsewhere) since it carries real redeemable value.
const generateCode = () => crypto.randomBytes(6).toString('hex').toUpperCase();

const giftCardSchema = new Schema({
    code: {
        type: String,
        required: true,
        unique: true,
        default: generateCode
    },
    initialBalance: {
        type: Number,
        required: [true, 'Initial balance is required'],
        min: 1
    },
    currentBalance: {
        type: Number,
        required: true,
        min: 0
    },
    purchaserId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    recipientEmail: {
        type: String,
        required: [true, 'Recipient email is required'],
        trim: true,
        lowercase: true
    },
    expiryDate: {
        type: Date,
        required: true
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

module.exports = mongoose.model('GiftCard', giftCardSchema);
