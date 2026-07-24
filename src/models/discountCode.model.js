const mongoose = require('mongoose');

const discountCodeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  description: {
    type: String,
    default: '',
  },
  percentage: {
    type: Number,
    required: true,
    min: 1,
    max: 100,
  },
  expiryDate: {
    type: Date,
    required: true,
  },
  // SHA-256 of the normalized (uppercased/trimmed) plaintext code - see
  // utils/discountCodeService.js. The plaintext itself is never stored.
  codeHash: {
    type: String,
    required: true,
    unique: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

module.exports = mongoose.model('DiscountCode', discountCodeSchema);
