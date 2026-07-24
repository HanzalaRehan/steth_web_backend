const mongoose = require('mongoose');

// Stores raw rrweb event chunks as they're flushed from the client, keyed
// by sessionId so the admin viewer can fetch and replay them in order.
const replaySnapshotSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
  },
  events: {
    type: [mongoose.Schema.Types.Mixed],
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

replaySnapshotSchema.index({ sessionId: 1, timestamp: 1 });

module.exports = mongoose.model('ReplaySnapshot', replaySnapshotSchema);
