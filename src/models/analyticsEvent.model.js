const mongoose = require('mongoose');

const analyticsEventSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    enum: ['pageview', 'click', 'form', 'search'],
    required: true,
  },
  page: String,
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

analyticsEventSchema.index({ sessionId: 1, timestamp: 1 });
analyticsEventSchema.index({ type: 1, page: 1 });
// Part B.5 - analyticsDashboard.controller.js's getFunnel filters exactly
// on {type:'pageview', timestamp:{$gte}}, which the two indexes above
// don't cover well (neither leads with type+timestamp together).
analyticsEventSchema.index({ type: 1, timestamp: 1 });

module.exports = mongoose.model('AnalyticsEvent', analyticsEventSchema);
