// Single Redis connection, reused by the analytics queue today and by the
// B.5 caching work later (see CLAUDE.md: don't stand up a second instance).
const IORedis = require('ioredis');
const { Queue } = require('bullmq');

let connection = null;
let analyticsQueue = null;

const getRedisConnection = () => {
  if (!connection) {
    connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: null, // required by BullMQ
      lazyConnect: false,
    });
    connection.on('error', (err) => {
      console.error('Redis connection error:', err.message);
    });
  }
  return connection;
};

const getAnalyticsQueue = () => {
  if (!analyticsQueue) {
    analyticsQueue = new Queue('analytics', { connection: getRedisConnection() });
  }
  return analyticsQueue;
};

module.exports = {
  getRedisConnection,
  getAnalyticsQueue,
};
