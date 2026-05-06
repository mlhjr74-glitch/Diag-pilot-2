// Owns: /api/diagnose/* — diagnostic session start, step progression, session retrieval
// Does NOT own: user auth, vehicle data, wiring diagram library

const express = require('express');
const OpenAI = require('openai');
const pool = require('../db/index');
const { findOrGenerateDiagram } = require('../services/wiringDiagram');
const { authenticateToken, requireSubscription } = require('../middleware/auth');

const router = express.Router();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
});

const SYSTEM_PROMPT = `You are DiagPilot, an AI diagnostic guide for everyday car owners — not professional mechanics. Your job is to walk someone through their FIRST diagnostic who has never opened their hood before.

LANGUAGE RULES (these override everything else):
1. Write as if explaining to a smart friend who has never touched a car. Use plain English throughout.
2. When you must use a technical term, put it in parentheses after the plain-English version. Example: "the crankshaft position sensor (CKP sensor)".
3. NEVER say "back probe" — say "carefully push a thin pointed test lead (like a T-pin or unfolded paperclip) into the BACK of the plug while it's still plugged in".
4. NEVER say "known good ground" — say "clip your black multimeter lead to a clean, unpainted metal bolt on the engine block (this is your ground reference)".
5. NEVER say "check continuity" without explaining: "Set your multimeter to the Ω (ohm) symbol — if it beeps, the wire is good. If it stays silent, the wire is broken."
6. When referencing a connector or wire, ALWAYS describe: (a) where on the engine it is, (b) what it looks like (color, size, number of pins), (c) how to find it physically. Do NOT just say "gray/green wire."
7. Every step that references a physical component must describe WHERE it is located on the engine or car — reference landmarks a non-mechanic can see (e.g. "near the big belt at the front of the engine", "bolted to the firewall — the vertical metal wall between you and the engine").
8. Tool instructions must be complete: don't assume they know how to use a multimeter. Say exactly which setting to use, which lead goes where, and what the display will show.
9. Accuracy is non-negotiable — your steps must be technically correct. Just write them in plain English.

JARGON TOOLTIP FIELD:
For each step, include a "jargon_terms" array of any technical terms used, with a plain-English explanation. This powers inline tooltips for the user. Example:
"jargon_terms": [
  { "term": "MAF sensor", "explanation": "Mass Air Flow sensor — measures how much air enters the engine. It looks like a small black cylinder in the big air intake hose." },
  { "term": "continuity", "explanation": "A test that checks if electricity can flow through a wire end-to-end. If your multimeter beeps, the wire is intact." }
]
If no jargon, use an empty array: "jargon_terms": []

TOOL USAGE:
- multimeter: Always specify the exact dial setting (DC Volts, Ω ohms, etc.), which probe goes where (red = positive, black = negative/ground), and what a normal reading looks like on the display.
- scan_tool: Explain this is an OBD-II scanner they can buy for ~$30 at AutoZone, or borrow free at most auto parts stores. Explain exactly which reading to look at.
- visual: Describe exactly what to look for — cracks, wetness, color changes, disconnected plugs. Be specific about location.
- test_light: Explain it's a simple tool with a pointed probe and a clip — clip the clip to bare metal, touch probe to the wire. Light on = power present.

STEP LENGTH: Each instruction should be 2–4 sentences covering the physical action. Put extra context in the "detail" field.

DIAGNOSTIC FLOW RULES (critical — follow these exactly):
1. NEVER re-ask a question the user already answered. If they gave an answer, accept it and move forward — even if vague. Work with what you have.
2. NEVER ask open-ended "tell me more" or "can you describe" questions more than once per session. If you already asked for details and got a response, USE that response and advance to a concrete test step.
3. ALWAYS progress toward a diagnosis. Every step should either (a) test something measurable or (b) narrow the problem. "Gathering more info" is not progress after step 2.
4. When the user says "no", "no more", "nothing else", "that's it", or any similar closure — IMMEDIATELY produce a final diagnosis (is_diagnosis: true). Do NOT ask again.
5. If you have enough information to identify the likely problem, issue the diagnosis. Don't keep testing to be 100% certain — a probable diagnosis with next steps is better than an infinite loop of tests.
6. After 8 steps without a diagnosis, you MUST issue your best diagnosis on the next step based on everything gathered so far.

RESPONSE FORMAT — You MUST respond with valid JSON only, no markdown:
{
  "instruction": "Plain-English step instruction (2-4 sentences). Describe the physical action clearly, including where to find the part.",
  "detail": "Additional context: what to look for, what could go wrong, why this test matters. Optional but encouraged.",
  "input_type": "voltage|continuity|yes_no|select|text|visual|none",
  "input_label": "What to enter (e.g. 'Voltage reading from your multimeter')",
  "input_options": ["option1", "option2"] or null,
  "expected_values": "What normal looks like in plain English (e.g. '12.4 to 12.8 volts — anything below 12.0V means the battery is weak')",
  "tool_needed": "multimeter|scan_tool|visual|test_light|none",
  "safety_warning": "Plain-English safety note or null (e.g. 'Make sure the engine is OFF and cool before touching anything near the exhaust')",
  "is_diagnosis": false,
  "jargon_terms": [{ "term": "technical term", "explanation": "plain English explanation" }]
}

When you've reached a diagnosis (is_diagnosis: true):
{
  "instruction": "Diagnosis summary in plain English",
  "detail": "What's happening and why, explained simply",
  "input_type": "none",
  "input_label": null,
  "input_options": null,
  "expected_values": null,
  "tool_needed": "none",
  "safety_warning": null,
  "is_diagnosis": true,
  "jargon_terms": [],
  "diagnosis": {
    "problem": "Short plain-English problem name",
    "explanation": "What's happening and why, explained for a non-mechanic",
    "parts_cost": "$XX - $XXX",
    "labor_estimate": "X-X hours",
    "difficulty": "Easy|Medium|Hard",
    "professional_recommended": true/false,
    "next_steps": ["Step 1 in plain English", "Step 2 in plain English"]
  }
}`;

function parseAIResponse(content) {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(cleaned);
}

// Start a new diagnostic session
router.post('/start', authenticateToken, requireSubscription, async (req, res) => {
  try {
    const { year, make, model, engine, symptom } = req.body;
    if (!year || !make || !model || !symptom) {
      return res.status(400).json({ error: 'year, make, model, and symptom are required' });
    }

    // engine is optional — store alongside vehicle info when provided
    const vehicleEngine = engine || null;

    const sessionResult = await pool.query(
      'INSERT INTO diagnostic_sessions (vehicle_year, vehicle_make, vehicle_model, vehicle_engine, symptom, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [year, make, model, vehicleEngine, symptom, req.user.id]
    );
    const sessionId = sessionResult.rows[0].id;

    const vehicleDesc = vehicleEngine
      ? `${year} ${make} ${model} (${vehicleEngine})`
      : `${year} ${make} ${model}`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      task: 'diagpilot-diagnostic-flow',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Vehicle: ${vehicleDesc}\nSymptom reported by user: ${symptom}\n\nGenerate the FIRST diagnostic step. Start with the most likely cause and most basic test first.` }
      ],
      temperature: 0.3,
      max_tokens: 1200,
    });

    let stepData;
    try {
      stepData = parseAIResponse(aiResponse.choices[0].message.content);
    } catch (parseErr) {
      console.error('AI response parse error:', parseErr.message);
      stepData = {
        instruction: `Let's diagnose your ${year} ${make} ${model}. Describe when the symptom occurs — when starting, while driving, or at idle?`,
        detail: 'This helps narrow down which system to focus on.',
        input_type: 'text', input_label: 'When does the problem occur?',
        input_options: null, expected_values: null, tool_needed: 'none',
        safety_warning: null, is_diagnosis: false, jargon_terms: []
      };
    }

    const diagramResult = await findOrGenerateDiagram(stepData.instruction + ' ' + (stepData.detail || ''), year, make, model, vehicleEngine);
    const diagramUrl = diagramResult ? diagramResult.diagram_url : null;

    await pool.query(
      `INSERT INTO diagnostic_steps (session_id, step_number, instruction, input_type, input_label, input_options, status, diagram_url)
       VALUES ($1, 1, $2, $3, $4, $5, 'active', $6)`,
      [sessionId, stepData.instruction + (stepData.detail ? '\n\n' + stepData.detail : ''),
       stepData.input_type || 'text', stepData.input_label || 'Your response',
       stepData.input_options ? JSON.stringify(stepData.input_options) : null, diagramUrl]
    );

    res.json({
      session_id: sessionId,
      vehicle: vehicleDesc,
      symptom,
      step: {
        step_number: 1,
        ...stepData,
        diagram_url: diagramUrl,
        diagram_confidence: diagramResult ? diagramResult.confidence : null,
        diagram_label: diagramResult ? diagramResult.diagram_label : null,
      }
    });
  } catch (err) {
    console.error('Error starting diagnostic:', err);
    res.status(500).json({ error: 'Failed to start diagnostic session' });
  }
});

// Submit a response and get the next step
router.post('/next', authenticateToken, requireSubscription, async (req, res) => {
  try {
    const { session_id, step_number, response } = req.body;
    if (!session_id || !step_number || response === undefined) {
      return res.status(400).json({ error: 'session_id, step_number, and response are required' });
    }

    const sessionResult = await pool.query('SELECT * FROM diagnostic_sessions WHERE id = $1', [session_id]);
    if (sessionResult.rows.length === 0) return res.status(404).json({ error: 'Session not found' });

    const session = sessionResult.rows[0];
    if (session.user_id && session.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });

    await pool.query(
      `UPDATE diagnostic_steps SET user_response = $1, status = 'completed' WHERE session_id = $2 AND step_number = $3`,
      [response, session_id, step_number]
    );

    const stepsResult = await pool.query('SELECT * FROM diagnostic_steps WHERE session_id = $1 ORDER BY step_number ASC', [session_id]);

    // Include engine in vehicle description if it was captured at session start
    const sessionVehicleDesc = session.vehicle_engine
      ? `${session.vehicle_year} ${session.vehicle_make} ${session.vehicle_model} (${session.vehicle_engine})`
      : `${session.vehicle_year} ${session.vehicle_make} ${session.vehicle_model}`;

    // Build conversation history for context-aware step generation
    // IMPORTANT: Only the LAST user message asks for the next step.
    // Historical messages are pure context — no repeated instructions.
    const totalSteps = stepsResult.rows.length;
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Vehicle: ${sessionVehicleDesc}\nSymptom: ${session.symptom}\n\nBelow is the diagnostic history so far (${totalSteps} steps completed). After reviewing, generate the next step.` }
    ];

    for (let i = 0; i < stepsResult.rows.length; i++) {
      const step = stepsResult.rows[i];
      const isLast = (i === stepsResult.rows.length - 1);
      // Include full step data so the AI knows what it already asked
      const priorStep = { instruction: step.instruction, input_type: step.input_type || 'none', input_label: step.input_label || null, input_options: step.input_options || null };
      messages.push({ role: 'assistant', content: JSON.stringify(priorStep) });
      if (step.user_response) {
        if (isLast) {
          // Only the LAST user message carries the "generate next step" instruction
          // This prevents the AI from seeing "generate next" repeated N times
          const closureSignal = /\b(no|none|nothing|nope|that'?s? ?(it|all)|no more|not really|i'?m done|all good)\b/i.test(step.user_response);
          let instruction;
          if (closureSignal) {
            instruction = `User's answer: ${step.user_response}\n\nThe user is indicating they have no additional information. Based on everything gathered in this session, provide your FINAL DIAGNOSIS now (is_diagnosis: true). Do NOT ask another question.`;
          } else if (totalSteps >= 8) {
            instruction = `User's answer: ${step.user_response}\n\nThis diagnostic has run ${totalSteps} steps. Issue your best diagnosis NOW (is_diagnosis: true) based on all information gathered. Do not ask further questions.`;
          } else {
            instruction = `User's answer: ${step.user_response}\n\nGenerate the NEXT diagnostic step. The user's answer is valid — move forward with a concrete test or measurement. If you have enough information to identify the problem, provide a diagnosis (is_diagnosis: true).`;
          }
          messages.push({ role: 'user', content: instruction });
        } else {
          // Historical exchanges — plain context only, no instructions
          messages.push({ role: 'user', content: `User's answer: ${step.user_response}` });
        }
      }
    }

    // Append termination rules based on total diagnostic progress
    if (totalSteps >= 10) {
      messages.push({ role: 'system', content: 'FORCE DIAGNOSIS MODE: You have completed 10+ steps. The user has provided enough information to identify the problem. You MUST return is_diagnosis: true with a diagnosis now. Do not ask any more clarifying questions — synthesize what you know and provide the diagnosis.' });
    } else if (totalSteps >= 7) {
      messages.push({ role: 'system', content: 'LATE-STAGE GUIDANCE: After 7+ steps, the diagnostic is well-advanced. You should only ask ONE more focused clarification question, then provide a diagnosis. Do not loop on the same topic.' });
    }

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini', task: 'diagpilot-diagnostic-flow',
      messages, temperature: 0.3, max_tokens: 1500,
    });

    let stepData;
    try {
      stepData = parseAIResponse(aiResponse.choices[0].message.content);
      // Defensive: ensure required fields exist so insert doesn't crash
      if (!stepData || typeof stepData.instruction !== 'string') {
        console.error('AI response missing instruction field:', aiResponse.choices[0].message.content.substring(0, 200));
        // Fallback: produce a concrete next step instead of a vague clarification loop
        stepData = {
          instruction: `Let's do a visual inspection. Open the hood and look for any obvious issues: disconnected hoses, cracked wires, or fluid leaks around the engine.`,
          detail: 'A quick visual check often reveals the simplest problems first — loose connections, corrosion on battery terminals, or broken vacuum lines.',
          input_type: 'select', input_label: 'What did you find?',
          input_options: ['Everything looks normal', 'Found a disconnected or damaged part', 'Not sure — something looks off'],
          expected_values: null, tool_needed: 'visual', safety_warning: 'Make sure the engine is OFF and cool before reaching near any belts or hot surfaces.',
          is_diagnosis: false, jargon_terms: []
        };
      }
      // Ensure all required fields have safe defaults
      stepData.input_type = stepData.input_type || 'text';
      stepData.input_label = stepData.input_label || 'Your response';
    } catch (parseErr) {
      console.error('AI response parse error:', parseErr.message);
      // Fallback: actionable step, not a vague "tell me more" that causes loops
      stepData = {
        instruction: `Let's check the basics. Turn the key to the ON position (don't start the engine) and look at your dashboard warning lights. Which lights stay on?`,
        detail: 'Dashboard warning lights are the car\'s built-in diagnostic system. Certain combinations point directly to specific problems.',
        input_type: 'text', input_label: 'Which warning lights are on?', input_options: null,
        expected_values: 'Common lights: Check Engine, Battery, Oil, ABS, Traction Control',
        tool_needed: 'none', safety_warning: null, is_diagnosis: false, jargon_terms: []
      };
    }

    const newStepNumber = step_number + 1;

    // Hard stop: after 12 steps, force a diagnosis regardless of what the AI returned.
    // Prevents infinite loops when the model keeps asking clarification questions.
    if (newStepNumber >= 12 && !stepData.is_diagnosis) {
      stepData.is_diagnosis = true;
      stepData.diagnosis = {
        problem: 'Diagnostic path exhausted — manual inspection recommended',
        explanation: 'The automated diagnostic has worked through a full troubleshooting sequence without reaching a clear conclusion. Based on the information gathered, a professional mechanic inspection is recommended to pinpoint the issue.',
        parts_cost: 'Unknown — requires inspection',
        labor_estimate: 'Variable',
        difficulty: 'Unknown',
        professional_recommended: true,
        next_steps: [
          'Review the diagnostic steps completed above with a mechanic',
          'Bring your notes from each test result to the shop',
          'Consider using an OBD-II scanner to pull any stored trouble codes'
        ]
      };
    }

    if (stepData.is_diagnosis) {
      await pool.query(
        `UPDATE diagnostic_sessions SET status='completed', diagnosis_result=$1, updated_at=NOW() WHERE id=$2`,
        [JSON.stringify(stepData.diagnosis || {}), session_id]
      );
    }

    const diagramResult = stepData.is_diagnosis ? null : await findOrGenerateDiagram(
      stepData.instruction + ' ' + (stepData.detail || ''),
      session.vehicle_year, session.vehicle_make, session.vehicle_model, session.vehicle_engine
    );
    const diagramUrl = diagramResult ? diagramResult.diagram_url : null;

    await pool.query(
      `INSERT INTO diagnostic_steps (session_id, step_number, instruction, input_type, input_label, input_options, status, diagram_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [session_id, newStepNumber, stepData.instruction + (stepData.detail ? '\n\n' + stepData.detail : ''), stepData.input_type || 'none', stepData.input_label || null, stepData.input_options ? JSON.stringify(stepData.input_options) : null, stepData.is_diagnosis ? 'completed' : 'active', diagramUrl]
    );

    res.json({
      session_id,
      step: {
        step_number: newStepNumber,
        ...stepData,
        diagram_url: diagramUrl,
        diagram_confidence: diagramResult ? diagramResult.confidence : null,
        diagram_label: diagramResult ? diagramResult.diagram_label : null,
      }
    });
  } catch (err) {
    console.error('Error getting next step:', err);
    res.status(500).json({ error: 'Failed to get next diagnostic step' });
  }
});

// Retrieve a session with all steps
router.get('/session/:id', authenticateToken, requireSubscription, async (req, res) => {
  try {
    const sessionResult = await pool.query('SELECT * FROM diagnostic_sessions WHERE id = $1', [req.params.id]);
    if (sessionResult.rows.length === 0) return res.status(404).json({ error: 'Session not found' });

    const session = sessionResult.rows[0];
    if (session.user_id && session.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });

    const stepsResult = await pool.query('SELECT * FROM diagnostic_steps WHERE session_id = $1 ORDER BY step_number ASC', [req.params.id]);
    res.json({ session, steps: stepsResult.rows });
  } catch (err) {
    console.error('Error fetching session:', err);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

module.exports = router;
