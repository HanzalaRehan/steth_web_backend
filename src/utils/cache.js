// Part B.5 - generic read-through cache built on the single shared Redis
// connection from src/config/redis.js (same instance as the analytics
// queue - don't stand up a second Redis instance for this).
//
// Caching is best-effort, same philosophy as the analytics pipeline: if
// Redis is unreachable, every function here falls back to running the
// real query instead of throwing, so a cache outage never breaks a
// storefront request.
const { getRedisConnection } = require('../config/redis');

// Fixed-key caches (fabrics/categories/colors/customers-also-bought) are
// invalidated directly by key. Query-varying caches (product listings,
// which have unbounded filter/sort/page combinations) use a version
// counter instead - bumping the version invalidates every previously
// cached variation at once without needing to enumerate or SCAN for them.
const VERSION_PREFIX = 'cache:version:';

const getOrSetCache = async (key, ttlSeconds, fetchFn) => {
  let redis;
  try {
    redis = getRedisConnection();
    const cached = await redis.get(key);
    if (cached !== null) return JSON.parse(cached);
  } catch (error) {
    console.error(`Cache read failed for ${key} (falling back to live query):`, error.message);
  }

  const fresh = await fetchFn();

  try {
    if (redis) await redis.set(key, JSON.stringify(fresh), 'EX', ttlSeconds);
  } catch (error) {
    console.error(`Cache write failed for ${key} (non-blocking):`, error.message);
  }

  return fresh;
};

const invalidateCache = async (key) => {
  try {
    await getRedisConnection().del(key);
  } catch (error) {
    console.error(`Cache invalidation failed for ${key} (non-blocking):`, error.message);
  }
};

const getCacheVersion = async (namespace) => {
  try {
    const version = await getRedisConnection().get(`${VERSION_PREFIX}${namespace}`);
    return version || '1';
  } catch (error) {
    console.error(`Cache version read failed for ${namespace}:`, error.message);
    return '1';
  }
};

const bumpCacheVersion = async (namespace) => {
  try {
    await getRedisConnection().incr(`${VERSION_PREFIX}${namespace}`);
  } catch (error) {
    console.error(`Cache version bump failed for ${namespace} (non-blocking):`, error.message);
  }
};

module.exports = {
  getOrSetCache,
  invalidateCache,
  getCacheVersion,
  bumpCacheVersion,
};
