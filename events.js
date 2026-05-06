// Owns: /api/events/* — frontend event logging
// Does NOT own: Stripe webhooks, auth, subscription status

const express = require('express');
const { logEvent } = require('../db/events');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// POST /api/events/log — log a frontend-triggered event (paywall_view, checkout_start)
// Requires auth because we need user_id and email for all checkout funnel events
router.post('/log', authenticateToken, async (req, res) => {
  try {
    const { eventType, metadata = {} } = req.body;
    if (!eventType || typeof eventType !== 'string') {
      return res.status(400).json({ error: 'eventType is required.' });
    }

    // Only allow pre-approved frontend event types
    const allowed = ['paywall_view', 'checkout_start'];
    if (!allowed.includes(eventType)) {
      return res.status(400).json({ error: 'Invalid eventType for frontend logging.' });
    }

    const ip = req.ip || req.headers['x-forwarded-for'] || null;
    const ua = req.headers['user-agent'] || null;

    await logEvent({
      eventType,
      email: req.user.email,
      ipAddress: ip,
      userAgent: ua,
      metadata: { userId: req.user.id, ...metadata }
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Event log error:', err);
    res.status(500).json({ error: 'Failed to log event.' });
  }
});

module.exports = router;