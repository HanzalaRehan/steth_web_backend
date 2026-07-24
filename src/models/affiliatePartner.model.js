const mongoose = require('mongoose');
const crypto = require('crypto');

// Same unguessable-secret generation pattern as GiftCard.model.js's code -
// this is a real, usable referral code, not a display label.
const generateReferralCode = () => crypto.randomBytes(6).toString('hex').toUpperCase();

const affiliatePartnerSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
  },
  referralCode: {
    type: String,
    required: true,
    unique: true,
    default: generateReferralCode,
  },
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active',
  },
  sourceRequest: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AffiliateRequest',
    default: null,
  },
}, { timestamps: true });

module.exports = mongoose.model('AffiliatePartner', affiliatePartnerSchema);
