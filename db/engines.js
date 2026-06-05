const pool = require('./index');

/**
 * Get engine options for a specific vehicle make/model/year
 * @param {string} make - Vehicle make (e.g., "Honda")
 * @param {string} model - Vehicle model (e.g., "Civic")
 * @param {number} year - Vehicle year (e.g., 2023)
 * @returns {Promise<Array>} Array of engine options
 */
async function getEnginesForVehicle(make, model, year) {
  try {
    // Query the database for engines matching this vehicle
    const result = await pool.query(
      `SELECT DISTINCT engine FROM vehicle_engines 
       WHERE make = $1 AND model = $2 AND year = $3 
       ORDER BY engine ASC`,
      [make, model, year]
    );
    
    return result.rows.map(row => row.engine);
  } catch (err) {
    console.error('Error fetching engines:', err);
    // Return empty array if table doesn't exist or query fails
    return [];
  }
}

module.exports = { getEnginesForVehicle };
