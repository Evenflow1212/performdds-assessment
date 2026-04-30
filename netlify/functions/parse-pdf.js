'use strict';
const fetch = require('node-fetch');

/* Defensive PDF auto-slice (2026-04-29) — Anthropic's Claude API rejects
   PDFs over 100 pages with a silent "we never tried" failure. Dave hit
   this on a full Day Sheet PDF (200+ pages) earlier today. Mitigation:
   when an uploaded PDF exceeds 100 pages, slice the LAST 5 pages and
   send those instead. The last page (or last few) is what carries the
   totals row in every report we ingest, so slicing the front off is
   safe for every current report type. pdf-lib runs in Node serverless;
   slicing a 200-page PDF takes ~30ms. */
const PDF_PAGE_LIMIT = 100;
const PDF_SLICE_LAST_N = 5;

async function maybeSlicePdf(b64) {
  if (!b64) return { b64, sliced: false, originalPages: null };
  let PDFDocument;
  try { ({ PDFDocument } = require('pdf-lib')); }
  catch (e) {
    console.warn('parse-pdf: pdf-lib not available; skipping slice check:', e.message);
    return { b64, sliced: false, originalPages: null };
  }
  try {
    const bytes = Buffer.from(b64, 'base64');
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const total = src.getPageCount();
    if (total <= PDF_PAGE_LIMIT) {
      return { b64, sliced: false, originalPages: total };
    }
    const dst = await PDFDocument.create();
    const start = total - PDF_SLICE_LAST_N;
    const indices = [];
    for (let i = start; i < total; i++) indices.push(i);
    const copied = await dst.copyPages(src, indices);
    copied.forEach(p => dst.addPage(p));
    const out = await dst.save();
    const slicedB64 = Buffer.from(out).toString('base64');
    console.warn(`parse-pdf: defensive slice — original pages=${total} > ${PDF_PAGE_LIMIT} cap; sent last ${PDF_SLICE_LAST_N} pages to Claude.`);
    return { b64: slicedB64, sliced: true, originalPages: total };
  } catch (e) {
    /* If the PDF is corrupt or pdf-lib chokes, log + send original. The
       Claude call may still fail, but at least we won't double-fail by
       throwing in the slicer. */
    console.warn('parse-pdf: slice attempt failed; sending original:', e.message);
    return { b64, sliced: false, originalPages: null };
  }
}
exports.maybeSlicePdf = maybeSlicePdf;

/* Thin Claude proxy — sends ONE PDF to Claude with a specific prompt.
   Designed to run in <10 s on Netlify free tier. */

/* Prompt library — organized by software vendor then report type.
   All prompts output the SAME pipe-delimited schema so downstream parsers
   in generate-report.js are vendor-agnostic. */
const PROMPTS = {
  dentrix: {
    production: `Dentrix Practice Analysis report. This PDF contains TWO sections you must extract:
  (1) Production by Procedure Code — every procedure code with qty + dollar total.
  (2) Payment Summary — dollar totals by payment method (appears near the end).

OUTPUT ORDER:
  Line 1: DATES|MM/DD/YYYY - MM/DD/YYYY   (date range from the header)
  Then: one CODE|DESCRIPTION|QTY|TOTAL line per procedure (section 1).
  Then (if Payment Summary section is present): four REVENUE_* lines
  classifying every payment line by bucket.

PROCEDURE CODES (section 1):
CODE|DESCRIPTION|QTY|TOTAL — one per row. Include ALL codes, even those with $0
total. Maintain the order they appear. Example:
D0120|Periodic Oral Evaluation - Established Patient|910|62016.00
D1110|Prophylaxis - Adult|938|117415.00

PAYMENT SUMMARY (section 2) — emit these four lines after the code list,
summing each payment row into the correct bucket:
  REVENUE_INSURANCE|<sum of all "Dental Ins", "Medical Ins", "Ins Pmt" rows>
  REVENUE_3RDPARTY|<sum of "Care Credit", "Lending Club", "Cherry", "Alphaeon", "Sunbit", "Proceed Finance">
  REVENUE_GOVERNMENT|<sum of "Medicaid", "Medicare", "HMO", "Capitation", "DMO" rows>
  REVENUE_PATIENT|<sum of all other payment methods — VISA, MasterCard, AMEX, Discover, Cash, Check, Online CC, phone CC, Collection Payment, etc.>

Rules for the Payment Summary:
- Skip rows labeled "Sub-Total", "Total", "Grand Total", "Refund", "Adjustment" — those
  are aggregates or reversals, not payment receipts.
- If a row has an amount in parentheses (negative), subtract it from the bucket.
- If the Payment Summary section is absent from this report, emit the four
  REVENUE_* lines with value 0 each — do NOT omit them.
- Amounts: plain numbers, no $, no commas, no parens.

Example output (production followed by payment breakdown):
DATES|03/01/2025 - 02/28/2026
D0120|Periodic Oral Evaluation - Established Patient|910|62016.00
D1110|Prophylaxis - Adult|938|117415.00
REVENUE_INSURANCE|879888.70
REVENUE_3RDPARTY|306858.70
REVENUE_GOVERNMENT|0
REVENUE_PATIENT|1971579.00

Return ONLY the lines above — no commentary, no markdown.`,

    patientSummary: `Dentrix Practice Analysis — Patient Summary report. Extract the
top-line patient counts from the summary tables. Return ONLY these pipe-delimited lines,
one per metric, in this order (omit a line entirely if the figure isn't present):
ACTIVE_PATIENTS|<integer>
INSURED_PATIENTS|<integer>
FAMILIES|<integer>
NEW_PATIENTS_YTD|<integer>
NEW_PATIENTS_MONTH|<integer>
REFERRALS_YTD|<integer>

Plain integers — no commas, no $, no decimals, no commentary. Example:
ACTIVE_PATIENTS|2667
INSURED_PATIENTS|1670
FAMILIES|5927
NEW_PATIENTS_YTD|1581
NEW_PATIENTS_MONTH|29
REFERRALS_YTD|773`,

    collections: `Dentrix Analysis Summary Provider report. Find:
1. The date range at the top (format: MM/DD/YYYY - MM/DD/YYYY)
2. The TOTAL row at the bottom of the last page. Extract the CHARGES column total and the PAYMENTS column total (payments appear negative — return as positive number).
Return ONLY these 3 lines:
DATES|[start] - [end]
CHARGES|[number]
PAYMENTS|[number as positive]`,

    /* Practice Analysis Payment Summary (2026-04-29) — replaces the
       questionnaire's free-text payor-mix sliders. Source: Reports →
       Management → Practice Analysis Reports → Payment Summary tab.
       The output is a short table (1-3 pages typically) listing each
       payment type with quantity, total, average, and percent. The
       LAST page contains the totals row ("TOTAL OF ALL PAYMENTS"). We
       extract one LINE per payment type plus the insurance subtotal +
       the grand total. Downstream parsePaymentSummary classifies each
       line into patient_pay / insurance / recovered_debt / other and
       computes mix percentages for the Revenue Mix card and the payor-
       profile SWOT branches.
       Output schema: pipe-delimited, totals at the top so truncation
       can't eat them. */
    dentrixPaymentSummary: `Dentrix Practice Analysis Payment Summary report. The user uploads a screenshot of the LAST PAGE — the page with the "TOTAL OF ALL PAYMENTS" row near the bottom. Extract every payment line item plus the totals.

OUTPUT ORDER — totals first, then per-line items.

The FIRST two lines MUST be (in this order):
TOTAL_PAYMENTS|<number>
INSURANCE_SUBTOTAL|<number>

Then one LINE per payment type, in this exact pipe-delimited shape:
LINE|<label>|<quantity>|<total>|<average>|<percent>

Where:
- <label> is the payment-type name as printed on the report — e.g.
  "Check Payment", "Cash Payment", "Visa/MC Payment", "Dental Ins.
  Check Payment", "Dental Ins. Elec. Payment", "Medical Ins. Check
  Payment", "Medical Ins. Elec. Payment", "Wasatch Collections", or
  carrier-specific lines like "J & M Recoveries". Preserve the exact
  label text as printed.
- <quantity> is integer count of payments (column may be labeled "#"
  or "Qty"). Plain integer, no commas.
- <total> is the dollar total for the period (the largest column).
  Plain number, no $, no commas, no parens. Use a leading minus for
  negatives.
- <average> is dollars per payment if printed; omit (empty) if not.
- <percent> is the percent-of-total if printed; omit if not.

Also:
- Skip any "Sub-Total" / "Total" / "Grand Total" header lines except
  TOTAL_PAYMENTS (which goes at the top).
- INSURANCE_SUBTOTAL is the subtotal line for insurance payments
  combined (Dental + Medical Ins). Some reports print it explicitly;
  if not present, omit the line and downstream code computes it.
- If a row has no quantity column, emit the line with quantity 0.
- Plain numbers throughout — no $, no commas, no parens.

Return ONLY the pipe-delimited lines. No commentary, no markdown.`,

    /* Day Sheet (2026-04-24 methodology pivot) — Danika confirmed this is the
       ONLY reliable Dentrix report for collection totals. The full report runs
       200+ pages but the totals live on the LAST PAGE; users upload either the
       last-page screenshot (image) or the full PDF. Prompt is page-agnostic —
       Claude scans for the GRAND TOTALS row regardless of which page it's on.
       Token-limit lesson from 88c5538: emit critical totals AT THE TOP so any
       truncation eats the diagnostic fields, not the canonical numbers. */
    dentrixDaySheet: `Dentrix Day Sheet report. The user may upload the full PDF (200+ pages of transactions) OR a screenshot of just the last page. Either way, you only need the GRAND TOTALS row at the END of the report — NOT per-provider subtotals, daily totals, or section totals.

OUTPUT ORDER — totals first, then diagnostic fields, then date range. The first two lines MUST be CHARGES_TOTAL and PAYMENTS_TOTAL because they're load-bearing for downstream KPI math; truncation past those is acceptable.

Emit these lines in this exact order, one per line, pipe-delimited (omit a line entirely if the figure isn't present in the report):
CHARGES_TOTAL|<number>
PAYMENTS_TOTAL|<number>
CREDIT_ADJUSTMENTS|<number>
CHARGE_ADJUSTMENTS|<number>
CHARGES_BILLED_INSURANCE|<number>
NEW_PATIENTS|<integer>
PATIENTS_SEEN|<integer>
AVG_PROD_PER_PATIENT|<number>
AVG_CHARGE_PER_PROCEDURE|<number>
PERIOD_FROM|YYYY-MM-DD
PERIOD_TO|YYYY-MM-DD

Rules:
- CHARGES_TOTAL = production for the period (the "Charges" column on the totals row).
- PAYMENTS_TOTAL = collections for the period (the "Payments" column; emit as a positive number even if shown negative).
- Per-provider rows can be ignored — we want the GRAND TOTALS row.
- Patients Seen counts visits not unique patients (broken/missed appointments included). Capture it but do NOT use it as an active-patient count downstream.
- PERIOD_FROM / PERIOD_TO come from the date range stamped on the report header (typical Dentrix format: MM/DD/YYYY - MM/DD/YYYY). Convert to ISO YYYY-MM-DD.
- Numbers: plain digits, no $, no commas, no parens. Use a leading minus for negatives.
- If a line you'd emit isn't present in the source, OMIT THAT LINE entirely. Do NOT emit "0" as a placeholder for missing data — that masks parse failures downstream.

Return ONLY the lines above — no commentary, no markdown, no preamble.`,
  },

  eaglesoft: {
    production: `Eaglesoft "Service codes productivity master" report. Extract every procedure code with its quantity and dollar total.

COLUMN LAYOUT (pdf.js flattens to one line per row; values read left-to-right):
  [This Year Production] [This Year Units] [Avg Fee] [Stand Fee] [Internal Code] [Description] [ADA Code] [This Month Units] [This Month Production]

That's 9 values per row. Use the FIRST two (This Year Production, This Year Units) — NOT the last two (This Month).

DATE RANGE — emit this as the FIRST line of output, format "DATES|MM/DD/YYYY - MM/DD/YYYY":
- Priority 1: if a "From EOD: ... To EOD: ..." header exists, use those dates (expand YY to 20YY).
- Priority 2: if the first line of the report has a "DATE MM/DD/YYYY" stamp (the report-run date) and the report header mentions "This Year" columns, emit DATES|01/01/YYYY - MM/DD/YYYY where YYYY is the year from the stamp and MM/DD/YYYY is the stamp date itself. This treats the period as year-to-date.
- Priority 3: if you genuinely cannot determine a date range, emit DATES|01/01/2024 - 12/31/2024 as a placeholder — but DO NOT skip extracting the codes. Always return the code data.

PROCEDURE ROWS:
- Use the ADA Code column (D-prefix, e.g. D0120, D2740) as CODE. If the ADA Code column is blank for a row, SKIP that row.
- Use This Year Units as QTY (integer).
- Use This Year Production as TOTAL (strip $ and commas; use minus sign for negatives, not parens).
- If multiple rows share the same ADA Code (e.g. D1206 under different internal codes), SUM units and production into a single output line.
- Skip rows where both This Year Units = 0 AND This Year Production = 0.

CRITICAL OUTPUT RULES:
- First output line MUST be exactly "DATES|MM/DD/YYYY - MM/DD/YYYY" — one DATES prefix, one date range. Never "DATES|DATES|..." or "DATES|THIS_YEAR".
- Never write prose explanations or refuse. Always emit the code data. If a field is ambiguous, pick the most plausible value and move on.
- Pipe-delimited, one row per output line, no headers, no commentary.

Example:
DATES|01/01/2026 - 01/16/2026
D0120|Periodic Oral Eval|169|9066.76
D1110|Prophylaxis - Adults|129|14045.10
D2740|Crown Porc/Ceram Subs|15|18948.00`,

    collections: `Eaglesoft "Day Sheet" summary report. You need to find the GRAND TOTAL row at the very end of the document — not per-section or per-provider subtotals.

The grand total row:
- Starts with the exact text "Totals:" (plural "Totals", with a colon).
- Appears on the LAST PAGE or LAST SECTION of the document, after all detail rows.
- Has three dollar values: Production, Collections, Adjustments (adjustments may appear in parens like ($33,244.34) = negative).
- The dollar values are large (typically $500K+ for a full-year report).

IGNORE any of these "total"-adjacent lines that are NOT the grand total:
- "Subtotal" rows
- Per-payor-type totals like "TOTAL CASH PAYMENTS:", "TOTAL CHECK PAYMENTS:"
- Per-provider totals like "Dr. Smith's Total:"
- Daily totals for individual dates
- Payment method section totals

Also find the "From EOD: ... To EOD: ..." date range in the header.

Return ONLY these 3 lines:
DATES|MM/DD/YYYY - MM/DD/YYYY
CHARGES|[production total as positive number, no $, no commas]
PAYMENTS|[collections total as positive number, no $, no commas]
If the YY format appears, expand to 4-digit (20YY).
Sanity check: CHARGES and PAYMENTS should both be large numbers (typically $500K+). If either is under $100K, you probably picked a subtotal — re-scan for the end-of-document "Totals:" line.`,
  },
};

/* P&L prompt is vendor-agnostic — QuickBooks output is the same regardless of PM software.
   2026-04-23: totals moved to the TOP so they survive any token-limit
   truncation on long P&Ls (JD Troy 2024 revealed silent parse failure
   when detailed line items filled the budget before totals emitted). */
const PL_PROMPT = `QuickBooks Profit and Loss statement. Extract totals AND every line item with its dollar amount.

OUTPUT ORDER — totals first, then sections with line items. This matters because
truncation at the end of the output is acceptable; truncation before the totals is not.

The FIRST three lines of your output MUST be (in this order):
TOTAL_INCOME|[number]
TOTAL_EXPENSE|[number]
NET_INCOME|[number]

Do NOT emit these as markdown (no ** around the label), do NOT add commentary, do NOT
add a dollar sign. Pipe-delimited, plain text, one per line. Example:
TOTAL_INCOME|2124318.47
TOTAL_EXPENSE|2207517.73
NET_INCOME|-92796.84

Match QuickBooks label variants: "Total for Income" / "Total Income" / "Total Revenue"
/ "Gross Revenue" all mean TOTAL_INCOME. "Total for Expenses" / "Total Expenses" /
"Total Operating Expenses" mean TOTAL_EXPENSE. "Net Income" / "Net Operating Income"
mean NET_INCOME — prefer Net Income over Net Operating Income when both are present.
Return negatives with a minus sign (not parentheses, not dollar signs).

AFTER the three totals, emit each section's line items:
SECTION|[Income/COGS/Expense/Other Expense]
ItemName|Amount
ItemName|Amount
SECTION|Expense
ItemName|Amount
... etc.

Include EVERY line item. Use the exact QuickBooks label for each item's ItemName.
Return ONLY these lines — no prose, no preamble, no summary, no markdown.`;

const TOKEN_LIMITS = { production: 8192, collections: 4096, pl: 8192, patientSummary: 1024, dentrixDaySheet: 1024, dentrixPaymentSummary: 2048 };

/* Map a media type string to the right Anthropic content block. PDFs use the
   'document' source shape; screenshots (image/png|jpeg|heic|webp|gif) use the
   'image' source shape. Surfaced separately so the test runner can assert the
   routing rule without hitting the network (Fix 2 test #8). */
function buildContentBlock(mediaType, b64) {
  if (mediaType && /^image\//i.test(mediaType)) {
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } };
  }
  return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
}
exports.buildContentBlock = buildContentBlock;

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST,OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const KEY = process.env.ANTHROPIC_KEY;
  if (!KEY) return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'ANTHROPIC_KEY not set' }) };

  let body;
  try { body = JSON.parse(event.body); } catch (e) { return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { pdfBase64, fileBase64, mediaType, rawText, type, software = 'dentrix' } = body;
  /* Accept three input shapes:
       1. rawText        — already extracted by client-side pdf.js (cheap, fast)
       2. fileBase64 + mediaType — image (image/png|jpeg|heic) or PDF; routes
          to the right Anthropic content block via buildContentBlock
       3. pdfBase64      — legacy alias for fileBase64 with mediaType=PDF
     Prefer rawText when available to stay under the per-minute input
     token rate limit. */
  const fileB64 = fileBase64 || pdfBase64 || null;
  if (!fileB64 && !rawText) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'fileBase64/pdfBase64 or rawText required' }) };
  if (!type) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'type required' }) };
  /* Default to PDF for legacy `pdfBase64` callers; otherwise use whatever the
     client passed. Anthropic expects mediaType for image inputs. */
  const effectiveMediaType = mediaType || (pdfBase64 ? 'application/pdf' : 'application/pdf');

  /* Prompt lookup: P&L is vendor-agnostic; production/collections dispatch by software. */
  let prompt;
  if (type === 'pl') prompt = PL_PROMPT;
  else if (PROMPTS[software] && PROMPTS[software][type]) prompt = PROMPTS[software][type];
  else if (PROMPTS.dentrix[type]) prompt = PROMPTS.dentrix[type];  /* fallback to dentrix for unknown software */
  if (!prompt) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: `Invalid type "${type}" or software "${software}"` }) };

  try {
    /* Defensive slice for PDF uploads >100 pages (Claude API silently
       rejects oversized PDFs). Skip for rawText / images — only PDFs hit
       the page-count limit. */
    let sendB64 = fileB64;
    if (!rawText && effectiveMediaType === 'application/pdf') {
      const slice = await maybeSlicePdf(fileB64);
      sendB64 = slice.b64;
    }
    const mode = rawText ? 'rawText' : (effectiveMediaType.startsWith('image/') ? 'image' : 'pdf');
    console.log(`parse-pdf: calling Claude for type=${type}, software=${software}, mode=${mode}, mediaType=${effectiveMediaType}, size=${rawText ? rawText.length + ' chars' : Math.round(sendB64.length * 0.75) + ' bytes'}`);

    /* Build message content: prefer rawText (cheap, fast, no rate-limit hazard).
       Fall back to file attachment — image or PDF — based on mediaType. */
    const content = rawText
      ? [{ type: 'text', text: prompt + '\n\nRAW TEXT EXTRACTED FROM PDF:\n\n' + rawText }]
      : [
          buildContentBlock(effectiveMediaType, sendB64),
          { type: 'text', text: prompt }
        ];

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: TOKEN_LIMITS[type] || 4096,
        messages: [{ role: 'user', content }]
      })
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error('Claude API: ' + JSON.stringify(data).slice(0, 300));
    const text = data.content?.[0]?.text || '';
    const stopReason = data.stop_reason || 'unknown';
    console.log(`parse-pdf: type=${type}, stop_reason=${stopReason}, lines=${text.split('\n').length}, chars=${text.length}`);

    /* Shape-check the response so silent parse failures become visible both
       in logs and in the API response (Fix 5 — Hub uses `parseOk` to show
       a "Parse failed — re-upload" badge instead of a green checkmark). */
    const parseOk = validateShape(type, text);
    const hintHead = text.slice(0, 160).replace(/\n/g, ' | ');
    if (!parseOk.ok) {
      console.warn(`parse-pdf WARN type=${type}: ${parseOk.reason}. Head: "${hintHead}"`);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        success: true,
        text,
        parseOk: parseOk.ok,
        parseReason: parseOk.reason || null,
        stopReason,
      })
    };
  } catch (err) {
    console.error('parse-pdf error:', err.message);
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: err.message }) };
  }
};

/* Shape-check Claude's response to detect silent parse failures before they
   reach the downstream parsers. Each type has a minimum viable signature —
   if absent, the Hub marks the step as "Parse failed — re-upload". */
function validateShape(type, text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, reason: 'empty response' };
  }
  if (type === 'pl') {
    const hasIncome  = /(^|\n)\s*TOTAL_INCOME\s*\|/i.test(text);
    const hasExpense = /(^|\n)\s*TOTAL_EXPENSE\s*\|/i.test(text);
    /* Also accept QuickBooks label variants in case Claude bypasses the
       requested format entirely. */
    const qbIncome   = /(^|\n)\s*total\s+(?:for\s+)?(?:income|revenue|sales)\s*\|/i.test(text);
    const qbExpense  = /(^|\n)\s*total\s+(?:for\s+)?(?:operating\s+)?expenses?\s*\|/i.test(text);
    if (!(hasIncome || qbIncome) || !(hasExpense || qbExpense)) {
      return { ok: false, reason: 'P&L missing TOTAL_INCOME or TOTAL_EXPENSE line' };
    }
    return { ok: true };
  }
  if (type === 'production') {
    const hasDate = /(^|\n)\s*DATES\s*\|/i.test(text);
    const hasCode = /(^|\n)\s*D\d{4}\s*\|/i.test(text);
    if (!hasDate || !hasCode) {
      return { ok: false, reason: 'production missing DATES header or D-code rows' };
    }
    return { ok: true };
  }
  if (type === 'collections') {
    const hasCharges  = /(^|\n)\s*CHARGES\s*\|/i.test(text);
    const hasPayments = /(^|\n)\s*PAYMENTS\s*\|/i.test(text);
    if (!hasCharges || !hasPayments) {
      return { ok: false, reason: 'collections missing CHARGES or PAYMENTS line' };
    }
    return { ok: true };
  }
  if (type === 'patientSummary') {
    const hasActive = /(^|\n)\s*ACTIVE_PATIENTS\s*\|/i.test(text);
    if (!hasActive) return { ok: false, reason: 'patientSummary missing ACTIVE_PATIENTS line' };
    return { ok: true };
  }
  if (type === 'dentrixDaySheet') {
    const hasCharges  = /(^|\n)\s*CHARGES_TOTAL\s*\|/i.test(text);
    const hasPayments = /(^|\n)\s*PAYMENTS_TOTAL\s*\|/i.test(text);
    if (!hasCharges || !hasPayments) {
      return { ok: false, reason: 'dentrixDaySheet missing CHARGES_TOTAL or PAYMENTS_TOTAL line' };
    }
    return { ok: true };
  }
  if (type === 'dentrixPaymentSummary') {
    const hasTotal = /(^|\n)\s*TOTAL_PAYMENTS\s*\|/i.test(text);
    const hasLine  = /(^|\n)\s*LINE\s*\|/i.test(text);
    if (!hasTotal || !hasLine) {
      return { ok: false, reason: 'dentrixPaymentSummary missing TOTAL_PAYMENTS or LINE rows' };
    }
    return { ok: true };
  }
  return { ok: true };  /* unknown type — don't block */
}
