// Owns: dynamic AI wiring diagram generation with confidence scoring
// Does NOT own: static diagram library queries (db/diagrams.js), diagnostic sessions

const OpenAI = require('openai');
const pool = require('../db/index');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
});

// ─── Confidence scoring ────────────────────────────────────────────────────────
// Factors (cumulative):
//   +0.50  exact make + model match in vehicle_component_pins data
//   +0.20  year falls within component_pins year range
//   +0.15  engine variant match in vehicle_engines table
//   +0.15  keyword overlap with vehicle_systems slug
// Cap: 1.0. Floor: 0.55 (we always have generic automotive knowledge)

async function computeConfidence(instructionText, make, model, year, engine) {
  let score = 0.55; // base: AI has generic automotive knowledge

  try {
    const yearInt = parseInt(year, 10);

    // Factor 1: do we have specific pinout data for this make/model?
    const pinDataCheck = await pool.query(
      `SELECT COUNT(*) as cnt
       FROM vehicle_systems vs
       JOIN vehicle_system_components vsc ON vsc.system_id = vs.id
       JOIN vehicle_component_pins vcp ON vcp.component_id = vsc.id
       WHERE LOWER(vs.make) = LOWER($1)
         AND LOWER(vs.model) = LOWER($2)`,
      [make, model]
    );
    const hasPinData = parseInt(pinDataCheck.rows[0].cnt, 10) > 0;
    if (hasPinData) score += 0.50;

    // Factor 2: year falls within that system's year range
    if (hasPinData && !isNaN(yearInt)) {
      const yearCheck = await pool.query(
        `SELECT COUNT(*) as cnt
         FROM vehicle_systems
         WHERE LOWER(make) = LOWER($1)
           AND LOWER(model) = LOWER($2)
           AND year_start <= $3
           AND year_end >= $3`,
        [make, model, yearInt]
      );
      if (parseInt(yearCheck.rows[0].cnt, 10) > 0) score += 0.20;
    }

    // Factor 3: engine variant match in vehicle_engines table
    if (engine && !isNaN(yearInt)) {
      const engineCheck = await pool.query(
        `SELECT COUNT(*) as cnt
         FROM vehicle_engines
         WHERE LOWER(make) = LOWER($1)
           AND LOWER(model) = LOWER($2)
           AND year_start <= $3
           AND year_end >= $3
           AND LOWER(display_name) ILIKE $4`,
        [make, model, yearInt, `%${engine.split('(')[0].trim().toLowerCase()}%`]
      );
      if (parseInt(engineCheck.rows[0].cnt, 10) > 0) score += 0.15;
    }

    // Factor 4: instruction keyword matches a known vehicle_systems slug
    const systemCheck = await pool.query(
      `SELECT slug FROM vehicle_systems WHERE is_generic = FALSE LIMIT 20`
    );
    const slugs = systemCheck.rows.map(r => r.slug.toLowerCase());
    const lowerInstruction = instructionText.toLowerCase();
    const slugHit = slugs.some(s => lowerInstruction.includes(s));
    if (slugHit) score += 0.15;

  } catch (err) {
    // Confidence scoring is non-fatal — use base score
  }

  return Math.min(Math.round(score * 1000) / 1000, 1.0);
}

// ─── SVG diagram generation ───────────────────────────────────────────────────
// Generates a structured SVG wiring diagram as text via OpenAI.
// Returns an SVG string ready to upload as image/svg+xml.

const SVG_WIRING_PROMPT = `You are an ASE-certified master automotive technician creating wiring diagrams for DIY mechanics.
Generate a CLEAN SVG wiring diagram for the specified connector/component and vehicle.

Rules:
- Produce ONLY a valid SVG string, no markdown, no code fences, no explanation text.
- The SVG must be self-contained: width="600" height="400" viewBox="0 0 600 400" with a dark background (#0a0e17).
- Use cyan (#22d3ee) for labels and connector outlines.
- Use white (#ffffff) for wire lines.
- Show a visual connector box with labeled pins (pin number, wire color, signal name).
- Add expected voltage values as small text next to each pin.
- Include the component name and vehicle at the top.
- Add 2–3 "Testing Tips" as small text at the bottom.
- Maximum 20 pins. For connectors with more, show the 8 most diagnostically important.
- Make it readable at 600×400px — use 12–14px font for pin labels.
- Start the SVG with: <svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400">
- End with: </svg>
- Nothing before the opening <svg> tag or after </svg>.`;

async function generateWiringDiagramSVG(instructionText, make, model, year, engine) {
  const vehicleDesc = engine
    ? `${year} ${make} ${model} (${engine})`
    : `${year} ${make} ${model}`;

  // Extract the most likely component from the instruction
  const componentGuess = extractComponentFromInstruction(instructionText);

  const userPrompt = `Vehicle: ${vehicleDesc}
Diagnostic context: ${instructionText.substring(0, 400)}
Component to diagram: ${componentGuess}

Generate the wiring diagram SVG for this component on this vehicle.`;

  const aiRes = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    task: 'diagpilot-wiring-svg',
    messages: [
      { role: 'system', content: SVG_WIRING_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.2,
    max_tokens: 2000,
  });

  let svgContent = aiRes.choices[0].message.content.trim();

  // Strip any markdown fences if present
  svgContent = svgContent
    .replace(/^```(?:svg|xml)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // Validate it starts with <svg — if not, build a fallback
  if (!svgContent.startsWith('<svg')) {
    svgContent = buildFallbackSVG(componentGuess, vehicleDesc);
  }

  return svgContent;
}

// ─── Fallback SVG ─────────────────────────────────────────────────────────────
// Used when AI response is malformed. Shows a "data unavailable" card
// that still looks polished and doesn't crash the flow.

function buildFallbackSVG(component, vehicleDesc) {
  const safeComponent = component.replace(/[<>&"]/g, '');
  const safeVehicle = vehicleDesc.replace(/[<>&"]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400">
  <rect width="600" height="400" fill="#0a0e17"/>
  <rect x="20" y="20" width="560" height="360" rx="10" fill="none" stroke="#22d3ee" stroke-width="1" stroke-opacity="0.3"/>
  <text x="300" y="60" text-anchor="middle" fill="#22d3ee" font-family="monospace" font-size="14" font-weight="bold">${safeComponent}</text>
  <text x="300" y="85" text-anchor="middle" fill="#94a3b8" font-family="monospace" font-size="11">${safeVehicle}</text>
  <text x="300" y="200" text-anchor="middle" fill="#64748b" font-family="monospace" font-size="12">Wiring data generating — check service manual</text>
  <text x="300" y="220" text-anchor="middle" fill="#64748b" font-family="monospace" font-size="12">for your specific vehicle's pinout.</text>
</svg>`;
}

// ─── Component extraction ─────────────────────────────────────────────────────
// Heuristic: scan instruction text for known automotive component keywords
// and return the most specific one found. Falls back to generic "connector".

const COMPONENT_KEYWORDS = [
  'crankshaft position sensor', 'ckp sensor', 'crank sensor',
  'camshaft position sensor', 'cmp sensor', 'cam sensor',
  'mass airflow sensor', 'maf sensor',
  'oxygen sensor', 'o2 sensor', 'lambda sensor',
  'map sensor', 'manifold absolute pressure',
  'throttle position sensor', 'tps',
  'coolant temperature sensor', 'ects', 'ect sensor',
  'fuel injector', 'injector',
  'ignition coil', 'coil pack', 'cop coil',
  'abs sensor', 'wheel speed sensor',
  'idle air control', 'iac valve',
  'egr valve', 'egr sensor',
  'knock sensor',
  'variable valve timing', 'vvt solenoid', 'oil control valve',
  'alternator', 'generator',
  'starter motor', 'starter relay',
  'fuel pump', 'fuel pressure sensor',
  'pcm', 'ecm', 'ecu',
  'transmission speed sensor', 'input shaft sensor', 'output shaft sensor',
  'tcc solenoid', 'shift solenoid',
  'blower motor', 'hvac',
  'power steering pressure sensor',
];

function extractComponentFromInstruction(text) {
  const lower = text.toLowerCase();
  for (const kw of COMPONENT_KEYWORDS) {
    if (lower.includes(kw)) {
      return kw.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
  }
  return 'Connector Pinout';
}

// ─── R2 upload ────────────────────────────────────────────────────────────────
// Uploads SVG buffer to Polsia R2 proxy. Returns CDN URL.

async function uploadSvgToR2(svgString, filename) {
  const R2_BASE_URL = process.env.POLSIA_R2_BASE_URL || 'https://polsia.com';
  const POLSIA_API_KEY = process.env.POLSIA_API_KEY || '';

  const buffer = Buffer.from(svgString, 'utf-8');
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const CRLF = '\r\n';
  const preamble = Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
    `Content-Type: image/svg+xml${CRLF}${CRLF}`
  );
  const epilogue = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
  const body = Buffer.concat([preamble, buffer, epilogue]);

  const res = await fetch(`${R2_BASE_URL}/api/proxy/r2/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${POLSIA_API_KEY}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => 'unknown');
    throw new Error(`R2 SVG upload failed (${res.status}): ${errText}`);
  }

  const result = await res.json();
  // R2 proxy may return either result.url or result.file.url
  const url = result.url || (result.file && result.file.url);
  if (!url) throw new Error('R2 upload returned no URL: ' + JSON.stringify(result));
  return url;
}

// ─── Store in wiring_diagrams ─────────────────────────────────────────────────
// Stores auto-generated diagram as approved (no review queue — fully autonomous).
// Returns the full row including confidence_score and diagram_label.

async function storeDynamicDiagram({ make, model, year, engine, component, diagramUrl, confidence, diagramLabel, keywords }) {
  const yearInt = parseInt(year, 10);
  const keywordsArr = Array.from(new Set([
    component.toLowerCase(),
    make.toLowerCase(),
    model.toLowerCase(),
    ...keywords.map(k => k.toLowerCase()),
  ]));

  const title = `${year} ${make} ${model}${engine ? ` (${engine})` : ''} — ${component}`;

  const result = await pool.query(
    `INSERT INTO wiring_diagrams
       (title, diagram_url, keywords, make, model, year_start, year_end, is_generic,
        status, ai_generated, confidence_score, diagram_label)
     VALUES ($1, $2, $3, $4, $5, $6, $6, FALSE, 'approved', TRUE, $7, $8)
     RETURNING id, diagram_url, confidence_score, diagram_label`,
    [title, diagramUrl, keywordsArr, make, model, yearInt, confidence, diagramLabel]
  );
  return result.rows[0];
}

// ─── Public API ───────────────────────────────────────────────────────────────
// Called from routes/diagnose.js in place of the old findMatchingDiagram fallback.
// Returns { diagram_url, confidence, diagram_label } or null on failure.
// Never throws — diagram generation is non-fatal to the diagnostic flow.

async function findOrGenerateDiagram(instructionText, year, make, model, engine) {
  try {
    // 1. Try the static approved library first (existing behavior, fast path)
    const existing = await pool.query(
      `SELECT diagram_url, COALESCE(confidence_score, 1.0) as confidence_score, diagram_label
       FROM wiring_diagrams
       WHERE status = 'approved'
         AND (
           -- vehicle-specific match
           (make = $2 AND model = $3 AND year_start <= $4 AND year_end >= $4
            AND (SELECT COUNT(*) FROM unnest(keywords) k WHERE $1::text ILIKE '%' || k || '%') > 0)
           OR
           -- generic fallback
           (is_generic = TRUE
            AND (SELECT COUNT(*) FROM unnest(keywords) k WHERE $1::text ILIKE '%' || k || '%') > 0)
         )
       ORDER BY
         -- vehicle-specific beats generic
         CASE WHEN make = $2 AND model = $3 THEN 0 ELSE 1 END,
         -- more keyword hits = better match
         (SELECT COUNT(*) FROM unnest(keywords) k WHERE $1::text ILIKE '%' || k || '%') DESC
       LIMIT 1`,
      [instructionText, make, model, parseInt(year, 10)]
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      return {
        diagram_url: row.diagram_url,
        confidence: parseFloat(row.confidence_score),
        diagram_label: row.diagram_label || null,
      };
    }

    // 2. No static match — generate dynamically
    const component = extractComponentFromInstruction(instructionText);

    // Only generate if we identified a specific component (not just "Connector Pinout")
    if (component === 'Connector Pinout') return null;

    // Compute confidence before generating
    const confidence = await computeConfidence(instructionText, make, model, year, engine);

    // Build human-readable label for sub-95% confidence diagrams
    const CONFIDENCE_THRESHOLD = 0.95;
    let diagramLabel = null;
    if (confidence < CONFIDENCE_THRESHOLD) {
      diagramLabel = `Generic diagram — closest match for your vehicle. Layout may vary slightly for your specific ${year} ${make} ${model}.`;
    }

    // Generate SVG via OpenAI
    const svgContent = await generateWiringDiagramSVG(instructionText, make, model, year, engine);

    // Upload to R2
    const safeFilename = `wiring-${make}-${model}-${year}-${component.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.svg`;
    const diagramUrl = await uploadSvgToR2(svgContent, safeFilename);

    // Keywords for future matching (save these so next time is a cache hit)
    const keywords = [component.toLowerCase(), ...component.toLowerCase().split(' ')];

    // Store as approved diagram (cached for future sessions)
    await storeDynamicDiagram({
      make, model, year, engine, component,
      diagramUrl, confidence, diagramLabel, keywords,
    });

    return { diagram_url: diagramUrl, confidence, diagram_label: diagramLabel };

  } catch (err) {
    // Non-fatal — log and return null so diagnostic flow continues
    console.error('[wiringDiagram] findOrGenerateDiagram error:', err.message);
    return null;
  }
}

module.exports = { findOrGenerateDiagram };
