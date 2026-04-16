# BACKLOG — Product ideas, not yet built

Ideas Dave dumps here as they come to mind. Not a priority list — more a catcher's mitt so nothing gets lost.

Format:
- **Title** (one line)
- _why_ — the value / user problem
- _how_ — rough implementation thought (may be wrong, refine when we pick it up)
- _status_ — `idea` / `spec'd` / `in-flight` / `shipped`

When one gets picked up, move it near the top and flip the status.

---

## Market context & competitive intel

### Google / Yelp review ingestion
- _why_ — Two practices with identical internal numbers can have very different patient-perceived quality. A 4.9-star practice with 300 Google reviews is in a very different place than a 3.1-star practice with 12 reviews and three recent one-stars about wait times. Reviews surface operational patterns that the numbers can't: staff turnover (names disappearing), front-desk tone, insurance billing surprises, treatment-presentation friction. Including them in the Assessment lets the SWOT reflect *what patients actually say* instead of only what the P&L shows.
- _how_ — We already have practice name + zip from the questionnaire.
  - **Google**: Places API `findPlaceFromText` → `placeId` → `place details` returns rating, user_ratings_total, and up to 5 most recent reviews with author, rating, text, time. Official API, requires a Google Cloud key, ~$0.02 per lookup.
  - **Yelp**: Fusion API `businesses/search` → `businesses/{id}/reviews` (3 most recent). Free tier is generous.
  - Optional second pass: feed the review text to Claude and ask it to tag themes (wait times, billing, clinical quality, front desk, etc.) and produce a short "what patients are saying" summary.
  Surface on the Report as a "Market Voice" card: overall rating, review count, representative positive + negative quote, and any themes that stood out. Feeds into SWOT as strengths (if 4.5+ / high volume) or weaknesses (if themes show operational issues).
- _status_ — idea (2026-04-16)

### Competitive-market score from ZIP code
- _why_ — Two practices with identical internal numbers can have very different strategic situations. A practice in a dense metro with 20 dentists in a 3-mile radius is playing a different game than one rural practice serving a 30-mile radius. Knowing which situation the client is in changes the recommendations we make (e.g., marketing strategy, FFS vs PPO mix advice, pricing posture, expansion viability).
- _how_ — On submission, look up the practice's zip against:
  - U.S. Census / ACS data → population density, median income, age demographics of the service area
  - HRSA or state licensing data → number of active dentists within an N-mile radius
  - Some simple rollup score (1–10) that combines density, competition count, and income level
  Then surface it on the Report as a "Market Context" card next to the scorecard, and let it influence SWOT + Opportunity language (e.g., "in a highly competitive metro like yours, raising fees above PPO max is a meaningful lift").
- _status_ — idea (2026-04-16)

---

## Data quality / pipeline

_(nothing here yet — Dave flag anything from the Debug Workbook that looked off here)_

---

## UX / Report polish

_(Dave said: mathematical correctness first, visual polish later — nothing here until KPIs are verified)_

---

## Deferred from earlier in this session

- **Owner vs Associate $/Day split** — currently just showing Combined because we can't derive per-provider production without parsing per-provider PDFs. Revisit when we pick up Phase 3 (better PDF extraction).
- **Overhead methodology review** — Dave said "I'm trying to understand what 87% overhead means right now, let's come back to that later." Current code subtracts owner add-backs (car, meals, travel, 401k) and patient reimbursements from expenses. Worth revisiting whether that matches Dave's teaching methodology exactly.
- **Review & Edit step (Phase 2 from the refactor plan)** — a screen between "server returned data" and "view report" where Dave (or the dentist) can override any extracted/computed value before the Report generates. Replaces what the old Excel workbook was doing as a "working canvas."

---

## How to add to this file

Just say "add to the backlog: X" and I'll write it up properly with the _why_ / _how_ / _status_ fields.
