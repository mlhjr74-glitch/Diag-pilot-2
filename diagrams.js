// Owns: wiring_diagrams table queries — static library CRUD, AI draft management, review queue
// Does NOT own: dynamic generation (services/wiringDiagram.js), diagnostic sessions, part locations

const pool = require('./index');

/**
 * Find the best-matching wiring diagram for a diagnostic step.
 * Tries vehicle-specific first; falls back to generic diagrams.
 * Returns diagram_url or null — failure is non-fatal.
 * Only matches diagrams that are live (status = 'approved').
 */
async function findMatchingDiagram(instructionText, vehicleYear, vehicleMake, vehicleModel) {
  try {
    if (vehicleYear && vehicleMake && vehicleModel) {
      const result = await pool.query(
        `SELECT diagram_url FROM wiring_diagrams
         WHERE status = 'approved'
           AND make = $2 AND model = $3 AND year_start <= $4 AND year_end >= $4
           AND (SELECT COUNT(*) FROM unnest(keywords) k WHERE $1::text ILIKE '%' || k || '%') > 0
         ORDER BY (SELECT COUNT(*) FROM unnest(keywords) k WHERE $1::text ILIKE '%' || k || '%') DESC
         LIMIT 1`,
        [instructionText, vehicleMake, vehicleModel, vehicleYear]
      );
      if (result.rows.length > 0) return result.rows[0].diagram_url;
    }

    const fallback = await pool.query(
      `SELECT diagram_url FROM wiring_diagrams
       WHERE status = 'approved' AND is_generic = true
         AND (SELECT COUNT(*) FROM unnest(keywords) k WHERE $1::text ILIKE '%' || k || '%') > 0
       ORDER BY (SELECT COUNT(*) FROM unnest(keywords) k WHERE $1::text ILIKE '%' || k || '%') DESC
       LIMIT 1`,
      [instructionText]
    );
    return fallback.rows.length > 0 ? fallback.rows[0].diagram_url : null;
  } catch (err) {
    console.error('findMatchingDiagram error:', err);
    return null;
  }
}

/**
 * Insert an AI-generated draft diagram (status = pending_review, no image URL).
 * Returns the full row.
 */
async function createAIDraft({ part_type, make, model, year, wiring_info }) {
  const result = await pool.query(
    `INSERT INTO wiring_diagrams
       (title, description, diagram_url, keywords, make, model, year_start, year_end, is_generic, status, ai_generated)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, FALSE, 'pending_review', TRUE)
     RETURNING *`,
    [
      `${year} ${make} ${model} — ${part_type}`,
      wiring_info,
      '', // no image for AI drafts
      [part_type.toLowerCase(), make.toLowerCase(), model.toLowerCase()],
      make,
      model,
      parseInt(year, 10),
    ]
  );
  return result.rows[0];
}

/**
 * List diagrams filtered by status. Used for admin review queue.
 */
async function listDiagramsByStatus(status) {
  const result = await pool.query(
    `SELECT * FROM wiring_diagrams WHERE status = $1 ORDER BY created_at DESC`,
    [status]
  );
  return result.rows;
}

/**
 * Approve a pending_review diagram — makes it live.
 */
async function approveDiagram(id) {
  const result = await pool.query(
    `UPDATE wiring_diagrams SET status='approved', review_notes=NULL, updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Reject a pending_review diagram with optional notes.
 */
async function rejectDiagram(id, notes) {
  const result = await pool.query(
    `UPDATE wiring_diagrams SET status='rejected', review_notes=$2, updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [id, notes || null]
  );
  return result.rows[0] || null;
}

module.exports = { findMatchingDiagram, createAIDraft, listDiagramsByStatus, approveDiagram, rejectDiagram };
