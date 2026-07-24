const crypto = require('crypto');
const { getAnalyticsQueue } = require('../config/redis');

const COOKIE_NAME = 'steth_sid';
const COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 365; // 1 year

// Reads the anonymous session id from the cookie, or issues a new one.
// Shared by both ingestion endpoints so a session id is always available
// before enqueueing, without requiring the client to generate its own.
const ensureSessionId = (req, res) => {
  let sessionId = req.cookies?.[COOKIE_NAME];
  if (!sessionId) {
    sessionId = crypto.randomBytes(16).toString('hex');
    res.cookie(COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      maxAge: COOKIE_MAX_AGE_MS,
    });
  }
  return sessionId;
};

const analyticsController = {
  // Batched page views / clicks / form interactions / search terms.
  // Best-effort: never blocks or fails the caller even if Redis is down.
  ingestEvents: async (req, res) => {
    const sessionId = ensureSessionId(req, res);
    // Respond immediately - analytics must never hold up the storefront.
    res.status(202).json({ success: true });

    try {
      const { events } = req.body;
      if (!Array.isArray(events) || events.length === 0) return;

      await getAnalyticsQueue().add('ingest-events', {
        sessionId,
        events,
        userAgent: req.headers['user-agent'] || '',
        receivedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Analytics event enqueue failed (non-blocking):', error.message);
    }
  },

  // Batched rrweb snapshot chunks, same best-effort contract as ingestEvents.
  ingestReplay: async (req, res) => {
    const sessionId = ensureSessionId(req, res);
    res.status(202).json({ success: true });

    try {
      const { events } = req.body;
      if (!Array.isArray(events) || events.length === 0) return;

      await getAnalyticsQueue().add('ingest-replay', {
        sessionId,
        events,
        receivedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Analytics replay enqueue failed (non-blocking):', error.message);
    }
  },
};

module.exports = { analyticsController, COOKIE_NAME };
