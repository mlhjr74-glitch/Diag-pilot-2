/**
 * Migration: Create events table
 * 
 * Stores frontend events logged by users (paywall views, checkout starts, etc.)
 * Includes indexes for efficient querying by event type, email, and timestamp.
 */

module.exports = {
  name: 'add_events_table',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(100) NOT NULL,
        email VARCHAR(255) NOT NULL,
        ip_address VARCHAR(45),
        user_agent TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Index for filtering by event type
    await client.query(`
      CREATE INDEX IF NOT EXISTS events_event_type_idx ON events (event_type)
    `);

    // Index for filtering by email
    await client.query(`
      CREATE INDEX IF NOT EXISTS events_email_idx ON events (email)
    `);

    // Index for time-based queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS events_created_at_idx ON events (created_at)
    `);

    // Composite index for common query patterns
    await client.query(`
      CREATE INDEX IF NOT EXISTS events_email_type_idx ON events (email, event_type, created_at)
    `);
  }
};
