const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { logEvent } = require('./db/events');

// Stripe webhook endpoint - receives raw body
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);

    // Log the event
    logEvent({
      eventType: 'stripe_webhook',
      metadata: { eventType: event.type, eventId: event.id }
    }).catch(() => {});

    // Handle different event types
    switch (event.type) {
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object);
        break;
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// Create a subscription
router.post('/create-subscription', async (req, res) => {
  try {
    const { customerId, priceId } = req.body;

    if (!customerId || !priceId) {
      return res.status(400).json({ error: 'Missing customerId or priceId' });
    }

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });

    res.json({
      subscriptionId: subscription.id,
      clientSecret: subscription.latest_invoice.payment_intent.client_secret,
    });
  } catch (err) {
    console.error('Error creating subscription:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get subscription details
router.get('/subscription/:subscriptionId', async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    res.json(subscription);
  } catch (err) {
    console.error('Error retrieving subscription:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cancel subscription
router.post('/cancel-subscription', async (req, res) => {
  try {
    const { subscriptionId } = req.body;

    if (!subscriptionId) {
      return res.status(400).json({ error: 'Missing subscriptionId' });
    }

    const subscription = await stripe.subscriptions.del(subscriptionId);
    res.json({ message: 'Subscription cancelled', subscription });
  } catch (err) {
    console.error('Error cancelling subscription:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update subscription
router.post('/update-subscription', async (req, res) => {
  try {
    const { subscriptionId, priceId } = req.body;

    if (!subscriptionId || !priceId) {
      return res.status(400).json({ error: 'Missing subscriptionId or priceId' });
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const updatedSubscription = await stripe.subscriptions.update(subscriptionId, {
      items: [
        {
          id: subscription.items.data[0].id,
          price: priceId,
        },
      ],
    });

    res.json(updatedSubscription);
  } catch (err) {
    console.error('Error updating subscription:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper functions for webhook handlers
async function handleSubscriptionCreated(subscription) {
  console.log('Subscription created:', subscription.id);
  // Add your database logic here
}

async function handleSubscriptionUpdated(subscription) {
  console.log('Subscription updated:', subscription.id);
  // Add your database logic here
}

async function handleSubscriptionDeleted(subscription) {
  console.log('Subscription deleted:', subscription.id);
  // Add your database logic here
}

async function handleInvoicePaymentSucceeded(invoice) {
  console.log('Invoice payment succeeded:', invoice.id);
  // Add your database logic here
}

async function handleInvoicePaymentFailed(invoice) {
  console.log('Invoice payment failed:', invoice.id);
  // Add your database logic here
}

module.exports = router;