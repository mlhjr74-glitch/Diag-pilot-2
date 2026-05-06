// Owns: /api/part-locations — part physical location lookup by vehicle
// Does NOT own: wiring diagrams, diagnostic sessions

const express = require('express');
const { getPartLocation } = require('../db/partLocations');

const router = express.Router();

// GET /api/part-locations?part=<name>&make=<make>&model=<model>&year=<year>
router.get('/', async (req, res) => {
  try {
    const { part, make, model, year } = req.query;
    if (!part) return res.status(400).json({ error: 'part parameter required' });

    const location = await getPartLocation(part, make, model, year);
    if (!location) return res.json({ found: false });

    res.json({ found: true, ...location });
  } catch (err) {
    console.error('Part location lookup error:', err);
    res.status(500).json({ error: 'Failed to look up part location.' });
  }
});

module.exports = router;
