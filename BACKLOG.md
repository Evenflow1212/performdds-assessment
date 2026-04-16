# BACKLOG — Product ideas, not yet built

Ideas Dave dumps here as they come to mind. Not a priority list — more a catcher's mitt so nothing gets lost.

Format:
- **Title** (one line)
- _why_ — the value / user problem
- _how_ — rough implementation thought (may be wrong, refine when we pick it up)
- _status_ — `idea` / `spec'd` / `in-flight` / `shipped`

When one gets picked up, move it near the top and flip the status.

---

## SWOT rules (content quality)

### Payor-mix SWOT: out-of-network practices should consider high-paying PPOs
- _why_ — Being out of network is an impediment for new patient acquisition. Patients increasingly filter their dentist search by what their insurance accepts. A practice that's 100% FFS (or >70% FFS) is leaving new patients on the table — especially anyone whose employer plan routes them to in-network providers. The assessment already captures payor mix on the questionnaire; we should use it.
- _how_ — In generateSWOT, when payorMix.ffs ≥ 70 (and/or ppo = 0), add an **Opportunity** bullet along the lines of: "At [X]% out of network, the practice may be limiting its new-patient pool. Selectively joining 1–2 high-paying PPOs (e.g., Delta Premier / Aetna / MetLife tiers) would make the practice accessible to more patients without wholesale discounting."
  - Tier 1 fire at ffs == 100 (stronger language)
  - Tier 2 fire at ffs ≥ 70 (softer)
  - **EXEMPTION**: cosmetic/boutique practices. Signals: high $/day, high crown value, low total patient volume (low prophy count), affluent ZIP. For these, do NOT suggest PPOs — their FFS-only posture is the strategy, not an accident.
  - **Instead for exempted practices**: add a Threat bullet about concentration risk — low patient volume means the practice is highly dependent on a strong economy, and a small number of yes/no decisions can make or break a quarter.
  - **New patient gating** (answer to Q2):
    - Rule of thumb: a 100% FFS or heavily-FFS practice typically tops out at 20–25 new patients/month.
    - If `ffs ≥ 70% AND npPerMonth ≥ 30` → add a **Strength** bullet celebrating that the practice is thriving out-of-network, which is hard to pull off.
    - Still fire the PPO "consider this" nudge regardless of NP flow, but with a **caveat** built into the language: "we know it's not easy to earn a living out of network; if being out-of-network is core to the practice identity, skip this — just something to consider." So the bullet reads less like a prescription and more like an option.
  - **Phrasing — stay generic for v1** (answer to Q3): don't name specific PPO carriers in the SWOT text. Keep it "high-paying PPOs" and let the consultation call do the naming. Revisit once we build per-state reimbursement intelligence (see follow-up below).
  - **Quadrant assignment** (answer to Q4): clean separation — low new-patient count goes in **Weakness** (the symptom), adding a PPO goes in **Opportunity** (the lever). They reference the same underlying issue but belong in their own quadrants.
  - **Dollar quantification** (answer to Q5): rough formula is `10-15 additional new patients/month × PPO patient first-year national average spend`. Need to research the benchmark — what does a new PPO patient typically spend in their first 12 months at a new dentist? Industry research gives us $1,500–$2,500 as a rough range; tighten with a real source before shipping. _Action item_: WebSearch for "PPO new patient first year value dental" when spec'ing this rule, or pull from ADA Health Policy Institute data.
- _open questions_ — remaining questions in chat; Dave answering one at a time
- _status_ — idea (2026-04-16, Dave answered Q1 + Q2)

### Per-state PPO reimbursement intelligence
- _why_ — Once we want to name specific PPOs in the SWOT ("join Delta Premier and Aetna, they pay best in your market"), we need a lookup: for this state/region, which carriers pay above average. Until we have that data, the SWOT has to stay generic ("high-paying PPOs") and leave the carrier selection to the consulting call.
- _how_ — Could start with a manually-curated JSON of carriers-per-state ranked by typical reimbursement tier. Over time, could be fed by aggregated data from Dave's client base (anonymized). Could also consider third-party sources if any exist (most are paid subscriptions).
- _status_ — idea (2026-04-16) — gating specific-PPO naming in the payor-mix SWOT rule above.

### Teach: Crown value methodology
- _why_ — Dave mentioned that crown VALUE (not just count) is a key signal for identifying high-cosmetic/boutique practices. Low crown count + high crown value = high-cosmetic. High crown count + low crown value = something else. The distinction matters for both PPO-suggestion logic (above) and general practice profiling.
- _how_ — Capture the lesson when Dave is ready. Likely feeds into a new `kpis/crown-value.yaml` in the knowledge base and a practice-type classifier that uses it.
- _status_ — waiting on Dave teaching (2026-04-16)

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
