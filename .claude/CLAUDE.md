# PerformDDS Assessment - Project Memory

## Owner
Dave (david@davidorr.me) — dental practice management consultant.

## Project
- **Site**: dentalpracticeassessments.com
- **Repo**: github.com/Evenflow1212/performdds-assessment (auto-deploys to Netlify from `main`)
- **Purpose**: Dentist uploads Dentrix PDF reports → Claude extracts numbers → we compute KPIs → produce an HTML Executive Report with opportunities quantified in dollars.

## Architecture (post-v41, April 2026)

Clean three-layer pipeline after the Excel teardown:

### Layer 1 — Collection
- **`assessment_hub.html`** — multi-step wizard. Collects:
  - PDF uploads (production, collections, P&L)
  - AR totals (form)
  - Staff costs + hygiene schedule (form)
  - Practice profile / survey (stored in sessionStorage as `practiceProfile`)
- Calls `/.netlify/functions/parse-pdf` once per PDF to get pipe-delimited text.
- Posts everything to `/.netlify/functions/generate-report`.

### Layer 2 — Processing
- **`netlify/functions/generate-report.js`** (~810 lines) — the single serverless entry point.
  - `parseProduction` / `parseCollections` / `parsePL` — text → structured objects
  - `generateSWOT` — rule-based S/W/O/T bullets
  - `computeReportData` — the heart: categorizes production, annualizes, computes every KPI, builds opportunities, assembles the canonical **data object**
  - `renderReportHtml` — fills placeholders in `assessment-report-template.html`
  - Handler returns `{ data, reportHtml, summary }`
- **`netlify/functions/parse-pdf.js`** — Claude API call for PDF text extraction.

### Layer 3 — Display
- **`assessment-report-template.html`** — single-file HTML with `{{placeholders}}` the backend fills in.
- Hub renders via `viewOnlineReport()` which opens the returned `reportHtml` in a new tab.
- Download options: **PDF** (browser print), **JSON** (canonical data object), **CSV** (flattened rows).

## The canonical data object

Produced by `computeReportData()`. Top-level shape:

```
{ version, generatedAt,
  practice:     { name, website, zipCode, pmSoftware, doctorDays, hygieneDaysPerWeek, hasAssociate, associateDaysPerMonth, ... },
  period:       { prodMonths, years, annualFactor },
  production:   { total, annualized, byCategory, split, categoriesForChart, splitForChart, codes },
  collections:  { total, annualized, collectionRate },
  financials:   { plIncome, plExpenses, overheadPct, profitPct, netIncome, staffCostPct },
  ar:           { patient, insurance },
  kpis:         { annualProduction, collectionRate, hygienePercent, ownerDocDailyAvg, associateDocDailyAvg, combinedDocDailyAvg, hygDailyAvg, overheadPct, profitPct, staffCostPct },
  goals:        { current, shortTerm, longTerm, totalDocDaysPerYear, hygDaysPerYear },
  opportunities:{ top3, totalValue, all },
  swot:         { strengths, weaknesses, opportunities, threats }
}
```

This is what the Hub downloads as JSON. It's also the source of truth the HTML Report reads from. Adding a new KPI = add a computation in `computeReportData`, add a field in the object, add a card in `renderReportHtml`.

## Knowledge base

Separate repo at `~/Desktop/performdds-knowledge/` (local, git-committed, NOT in the public repo). Contains:
- KPI YAML files with definitions, formulas, benchmarks, and Dave's coaching notes
- Methodology markdown files (retain-restore-realign, bite-wellness-visit, scorekeeping, etc.)
- CHANGELOG.md tracking what's added each session

When benchmarks or KPI math changes: update the knowledge base AND the code in the same session.

## Testing

`test-data/verify-generate-report.js` — synthetic end-to-end test. Run with:
```
node test-data/verify-generate-report.js
```
Builds a fake payload, invokes the handler in-process, asserts KPI magnitudes and that no `{{placeholder}}` leaks through. Writes `test-data/output/smoke-test-report.html` for visual inspection.

## Roadmap

- **Phase 2 (next)**: "Review & Edit" step in the Hub — dentist sees extracted numbers before report generates, can correct any field, re-renders instantly. Replaces the Excel workbook as the "eyes-on the data" layer.
- **Phase 3**: Move PDF extraction to the backend. Use Claude structured outputs / tool use with strict JSON schemas instead of pipe-delimited text parsing. Add caching per-PDF so re-runs don't re-pay.

## What was removed in v41

The old Excel pipeline is gone entirely:
- `generate-workbook.js` (4,294 lines of template XML manipulation)
- `generate-assessment.js` (unused)
- `Blank_Assessment_Template.xlsx` + backup + `template_extracted/`
- Client-side JSZip helpers (`embedPlImageClientSide`, `postProcessClientSide`, the `pp*` family)
- Client-side PDF-to-image rendering (fed the Excel P&L Image tab)
- `exceljs` and `jszip` dependencies
- `WORKBOOK_FIX_NOTES.md`

**Do not re-add Excel output.** The user explicitly does not want clients working in Excel. JSON + HTML + CSV cover every downstream need.

## Dave's working style
- "Don't ever ask, just do it" — autonomous fixes preferred
- Cannot push from sandbox — runs git commands in Terminal himself
- Gets frustrated with back-and-forth; batch changes when possible
- Values iteration speed — a small bug that ships fast beats a perfect change that takes a day
- Likes concrete numbers and dollar amounts in explanations, not abstractions
