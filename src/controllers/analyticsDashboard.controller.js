const AnalyticsSession = require('../models/analyticsSession.model');
const AnalyticsEvent = require('../models/analyticsEvent.model');
const ReplaySnapshot = require('../models/replaySnapshot.model');

// Funnel stages inferred from page-view paths captured by the client.
// A session "reaches" a stage if it has at least one pageview matching
// that stage's path pattern.
const FUNNEL_STAGES = [
  { key: 'landed', label: 'Landed on site', match: () => true },
  { key: 'productView', label: 'Viewed a product', match: (page) => /\/product\//.test(page) },
  { key: 'cart', label: 'Viewed cart', match: (page) => /\/cart/.test(page) },
  { key: 'checkout', label: 'Started checkout', match: (page) => /\/checkout/.test(page) },
  { key: 'order', label: 'Completed order', match: (page) => /\/order-confirmation|\/order-success/.test(page) },
];

const analyticsDashboardController = {
  // Sessions-over-time + basic totals for the KPI cards.
  getKpis: async (req, res) => {
    try {
      const days = Math.min(Number(req.query.days) || 30, 90);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const sessions = await AnalyticsSession.find({ firstSeenAt: { $gte: since } })
        .select('firstSeenAt customerId')
        .lean();

      const byDay = {};
      for (const s of sessions) {
        const day = s.firstSeenAt.toISOString().slice(0, 10);
        byDay[day] = (byDay[day] || 0) + 1;
      }
      const sessionsOverTime = Object.entries(byDay)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date));

      return res.status(200).json({
        success: true,
        totalSessions: sessions.length,
        identifiedSessions: sessions.filter((s) => s.customerId).length,
        sessionsOverTime,
      });
    } catch (error) {
      console.error('Error fetching analytics KPIs:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch KPIs', error: error.message });
    }
  },

  // Drop-off funnel computed from each session's set of visited pages.
  getFunnel: async (req, res) => {
    try {
      const days = Math.min(Number(req.query.days) || 30, 90);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const pageviews = await AnalyticsEvent.find({
        type: 'pageview',
        timestamp: { $gte: since },
      }).select('sessionId page').lean();

      const pagesBySession = new Map();
      for (const ev of pageviews) {
        if (!pagesBySession.has(ev.sessionId)) pagesBySession.set(ev.sessionId, []);
        pagesBySession.get(ev.sessionId).push(ev.page || '');
      }

      const funnel = FUNNEL_STAGES.map((stage) => ({ key: stage.key, label: stage.label, sessions: 0 }));
      for (const pages of pagesBySession.values()) {
        for (let i = 0; i < FUNNEL_STAGES.length; i++) {
          if (pages.some((p) => FUNNEL_STAGES[i].match(p))) {
            funnel[i].sessions += 1;
          }
        }
      }

      return res.status(200).json({ success: true, funnel });
    } catch (error) {
      console.error('Error computing funnel:', error);
      return res.status(500).json({ success: false, message: 'Failed to compute funnel', error: error.message });
    }
  },

  // Top entry/exit pages from the session documents the worker maintains.
  getTopPages: async (req, res) => {
    try {
      const [topEntry, topExit] = await Promise.all([
        AnalyticsSession.aggregate([
          { $match: { entryPage: { $ne: null, $exists: true } } },
          { $group: { _id: '$entryPage', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 10 },
        ]),
        AnalyticsSession.aggregate([
          { $match: { exitPage: { $ne: null, $exists: true } } },
          { $group: { _id: '$exitPage', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 10 },
        ]),
      ]);

      return res.status(200).json({
        success: true,
        topEntryPages: topEntry.map((r) => ({ page: r._id, count: r.count })),
        topExitPages: topExit.map((r) => ({ page: r._id, count: r.count })),
      });
    } catch (error) {
      console.error('Error fetching top pages:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch top pages', error: error.message });
    }
  },

  // Top search terms from 'search' type events.
  getTopSearches: async (req, res) => {
    try {
      const results = await AnalyticsEvent.aggregate([
        { $match: { type: 'search', 'metadata.term': { $exists: true, $ne: '' } } },
        { $group: { _id: '$metadata.term', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 },
      ]);

      return res.status(200).json({
        success: true,
        topSearches: results.map((r) => ({ term: r._id, count: r.count })),
      });
    } catch (error) {
      console.error('Error fetching top searches:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch top searches', error: error.message });
    }
  },

  // List sessions that have at least one replay snapshot, for the viewer's picker.
  getReplaySessions: async (req, res) => {
    try {
      const sessions = await ReplaySnapshot.aggregate([
        { $group: { _id: '$sessionId', chunks: { $sum: 1 }, lastEventAt: { $max: '$timestamp' } } },
        { $sort: { lastEventAt: -1 } },
        { $limit: 50 },
      ]);

      return res.status(200).json({
        success: true,
        sessions: sessions.map((s) => ({ sessionId: s._id, chunks: s.chunks, lastEventAt: s.lastEventAt })),
      });
    } catch (error) {
      console.error('Error listing replay sessions:', error);
      return res.status(500).json({ success: false, message: 'Failed to list replay sessions', error: error.message });
    }
  },

  // Full ordered rrweb event stream for one session, for rrweb-player.
  getReplayForSession: async (req, res) => {
    try {
      const { sessionId } = req.params;
      const chunks = await ReplaySnapshot.find({ sessionId }).sort({ timestamp: 1 }).lean();
      const events = chunks.flatMap((c) => c.events);

      return res.status(200).json({ success: true, sessionId, events });
    } catch (error) {
      console.error('Error fetching session replay:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch session replay', error: error.message });
    }
  },
};

module.exports = analyticsDashboardController;
