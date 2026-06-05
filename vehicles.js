// Owns: /api/vehicles/* — make/model/year lists + engine options per vehicle
// Does NOT own: diagnostic sessions, user data, engine DB seeding

const express = require('express');
const { getEnginesForVehicle } = require('./db/engines');

const router = express.Router();

const VEHICLE_MAKES = [
  'Acura', 'Audi', 'BMW', 'Buick', 'Cadillac', 'Chevrolet', 'Chrysler',
  'Dodge', 'Ford', 'GMC', 'Honda', 'Hyundai', 'Infiniti', 'Jeep', 'Kia',
  'Lexus', 'Lincoln', 'Mazda', 'Mercedes-Benz', 'Mini', 'Mitsubishi',
  'Nissan', 'Ram', 'Subaru', 'Tesla', 'Toyota', 'Volkswagen', 'Volvo'
];

const VEHICLE_MODELS = {
  'Acura':         ['ILX', 'TLX', 'RDX', 'MDX', 'Integra'],
  'Audi':          ['A3', 'A4', 'A6', 'Q3', 'Q5', 'Q7'],
  'BMW':           ['3 Series', '5 Series', 'X1', 'X3', 'X5'],
  'Buick':         ['Encore', 'Envision', 'Enclave'],
  'Cadillac':      ['CT4', 'CT5', 'XT4', 'XT5', 'Escalade'],
  'Chevrolet':     ['Malibu', 'Camaro', 'Corvette', 'Equinox', 'Traverse', 'Tahoe',
                    'Silverado 1500', 'Silverado 2500HD', 'Silverado 3500HD',
                    'Colorado', 'Trax', 'Blazer'],
  'Chrysler':      ['300', 'Pacifica'],
  'Dodge':         ['Charger', 'Challenger', 'Durango', 'Hornet'],
  'Ford':          ['Mustang', 'Fusion', 'Escape', 'Explorer', 'Edge',
                    'F-150', 'F-250 Super Duty', 'F-350 Super Duty',
                    'Ranger', 'Bronco', 'Maverick'],
  'GMC':           ['Terrain', 'Acadia', 'Yukon',
                    'Sierra 1500', 'Sierra 2500HD', 'Sierra 3500HD', 'Canyon'],
  'Honda':         ['Civic', 'Accord', 'CR-V', 'HR-V', 'Pilot', 'Odyssey', 'Ridgeline', 'Passport'],
  'Hyundai':       ['Elantra', 'Sonata', 'Tucson', 'Santa Fe', 'Kona', 'Palisade'],
  'Infiniti':      ['Q50', 'Q60', 'QX50', 'QX60', 'QX80'],
  'Jeep':          ['Wrangler', 'Grand Cherokee', 'Cherokee', 'Compass', 'Renegade', 'Gladiator'],
  'Kia':           ['Forte', 'K5', 'Sportage', 'Sorento', 'Telluride', 'Soul', 'Seltos'],
  'Lexus':         ['IS', 'ES', 'RX', 'NX', 'GX', 'LX'],
  'Lincoln':       ['Corsair', 'Nautilus', 'Aviator', 'Navigator'],
  'Mazda':         ['Mazda3', 'Mazda6', 'CX-5', 'CX-30', 'CX-50', 'CX-9', 'MX-5 Miata'],
  'Mercedes-Benz': ['C-Class', 'E-Class', 'S-Class', 'GLA', 'GLC', 'GLE', 'GLS'],
  'Mini':          ['Cooper', 'Countryman', 'Clubman'],
  'Mitsubishi':    ['Outlander', 'Eclipse Cross', 'Mirage'],
  'Nissan':        ['Altima', 'Maxima', 'Sentra', 'Rogue', 'Pathfinder', 'Murano', 'Frontier', 'Titan', 'Kicks'],
  'Ram':           ['1500', '2500', '3500', 'ProMaster'],
  'Subaru':        ['Impreza', 'Legacy', 'Outback', 'Forester', 'Crosstrek', 'Ascent', 'WRX', 'BRZ'],
  'Tesla':         ['Model 3', 'Model Y', 'Model S', 'Model X', 'Cybertruck'],
  'Toyota':        ['Corolla', 'Camry', 'RAV4', 'Highlander', 'Tacoma', 'Tundra',
                    '4Runner', 'Prius', 'Supra', 'GR86', 'Sequoia'],
  'Volkswagen':    ['Jetta', 'Passat', 'Golf', 'Tiguan', 'Atlas', 'ID.4', 'Taos'],
  'Volvo':         ['S60', 'S90', 'XC40', 'XC60', 'XC90']
};

router.get('/makes', (req, res) => {
  res.json({ makes: VEHICLE_MAKES });
});

router.get('/models', (req, res) => {
  const make = req.query.make;
  if (!make) return res.status(400).json({ error: 'make parameter required' });
  res.json({ models: VEHICLE_MODELS[make] || [] });
});

router.get('/years', (req, res) => {
  const currentYear = new Date().getFullYear();
  const years = [];
  for (let y = currentYear + 1; y >= 1990; y--) years.push(y);
  res.json({ years });
});

// Returns engine options for a given make/model/year from the DB.
// If none found, returns an empty array — frontend hides the dropdown in that case.
router.get('/engines', async (req, res) => {
  const { make, model, year } = req.query;
  if (!make || !model || !year) {
    return res.status(400).json({ error: 'make, model, and year are required' });
  }
  try {
    const engines = await getEnginesForVehicle(make, model, parseInt(year, 10));
    res.json({ engines });
  } catch (err) {
    console.error('Error fetching engines:', err);
    res.status(500).json({ error: 'Failed to fetch engine options' });
  }
});

module.exports = router;