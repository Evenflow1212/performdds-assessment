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
    production: `Eaglesoft "Service codes productivity master" report. Each row has an internal Eaglesoft code + a separate ADA Code column (starts with D), a description, and "This Year" Units and Production columns.

For the DATE range, look for a "From EOD: ... To EOD: ..." header line anywhere in the document. Convert the mm/dd/yy dates to MM/DD/YYYY. If no date range is visible, emit DATES|THIS_YEAR as a placeholder.

For each procedure row:
- Use the ADA Code column as CODE (must start with D, e.g., D0120, D1110, D2740).
- If the ADA Code column is empty or blank for a row, SKIP that row entirely.
- Use "This Year Units" as QTY.
- Use "This Year Production" as TOTAL (strip $ and commas; negative values use a minus sign, not parens).
- If multiple rows share the same ADA code (e.g., D1206 appears under different internal codes), SUM their units and production into a single line.
- Skip rows where This Year Units = 0 AND This Year Production = 0.

Return ONLY lines in this format — no other text:
First line: DATES|MM/DD/YYYY - MM/DD/YYYY
Then one line per ADA code: CODE|DESCRIPTION|QTY|TOTAL
Example:
DATES|01/01/2024 - 12/31/2024
D0120|Periodic Oral Evaluation|652|41200.00
D1110|Prophylaxis - Adult|1204|154500.00`,

    collections: `Eaglesoft "Day Sheet" summary. Find the "Totals:" line near the end — it has three columns: Production, Collections, Adjustments (adjustments may appear in parens = negative).

Also find the "From EOD: ... To EOD: ..." date range in the header.

Return ONLY these 3 lines:
DATES|MM/DD/YYYY - MM/DD/YYYY
CHARGES|[production total as positive number, no $, no commas]
PAYMENTS|[collections total as positive number, no $, no commas]
If the report uses YY (2-digit year) format in the header, expand to 4-digit (20YY).`,
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
