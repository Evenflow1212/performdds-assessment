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

## Report polish — queued during review-page build (2026-04-16 evening)

Dave flagged these while I was mid-build on the internal review page. Not touching them yet; capture-only.

### Hygiene % of Production benchmark is too low
- _current_ — Report card says "Target 30–33%"
- _fix_ — raise to **30–35%** baseline; it's regional so ideally the benchmark flexes by ZIP code. Dave said "more like 35%" — may trend higher in affluent / FFS markets.
- _how_ — hardcoded benchmark lives in `generate-report.js` `renderReportHtml` (search "30-33%" or similar). Bump to 30–35% for v1. ZIP-based adjustment is a follow-up — would need a lookup table (urban/metro = higher hygiene %, rural = lower).
- _status_ — idea (2026-04-16), easy fix for v1 + gated regional follow-up

### Report CTA — visual dashboard snapshot next to "deserves a movie" pitch
- _current_ — Report's end CTA: "This is a snapshot. Your practice deserves a movie." + 30-min call button. Pitch is verbal-only; no visual of what ongoing coaching looks like.
- _idea_ — drop a snapshot image of the actual ongoing dashboard (trend lines / goal tracking / monthly KPI progression) alongside the pitch so the reader can *see* the product, not just read about it.
- _layout options_ —
  1. **Below the CTA box** with caption "Preview: your ongoing coaching dashboard" — cleanest, doesn't interrupt the narrative-to-CTA flow.
  2. **Above the CTA box** — risks breaking the emotional arc from content into the ask.
  3. **Behind the CTA box with text overlay** — most visually striking, risks making the button text hard to read; would need a dark gradient overlay.
  - Dave's instinct: "I don't know what you think." My vote: option 1 with a nice framed screenshot + caption. Clean and credible beats clever.
- _dependency_ — **need the actual image asset.** Options:
  - Screenshot of an existing PerformDDS client dashboard (preferred — real product)
  - Commission a designed mock if no dashboard exists yet
  - Placeholder stock image of a generic analytics dashboard (weakest — readers can tell)
- _status_ — idea (2026-04-16); blocked on image asset decision

### Report + Review — surface the dentist's stated pain points
- _why_ — Survey captures what the dentist *says* is wrong: `practiceProfile.concerns` (checkbox list — "want to be more profitable", "staff issues", "insurance reimbursements too low", etc.) and `practiceProfile.biggestChallenge` (freeform open-ended text). **Neither surfaces anywhere on the Report or internal Review page.** The practice profile section shows "What you told us" = names/dates/days/payor mix, but not the actual problems the dentist flagged in their own words.
- _impact_ — the Report's whole job is to tie what the dentist SAID they wanted to what the numbers show. If staff issues is a flagged concern, the staff cost % finding needs to explicitly connect to it. If "more profitable" is a concern, the overhead + profit margin story leads with that framing.
- _fix_ —
  1. Report Practice Profile section: add a **"Your pain points"** block at the top: bulleted list of checked concerns, plus the biggestChallenge quoted verbatim underneath (same quote-block styling the Report already has in IN THEIR OWN WORDS).
  2. Review page: same fields added to Practice Profile kv table.
  3. Down-stream: SWOT / Opportunities content should *reference back* to these concerns when relevant — "You said staff issues are a concern. Your 36% staff cost (vs 20% target) is downstream of that — misaligned capacity or underproducing hygienists are the usual root cause."
- _data already there_ — yes. `practiceProfile.concerns` = array of strings, `practiceProfile.biggestChallenge` = string. Both come through the request body into `computeReportData` via `practiceProfile` param.
- _status_ — idea (2026-04-16), ready to implement

### Report Goals card — swap the +15%/+30% blunt-instrument table for the per-stream Targets & Goal matrix
- _current_ — Report's "Current state → short-term → fully optimized" card shows 5 rows: Combined Doctor $/Day, Hygiene $/Day, Annual Doctor Production, Annual Hygiene Production, Total Annual Production. Short-term = +15% / fully optimized = +30% applied uniformly. Dave: "this is gonna have to be refined and expanded to have more meaning."
- _fix_ — replace with the full per-stream **Initial Monthly Target** / **Long Term Monthly Goal** matrix from `d.goals.targets`. Rows: general dentist, associate GP, hygiene, perio surgery, endo, oral surgery, ortho, cap, other. Columns: Days Worked, $/Day, Monthly. Two blocks side-by-side (Initial / Long Term). Plus the **Hygiene Capacity Gap** callout from `d.goals.hygienePotential` ("you work X hygiene days/mo; your patient base requires Y; gap = Z visits/mo = $N/yr").
- _what it shows the dentist_ — not just "work harder and hit +15%," but "here's *exactly* which stream needs how many days at what daily production to hit $X/year, and here's the capacity gap that justifies adding hygiene days." Actionable.
- _dependencies_ — data already on canonical `d.goals.targets` + `d.goals.hygienePotential`. Just needs the HTML rendering in `renderReportHtml`. The internal Review page already renders this; port the same table (prettier styling) to the client Report.
- _also_ — once per-provider GP split lands (owner vs associate PDFs), split the "general dentist" row into owner + associate with separate $/day targets per provider.
- _status_ — spec complete (2026-04-16), ready to implement after the current review-page build lands

### NEW SWOT Threat rule — low new patient flow → shrinking patient base
- _why_ — If new patients/month × 12 is below the practice's natural attrition, the active patient base is shrinking year over year. Dentist is treadmilling — working harder for less. Classic slow-death signal the Report should surface explicitly.
- _how_ — In `generateSWOT`, new threat bullet:
  - Inputs (already on canonical data): `d.goals.hygienePotential.activePatientEstimate`, `d.goals.hygienePotential.newPatientsPerMo`
  - Industry attrition benchmark: **15–20% of active patients leave each year** (move, switch, age out, die). Use 18% as the default replacement threshold.
  - Rule: if `newPatientsPerMo × 12 < activePatientEstimate × 0.18` → fire threat.
  - Language: "Your new patient flow of N/mo × 12 = X/year is below the ~18% replacement rate your active patient base (Y) requires (~Z/year needed). You're losing patients faster than you're replacing them — the practice is shrinking, which compounds every year."
  - Quantify the gap: `visitsShortfall = (activePatientEstimate × 0.18 − newPatientsPerMo × 12)` → each missing new patient is ~$1,500–$2,500 in first-year value (tie to the PPO benchmark in the payor-mix spec).
- _dependencies_ — none; `hygienePotential.newPatientsPerMo` already computed from D0150 count.
- _status_ — idea (2026-04-16), ready to implement

### Remove "ownership change → attrition" SWOT threat (buy/sell only)
- _current_ — SWOT THREATS card includes "A change in ownership or management style can lead to patient and staff attrition." Fires by default on every assessment.
- _problem_ — irrelevant unless the practice is being bought or sold. Default-assessment context = owner running their practice; this threat doesn't apply.
- _fix_ — for v1, **remove this rule entirely** from `generateSWOT` in generate-report.js. Don't re-surface.
- _later_ — when we build buy-side / sell-side assessment modes (separate report flavor), this threat belongs there under a "transition risk" section with more specific language. Dave said "we will develop some cardio [cards] for that but not yet."
- _status_ — idea (2026-04-16), quick removal now, future-mode placeholder

### AR display — show full aging breakdown, not just 90+ days
- _current_ — Report shows two compact cards: "Patient AR (90+ days) $9,765 of $120,145 total" and same for insurance. Only surfaces the 90+ bucket.
- _fix_ — Show the full aging table for both patient and insurance AR: **current / 30–60 / 60–90 / 90+ / total** in each row. The data is already on `d.ar.patient.{current,d3160,d6190,d90plus,total}` and same for insurance — just render it.
- _why_ — Dave reads the aging distribution, not just the 90+ number. An AR book with 70% current is very different from one with 70% 60+ even if the 90+ dollar amount looks similar.
- _how_ — replace the two 90+ cards in `renderReportHtml` (search for "Patient AR (90+") with a small 2×5 table (rows = patient/insurance, columns = buckets + total). Compact styling so it doesn't blow up the scorecard grid.
- _status_ — idea (2026-04-16)

### Goals table — round $/day figures to nearest $100
- _current_ — Report shows hygiene $/day Short-term $1,002 / Fully Optimized $1,202 and doctor $4,215 / $4,765 — ugly odd numbers because they're computed as `current + $200` / `current × 1.15`.
- _fix_ — round all displayed $/day goal figures to the nearest **$100**. $1,002 → $1,000. $1,202 → $1,200. $4,215 → $4,200. $4,765 → $4,800.
- _how_ — in `generate-report.js` `computeReportData` around the goal-matrix computation, round `gShortDocDaily / gShortHygDaily / gLongDocDaily / gLongHygDaily` to nearest 100 before returning. `Math.round(x / 100) * 100`.
- _status_ — idea (2026-04-16), one-line fix

### "Where production comes from" — drop donut, keep bar chart only
- _current_ — two visualizations side-by-side: Production by Category (horizontal bar) + Doctor vs Hygiene vs Specialty (donut)
- _fix_ — remove the donut. Keep the bar chart. **Add % at the end of each bar** (e.g. "General Dentistry $1,055,000 — 64%").
- _why_ — Dave doesn't need both; the bar chart already shows the split visually, the donut is redundant.
- _status_ — idea (2026-04-16)

---

## Eaglesoft parser bugs from first real run (2026-04-16 evening, JD Troy DDS)

End-to-end Eaglesoft pipeline works — practice name + P&L come through cleanly. Two bugs in the Claude-normalized output surfaced:

### Period-mismatch handling across uploaded reports
- _observed_ — JD Troy DDS test: Service codes master was 16 days (2026 YTD), Day Sheet was 24 months, P&L was 12 months. Pipeline computed collection rate = 152% because it compared production from one period to collections from another.
- _root_ — each PDF has its own period. Server uses production's `months` for production annualization and collections' `months` for collections annualization, but then compares annualized-vs-annualized when the periods still aren't identical ranges.
- _fix options_ —
  1. **Hub-level warning**: when the three date ranges don't overlap by at least 11 months, flag "period mismatch — results may be inaccurate" on the Report.
  2. **User prompt at upload**: after parsing, show Dave the detected date ranges and ask "is this the period you want to analyze?" Allow override (e.g. force 12-month trailing).
  3. **Normalize everything to common trailing 12**: if any report has more than 12 months of data, use only the last 12; if less, warn. Hardest to do correctly because some PDFs don't have month-by-month detail.
- _status_ — design needed before tomorrow's multi-vendor data lands. Dentrix Ascend / Open Dental / Dentrix will each have their own date-range quirks.

### Eaglesoft production extraction picks "This Month" instead of "This Year"
- _observed_ — JD Troy DDS Service codes productivity master returned 69 codes totaling $130,155 for the year. P&L says $2.1M revenue; research sample showed ~$2.8M production. Top code D2740 came back as 15 units / $18,948 — those exact numbers are the "This Month" column in the agent's research sample, NOT "This Year".
- _root cause_ — pdf.js flattens multi-column tables into linear text. The Service codes productivity master has 9 columns: Code / ADA Code / Desc / Stand Fee / Avg Fee / **This Month Units** / **This Month Production** / **This Year Units** / **This Year Production**. When flattened, all these numbers run together per row and Claude can't tell which pair is which.
- _fix options_ —
  1. **Better prompt disambiguation**: tell Claude "the LAST two numbers on each row are This Year Units and This Year Production; the middle pair is This Month — always use the last pair." Test first.
  2. **Column-aware pdf.js extraction**: our `pdfToTextRows` helper joins by y-coordinate only; add x-coordinate tokenization and emit with pipes as column separators.
  3. **Preferred**: direct Claude Vision on the actual PDF pages for just this one report (bypasses pdf.js flattening entirely). Cost: more tokens, but the report isn't that big (~500KB) and rate-limit is fine if we serialize.
- _status_ — bug (2026-04-16), blocking accurate Eaglesoft production numbers

### Eaglesoft collections extraction pulls partial total
- _observed_ — JD Troy DDS Day Sheet returned $2.38M collections annualized. Research sample showed Day Sheet Totals row = $4.76M collections. Half of actual.
- _root cause_ — unclear. Possibly: Claude found a section total (e.g. per-payor payment total) instead of the grand total. Day Sheet has multiple "Totals:" lines throughout if it's multi-section.
- _fix_ — tighten the prompt: "Find the SINGLE grand-total 'Totals:' line at the very END of the document (last page). Ignore per-section or per-provider totals. The three numbers on that line are Production / Collections / Adjustments." Plus: log the raw text Claude saw so we can diagnose next time.
- _status_ — bug (2026-04-16), partial numbers = wrong KPIs

### Hot-swap caveat — script-scope vs window bindings
- _observed_ — trying to hot-swap `parseViaClaude` via `window.X = newFn` worked for `window.X === X` checks but the actual `generate()` function kept using the original binding. Hot-swap fails silently with top-level `async function` declarations.
- _workaround_ — just reload and re-run after deploy. Don't invest more in hot-swap infrastructure.

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

### "Save Progress" button on the Hub
- _why_ — Right now the Hub lives entirely in the browser's sessionStorage / in-memory JS state. Refresh the page and you lose every uploaded PDF + every typed-in field. A dentist interrupted mid-assessment (takes a call, closes laptop, browser crashes) has to start over — hostile UX that discourages completion. Dave flagged this 2026-04-16 during a live run.
- _how_ — Server-side persistence (Dave's instinct is right: needs a backend). Options, cheapest → richest:
  1. **Netlify Blobs** (already on Netlify, no new infra) — key the blob to a generated session UUID, store it in localStorage on the user's device. "Resume" link can be a `?session=<uuid>` URL.
  2. **Supabase / Firebase** — if we want real accounts, cross-device resume, or admin visibility into in-flight assessments.
  3. **AWS S3 + DynamoDB** — Dave's mention, most flexible but more to manage.
  - Data to persist: canonical form state (all 8 steps), uploaded PDF bytes (or their parsed text — PDFs are smaller after text extraction), the practice profile from the questionnaire.
  - Privacy note: dentist data is sensitive. Whatever backend we pick needs encryption-at-rest and short retention (30 days?) unless Dave turns the account into a real saved profile.
  - UI: "Save & Continue Later" button on every step, returns a resume link the user can email themselves or bookmark.
- _dependencies_ — no existing backend-state story; this is the first thing that would require one.
- _status_ — idea (2026-04-16) — requires server-side infra decision before implementation

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
