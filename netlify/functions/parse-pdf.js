'use strict';
const fetch = require('node-fetch');

/* Thin Claude proxy — sends ONE PDF to Claude with a specific prompt.
   Designed to run in <10 s on Netlify free tier. */

/* Prompt library — organized by software vendor then report type.
   All prompts output the SAME pipe-delimited schema so downstream parsers
   in generate-report.js are vendor-agnostic. */
const PROMPTS = {
  dentrix: {
    production: `Dentrix Production by Procedure Code report. Extract the date range from the header, then every procedure code with its description, quantity and dollar total.
Return ONLY lines in this format — no other text:
First line: DATES|MM/DD/YYYY - MM/DD/YYYY
Then one line per code: CODE|DESCRIPTION|QTY|TOTAL
Example:
DATES|03/01/2025 - 02/28/2026
D0120|Periodic Oral Evaluation - Established Patient|910|62016.00
D1110|Prophylaxis - Adult|938|117415.00
Include ALL codes, even those with $0 total. Maintain the order they appear in the document.`,

    collections: `Dentrix Analysis Summary Provider report. Find:
1. The date range at the top (format: MM/DD/YYYY - MM/DD/YYYY)
2. The TOTAL row at the bottom of the last page. Extract the CHARGES column total and the PAYMENTS column total (payments appear negative — return as positive number).
Return ONLY these 3 lines:
DATES|[start] - [end]
CHARGES|[number]
PAYMENTS|[number as positive]`,
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

/* P&L prompt is vendor-agnostic — QuickBooks output is the same regardless of PM software. */
const PL_PROMPT = `QuickBooks Profit and Loss statement. Extract every line item with its dollar amount.
Return ONLY lines in this format:
SECTION|[Income/COGS/Expense/Other Expense]
ITEM|AMOUNT
Use these exact section markers before each group.
For each line item under Expenses, return: ItemName|Amount
Also include these summary lines at the end:
TOTAL_INCOME|[amount]
TOTAL_EXPENSE|[amount]
NET_INCOME|[amount]
Match QuickBooks labels: "Total for Income" / "Total Income" / "Total Revenue" all mean TOTAL_INCOME. "Total for Expenses" / "Total Expenses" mean TOTAL_EXPENSE. "Net Income" / "Net Operating Income" mean NET_INCOME (prefer Net Income if both present).
Return negative numbers with minus sign. Include ALL line items.`;

const TOKEN_LIMITS = { production: 8192, collections: 4096, pl: 8192 };

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST,OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const KEY = process.env.ANTHROPIC_KEY;
  if (!KEY) return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'ANTHROPIC_KEY not set' }) };

  let body;
  try { body = JSON.parse(event.body); } catch (e) { return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { pdfBase64, rawText, type, software = 'dentrix' } = body;
  /* Accept EITHER pdfBase64 (document attachment — expensive input tokens)
     OR rawText (text already extracted by client-side pdf.js — cheap).
     Prefer rawText when available to stay well under the per-minute input
     token rate limit. */
  if (!pdfBase64 && !rawText) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'pdfBase64 or rawText required' }) };
  if (!type) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'type required' }) };

  /* Prompt lookup: P&L is vendor-agnostic; production/collections dispatch by software. */
  let prompt;
  if (type === 'pl') prompt = PL_PROMPT;
  else if (PROMPTS[software] && PROMPTS[software][type]) prompt = PROMPTS[software][type];
  else if (PROMPTS.dentrix[type]) prompt = PROMPTS.dentrix[type];  /* fallback to dentrix for unknown software */
  if (!prompt) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: `Invalid type "${type}" or software "${software}"` }) };

  try {
    const mode = rawText ? 'rawText' : 'pdfBase64';
    console.log(`parse-pdf: calling Claude for type=${type}, software=${software}, mode=${mode}, size=${rawText ? rawText.length + ' chars' : Math.round(pdfBase64.length * 0.75) + ' bytes'}`);

    /* Build message content: prefer rawText (cheap, fast, no rate-limit hazard).
       Fall back to PDF document attachment only if no rawText provided. */
    const content = rawText
      ? [{ type: 'text', text: prompt + '\n\nRAW TEXT EXTRACTED FROM PDF:\n\n' + rawText }]
      : [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
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
    console.log(`parse-pdf: got ${text.split('\n').length} lines for type=${type}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: true, text })
    };
  } catch (err) {
    console.error('parse-pdf error:', err.message);
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: err.message }) };
  }
};
