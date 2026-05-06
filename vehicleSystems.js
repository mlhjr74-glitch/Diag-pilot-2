// Owns: /api/vehicle-systems/* — system reference panel data (pinouts, locations, descriptions)
// Does NOT own: diagnostic sessions, part locations, wiring diagram library

const express = require('express');
const { authenticateToken, requireSubscription } = require('../middleware/auth');
const { getSystemsForVehicle, getSystemBySlug } = require('../db/vehicleSystems');

const router = express.Router();

// GET /api/vehicle-systems?make=Toyota&model=Camry&year=2005
// Returns all systems available for this vehicle, with components and pinouts.
router.get('/', authenticateToken, requireSubscription, async (req, res) => {
  try {
    const { make, model, year } = req.query;
    const systems = await getSystemsForVehicle(make, model, year);
    res.json({ systems, count: systems.length });
  } catch (err) {
    console.error('vehicle-systems list error:', err);
    res.status(500).json({ error: 'Failed to load vehicle systems.' });
  }
});

// GET /api/vehicle-systems/:slug?make=Toyota&model=Camry&year=2005
// Returns a single system by slug (e.g. "ignition").
router.get('/:slug', authenticateToken, requireSubscription, async (req, res) => {
  try {
    const { make, model, year } = req.query;
    const system = await getSystemBySlug(req.params.slug, make, model, year);
    if (!system) return res.status(404).json({ error: 'System not found.' });
    res.json({ system });
  } catch (err) {
    console.error('vehicle-systems slug error:', err);
    res.status(500).json({ error: 'Failed to load system.' });
  }
});

module.exports = router;
