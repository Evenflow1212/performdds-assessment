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

**Do not re-add client-facing Excel output.** The user explicitly does not want clients working in Excel. Client deliverables stay HTML Report + JSON + CSV.

**Exception — Debug Workbook for Dave's eyes only**: an Excel file populated from the canonical data object is OK as an *internal verification view*, because Dave reads multi-sheet spreadsheets faster than JSON for sanity-checking KPI math. The approach is template-driven (SheetJS `XLSX.read(template)` → mutate specific cells → `XLSX.write()`), NOT the old rebuild-from-scratch pipeline. Styles and formulas survive because we never rebuild the file. Template lives at `Blank_Assessment_Template.xlsx` in the repo root.

## Screenshot convention

When Dave says "the last screenshot" / "my latest screenshot" / "check my screenshot", look in `~/Pictures/screenshots/` and open the most recent file by mtime. **Always check dimensions first** with `sips -g pixelWidth -g pixelHeight` — if the long edge is >2000px, resize before viewing inline. The 2000px "many-image" API limit has bricked sessions before; retina full-screen screenshots exceed it.

## Dave's working style
- "Don't ever ask, just do it" — autonomous fixes preferred
- **Commit and push directly** from the sandbox for normal changes. Only pause for explicit approval on risky ops (big refactors, force pushes, destructive commands, anything that touches shared state beyond the repo).
- Batch changes when possible — don't push each tiny tweak individually unless Dave is blocked.
- Values iteration speed — a small bug that ships fast beats a perfect change that takes a day.
- Likes concrete numbers and dollar amounts in explanations, not abstractions.
- When Dave is running through the live tool and hits something broken that's blocking him, fix + push immediately (even if other changes are batched).
