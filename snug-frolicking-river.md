# Task #1199377: Refactor Wiring Diagram System to be Vehicle-Aware

## Context

**Problem:** The current wiring diagram system matches diagrams to diagnostic steps by **keywords only**. A Ford 8-wire O2 sensor and a GM 5-wire O2 sensor have completely different connectors, pinouts, and wire colors, but identical keywords. Showing the wrong diagram is worse than showing none (customer could fry components).

**Goal:** Tie every wiring diagram to **make/model/year range** so that when a user selects a vehicle, ONLY diagrams matching that exact vehicle are shown. Support year ranges (many connectors are shared across model years).

**Impact:** BLOCKING — the entire diagram library architecture depends on vehicle-specific matching before more diagrams are uploaded.

---

## Requirements (From Task)

1. Every wiring diagram must have make/model/year range metadata (not just keywords)
2. When a user is in a diagnostic session with selected vehicle, show ONLY diagrams matching that vehicle + keyword
3. Admin upload interface must require make/model/year range fields
4. Support year ranges (e.g., Ford F-150 2011-2014)
5. Fallback: if no vehicle-specific diagram exists, show nothing (not generic/wrong)
6. Database schema: add `make`, `model`, `year_start`, `year_end` columns to `wiring_diagrams` table

---

## Solution Overview

### Phase 1: Database Migration (005_vehicle_aware_diagrams.js)

Add four new columns to `wiring_diagrams` table:
- `make` (VARCHAR(100), nullable initially to allow existing diagrams to be updated later)
- `model` (VARCHAR(100), nullable)
- `year_start` (INTEGER, nullable) — inclusive
- `year_end` (INTEGER, nullable) — inclusive
- `is_generic` (BOOLEAN, default FALSE) — flag for "show only if no vehicle-specific match"

Add index on (make, model, year_start, year_end) for fast filtering.

**Down migration:** Drop the new columns.

---

### Phase 2: Backend Changes

**1. Update `findMatchingDiagram()` function** (server.js, lines 1349-1377)

**Current signature:**
```javascript
async function findMatchingDiagram(instructionText)
```

**New signature:**
```javascript
async function findMatchingDiagram(instructionText, vehicleYear, vehicleMake, vehicleModel)
```

**Algorithm:**
1. Extract keywords from instructionText (same as before)
2. Build WHERE clause:
   - `WHERE keywords matches instruction text` (existing keyword logic)
   - `AND make = $vehicleMake AND model = $vehicleModel`
   - `AND year_start <= $vehicleYear AND year_end >= $vehicleYear`
3. Return best match by keyword overlap count
4. If no match: Check for generic fallback (is_generic = TRUE, keyword match)
5. If still no match: Return null

**Rationale for fallback:** Allows generic diagrams (e.g., "General Wiring 101") to display if no vehicle-specific diagram exists, but only after checking vehicle-specific first.

---

**2. Update `/api/diagnose/start` endpoint** (server.js, lines 821-907)

At line 877, change:
```javascript
// OLD:
const diagramUrl = await findMatchingDiagram(stepData.instruction + ' ' + (stepData.detail || ''));

// NEW:
const diagramUrl = await findMatchingDiagram(
  stepData.instruction + ' ' + (stepData.detail || ''),
  year,
  make,
  model
);
```

---

**3. Update `/api/diagnose/next` endpoint** (server.js, lines 910-1050)

At line 1019, change:
```javascript
// OLD:
const diagramUrl = stepData.is_diagnosis
  ? null
  : await findMatchingDiagram(stepData.instruction + ' ' + (stepData.detail || ''));

// NEW:
const diagramUrl = stepData.is_diagnosis
  ? null
  : await findMatchingDiagram(
      stepData.instruction + ' ' + (stepData.detail || ''),
      session.vehicle_year,
      session.vehicle_make,
      session.vehicle_model
    );
```

---

**4. Update `POST /api/admin/diagrams` endpoint** (server.js, lines 1182-1219)

Add required fields to request body:
- `make` (required) — from select dropdown
- `model` (required) — from select dropdown
- `year_start` (required) — integer, 1990-2027
- `year_end` (required) — integer, 1990-2027

Validation:
- Both make/model/year_start/year_end required
- year_start <= year_end
- year_start and year_end in range [1990, 2027]

Store in database:
```javascript
const result = await pool.query(
  `INSERT INTO wiring_diagrams (title, description, diagram_url, keywords, make, model, year_start, year_end)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
  [title, description, diagramUrl, keywordsArr, make, model, year_start, year_end]
);
```

---

**5. Update `GET /api/admin/diagrams` endpoint** (server.js, lines 1222-1232)

Add optional query parameters for filtering:
- `?make=Ford` — filter by make
- `?model=F-150` — filter by model
- `?year=2014` — filter by year (shows diagrams where year is in [year_start, year_end])

---

**6. Update `PATCH /api/admin/diagrams/:id` endpoint** (server.js, lines 1246-1278)

Add optional fields in request body to update:
- `make`, `model`, `year_start`, `year_end`

Validation same as upload endpoint.

---

### Phase 3: Frontend Admin Interface Changes

**File:** `public/admin.html`

**1. Diagram Upload Form** (lines 419-451)

Current fields:
- Title (required)
- Keywords (optional)
- Description (optional)
- Diagram File (required)

**Add new fields:**
- **Make** (required dropdown) — populated from `/api/vehicles/makes`
- **Model** (required dropdown) — populated from `/api/vehicles/models?make=...`
- **Year Start** (required numeric input or dropdown) — 1990-2027
- **Year End** (required numeric input or dropdown) — 1990-2027

New form structure:
```html
<div class="form-group">
  <label>Make *</label>
  <select id="diag-make">
    <option value="">Select make...</option>
    <!-- populated by fetchMakes() -->
  </select>
</div>
<div class="form-group">
  <label>Model *</label>
  <select id="diag-model">
    <option value="">Select model...</option>
  </select>
</div>
<div class="form-group">
  <label>Year Start *</label>
  <select id="diag-year-start">
    <option value="">1990</option>
    <!-- ... -->
    <option value="">2027</option>
  </select>
</div>
<div class="form-group">
  <label>Year End *</label>
  <select id="diag-year-end">
    <option value="">2027</option>
    <!-- ... -->
  </select>
</div>
```

**2. Form Validation** (upload handler)

- Title: required
- Make: required
- Model: required
- Year Start/End: required, both integers, year_start <= year_end
- Diagram File: required

**3. Diagram List Display** (lines 669-710)

Update diagram cards to show:
- Title
- Description
- Make / Model / Years (e.g., "Ford F-150 2011-2014")
- Keywords
- Copy URL, Edit, Delete buttons

Add "Edit" button to open modal for updating metadata (including make/model/years).

**4. Diagram List Filtering** (add above diagram grid)

Add filter controls:
- Make dropdown (optional)
- Model dropdown (optional, filters by selected make)
- Show all / Show only this year (toggle)

Fetches `GET /api/admin/diagrams?make=...&model=...&year=...`

---

### Phase 4: Vehicle Selector Data

The vehicle data already exists in server.js (lines 705-763):
- 28 makes (hardcoded)
- Models per make (hardcoded)
- Years 1990-2027

**Reuse existing endpoints:**
- `GET /api/vehicles/makes`
- `GET /api/vehicles/models?make=...`
- `GET /api/vehicles/years`

No changes needed — frontend will call these endpoints to populate dropdowns.

---

## Critical Files to Modify

| File | Changes | Lines |
|------|---------|-------|
| `migrations/005_vehicle_aware_diagrams.js` | NEW — add vehicle columns to wiring_diagrams | — |
| `server.js` | Update `findMatchingDiagram()` signature + logic | 1349-1377 |
| `server.js` | Update `/api/diagnose/start` call site | 877 |
| `server.js` | Update `/api/diagnose/next` call site | 1019 |
| `server.js` | Update `POST /api/admin/diagrams` endpoint | 1182-1219 |
| `server.js` | Update `GET /api/admin/diagrams` endpoint | 1222-1232 |
| `server.js` | Update `PATCH /api/admin/diagrams/:id` endpoint | 1246-1278 |
| `public/admin.html` | Add make/model/year fields to upload form | 419-451 |
| `public/admin.html` | Update diagram display to show vehicle info | 669-710 |
| `public/admin.html` | Add make/model/year dropdowns + populate logic | NEW |
| `public/admin.html` | Add upload handler validation | 603-656 |

---

## Data Migration Strategy

**Existing diagrams:** Currently have no make/model/year info. Options:

1. **Mark as legacy/generic:** Set `make=NULL, model=NULL, year_start=NULL, year_end=NULL` on existing rows. These will only display if no vehicle-specific match exists.
2. **Manual backfill:** Admin goes into each existing diagram and fills in vehicle info.
3. **Deprecate:** Delete all existing diagrams and ask owner to re-upload with vehicle info.

**Recommended:** Option 1 (mark as legacy). This ensures old diagrams don't break anything but also ensures new diagrams are vehicle-specific. When matching, if no vehicle-specific diagram exists, show the legacy one.

---

## Matching Algorithm (Detailed)

**findMatchingDiagram(instructionText, vehicleYear, vehicleMake, vehicleModel)**

```javascript
async function findMatchingDiagram(instructionText, vehicleYear, vehicleMake, vehicleModel) {
  try {
    // Extract keywords from instruction (same as before)
    const words = instructionText.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4);

    if (words.length === 0) return null;

    // First query: VEHICLE-SPECIFIC diagrams
    let result = await pool.query(
      `SELECT id, diagram_url, title, keywords,
              (SELECT COUNT(*) FROM unnest(keywords) k WHERE $1::text ILIKE '%' || k || '%') as match_count
       FROM wiring_diagrams
       WHERE
         make = $2
         AND model = $3
         AND year_start <= $4
         AND year_end >= $4
         AND (SELECT COUNT(*) FROM unnest(keywords) k WHERE $1::text ILIKE '%' || k || '%') > 0
       ORDER BY match_count DESC
       LIMIT 1`,
      [instructionText, vehicleMake, vehicleModel, vehicleYear]
    );

    if (result.rows.length > 0) {
      return result.rows[0].diagram_url;
    }

    // Fallback: GENERIC diagrams (if is_generic = true)
    result = await pool.query(
      `SELECT id, diagram_url, title, keywords,
              (SELECT COUNT(*) FROM unnest(keywords) k WHERE $1::text ILIKE '%' || k || '%') as match_count
       FROM wiring_diagrams
       WHERE
         is_generic = true
         AND (SELECT COUNT(*) FROM unnest(keywords) k WHERE $1::text ILIKE '%' || k || '%') > 0
       ORDER BY match_count DESC
       LIMIT 1`,
      [instructionText]
    );

    if (result.rows.length > 0) {
      return result.rows[0].diagram_url;
    }

    return null;
  } catch (err) {
    console.error('findMatchingDiagram error:', err);
    return null; // Non-fatal
  }
}
```

---

## Verification

### 1. Database Migration

```bash
npm run migrate  # Verify 005_vehicle_aware_diagrams.js runs successfully
psql $DATABASE_URL -c "
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'wiring_diagrams'
  ORDER BY ordinal_position
"
# Should show: id, title, description, diagram_url, keywords, created_at, updated_at, make, model, year_start, year_end, is_generic
```

### 2. Upload Endpoint

- Upload diagram with all required fields (make, model, year_start, year_end)
- Verify database contains vehicle info: `SELECT * FROM wiring_diagrams WHERE id = <latest>`
- Admin UI shows "Ford F-150 2011-2014" on diagram card

### 3. Matching Logic

- Start diagnostic session: Vehicle = "2014 Ford F-150"
- Step instruction matches multiple diagrams (one Ford-specific, one generic)
- Verify: Ford-specific diagram is shown, not generic

### 4. Edge Cases

- **No vehicle-specific diagram:** Generic diagram shown
- **Year range mismatch:** No diagram shown
- **Keyword mismatch:** No diagram shown
- **Year boundary:** 2011 and 2014 diagrams both match "2011 Ford F-150", 2013 diagram matches "2013 Ford F-150", 2015 diagram does NOT match "2014 Ford F-150"

### 5. Admin UI

- Upload form requires make/model/year_start/year_end (cannot submit without)
- Diagram list filters by make/model/year
- Edit button updates vehicle info on existing diagrams

---

## Rollout Strategy

1. **Create migration** → Deploy to production (no data changes yet)
2. **Update backend logic** (findMatchingDiagram, endpoints) → Deploy
3. **Mark existing diagrams as legacy** via script or manual SQL update
4. **Update admin UI** → Deploy
5. **Test with owner:** Upload new vehicle-specific diagram, verify it shows in diagnostic session
6. **Announce to users:** "Diagrams now vehicle-specific — better accuracy"

**No breaking changes:** Existing diagnostic sessions continue to work. New sessions use vehicle-aware matching.

---

## Implementation Order (Step-by-Step)

1. Write migration 005
2. Update `findMatchingDiagram()` function
3. Update `/api/diagnose/start` call site
4. Update `/api/diagnose/next` call site
5. Update POST/GET/PATCH admin endpoints
6. Update admin.html form (add vehicle fields + validation)
7. Test end-to-end
8. Deploy & verify

