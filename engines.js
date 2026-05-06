// Owns: vehicle_engines table queries — engine options per make/model/year
// Does NOT own: vehicle makes/models/years lists (routes/vehicles.js), diagnostic sessions

const pool = require('./index');

/**
 * Get available engine options for a specific make/model/year.
 * Returns rows ordered by displacement desc so larger engines appear first.
 */
async function getEnginesForVehicle(make, model, year) {
  const result = await pool.query(
    `SELECT id, display_name, displacement, engine_type, fuel_type, horsepower, torque
     FROM vehicle_engines
     WHERE LOWER(make) = LOWER($1)
       AND LOWER(model) = LOWER($2)
       AND year = $3
     ORDER BY
       CASE fuel_type WHEN 'Gas' THEN 0 WHEN 'Diesel' THEN 1 WHEN 'Hybrid' THEN 2 WHEN 'Electric' THEN 3 ELSE 4 END,
       displacement DESC`,
    [make, model, year]
  );
  return result.rows;
}

/**
 * Bulk-insert engine records. Skips duplicates (ON CONFLICT DO NOTHING).
 * engines: [{ make, model, year, displacement, engine_type, fuel_type, display_name, horsepower, torque }]
 */
async function bulkInsertEngines(engines) {
  if (!engines.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const e of engines) {
      await client.query(
        `INSERT INTO vehicle_engines (make, model, year, displacement, engine_type, fuel_type, display_name, horsepower, torque)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (make, model, year, display_name) DO NOTHING`,
        [e.make, e.model, e.year, e.displacement, e.engine_type, e.fuel_type, e.display_name, e.horsepower || null, e.torque || null]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getEnginesForVehicle, bulkInsertEngines };
