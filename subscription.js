// Owns: /api/subscription/* — status, checkout redirect, billing portal, activation
// Does NOT own: Stripe webhook (routes/stripe.js), auth

const express = require('express');
const pool = require('../db/index');
const { authenticateToken } = require('../middleware/auth');
const { logEvent } = require('../db/events');

const router = express.Router();

const APP_URL = process.env.APP_URL || 'https://diagpilot.polsia.app';
const STRIPE_SUBSCRIBE_URL = 'https://buy.stripe.com/3cI4gA14DeZOc5Uctd43S01';

router.get('/status', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT subscription_status, subscription_plan, subscription_expires_at, stripe_subscription_id FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found.' });

    const user = result.rows[0];
    const isActive = user.subscription_status === 'active';
    const isPastDue = user.subscription_status === 'past_due';

    // Log paywall hit: authenticated user with no active subscription checks their status
    if (!isActive) {
      logEvent({ eventType: 'paywall_view', email: user.email, metadata: { userId: req.user.id, status: user.subscription_status || 'none', plan: user.subscription_plan || null } });
    }

    // no-store: prevents browser from caching subscription state across DB changes
    res.set('Cache-Control', 'no-store').json({
      subscription_status: user.subscription_status || 'none',
      subscription_plan: user.subscription_plan,
      subscription_expires_at: user.subscription_expires_at,
      has_subscription: isActive,
      is_past_due: isPastDue,
      subscribe_url: `${APP_URL}/api/subscription/checkout`,
      manage_url: (isActive || isPastDue) ? `${APP_URL}/api/subscription/manage` : null,
      cancel_url: (isActive || isPastDue) ? `${APP_URL}/api/subscription/manage` : null
    });
  } catch (err) {
    console.error('Subscription status error:', err);
    res.status(500).json({ error: 'Failed to fetch subscription status.' });
  }
});

router.get('/checkout', authenticateToken, (req, res) => {
  logEvent({ eventType: 'checkout_start', email: req.user.email, metadata: { userId: req.user.id } });
  const checkoutUrl = new URL(STRIPE_SUBSCRIBE_URL);
  checkoutUrl.searchParams.set('prefilled_email', req.user.email);
  checkoutUrl.searchParams.set('client_reference_id', String(req.user.id));
  res.redirect(checkoutUrl.toString());
});

router.get('/manage', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT subscription_status FROM users WHERE id = $1', [req.user.id]);
    const status = result.rows[0]?.subscription_status;
    if (!status || (status !== 'active' && status !== 'past_due' && status !== 'canceled')) {
      return res.redirect('/app.html');
    }
    res.redirect('https://billing.stripe.com/p/login/aEU7sXfbGbYF2bKeUU');
  } catch (err) {
    console.error('Manage subscription error:', err);
    res.redirect('/app.html');
  }
});

router.post('/activate', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT subscription_status FROM users WHERE id = $1', [req.user.id]);
    if (result.rows[0]?.subscription_status === 'active') {
      return res.json({ activated: true, subscription_status: 'active' });
    }
    res.json({
      activated: false,
      subscription_status: result.rows[0]?.subscription_status || 'none',
      message: 'Subscription is being processed. It may take a moment to activate.'
    });
  } catch (err) {
    console.error('Activate subscription error:', err);
    res.status(500).json({ error: 'Failed to check subscription status.' });
  }
});

module.exports = router;