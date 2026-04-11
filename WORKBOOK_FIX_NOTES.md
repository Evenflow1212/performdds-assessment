# Workbook Corruption Fix — Status Notes

## Problem
ExcelJS corrupts the xlsx template when it reads/writes it:
- Template has 752 cellXfs (cell formats), 66 fonts, 49 borders
- ExcelJS reduces to 295 cellXfs, 36 fonts, 31 borders
- This causes Excel to show "repair dialog" on every generated workbook
- Sheets 1, 3-8 all show "XML error. Load error" in repair log
- After repair, all data is wiped

## Root Cause
ExcelJS re-indexes styles when loading/saving a template, dropping ~460 style definitions. It also adds non-standard attributes (x14ac:dyDescent, customHeight on sheetFormatPr, mc:Ignorable namespaces) that may compound the issue.

## Solution Found
**Don't use ExcelJS to load the template.** Instead:
1. Open template with openpyxl (Python) — preserves all 752+ styles
2. Inject cell values from parsed data
3. Add new sheets (P&L Raw Import, P&L Image)
4. Save — produces valid xlsx that preserves template formatting

## Proof of Concept Created
File: `Pigneri_Assessment_V2.xlsx` in the workspace folder
- Built by loading template in openpyxl, injecting ExcelJS values
- Preserves 755 cellXfs, no x14ac artifacts
- **NEEDS TESTING IN EXCEL** (user hadn't tested yet when session ended)

## Implementation Plan
Two options for making this permanent:

### Option A: Python Netlify Function (recommended)
- Create `netlify/functions/generate-workbook.py` using openpyxl
- Port all parsing logic (parseProduction, parseCollections, parsePL) to Python
- Client sends same JSON payload, gets back base64 xlsx
- Netlify supports Python functions via `requirements.txt`

### Option B: Node.js Post-Processing  
- Keep ExcelJS for data assembly
- After ExcelJS generates buffer, send to a Python Netlify function for "cleaning"
- Python function: open with openpyxl, re-save, return
- Two-step process, more complex

### Option C: Node.js ZIP-Level (no ExcelJS)
- Replace ExcelJS entirely with JSZip-based template modification
- Read template as zip, inject cell values into XML directly
- Most complex to implement but stays in Node.js

## Key Files
- Template: `Blank_Assessment_Template.xlsx` (in repo root, served from public URL)
- Server function: `netlify/functions/generate-workbook.js` (~1130 lines)
- Client: `assessment_hub.html` (~2100+ lines)
- Test data: Pigneri Dental Group (5 PDFs in workspace folder)

## Other Pending Items
- Remove unused `embedPlImageClientSide()` function from assessment_hub.html
- Consider moving Hygiene Potential to its own tab
- Design final PDF report with graphs/charts
