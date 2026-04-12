# PerformDDS Assessment Workbook - Project Memory

## Owner
Dave (david@davidorr.me) - dental practice management consultant

## Project
**Site**: dentalpracticeassessments.com
**Repo**: github.com/Evenflow1212/performdds-assessment (auto-deploys to Netlify from main)
**Purpose**: Generates Excel assessment workbooks from uploaded Dentrix dental practice PDF reports

## Architecture
- **Frontend**: `assessment_hub.html` — multi-step wizard, uploads PDFs, calls Netlify function
- **Backend**: `netlify/functions/generate-workbook.js` (~1650 lines) — serverless function
- **Template**: `Blank_Assessment_Template.xlsx` (371KB, 8 sheets, 752 cellXfs, 66 fonts, NO sharedStrings.xml)

## How The Workbook Generation Works (Two-Pass System)

### Pass 1: Template Injection
- Reads template XLSX as ZIP, parses sheet XML directly
- `sv()` function stores cell values in `_cellCollector[sheetName][cellRef]`
- Regex replaces existing cell values in template XML, inserts new cells for data that doesn't exist in template
- **CRITICAL**: Formula cells ARE overwritten when sv() has data for them (v18 fix)
- ExcelJS used ONLY for sheets 9-10 (P&L Raw Import, P&L Image)

### Pass 2: Style/XML Restoration
- Reads Pass 1 output as fresh ZIP (avoids JSZip read-back bug)
- Restores original template styles.xml (752 cellXfs) with modifications:
  - Adds cellXfs 752-759 for strikethrough variants
  - Changes yellow fills to blue
  - Fixes grey placeholder font color
- Applies sheet-level fixes via `sheetFixes` object:
  - **sheet1** (Production Worksheet): fixes General number format cells → integer/dollar
  - **sheet4** (Financial Overview): column widths, row heights, hidden monthly rows, IFERROR
  - **sheet7** (Budgetary P&L): IFERROR wrappers, column widths
  - **sheet8** (P&L Input): cell styles s="2"/s="316", column widths, row heights
- Removes sharedStrings.xml (ExcelJS injects one; template has none)
- Removes sharedStrings reference from workbook.xml.rels
- Builds fresh ZIP from _pass2* variables (NOT from fixZip reads — JSZip bug)

### JSZip Read-Back Bug (CRITICAL)
`.file(path, content)` writes do NOT persist for `.file(path).async()` reads on the same loaded zip instance. Solution: store all Pass 2 modifications in plain JS variables (`_pass2StylesXml`, `_pass2ContentTypes`, `_pass2SheetFixes`, `_pass2WbRels`) and write them directly to freshZip.

## Template Style Reference
- **Font 0**: Verdana 10pt
- **Font 4**: Candara 10pt (non-bold) — used for P&L Input data
- **Font 36**: Calibri 11pt
- **Font 52**: Candara 20pt
- **Font 56**: Rockwell 23pt BOLD — template P&L headers, NOT for injected data
- **Style s="2"**: Candara 10pt text (fontId=4, no bold, no wrapText, no fill)
- **Style s="316"**: $#,##0 dollar format (fontId=4 Candara 10pt, numFmtId=172)
- **Style s="383"**: Financial Overview default column style
- **Style s="419"**: Production Worksheet integer format (fmt=0)
- **Style s="427"**: Production Worksheet dollar format ($#,##0)
- **Style s="428"**: Production Worksheet dollar format ($#,##0) for N column

## Sheet Map
1. Production Worksheet — procedure code analysis (LEFT/RIGHT table layout)
2. All Codes - Production Report — full code listing with strikethrough for used codes
3. Hygiene Schedule — weekly appointment tracking (dates relative to today)
4. Financial Overview — FINANCIAL PERFORMANCE page (years, totals, AR, payments)
5. Targets & Goal — (not currently populated by code)
6. Employee Costs — staff positions, rates, hours
7. Budgetary P&L — budget vs actual
8. P&L Input — expense categorization from P&L report
9. P&L Raw Import (ExcelJS-generated)
10. P&L Image (ExcelJS-generated)

## Key Fixes Completed (Session History)

### v12-v15: ExcelJS Contamination Fix
- Identified ExcelJS rewrites style references across ALL sheets, reduces cellXfs from 752 to ~350
- Implemented two-pass approach with JS variable bypass for JSZip read-back bug
- Confirmed: p1:752 styles preserved, final output: 760 cellXfs

### v16: P&L Input Clean Styles
- Changed from template styles 728/729 (Rockwell bold) to s="2"/s="316" (Candara 10pt non-bold)
- Both Pass 1 new cell creation and Pass 2 cell style fix aligned on s="2" for col A, s="316" for cols B+
- Row heights normalized to 15pt, customHeight removed

### v17: Financial Overview Year Headers
- Fixed year headers: C6=dataYear-2, E6=dataYear-1, G6=dataYear
- Moved production/collection totals to correct year columns (G/H)
- `dataYear = years[0]` (first year in production date range)

### v18: Formula Overwrite Fix
- Removed "CRITICAL: Never overwrite template formulas" guard
- If sv() was called for a cell, the value replaces whatever's in template (formula or not)
- Fixed G20/H20 (production/collection totals) which were stuck at $0

### v19/v19b: Financial Overview Layout
- Hidden monthly rows 8-19 (no per-month data from Dentrix)
- **CRITICAL REGEX BUG**: Must strip `customHeight` BEFORE `ht` to avoid partial match (`customHeig`)
- Helper function `stripHt()` does removal in correct order
- Comprehensive row height map for all 45 rows

### v20/v20b: Row Height Polish
- Row 5 (HISTORICAL PRODUCTION header) bumped to 26pt for full visibility
- Section headers: 22pt, data rows: 16-18pt, spacers: 8-22pt, payment row: 24pt

### v21: Production Worksheet Number Formats
- Fixed cells with General format → proper integer/dollar formats
- E18, E30, E36: style 424/413 → 419 (integer, shows whole numbers not 18.8333)
- N9, N18, N47, N55, N68: style 417 → 428 ($#,##0 dollar)
- G30: style 413 → 427 (dollar format)

## Regex Safety Rules
1. **Always strip `customHeight` before `ht`** — `ht="[^"]*"` matches inside `customHeight="1"`
2. **Use `\s+ht=` (not `\s*ht=`)** for standalone ht attribute matching
3. **Column style regex**: `<col>` replacements must cover all template columns
4. **Cell style regex**: Match pattern `<c\s[^>]*r="COL(\d+)"...` with careful group handling

## Data Flow
- PDF text extracted by Claude API on frontend
- Structured text sent to Netlify function as pipe-delimited format
- Parsers: `parseProduction()`, `parseCollections()`, `parsePL()`, `parseAR()`, `parseStaffCosts()`, `parseHygiene()`
- `sv(worksheetRef, cellRef, value)` collects all data
- Template injection writes to sheet XML
- Pass 2 fixes styles and formatting

## Dave's Working Style
- "Don't ever ask, just do it" — autonomous fixes preferred
- Cannot push from sandbox — runs git commands in Terminal himself
- Gets frustrated with back-and-forth; batch changes when possible
- Wants to move on to generating assessment documents from the workbook data after workbook generation is solid
