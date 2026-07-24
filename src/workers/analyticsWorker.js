// Standalone entry point - run via `npm run worker`, never forked in-process
// from server.js. Deployed as its own always-on process (e.g. a separate
// Render Background Worker service) once Redis is provisioned.
require('dotenv').config();
const mongoose = require('mongoose');
const { Worker } = require('bullmq');
const { getRedisConnection } = require('../config/redis');
const AnalyticsSession = require('../models/analyticsSession.model');
const AnalyticsEvent = require('../models/analyticsEvent.model');
const ReplaySnapshot = require('../models/replaySnapshot.model');

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('[analyticsWorker] Connected to MongoDB'))
  .catch((err) => console.error('[analyticsWorker] MongoDB connection error:', err));

const touchSession = async (sessionId, { entryPage, exitPage, userAgent } = {}) => {
  const update = { $set: { lastSeenAt: new Date() }, $setOnInsert: { firstSeenAt: new Date() } };
  if (entryPage) update.$setOnInsert.entryPage = entryPage;
  if (exitPage) update.$set.exitPage = exitPage;
  if (userAgent) update.$set.userAgent = userAgent;

  await AnalyticsSession.findOneAndUpdate(
    { sessionId },
    update,
    { upsert: true, new: true }
  );
};

const processIngestEvents = async (job) => {
  const { sessionId, events, userAgent } = job.data;

  const docs = events.map((e) => ({
    sessionId,
    type: e.type,
    page: e.page,
    metadata: e.metadata || {},
    timestamp: e.timestamp ? new Date(e.timestamp) : new Date(),
  }));

  if (docs.length > 0) {
    await AnalyticsEvent.insertMany(docs, { ordered: false });
  }

  const pageviews = events.filter((e) => e.type === 'pageview' && e.page);
  const entryPage = pageviews[0]?.page;
  const exitPage = pageviews[pageviews.length - 1]?.page;

  await touchSession(sessionId, { entryPage, exitPage, userAgent });
};

const processIngestReplay = async (job) => {
  const { sessionId, events } = job.data;
  await ReplaySnapshot.create({ sessionId, events, timestamp: new Date() });
  await touchSession(sessionId, {});
};

const worker = new Worker(
  'analytics',
  async (job) => {
    if (job.name === 'ingest-events') return processIngestEvents(job);
    if (job.name === 'ingest-replay') return processIngestReplay(job);
    console.warn(`[analyticsWorker] Unknown job name: ${job.name}`);
  },
  { connection: getRedisConnection() }
);

worker.on('completed', (job) => {
  console.log(`[analyticsWorker] Completed job ${job.id} (${job.name})`);
});

worker.on('failed', (job, err) => {
  console.error(`[analyticsWorker] Job ${job?.id} (${job?.name}) failed:`, err.message);
});

console.log('[analyticsWorker] Worker started, listening on the "analytics" queue');
