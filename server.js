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
app.use('/api/stripe',require('../routes/stripe.js'));

// JSON parser for all other routes
app.use((req, res, next) => {
  express.json()(req, res, next);
});

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
app.use('/api/auth', require('./routes/auth'));
app.use('/api/subscription', require('./routes/subscription'));
app.use('/api/events', require('./routes/events'));
app.use('/api/vehicles', require('./routes/vehicles'));
app.use('/api/diagnose', require('./routes/diagnose'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/part-locations', require('./routes/partLocations'));
app.use('/api/vehicle-systems', require('./routes/vehicleSystems'));

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
module.exports=router;
