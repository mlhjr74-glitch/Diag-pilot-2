// Owns: /api/stripe/webhook — Stripe event processing
// Does NOT own: subscription UI, user auth

const express = require('express');
const pool = require('../db/index');
const { logEvent } = require('../db/events');

const router = express.Router();

// Raw body required for webhook — parsed in server.js before mounting
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    let event;
    try {
      event = JSON.parse(req.body.toString());
    } catch (parseErr) {
      console.error('Webhook parse error:', parseErr.message);
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const authHeader = req.headers['x-polsia-token'] || req.headers['authorization'];
    const expectedToken = process.env.POLSIA_API_TOKEN;
    const isFromPolsia = authHeader && expectedToken && authHeader.includes(expectedToken);
    console.log(`[Webhook] ${event.type}${isFromPolsia ? ' (verified Polsia)' : ''}`);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data?.object;
        if (!session) break;
        const email = session.customer_email || session.customer_details?.email;
        const clientRefId = session.client_reference_id;
        const subscriptionId = session.subscription;
        if (email && subscriptionId) {
          const q = clientRefId
            ? `UPDATE users SET subscription_status='active', subscription_plan='ai_diagnostics', stripe_subscription_id=$1, subscription_updated_at=NOW() WHERE id=$2 OR LOWER(email)=LOWER($3) RETURNING id, email`
            : `UPDATE users SET subscription_status='active', subscription_plan='ai_diagnostics', stripe_subscription_id=$1, subscription_updated_at=NOW() WHERE LOWER(email)=LOWER($2) RETURNING id, email`;
          const params = clientRefId ? [subscriptionId, parseInt(clientRefId), email] : [subscriptionId, email];
          const result = await pool.query(q, params);
          if (result.rows.length > 0) {
            const user = result.rows[0];
            console.log(`[Webhook] Activated: ${user.email}`);
            logEvent({ eventType: 'subscription_activated', email: user.email, metadata: { userId: user.id, subscriptionId } });
            logEvent({ eventType: 'payment_success', email: user.email, metadata: { userId: user.id, subscriptionId } });
          } else {
            console.log(`[Webhook] No user found for email: ${email}`);
          }
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data?.object;
        if (!sub) break;
        let appStatus = 'none';
        if (sub.status === 'active' || sub.status === 'trialing') appStatus = 'active';
        else if (sub.status === 'past_due') appStatus = 'past_due';
        else if (sub.status === 'canceled' || sub.status === 'unpaid') appStatus = 'canceled';
        const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
        await pool.query(
          `UPDATE users SET subscription_status=$1, subscription_expires_at=$2, subscription_updated_at=NOW() WHERE stripe_subscription_id=$3`,
          [appStatus, periodEnd, sub.id]
        );
        console.log(`[Webhook] Subscription ${sub.id} → ${appStatus}`);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data?.object;
        if (!sub) break;
        await pool.query(
          `UPDATE users SET subscription_status='canceled', subscription_updated_at=NOW() WHERE stripe_subscription_id=$1`,
          [sub.id]
        );
        console.log(`[Webhook] Subscription ${sub.id} canceled`);
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data?.object;
        if (!invoice?.subscription) break;
        const userResult = await pool.query(
          `SELECT id, email FROM users WHERE stripe_subscription_id=$1`,
          [invoice.subscription]
        );
        await pool.query(
          `UPDATE users SET subscription_status='past_due', subscription_updated_at=NOW() WHERE stripe_subscription_id=$1`,
          [invoice.subscription]
        );
        console.log(`[Webhook] Payment failed: ${invoice.subscription}`);
        if (userResult.rows.length > 0) {
          logEvent({ eventType: 'payment_failed', email: userResult.rows[0].email, metadata: { userId: userResult.rows[0].id, subscriptionId: invoice.subscription } });
        }
        break;
      }
      case 'polsia.subscription.sync': {
        const data = event.data;
        if (!data?.email) break;
        await pool.query(
          `UPDATE users SET subscription_status=$1, stripe_subscription_id=$2, subscription_plan=$3, subscription_expires_at=$4, subscription_updated_at=NOW() WHERE LOWER(email)=LOWER($5)`,
          [data.status || 'active', data.subscription_id, data.plan || 'ai_diagnostics', data.expires_at ? new Date(data.expires_at) : null, data.email]
        );
        console.log(`[Webhook] Polsia sync ${data.email}: ${data.status}`);
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;