const pool = require('./index');

/**
 * Get recent events from the database
 * @param {Object} options - Query options
 * @param {number} options.limit - Maximum number of events to return
 * @returns {Promise<Array>} Array of events
 */
async function getRecentEvents({ limit = 50 } = {}) {
  try {
    const result = await pool.query(
      `SELECT id, event_type, email, ip_address, user_agent, metadata, created_at 
       FROM events 
       ORDER BY created_at DESC 
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  } catch (err) {
    console.error('Error fetching events:', err);
    return [];
  }
}

module.exports = { logEvent: require('./events').logEvent, getRecentEvents };
