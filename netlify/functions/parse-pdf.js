'use strict';
const fetch = require('node-fetch');

/* Thin Claude proxy — sends ONE PDF to Claude with a specific prompt.
   Designed to run in <10 s on Netlify free tier. */

const PROMPTS = {
  production: `Dental Dentrix Production by Procedure Code report. Extract the date range from the header, then every procedure code with its description, quantity and dollar total.
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

  pl: `QuickBooks Profit and Loss statement. Extract every line item with its dollar amount.
Return ONLY lines in this format:
SECTION|[Income/COGS/Expense/Other Expense]
ITEM|AMOUNT
Use these exact section markers before each group.
For each line item under Expenses, return: ItemName|Amount
Also include these summary lines at the end:
TOTAL_INCOME|[amount]
TOTAL_EXPENSE|[amount]
NET_INCOME|[amount]
Return negative numbers with minus sign. Include ALL line items.`
};

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

  const { pdfBase64, type } = body;
  if (!pdfBase64 || !type) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'pdfBase64 and type required' }) };

  const prompt = PROMPTS[type];
  if (!prompt) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Invalid type. Use: production, collections, pl' }) };

  try {
    console.log(`parse-pdf: calling Claude for type=${type}`);
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: TOKEN_LIMITS[type] || 4096,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: prompt }
        ]}]
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
