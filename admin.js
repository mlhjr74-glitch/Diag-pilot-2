// Owns: /api/admin/* — wiring diagram CRUD, AI generation, review queue, session review, user comp management, event log query
// Does NOT own: user auth, diagnostic engine, part locations

const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');
const pool = require('../db/index');
const { requireAdmin } = require('../middleware/auth');
const { uploadToR2 } = require('../services/r2');
const { getRecentEvents } = require('../db/events');
const { createAIDraft, listDiagramsByStatus, approveDiagram, rejectDiagram } = require('../db/diagrams');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
});

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
    cb(allowed.includes(file.mimetype) ? null : new Error('Only PNG, JPEG, GIF, WebP, and SVG are allowed'), allowed.includes(file.mimetype));
  }
});

router.get('/verify', requireAdmin, (req, res) => res.json({ ok: true }));

// ─── User comp management ────────────────────────────────────────────────────
// Grant or revoke complimentary subscription access (no Stripe subscription needed).
// Comp'd users get subscription_plan='founder_comp' to distinguish from paid subs.

router.get('/users', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, name, subscription_status, subscription_plan, stripe_subscription_id, created_at FROM users ORDER BY id`
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Failed to list users.' });
  }
});

// CSV export of registered users — email, signup date, subscription status
router.get('/users/export', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT email, name, subscription_status, subscription_plan, created_at FROM users ORDER BY created_at ASC`
    );
    const rows = result.rows;
    const header = 'Email,Name,Subscription Status,Plan,Signup Date\n';
    const csv = rows.map(u => {
      const escape = (v) => v === null || v === undefined ? '' : String(v).replace(/,/g, ';').replace(/[\n\r]/g, ' ');
      return [escape(u.email), escape(u.name), escape(u.subscription_status), escape(u.subscription_plan), escape(u.created_at ? new Date(u.created_at).toISOString().slice(0, 10) : '')].join(',');
    }).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=diagpilot-users.csv');
    res.send(header + csv);
  } catch (err) {
    console.error('Export users error:', err);
    res.status(500).json({ error: 'Failed to export users.' });
  }
});

router.post('/comp-user', requireAdmin, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email?.trim()) return res.status(400).json({ error: 'Email is required.' });

    const normalizedEmail = email.trim().toLowerCase();
    const result = await pool.query(
      `UPDATE users SET subscription_status='active', subscription_plan='founder_comp', subscription_updated_at=NOW()
       WHERE LOWER(email) = $1 RETURNING id, email, name, subscription_status, subscription_plan`,
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No user found with that email.' });
    }

    console.log(`[Admin] Comp'd user: ${result.rows[0].email} (id=${result.rows[0].id})`);
    res.json({ user: result.rows[0], message: 'User comp applied — full access granted.' });
  } catch (err) {
    console.error('Comp user error:', err);
    res.status(500).json({ error: 'Failed to comp user.' });
  }
});

router.post('/revoke-comp', requireAdmin, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email?.trim()) return res.status(400).json({ error: 'Email is required.' });

    const normalizedEmail = email.trim().toLowerCase();

    // Only revoke comp'd users — don't touch paid Stripe subscriptions
    const result = await pool.query(
      `UPDATE users SET subscription_status=NULL, subscription_plan=NULL, subscription_updated_at=NOW()
       WHERE LOWER(email) = $1 AND subscription_plan = 'founder_comp' RETURNING id, email, name`,
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No comp\'d user found with that email (won\'t revoke paid subscriptions).' });
    }

    console.log(`[Admin] Revoked comp: ${result.rows[0].email} (id=${result.rows[0].id})`);
    res.json({ user: result.rows[0], message: 'Comp revoked.' });
  } catch (err) {
    console.error('Revoke comp error:', err);
    res.status(500).json({ error: 'Failed to revoke comp.' });
  }
});

// ─── Event log (founder-only) ──────────────────────────────────────────────
// GET /api/admin/events?last=50 — query recent user activity events

router.get('/events', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.last, 10) || 50, 1), 500);
    const events = await getRecentEvents({ limit });
    res.json({ events, count: events.length });
  } catch (err) {
    console.error('Events query error:', err);
    res.status(500).json({ error: 'Failed to query events.' });
  }
});

router.post('/diagrams', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const { title, description, keywords, make, model, year_start, year_end } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required.' });
    if (!make?.trim()) return res.status(400).json({ error: 'Make is required.' });
    if (!model?.trim()) return res.status(400).json({ error: 'Model is required.' });
    if (!year_start || !year_end) return res.status(400).json({ error: 'Year start and year end are required.' });

    const yearStart = parseInt(year_start, 10);
    const yearEnd = parseInt(year_end, 10);
    if (isNaN(yearStart) || isNaN(yearEnd)) return res.status(400).json({ error: 'Years must be valid integers.' });
    if (yearStart > yearEnd) return res.status(400).json({ error: 'Year start must be ≤ year end.' });
    if (yearStart < 1990 || yearEnd > 2027) return res.status(400).json({ error: 'Years must be between 1990 and 2027.' });

    let keywordsArr = [];
    if (keywords) {
      try { keywordsArr = JSON.parse(keywords); }
      catch { keywordsArr = keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean); }
    }

    const diagramUrl = await uploadToR2(req.file.buffer, req.file.originalname, req.file.mimetype);
    const result = await pool.query(
      `INSERT INTO wiring_diagrams (title, description, diagram_url, keywords, make, model, year_start, year_end, is_generic)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE) RETURNING *`,
      [title.trim(), description || null, diagramUrl, keywordsArr, make.trim(), model.trim(), yearStart, yearEnd]
    );
    res.status(201).json({ diagram: result.rows[0] });
  } catch (err) {
    console.error('Diagram upload error:', err);
    res.status(500).json({ error: err.message || 'Failed to upload diagram.' });
  }
});

router.get('/diagrams', requireAdmin, async (req, res) => {
  try {
    const { make, model, year } = req.query;
    let query = 'SELECT * FROM wiring_diagrams WHERE 1=1';
    const params = [];
    if (make) { query += ' AND make = $' + (params.length + 1); params.push(make); }
    if (model) { query += ' AND model = $' + (params.length + 1); params.push(model); }
    if (year) {
      const y = parseInt(year, 10);
      if (!isNaN(y)) {
        query += ' AND year_start <= $' + (params.length + 1) + ' AND year_end >= $' + (params.length + 2);
        params.push(y, y);
      }
    }
    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json({ diagrams: result.rows });
  } catch (err) {
    console.error('List diagrams error:', err);
    res.status(500).json({ error: 'Failed to list diagrams.' });
  }
});

router.delete('/diagrams/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM wiring_diagrams WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete diagram error:', err);
    res.status(500).json({ error: 'Failed to delete diagram.' });
  }
});

router.patch('/diagrams/:id', requireAdmin, async (req, res) => {
  try {
    const { title, description, keywords, make, model, year_start, year_end } = req.body;
    let keywordsArr;
    if (keywords !== undefined) {
      keywordsArr = Array.isArray(keywords)
        ? keywords.map(k => k.trim().toLowerCase()).filter(Boolean)
        : String(keywords).split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    }

    let yearStart, yearEnd;
    if (year_start !== undefined || year_end !== undefined) {
      if (year_start === undefined || year_end === undefined) return res.status(400).json({ error: 'Both year_start and year_end must be provided together.' });
      yearStart = parseInt(year_start, 10); yearEnd = parseInt(year_end, 10);
      if (isNaN(yearStart) || isNaN(yearEnd)) return res.status(400).json({ error: 'Years must be valid integers.' });
      if (yearStart > yearEnd) return res.status(400).json({ error: 'Year start must be ≤ year end.' });
      if (yearStart < 1990 || yearEnd > 2027) return res.status(400).json({ error: 'Years must be between 1990 and 2027.' });
    }

    const result = await pool.query(
      `UPDATE wiring_diagrams SET title=COALESCE($1,title), description=COALESCE($2,description), keywords=COALESCE($3,keywords), make=COALESCE($4,make), model=COALESCE($5,model), year_start=COALESCE($6,year_start), year_end=COALESCE($7,year_end), updated_at=NOW() WHERE id=$8 RETURNING *`,
      [title || null, description !== undefined ? description : null, keywordsArr || null, make?.trim() || null, model?.trim() || null, yearStart || null, yearEnd || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Diagram not found.' });
    res.json({ diagram: result.rows[0] });
  } catch (err) {
    console.error('Update diagram error:', err);
    res.status(500).json({ error: 'Failed to update diagram.' });
  }
});

router.post('/steps/:stepId/diagram', requireAdmin, async (req, res) => {
  try {
    const { diagram_url } = req.body;
    if (!diagram_url) return res.status(400).json({ error: 'diagram_url is required.' });
    const result = await pool.query(
      'UPDATE diagnostic_steps SET diagram_url = $1 WHERE id = $2 RETURNING id, session_id, step_number, diagram_url',
      [diagram_url, req.params.stepId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Step not found.' });
    res.json({ step: result.rows[0] });
  } catch (err) {
    console.error('Attach diagram error:', err);
    res.status(500).json({ error: 'Failed to attach diagram.' });
  }
});

router.get('/sessions', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ds.id, ds.vehicle_year, ds.vehicle_make, ds.vehicle_model, ds.symptom, ds.status, ds.created_at,
              u.email as user_email, COUNT(dsteps.id) as step_count
       FROM diagnostic_sessions ds
       LEFT JOIN users u ON u.id = ds.user_id
       LEFT JOIN diagnostic_steps dsteps ON dsteps.session_id = ds.id
       GROUP BY ds.id, u.email ORDER BY ds.created_at DESC LIMIT 100`
    );
    res.json({ sessions: result.rows });
  } catch (err) {
    console.error('List sessions error:', err);
    res.status(500).json({ error: 'Failed to list sessions.' });
  }
});

router.get('/sessions/:id/steps', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, step_number, instruction, input_type, diagram_url FROM diagnostic_steps WHERE session_id = $1 ORDER BY step_number ASC',
      [req.params.id]
    );
    res.json({ steps: result.rows });
  } catch (err) {
    console.error('Get session steps error:', err);
    res.status(500).json({ error: 'Failed to get steps.' });
  }
});

// ─── AI Diagram Generation ────────────────────────────────────────────────────
// POST /api/admin/diagrams/generate
// Calls OpenAI to produce wiring info (pin count, wire colors, pin functions)
// for a given part/vehicle combo. Stores as pending_review draft — no image.
// The ASE tech reviews and approves before it goes live.

const WIRING_PROMPT = `You are an ASE-certified master automotive technician with factory service manual access.
Generate accurate wiring information for the specified connector/component.

Respond ONLY with a valid JSON object, no markdown:
{
  "connector_name": "Full OEM connector name",
  "pin_count": <integer>,
  "wire_colors": [
    { "pin": 1, "color": "Black/White", "function": "Ground", "typical_voltage": "0V" }
  ],
  "connector_type": "Molex 4-pin / Weatherpack 2-pin / etc",
  "location_hint": "Where to find this connector on the vehicle",
  "testing_notes": "Key measurements the tech should take",
  "common_faults": ["Most common failure mode", "Second most common"]
}`;

router.post('/diagrams/generate', requireAdmin, async (req, res) => {
  try {
    const { part_type, make, model, year } = req.body;
    if (!part_type?.trim()) return res.status(400).json({ error: 'part_type is required.' });
    if (!make?.trim()) return res.status(400).json({ error: 'make is required.' });
    if (!model?.trim()) return res.status(400).json({ error: 'model is required.' });
    if (!year) return res.status(400).json({ error: 'year is required.' });

    const y = parseInt(year, 10);
    if (isNaN(y) || y < 1990 || y > 2027) return res.status(400).json({ error: 'year must be between 1990 and 2027.' });

    const aiRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      task: 'diagpilot-wiring-generation',
      messages: [
        { role: 'system', content: WIRING_PROMPT },
        { role: 'user', content: `Part/component: ${part_type}\nVehicle: ${y} ${make} ${model}` }
      ],
      temperature: 0.2,
      max_tokens: 1200,
    });

    let wiringInfo;
    try {
      const raw = aiRes.choices[0].message.content.trim()
        .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      wiringInfo = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      // AI returned non-JSON — store raw text as-is, still useful for review
      wiringInfo = aiRes.choices[0].message.content.trim();
    }

    const draft = await createAIDraft({
      part_type: part_type.trim(),
      make: make.trim(),
      model: model.trim(),
      year: y,
      wiring_info: wiringInfo,
    });

    console.log(`[Admin] AI draft created: id=${draft.id} — ${y} ${make} ${model} ${part_type}`);
    res.status(201).json({ diagram: draft, message: 'Draft created — awaiting tech review before going live.' });
  } catch (err) {
    console.error('Diagram generate error:', err);
    res.status(500).json({ error: err.message || 'Generation failed.' });
  }
});

// ─── Review Queue ─────────────────────────────────────────────────────────────
// GET  /api/admin/diagrams?status=pending_review  — handled by existing GET /diagrams (already filters by query params)
//   but we add a dedicated queue endpoint for convenience + status filtering:
// GET  /api/admin/diagrams/review          — lists all pending_review drafts
// PUT  /api/admin/diagrams/:id/approve     — approve draft → live
// PUT  /api/admin/diagrams/:id/reject      — reject with optional notes

router.get('/diagrams/review', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || 'pending_review';
    const diagrams = await listDiagramsByStatus(status);
    res.json({ diagrams, count: diagrams.length });
  } catch (err) {
    console.error('Review queue error:', err);
    res.status(500).json({ error: 'Failed to load review queue.' });
  }
});

router.put('/diagrams/:id/approve', requireAdmin, async (req, res) => {
  try {
    const diagram = await approveDiagram(req.params.id);
    if (!diagram) return res.status(404).json({ error: 'Diagram not found.' });
    console.log(`[Admin] Diagram approved: id=${diagram.id} — ${diagram.title}`);
    res.json({ diagram, message: 'Diagram approved and now live.' });
  } catch (err) {
    console.error('Approve diagram error:', err);
    res.status(500).json({ error: 'Failed to approve diagram.' });
  }
});

router.put('/diagrams/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { notes } = req.body;
    const diagram = await rejectDiagram(req.params.id, notes);
    if (!diagram) return res.status(404).json({ error: 'Diagram not found.' });
    console.log(`[Admin] Diagram rejected: id=${diagram.id} — ${diagram.title}`);
    res.json({ diagram, message: 'Diagram rejected.' });
  } catch (err) {
    console.error('Reject diagram error:', err);
    res.status(500).json({ error: 'Failed to reject diagram.' });
  }
});

module.exports = router;
