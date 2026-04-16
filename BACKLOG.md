# BACKLOG — Product ideas, not yet built

Ideas Dave dumps here as they come to mind. Not a priority list — more a catcher's mitt so nothing gets lost.

Format:
- **Title** (one line)
- _why_ — the value / user problem
- _how_ — rough implementation thought (may be wrong, refine when we pick it up)
- _status_ — `idea` / `spec'd` / `in-flight` / `shipped`

When one gets picked up, move it near the top and flip the status.

---

## The Goals tab — synthesis layer

### Rebuild the Goals tab properly (currently a stub)
- _why_ — This is where all the analysis becomes actionable. The Goals tab is where Current → Interim → Long-term production targets live, per-provider and for hygiene. Right now the implementation is a simple "current × 1.15" / "current × 1.30" projection on combined doctor $/day and hygiene $/day. It doesn't use the richer data we already have or could derive. Done right, it's the single most useful page in the whole report.
- _how_ — Pull inputs from three sources and synthesize:
  1. **Current baselines**: P&L expenses, production-by-code totals (per provider once we have per-provider PDFs — see the owner/associate split item).
  2. **Ceiling/potential** from the hygiene schedule math (which we need to actually port into generate-report.js — it lives in the old workbook logic and hasn't been migrated). Specifically: hard active-patient estimate from procedure counts (prophy × 2 + perio × 4 + SRP × 6), then potential appointments at compliance rates (adult prophy 80%, perio maint 5× per person per year, SRP/deep cleaning 30% of active), then **days required per month = (total hygiene visits needed ÷ patients per hygienist per day)**.
  3. **Survey answers**: current hygiene days per week, current doctor days, new upcoming question for patients-per-hygienist-per-day (see separate item below).

  **Goal-setting logic**:
  - Doctor $/Day interim: current + $250–$300/day (or +15%, whichever is cleaner). Long-term: interim + another $250–$300/day (or +15% more).
  - Add ~1 ortho case/month (~$5,000) to both goal tiers as a specific line item.
  - Hygiene days: push toward "days required per month." Interim = halfway between current and required. Long-term = closer to (or at) required.
  - Hygiene $/Day: current + $200 interim, +$400 long-term (Dave's existing rule, already in code).

  **Killer finding to surface explicitly**: "You say you have X hygiene days/week. Based on your active patient base and standard compliance, you should have Y. Gap = Z unserved patient-visits per month." That single line is a credibility check AND a quantified opportunity.

- _dependencies_ — owner/associate PDF split (for per-provider goal tiers), port hygiene schedule active-patient math from the old Excel logic, new survey question on patients-per-hygienist-per-day.
- _status_ — idea / spec partial (2026-04-16, Dave explained it in detail)

### Survey addition: patients per hygienist per day
- _why_ — This is a crucial denominator for the "days required per month" calculation (see Goals tab item above). Medicaid/HMO hygienists typically see 10/day; PPO hygienists should be ~8/day. Without this number we can't compute hygiene capacity properly, and the days-required math has to fall back to a guess.
- _how_ — Add one question to questionnaire.html right next to the existing "how many hygiene days per week" question. Number input, placeholder 8, with a short helper hint about the 8-vs-10 distinction. Save as `practiceProfile.patientsPerHygienistPerDay` (or similar). Feed into the Goals tab's hygiene-days-required calculation.
- _status_ — idea (2026-04-16)

### Survey vs reality credibility checks
- _why_ — Dave floated this as "interesting but not sure how valuable": compare what the dentist SAYS in the survey to what the DATA shows. Examples: stated hygiene days/week vs. calculated days-required; stated crown count/month vs. actual CDT D27xx counts from production; stated new-patient volume vs. D0150 count. Gaps are either (a) data the dentist doesn't know about themselves (useful finding), or (b) a read on how accurate their self-perception is (coaching tell).
- _how_ — For each survey field that has a corresponding derivable metric, compute both and show the delta. Could be a small callout section on the Report, or a hidden "Reality Check" section in the Debug Workbook, or both. Keep tone non-confrontational ("here's what the numbers show vs. what you reported" not "you're wrong").
- _status_ — idea (2026-04-16), Dave uncertain on value

## Lesson library (on-demand coaching)

### Lesson-per-KPI content library
- _why_ — Every KPI on the Report that's out of range has a coaching story behind it. Dave has taught most of these lessons many times already — soft tissue management, crown conversion, future booking, batting average, collection process, hygiene optimization, goal-setting, etc. Right now the Report surfaces the number and says "book a call." What if it surfaced the number AND a linked lesson the dentist could watch right then? That turns the Report from a diagnostic into a mini-curriculum. Huge pull for the consultation (they've already heard Dave's voice and now want to go deeper) AND huge value for the dentist who can't immediately book a call.
- _how_ — Build a mapping: each KPI + condition → lesson ID → lesson content (video URL, transcript, duration). When the Report renders, for every off-target KPI or key opportunity, attach a "🎓 Watch the lesson (3 min)" inline link. Lesson player could be a blob modal or open a new tab.
  - **Lesson index** lives as a JSON file in the repo (or the private knowledge base).
  - **Content sources**: Dave already has recorded Zoom lessons (Scorekeeping 720, Retain/Restore/Realign, Bite Wellness, etc. — per the knowledge base) that can seed the first 5–10 lessons. Transcribe, edit down to 3–5 min, publish.
- _dependencies_ — needs the AI video generation stack below if we want to produce lessons at scale without Dave re-recording each one.
- _status_ — idea (2026-04-16)

### AI-generated video lessons (Dave's likeness + voice)
- _why_ — Dave doesn't want to record 50 short videos manually every time a lesson needs an update or a new KPI gets a coaching story. AI likeness+voice synthesis (HeyGen, Synthesia, D-ID, ElevenLabs) lets you write/update a script and regenerate a polished video in minutes. The dentist sees Dave explaining their exact issue — personalized and scalable.
- _how_ — Evaluate vendors for likeness quality + voice cloning accuracy + pricing at the expected lesson volume. HeyGen and Synthesia are the current leaders for this use case. Process would be: Dave records a one-time training corpus (10–30 min of clean video + audio) → avatar gets trained → lessons produced by writing a script and hitting render. Videos embed directly in the Report via the lesson-per-KPI hook above.
- _open questions_ — licensing/platform of choice, how to keep videos fresh as KPIs and methodology evolve, what's the right length per lesson (Dave typically teaches in 15–20 min blocks; probably need to compress to 3–5 min for the Report context).
- _status_ — idea (2026-04-16)

## Survey (questionnaire.html) improvements

### Bug: Enter key in any survey field submits the whole form → jumps to the Hub prematurely
- _why_ — Dave hit Return after typing a zip code and the questionnaire submitted, dropping him onto the production-PDF upload step with a half-filled survey. Every HTML form does this by default (Enter in any input inside a `<form>` triggers submit), and our payor-mix sliders / text inputs all inherit it. Bad UX — users type + Enter as a "commit my entry" reflex, not a "submit the whole thing" signal.
- _how_ — Easiest: add a keydown listener on the form that calls `preventDefault` when `key === 'Enter'` AND the active element isn't a textarea or the actual Continue button. Alternative: set `onkeydown="return event.key !== 'Enter'"` on every text input (uglier). Either way, keep Enter working inside the `biggestChallenge` textarea (multiline is fine) and on the Continue button itself.
- _status_ — known (2026-04-16) — Dave flagged; fix in next iteration

### Goals & Vision questions → Opportunities when absent
- _why_ — The questionnaire already asks `hasProductionGoal` (yes/no/sort-of) and `knowsIfAhead` (yes/no/sometimes). These are powerful signals the current Report doesn't use. If a dentist admits they don't have production goals, or don't know whether they're ahead or behind mid-month, that's a foundational gap — EVERY other KPI conversation is downstream of "are you measuring anything." The assessment should surface this explicitly with its own Opportunity bullet and its own lesson link.
- _how_ — In generateSWOT (or a new dedicated rule), when `hasProductionGoal ∈ {"no", "sort_of"}` OR `knowsIfAhead ∈ {"no", "sometimes"}`, add an **Opportunity** bullet along the lines of: "Without a clearly stated production goal and a weekly/monthly tracking rhythm, every other improvement in this report is hard to sustain — there's no destination to measure progress against. Building out goals + scorekeeping is typically the first 30 days of coaching." Attach a lesson link (Opening Numbers Ritual + Scorekeeping from the knowledge base).
- _status_ — idea (2026-04-16) — ties to the Lesson library item above

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
  - **Fee-schedule honesty** (answer to Q6): yes — caveat the SWOT bullet with the trade-off. Language should acknowledge that joining a PPO means accepting their fee schedule (typically 15–25% below UCR), which is why the advice is to pick **high-paying** carriers specifically, not just any PPO. Transparent framing builds trust with the reader.
- _status_ — spec complete (2026-04-16) — ready to implement whenever we pick it up

### Spec summary for the payor-mix SWOT rule

**Inputs**: `payorMix.ffs`, `npPerMonth`, practice-type classifier (cosmetic/boutique detector: high $/day + high crown value + low prophy volume + affluent ZIP).

**Branches**:
1. **Cosmetic/boutique** (FFS-by-design) → no PPO suggestion. Add a **Threat** bullet about concentration risk (few patients, economy-dependent, quarterly yes/no decisions swing results).
2. **FFS ≥ 70% AND thriving** (npPerMonth ≥ 30) → add a **Strength** bullet celebrating the hard-won out-of-network momentum. Still fire a soft "consider PPO" nudge with the identity-preservation caveat.
3. **FFS ≥ 70% AND struggling** (npPerMonth < 20–25) → add a **Weakness** bullet about the low NP flow (symptom) AND an **Opportunity** bullet about joining 1–2 high-paying PPOs (lever). Dollar value: 10–15 additional NP/mo × PPO first-year spend.

**Phrasing constraints**:
- Generic PPO references ("high-paying PPOs"), no specific carrier names until we have per-state data.
- Include the fee-schedule caveat (15–25% below UCR) so the reader sees the trade-off.
- Include the identity-preservation caveat on the soft-nudge variant.

**Dependencies before shipping**:
- Crown-value KPI (for the cosmetic/boutique classifier)
- ZIP → market context data (for the affluent-area signal)
- PPO NP first-year-value benchmark (for the dollar figure)

### Per-state PPO reimbursement intelligence
- _why_ — Once we want to name specific PPOs in the SWOT ("join Delta Premier and Aetna, they pay best in your market"), we need a lookup: for this state/region, which carriers pay above average. Until we have that data, the SWOT has to stay generic ("high-paying PPOs") and leave the carrier selection to the consulting call.
- _how_ — Could start with a manually-curated JSON of carriers-per-state ranked by typical reimbursement tier. Over time, could be fed by aggregated data from Dave's client base (anonymized). Could also consider third-party sources if any exist (most are paid subscriptions).
- _status_ — idea (2026-04-16) — gating specific-PPO naming in the payor-mix SWOT rule above.

### Payor-mix SWOT: incompatible-blend rule (PPO + government/HMO)
- _why_ — A practice with meaningful PPO volume AND meaningful government/HMO volume (Medicaid, Medi-Cal, HMO) faces a structural growth ceiling for its PPO segment. The high-volume / fast-pace / tight-schedule operational tempo required to make Medicaid and HMO economics work is inherently hostile to the PPO patient experience — longer appointments, relationship-oriented front desk, unhurried chair time. You can't optimize a practice for both at once; the environment itself repels PPO growth. Worth flagging so the consultation can surface the strategic choice: commit to one lane.
- _how_ — In generateSWOT, when both `(payorMix.ppo ≥ ~20%)` AND `(payorMix.gov + payorMix.hmo ≥ ~20%)`, add a **Weakness** (or **Threat**, TBD) bullet: "The practice is blending PPO with government/HMO volume. Growing the PPO portion is typically hard in this configuration — the pace and style a Medicaid/HMO book demands works against the experience PPO patients expect." Tied to an **Opportunity** bullet about choosing a lane.
- _open questions_ — thresholds for "large mix"? Quadrant (Weakness vs Threat)? Language for the "choose a lane" opportunity? Catch these when Dave is done freeforming.
- _status_ — idea (2026-04-16)

### Teach: Crown value methodology
- _why_ — Dave mentioned that crown VALUE (not just count) is a key signal for identifying high-cosmetic/boutique practices. Low crown count + high crown value = high-cosmetic. High crown count + low crown value = something else. The distinction matters for both PPO-suggestion logic (above) and general practice profiling.
- _how_ — Capture the lesson when Dave is ready. Likely feeds into a new `kpis/crown-value.yaml` in the knowledge base and a practice-type classifier that uses it.
- _status_ — waiting on Dave teaching (2026-04-16)

## Market context & competitive intel

### Practice management software cost comparison
- _why_ — PM software is one of the most opaque, rarely-audited opex lines in a dental practice. Dentrix Ascend can run $200+/user/month — a 6-person practice pays ~$14k/year before any other software fees. Open Dental has no per-user licensing and the annual support is a fraction of that. Most dentists never revisit the decision after the initial purchase. The assessment already captures which PM they use (questionnaire → `pmSoftware`); we can surface a dollar-quantified savings Opportunity when they're on an expensive platform.
- _how_ — Build a small static table of current pricing per platform (Dentrix on-prem, Dentrix Ascend, Eaglesoft, Open Dental, Curve, Carestack, Easy Dental, Practice-Web). Use the practice's `pmSoftware` + approximate user count (staff + hygiene arrays from employee costs form) to estimate their current annual spend. If they're on a high-cost platform, add an **Opportunity** bullet: "Switching to Open Dental could save approximately $X,XXX/year in software costs" with a caveat that migration has switching costs (training time, data conversion, workflow relearn).
  - **Research action**: WebSearch for current 2025–2026 pricing of each major PM platform when spec'ing this. Prices shift frequently.
  - **Sensitivity note**: recommending a switch is heavy-handed. Framing should be "worth evaluating" not "you should move."
- _status_ — idea (2026-04-16)

### Website health score from their URL
- _why_ — The questionnaire already captures the practice website. A lot of practices haven't touched their site in years — it's slow, not mobile-friendly, missing basic SEO hygiene, buried in Google's results. The assessment could score it automatically and surface an objective "your website gets a 52/100" number that makes the problem visible. Pairs with the Google/Yelp review idea and the market-context idea — together they form a "digital presence" section of the assessment.
- _how_ — Several free/cheap signals to aggregate:
  - **Google PageSpeed Insights API** (free, returns Lighthouse scores for Performance, Accessibility, Best Practices, SEO — each 0–100).
  - **Basic SEO checks** via a HEAD/GET on the URL: HTTPS, mobile viewport meta tag, title/description present, schema.org dental-practice markup, canonical URL, robots.txt, sitemap.
  - **Google SERP position** — trickier, usually requires a paid API (SerpAPI, DataForSEO). Could start with just the Lighthouse + on-page checks and add ranking later.
  - **Last-updated heuristic** — parse for copyright year, blog post dates, etc. to flag stale sites.
  Aggregate into a 0–100 composite score + a "here's what's weak" card on the Report.
- _status_ — idea (2026-04-16)

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

## Rescued from the dead session (2026-04-16, bold-bassi worktree)

These items were decided in conversation after the last commit but before an API error ("image exceeds 2000px many-image limit") bricked the session. Recovered from the JSONL on disk.

### Debug Workbook: rebuild as template-driven Excel (Dave-only)
- _why_ — Dave downloaded the current 7-sheet `downloadDebugXlsx()` output and said "this is not the format I'm used to." He reads the original 12-sheet template layout fast; the flat dump is unreadable to him. The Debug Workbook's whole point is Dave verifying KPI math, so the format matters even though the file never reaches a client.
- _how_ — Replace `downloadDebugXlsx()` with a **template-driven** approach (fundamentally different from the old pipeline we killed):
  1. Ship `Blank_Assessment_Template.xlsx` in the repo (restored from git; now committed)
  2. Client-side: `fetch('/Blank_Assessment_Template.xlsx')` → `XLSX.read(bytes)` via SheetJS (already loaded in Hub)
  3. **Mutate specific cells only** — `ws['B4'].v = data.practice.name` — no rebuild, no XML surgery. Styles, fonts, merged cells, formulas all survive untouched because the file is never reconstructed.
  4. `XLSX.write()` → download as `<PracticeName>_Debug_Workbook.xlsx`
  5. Hard part is the **cell mapping** (which cell holds which value). The old `generate-workbook.js` (deleted in v41 but recoverable from git) had thousands of these — use it as a reference, not a basis.
- _limitation acknowledged_ — template has 8 real sheets (Production Worksheet, All Codes, Hygiene Schedule, Financial Overview, Targets & Goal, Employee Costs, Budgetary P&L, P&L Input). The 4 additional sheets in the old full workbook (SWOT, Practice Profile, P&L Raw Import, P&L Image) were dynamically added — skip those for v1, or append them as simple extra sheets afterward.
- _implementation sequence_ — start with **Financial Overview** (the sheet Dave screenshotted). Walk through cell-by-cell, Dave flags gaps, iterate across the other 7 sheets one at a time.
- _CLAUDE.md rule clarification_ — also committed in this session: the "no Excel" rule was about client deliverables. Debug-for-Dave is explicitly OK.
- _status_ — spec complete (2026-04-16), template file now committed, ready to implement

### Hub: "Refill Staff/Hygiene" button
- _why_ — Today Dave needed to repopulate steps 6 & 7 mid-session (his autofill URL silently 404'd because the test folder was renamed). The only option was to paste a dev-console `fetch().then()` snippet into Chrome's console — ugly and loses the invocation if he forgets it. Refreshing the page would lose his uploaded PDFs from steps 1–3.
- _how_ — Small button on the Hub (maybe on every step, or floating), "Refill Test Data" (dev-only, hidden unless `?dev=1` or on localhost). Clicking it runs the same `fetch('/test-data/{name}-form-data.json')` + `dispatchEvent('input')` loop, just wrapped in a button. Shows toast with count filled.
- _status_ — idea (2026-04-16)

### Hub: "Run Full Test Assessment" button
- _why_ — Bigger version of the above. One-click seeds **everything** (questionnaire answers + practice name + all 8 Hub steps) from a named test dataset, so Dave can iterate on report-math changes without retyping 151 fields every test cycle.
- _how_ — Similar mechanism as Refill, but spans `questionnaire.html` + `assessment_hub.html` via sessionStorage (questionnaire writes `practiceProfile`; Hub reads it). Button would: set sessionStorage, fill Hub form fields, optionally auto-click through to a specific step.
- _status_ — idea (2026-04-16), dev-only tooling

### Bug: stale `?autofill=pigneri` URL
- _why_ — Dave's test folder got renamed `pigneri/` → `houston/`, but the `questionnaire.html` landing link (and wherever else it's hardcoded) still says `?autofill=pigneri`. The autofill silently 404s on missing JSON.
- _how_ — Grep the codebase for `autofill=pigneri`, replace with `houston` (or parameterize). Also: autofill should console.warn on 404 instead of silently failing.
- _status_ — known (2026-04-16), quick fix

### Validation: Practice Name field sanitization
- _why_ — Dave typed something like "Thursday, April 16 D.d.s." into the Practice Name box and it became the Debug Workbook filename (`Thursday,_April_16_D.d.s._Debug_Workbook.xlsx`). Low-priority but looks unprofessional in any filename-based artifact.
- _how_ — Trim whitespace, strip punctuation not safe for filenames, cap length. Gentle — don't block the user, just clean.
- _status_ — idea (2026-04-16)

### Test data: Pigneri Dental Group AR numbers (for seeding)
The real AR values from today's Pigneri PDFs, useful for any Run Full Test Assessment automation:
- Patient — Current: $110,195.68 / 31–60: $1 / 61–90: $183 / Over 90: $9,765.39 / **Total: $120,145.07**
- Insurance — (numbers in session, re-extract from `004 daves patient aging report.pdf` + `005 daves insurance aging.pdf` when needed)

---

## Deferred from earlier in this session

- **Owner vs Associate $/Day split** — Dave has a clean solution (2026-04-16): when `hasAssociate = yes` in the survey, the Hub's Step 1 (Production) should accept **one production-by-code PDF per general dentist provider** (owner's + each associate's), not one combined PDF. Each PDF's total gets tagged to that provider, then:
  - Owner $/Day = (owner's annualized production) / (owner days per year)
  - Associate $/Day = (associate's annualized production) / (associate days per year)
  - Combined still reported, but now derived cleanly from the pieces instead of guessed.
  **Implementation sketch**:
  - Questionnaire already asks `hasAssociate`. Carry that flag into the Hub.
  - Hub Step 1 conditionally renders: one upload slot if solo, N upload slots (labeled "Dr. Owner production", "Associate 1 production", etc.) if has associate. User can enter names.
  - Backend `parseProduction` already produces `{codes, months, years}` per PDF — just call it once per uploaded file and keep the results tagged by provider.
  - `computeReportData` uses the tagged totals to split doctor $/day cleanly. Drop the dormant survey-based derivation logic.
  - Non-GP specialty production (endo/surg/ortho/perio) can stay in the "whose bucket?" column as-is — the split is only needed for the general-dentist cards. Hygiene always stays pooled.
  - **Downstream payoff (why this matters beyond just the scorecard)**: the Goals tab on the Report currently uses Combined Doctor $/Day for its +15% short-term / +30% long-term projections. That hides the per-provider picture. With split data, each GP gets their own growth trajectory: maybe the owner is maxed out at 3% room while the associate has 30% headroom, or vice versa. A uniform "+15%" on the blended number is often the wrong prescription. Per-provider goals = actionable coaching targets.
  Ready to implement once Dave greenlights — clear spec, no open questions.
- **Overhead methodology review** — Dave said "I'm trying to understand what 87% overhead means right now, let's come back to that later." Current code subtracts owner add-backs (car, meals, travel, 401k) and patient reimbursements from expenses. Worth revisiting whether that matches Dave's teaching methodology exactly.
- **Review & Edit step (Phase 2 from the refactor plan)** — a screen between "server returned data" and "view report" where Dave (or the dentist) can override any extracted/computed value before the Report generates. Replaces what the old Excel workbook was doing as a "working canvas."

---

## How to add to this file

Just say "add to the backlog: X" and I'll write it up properly with the _why_ / _how_ / _status_ fields.
