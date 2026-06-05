const pool = require('./index');

/**
 * Create an AI-generated diagram draft for review
 * @param {Object} data - Diagram data
 * @returns {Promise<Object>} Created diagram
 */
async function createAIDraft(data) {
  try {
    const result = await pool.query(
      `INSERT INTO wiring_diagrams (title, description, keywords, make, model, year_start, year_end, diagram_url, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending_review') RETURNING *`,
      [data.part_type, data.wiring_info, [], data.make, data.model, data.year, data.year, null]
    );
    return result.rows[0];
  } catch (err) {
    console.error('Error creating AI draft:', err);
    throw err;
  }
}

/**
 * List diagrams by status
 * @param {string} status - Diagram status to filter by
 * @returns {Promise<Array>} Array of diagrams
 */
async function listDiagramsByStatus(status) {
  try {
    const result = await pool.query(
      `SELECT * FROM wiring_diagrams WHERE status = $1 ORDER BY created_at DESC`,
      [status]
    );
    return result.rows;
  } catch (err) {
    console.error('Error listing diagrams:', err);
    return [];
  }
}

/**
 * Approve a diagram draft
 * @param {number} id - Diagram ID
 * @returns {Promise<Object>} Updated diagram
 */
async function approveDiagram(id) {
  try {
    const result = await pool.query(
      `UPDATE wiring_diagrams SET status = 'approved' WHERE id = $1 RETURNING *`,
      [id]
    );
    return result.rows[0];
  } catch (err) {
    console.error('Error approving diagram:', err);
    throw err;
  }
}

/**
 * Reject a diagram draft
 * @param {number} id - Diagram ID
 * @param {string} notes - Rejection notes
 * @returns {Promise<Object>} Updated diagram
 */
async function rejectDiagram(id, notes) {
  try {
    const result = await pool.query(
      `UPDATE wiring_diagrams SET status = 'rejected', rejection_notes = $1 WHERE id = $2 RETURNING *`,
      [notes || null, id]
    );
    return result.rows[0];
  } catch (err) {
    console.error('Error rejecting diagram:', err);
    throw err;
  }
}

module.exports = {
  createAIDraft,
  listDiagramsByStatus,
  approveDiagram,
  rejectDiagram
};
