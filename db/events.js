/**
 * Event logging module
 * Handles storing frontend events (paywall_view, checkout_start) to the database
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

/**
 * Log a frontend event to the database
 * @param {Object} eventData - Event information to log
 * @param {string} eventData.eventType - Type of event (e.g., 'paywall_view', 'checkout_start')
 * @param {string} eventData.email - User email
 * @param {string} eventData.ipAddress - User IP address
 * @param {string} eventData.userAgent - User browser/device info
 * @param {Object} eventData.metadata - Additional event metadata (userId, etc.)
 * @returns {Promise<Object>} Inserted event record
 */
async function logEvent({ eventType, email, ipAddress, userAgent, metadata = {} }) {
  const client = await pool.connect();
  
  try {
    const query = `
      INSERT INTO events (event_type, email, ip_address, user_agent, metadata, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING id, event_type, email, created_at;
    `;
    
    const result = await client.query(query, [
      eventType,
      email,
      ipAddress,
      userAgent,
      JSON.stringify(metadata)
    ]);
    
    return result.rows[0];
  } finally {
    client.release();
  }
}

module.exports = { logEvent };
