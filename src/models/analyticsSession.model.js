const mongoose = require('mongoose');

const analyticsSessionSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true,
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  entryPage: String,
  exitPage: String,
  userAgent: String,
  firstSeenAt: {
    type: Date,
    default: Date.now,
  },
  lastSeenAt: {
    type: Date,
    default: Date.now,
  },
}, { timestamps: true });

analyticsSessionSchema.index({ customerId: 1 });
analyticsSessionSchema.index({ firstSeenAt: -1 });

module.exports = mongoose.model('AnalyticsSession', analyticsSessionSchema);
