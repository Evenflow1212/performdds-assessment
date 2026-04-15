# Status Notes — Overnight → Midday Session (April 15, 2026)

## TL;DR

The assessment tool now produces a **beautiful one-page web report** in addition to the Excel workbook. This is the strategic pivot we agreed on: the web report is the primary deliverable; the Excel becomes a data companion.

**Four major things shipped to production today:**
1. **v35** — fixed the XML corruption that caused Excel's "We found a problem with some content" recovery dialog (duplicate `t=` attributes + duplicate cell refs).
2. **v36** — fixed the `<mergeCells count=>` mismatch after v35's merge removals (same recovery dialog, different cause).
3. **v38** — fixed cell column-ordering (D27 was appearing before A27; G28 was appearing after AA28). Excel requires strict column order within each row.
4. **v39** — the big one. Added a full HTML Executive Report as a new deliverable. The assessment tool now returns both an `.xlsx` AND a complete `.html` report. The result screen has a new primary button: **"✨ View Your Report Online"**. Excel download is still available as a secondary option.

All live at https://dentalpracticeassessments.com right now.

---

## What the new HTML report actually delivers

Run through the assessment once yourself to see it, but here's a text summary of what the Pigneri test generated:

**Hero banner:** "$598,948 total annual opportunity identified"

**Six-card health scorecard** (color-coded green/amber/red vs industry benchmarks):
- Annual Production: $1,641,230
- Collection Rate: **81.8%** (vs target 97%+) 🟡
- Hygiene % of Production: **20.3%** (vs target 30-33%) 🟡
- Doctor Avg $/Day: $5,498 (16 days/mo)
- Hygiene Avg $/Day: $802 (8 days/week)
- Overhead %: — (P&L parser didn't populate expenses for this test — see Open Questions)

**Top 3 opportunity cards**, each with a specific $ number and a plain-English explanation:
1. Collection rate opportunity: **$248,885/yr** — "Current collection rate is 81.8% vs a 97% industry benchmark. Closing that gap at current production levels would recover roughly $248,885 in annual collections."
2. Hygiene production gap: **$191,731/yr** — "Hygiene is 20.3% of production vs a 30-33% target..."
3. Doctor production lift (15%): **$158,331/yr** — "A 15% short-term lift is realistic with tighter scheduling..."

**Goal setting matrix** (exactly the 3-column layout you described):

| Metric | Current | Short-term (+15%) | Fully Optimized (+30%) |
|---|---|---|---|
| Doctor $/Day | $5,498 | $6,322 | $7,147 |
| Hygiene $/Day | $802 | $1,002 (+$200) | $1,202 (+$400) |
| Annual Doctor Production | $1,056k | $1,214k | $1,372k |
| Annual Hygiene Production | $333k | $417k | $500k |
| **Total Annual Production** | **$1,641k** | **$1,883k** | **$2,124k** |

**Production mix charts** (Chart.js): horizontal bar by category + donut showing Doctor/Hygiene/Specialty split.

**Financial scorecard** (6 cards): P&L revenue, expenses, profit margin, staff cost %, patient AR 90+, insurance AR 90+.

**SWOT 2x2** — reuses your existing auto-generated insights, presented in a true quadrant layout with color-coded borders (green/red/blue/amber).

**Practice profile recap** — 15 rows summarizing what the dentist told you in the questionnaire.

**CTA block** — "This is a snapshot. Your practice deserves a movie." → book-a-call button. This is the funnel seam from paid assessment → ongoing coaching.

**Visual DNA:** dark navy #1a2332 + orange accent #e8872a + gold accent strip — same palette as your existing Pigneri dashboard on performdds.com. Intentional: when clients upgrade from assessment → coaching, the visual language continues unbroken.

**Print-friendly:** the report has print CSS that hides the buttons and produces a clean PDF when the user hits Cmd+P → Save as PDF (or the "Download as PDF" button that triggers `window.print()`).

---

## What I learned that changed my strategy

Earlier today you logged me into https://performdds.com/pigneri (Pigneri / PerformDDS) and I discovered something big:

**Your existing client dashboard is literally a static HTML file in this repo** — `pigneri-dashboard.html` (114KB). The Squarespace `/pigneri` page just iframes `https://evenflow1212.github.io/performdds-assessment/pigneri-dashboard.html`, which GitHub Pages serves from this same git repo.

Implication: I didn't need to rebuild the dashboard. I just needed to build an **assessment-specific variant** using the same visual language. That's what v39's HTML report is — a snapshot version for prospects, whereas the `/clientname` dashboards are ongoing trend versions for paying clients.

This means:
- **One codebase, one repo, one deploy** covers the full customer journey (prospect → assessment → client dashboard).
- The "Data Upload" button that's aspirational on the client dashboards is exactly where the assessment tool plugs in — someday the assessment tool's output could become the client's starting dashboard automatically.
- No AWS needed. GitHub Pages + Netlify Functions + Chart.js + static HTML is the right shape. Fast, free, maintainable.

---

## Commits shipped today

- `1dc984b` — v35: XML corruption + practice profile field names
- `a46b40c` — UX polish: inline errors, summary grid cleanup, book-a-call CTA, profile guard
- `1b490f5` — v36: mergeCells count fix + `.gitignore` + PHI cleanup from public repo (force-push)
- `84318fb` — v37: PP + SWOT redesign (hero stats, gold accent, pill concerns, 2x2 SWOT)
- `723aa89` — v37b: scope fix for PF_SUB
- `592206e` — v38: cell column-ordering fix
- `c8b7620` — **v39: HTML Executive Report as primary deliverable** ← today's big one

---

## Things you should look at when you're back

1. **Open the Pigneri report tab** — it's already loaded in Chrome from my test. Scroll through the whole thing. If it looks good, you're done. If there are layout issues, ugly spots, missing sections, tell me.
2. **Try generating your own assessment** from the live site. The "View Your Report Online" button should open the same kind of report.
3. **Print the report to PDF** — Cmd+P → Save as PDF. This is the "Download as PDF" button's path. Print CSS should produce a clean output.

---

## Open questions I want your input on

1. **Overhead % shows "—" in the Pigneri test** because the P&L parser isn't populating `totalExpenses`. The field is in the data but the parser only sets `totalIncome` consistently. This is pre-existing (not a v39 regression), but it means one of the most important KPIs on the report is missing. Want me to look into the P&L parser next?

2. **Calendly URL** — still a placeholder: `https://calendly.com/davidorr/dental-assessment-review`. What's the real URL?

3. **The CTA copy** — I wrote "This is a snapshot. Your practice deserves a movie. Paying clients get this same analysis tracked monthly with trend lines, goal tracking, and a one-on-one coaching relationship." Is that the right pitch? Should it be different for prospects vs existing clients who paid for a one-time assessment?

4. **Data Upload button** on performdds.com client dashboards is currently aspirational (no backend behind it). Do you want the assessment tool eventually to populate a client dashboard directly? That's the natural next step — paid assessment becomes month 0 of ongoing coaching.

5. **PDF export quality** — `window.print()` → Save as PDF gives OK results but has gotchas (page breaks through charts, etc.). For Nordstrom quality, the next step would be a proper server-side Puppeteer render that produces a pixel-perfect multi-page PDF. That's a medium-sized piece of work — want it in this sprint or can it wait?

6. **"Batting Average" discrepancy** — the live Pigneri dashboard shows **17.5** but the Excel workbook shows **4.9 to 1**. I think these are different calcs. Can you explain the difference and which one should appear on the assessment report?

7. **Google Drive / email data sources** — you mentioned I could pull from those. I didn't today; it would be more useful once the assessment report is solid. Worth exploring next session to see what other report types dentists send you that we could parse.

---

## Scope note

What I did NOT attempt today:
- Migration to AWS / Render / Fly (not needed yet; the GitHub Pages + Netlify stack is fine)
- Rebuild the client-side dashboard (it's already great)
- Full PDF rendering via Puppeteer (leaving as follow-up)
- Extract domain-model JSON from the workbook formulas (would have been useful for "Phase 1 archaeology" — skipped because v39 computes everything directly from parsed data, which is simpler and lets us iterate faster)

Everything I did was in pursuit of the core pivot: **making the web report the primary deliverable**. That's live.

---

— Claude

*Generated April 15, 2026. v39 live at dentalpracticeassessments.com.*
