const express = require('express');
const path = require('path');
const fs = require('fs');
const { logEvent } = require('./db/events');

const app = express();
const port = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

// Health check (required for Render)
app.get('/health', (req, res) => res.json({ status: 'healthy' }));

// Stripe webhook needs raw body — mount before JSON parser
app.use('/api/stripe', require('./stripe.js'));

// JSON parser for all other routes
app.use(express.json());



// App page — log pageview before serving
app.get('/app', (req, res) => {
  logEvent({ eventType: 'pageview', metadata: { page: 'app', ip: req.ip } }).catch(() => {});
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});
app.get('/app.html', (req, res) => {
  logEvent({ eventType: 'pageview', metadata: { page: 'app', ip: req.ip } }).catch(() => {});
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Landing page — injects analytics slug
app.get('/', (req, res) => {
  logEvent({ eventType: 'pageview', metadata: { page: 'landing', ip: req.ip } }).catch(() => {});
  const slug = process.env.POLSIA_ANALYTICS_SLUG || '';
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__POLSIA_SLUG__', slug);
    res.type('html').send(html);
  } else {
    res.json({ message: 'Hello from Polsia Instance!' });
  }
});

// Admin UI
app.get('/admin', (req, res) => {
  logEvent({ eventType: 'pageview', metadata: { page: 'admin', ip: req.ip } }).catch(() => {});
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// API routes
app.use('/api/auth', require('./auth.js'));
app.use('/api/subscription', require('./subscription.js'));
app.use('/api/events', require('./events.js'));
app.use('/api/vehicles', require('./vehicles.js'));
app.use('/api/diagnose', require('./diagnose.js'));
app.use('/api/admin', require('./admin.js'));
app.use('/api/part-locations', require('./partlocations.js'));
app.use('/api/vehicle-systems', require('./vehiclesytems.js'));

const server = app.listen(port, '0.0.0.0', function() {
  console.log(`Server running on port ${port}`);
});

// Configure timeouts for Render
server.timeout = 120000; // 120 seconds for all requests
server.keepAliveTimeout = 65000; // Slightly less than Render's limit
