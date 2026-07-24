const mongoose = require('mongoose');

// Backend-only for now (Part B.4) - no public storefront submission form
// exists yet, so admin CRUD covers the full lifecycle including logging a
// request that came in through another channel (email, etc.).
const affiliateRequestSchema = new mongoose.Schema({
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
  message: {
    type: String,
    default: '',
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  },
  reviewedAt: {
    type: Date,
    default: null,
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
}, { timestamps: true });

module.exports = mongoose.model('AffiliateRequest', affiliateRequestSchema);
