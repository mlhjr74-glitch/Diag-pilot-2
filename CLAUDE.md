# DiagPilot — CLAUDE.md

## What this app does
DiagPilot is an AI-powered car diagnostic tool for DIY mechanics. Users describe a symptom, get step-by-step AI-guided diagnostic flowcharts, input test readings, and can escalate to a live certified technician via video call. Monthly subscription at $9.99/mo gates diagnostic access.

## Stack
Express.js + PostgreSQL (Neon) + OpenAI proxy · Render deployment · Stripe billing · Polsia R2 for file storage

## Directory map
- `server.js` — entry point: middleware mounts, route mounts, app.listen (≤60 lines)
- `routes/` — one file per API group: auth, subscription, stripe, vehicles, diagnose, admin, partLocations, vehicleSystems
- `db/` — database query functions: index.js (Pool), diagrams.js, partLocations.js, events.js, vehicleSystems.js, engines.js
- `middleware/` — auth.js: authenticateToken, requireSubscription, requireAdmin, session helpers
- `services/` — r2.js: Polsia R2 file upload helper; wiringDiagram.js: dynamic AI diagram generation + confidence scoring
- `public/` — static HTML pages (index.html, app.html, auth.html, admin.html), OG image, favicons
- `migrations/` — node-pg-migrate JS migration files (001–011)
- `migrate.js` — migration runner executed before server start

## Database
- `diagnostic_sessions` — one per diagnosis attempt, holds vehicle info + optional vehicle_engine and symptom
- `diagnostic_steps` — each AI-generated step in a session, with user input and diagram_url
- `users` — email/password accounts with subscription status; `subscription_plan='founder_comp'` for comp'd users
- `user_sessions` — 30-day persistent auth tokens
- `password_reset_tokens` — single-use reset links
- `wiring_diagrams` — diagram library; status=approved|pending_review|rejected; ai_generated flag; review_notes; confidence_score (0–1.0, null=manual upload); diagram_label (shown to user when confidence<0.95)
- `part_locations` — physical location descriptions keyed by (part_name, make, model, year_range); generic fallbacks for all vehicles
- `user_events` — activity log: signups, logins, paywall hits, checkout starts, subscription activations, pageviews
- `vehicle_systems` — system reference entries (ignition, fuel, etc.) keyed by make/model/year; is_generic=true for fallbacks
- `vehicle_system_components` — components within a system (coils, sensors, etc.) with location text
- `vehicle_component_pins` — pinout rows per component: pin number, wire color, signal name, description/expected values
- `vehicle_engines` — engine options per make/model/year (displacement, type, fuel_type, display_name, hp, torque); queried by `/api/vehicles/engines`

## External integrations
- **OpenAI** — diagnostic flowchart generation + AI wiring diagram SVG generation via `OPENAI_API_KEY` / `OPENAI_BASE_URL`
- **Stripe** — subscription billing via webhook at `/api/stripe/webhook`; portal at billing.stripe.com
- **Polsia R2** — wiring diagram image uploads via `POLSIA_R2_BASE_URL` / `POLSIA_API_KEY`

## Recent changes
- 2026-05-01: Logo redesign — SVG logo (`diagpilot-logo.svg`): wrench-body + circuit-trace neural nodes in brand cyan/orange; favicon.svg + apple-touch-icon.svg updated to match mark; all 4 HTML pages (index, app, auth, admin) now render `<img>` logo instead of text
- 2026-05-01: Dynamic AI wiring diagrams with 95% confidence gate (migration 012, `services/wiringDiagram.js`) — auto-generates SVG diagrams during diagnostics when no static match exists; confidence score 0–1.0 based on pinout data availability, year-range match, engine variant, and system slug overlap; 95%+ shows as vehicle-specific, below 95% shows "Generic diagram — closest match" note; generated diagrams cached in `wiring_diagrams` table as auto-approved for future sessions
- 2026-05-01: Fixed diagnostic AI looping (`routes/diagnose.js`) — conversation history no longer repeats "generate next step" on every historical message (only on the last); added 6 DIAGNOSTIC FLOW RULES to system prompt (never re-ask answered questions, detect closure signals, 8-step hard cap); fallback responses now produce concrete actionable steps instead of vague "tell me more" loops
- 2026-05-01: Fixed diagnostic flow crash at steps 3–4 (`routes/diagnose.js`) — `/next` endpoint now tells AI it is generating the NEXT step (not the first) with explicit context that the user's selected option is valid; `max_tokens` raised 800→1500 for fuller step generation; added defensive field guard so malformed AI responses produce a fallback step instead of crashing
- 2026-04-30: Engine sub-selection (migrations 009–011) — `vehicle_engines` table with OEM-sourced engine data for all 28 makes; 4th dropdown in vehicle selector (Year → Make → Model → Engine); engine shown only when DB has data for selection; engine context passed to AI diagnostic prompts
