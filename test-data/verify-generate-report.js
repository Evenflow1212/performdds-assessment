/* End-to-end smoke test for netlify/functions/generate-report.js
 *
 * Run from repo root:    node test-data/verify-generate-report.js
 *
 * Builds synthetic pipe-delimited payloads (matches what parse-pdf.js
 * produces after a real Hub run), invokes the handler in-process, and
 * sanity-checks the response shape + KPI magnitudes.
 *
 * Test suite includes the main smoke test plus adversarial parsePL()
 * cases exercising real-world Claude-output variants of the P&L totals
 * lines (plural "Total Expenses", title-case, currency-prefixed values,
 * parens-negative). These variants silently broke overhead % on the
 * Pigneri test in April 2026 (MORNING_NOTES.md).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const handler = require(path.resolve(__dirname, '..', 'netlify', 'functions', 'generate-report.js')).handler;

const prodText = [
  'DATE RANGE: 01/01/2025 - 12/31/2025',
  'D0120|Periodic Oral Evaluation|1200|78000',
  'D0150|Comprehensive Oral Evaluation|360|32400',
  'D0210|FMX|200|24000',
  'D0330|Panorex|180|19800',
  'D1110|Adult Prophylaxis|2400|240000',
  'D1120|Child Prophy|400|32000',
  'D4910|Perio Maintenance|600|84000',
  'D4341|SRP 4+|120|42000',
  'D2740|Crown Porcelain|140|210000',
  'D2750|Crown Porcelain/Metal|60|84000',
  'D2962|Veneer|12|24000',
  'D7140|Extraction|80|24000',
  'D3330|Root Canal Molar|40|60000',
  'D8090|Ortho|8|48000',
].join('\n');

const collText = [
  'DATES| 01/01/2025 - 12/31/2025',
  'CHARGES|1002200',
  'PAYMENTS|920000',
].join('\n');

/* Baseline P&L text — uses the canonical schema described in the
   parse-pdf.js PL_PROMPT. Other tests derive from this by substituting
   the total-expense line only. */
const PL_STANDARD = [
  'DATES| 01/01/2025 - 12/31/2025',
  'SECTION|Income',
  'Patient Income|850000',
  'Insurance Income|125000',
  'TOTAL_INCOME|975000',
  'SECTION|Expense',
  'Salaries & Wages|250000',
  'Payroll Taxes|25000',
  'Lab Fees|48000',
  'Dental Supplies|45000',
  'Rent|36000',
  'Marketing|18000',
  'Office Supplies|12000',
  'Other Expenses|55000',
  'TOTAL_EXPENSE|489000',
  'NET_INCOME|486000',
].join('\n');

function buildEvent(plText) {
  return {
    httpMethod: 'POST',
    body: JSON.stringify({
      prodText, collText,
      plText: plText == null ? PL_STANDARD : plText,
      practiceName: 'Test Dental Group',
      arPatient: { total: 45000, d90plus: 8000 },
      arInsurance: { total: 62000, d90plus: 4000 },
      hygieneData: null,
      employeeCosts: {
        staff: [
          { rate: 25, hours: 160 }, { rate: 22, hours: 160 }, { rate: 20, hours: 160 },
        ],
        hygiene: [
          { rate: 42, hours: 136 }, { rate: 40, hours: 136 },
        ],
        staffBenefits: 3500, staffEmpCostPct: 0.10,
        hygBenefits: 1800, hygEmpCostPct: 0.10,
      },
      practiceProfile: {
        name: 'Test Dental Group',
        zipCode: '12345',
        doctorDays: 16,
        numHygienists: 4,
        hasAssociate: false,
        yearsOwned: 12,
        ownerAge: 48,
        opsActive: 5, opsTotal: 6,
        payorMix: { ppo: 60, hmo: 10, gov: 5, ffs: 25 },
        pmSoftware: 'dentrix',
      },
    }),
  };
}

async function invoke(plText) {
  const res = await handler(buildEvent(plText));
  if (res.statusCode !== 200) throw new Error('HTTP ' + res.statusCode + ': ' + res.body);
  return JSON.parse(res.body);
}

function expect(cond, msg) { if (!cond) throw new Error(msg); }

const CASES = [];
function test(name, fn) { CASES.push({ name, fn }); }

/* ──────────────────────────────────────────────────────────────────────
   Main smoke test — standard P&L input. Verifies shape + KPI magnitudes
   end-to-end and writes the rendered report to disk for visual inspection.
   ────────────────────────────────────────────────────────────────────── */
test('smoke test — standard inputs', async () => {
  const body = await invoke();
  expect(body.success, 'body.success was false');
  const k = body.data.kpis;
  expect(k.annualProduction > 900000 && k.annualProduction < 1200000, 'annualProduction out of band: ' + k.annualProduction);
  expect(k.collectionRate > 80 && k.collectionRate < 100, 'collectionRate out of band: ' + k.collectionRate);
  expect(k.hygienePercent > 25 && k.hygienePercent < 55, 'hygienePercent out of band: ' + k.hygienePercent);
  expect(k.overheadPct > 30 && k.overheadPct < 80, 'overheadPct out of band: ' + k.overheadPct);
  expect(body.reportHtml.length >= 10000, 'reportHtml suspiciously short: ' + body.reportHtml.length);
  expect(!/\{\{[a-zA-Z]+\}\}/.test(body.reportHtml), 'reportHtml has un-substituted {{placeholder}}');
  const outPath = path.resolve(__dirname, 'output', 'smoke-test-report.html');
  fs.writeFileSync(outPath, body.reportHtml);
});

/* ──────────────────────────────────────────────────────────────────────
   Adversarial parsePL() cases — each one mutates a single line of the
   canonical P&L text to a plausible real-world variant and asserts that
   overhead % still populates (i.e. totalExpense was recognized).
   ────────────────────────────────────────────────────────────────────── */

test('parsePL — TOTAL_EXPENSES (plural S) populates totalExpense', async () => {
  const pl = PL_STANDARD.replace('TOTAL_EXPENSE|489000', 'TOTAL_EXPENSES|489000');
  const body = await invoke(pl);
  const fin = body.data.financials;
  expect(fin.plExpensesRaw > 400000, 'plExpensesRaw not populated on plural variant: ' + fin.plExpensesRaw);
  expect(body.data.kpis.overheadPct != null, 'overheadPct is null — parser missed TOTAL_EXPENSES');
});

test('parsePL — "Total Expenses" (space + title case) populates totalExpense', async () => {
  const pl = PL_STANDARD.replace('TOTAL_EXPENSE|489000', 'Total Expenses|489000');
  const body = await invoke(pl);
  const fin = body.data.financials;
  expect(fin.plExpensesRaw > 400000, 'plExpensesRaw not populated on "Total Expenses" variant: ' + fin.plExpensesRaw);
  expect(body.data.kpis.overheadPct != null, 'overheadPct is null — parser missed "Total Expenses"');
});

test('parsePL — value with $ prefix and commas parses', async () => {
  const pl = PL_STANDARD.replace('TOTAL_EXPENSE|489000', 'TOTAL_EXPENSE|$489,000.00');
  const body = await invoke(pl);
  const fin = body.data.financials;
  expect(Math.abs(fin.plExpensesRaw - 489000) < 1, 'plExpensesRaw wrong on currency-formatted value: ' + fin.plExpensesRaw);
});

test('parsePL — parens-negative value parses as positive magnitude', async () => {
  const pl = PL_STANDARD.replace('TOTAL_EXPENSE|489000', 'TOTAL_EXPENSE|(489,000.00)');
  const body = await invoke(pl);
  const fin = body.data.financials;
  expect(Math.abs(fin.plExpensesRaw - 489000) < 1, 'plExpensesRaw wrong on parens-negative: ' + fin.plExpensesRaw);
});

test('parsePL — "Total for Expenses" (QB verbose label) populates totalExpense', async () => {
  const pl = PL_STANDARD.replace('TOTAL_EXPENSE|489000', 'Total for Expenses|489000');
  const body = await invoke(pl);
  const fin = body.data.financials;
  expect(fin.plExpensesRaw > 400000, 'plExpensesRaw not populated on "Total for Expenses": ' + fin.plExpensesRaw);
});

test('parsePL — TOTAL_EXPENSES must not leak into items[] (no phantom $489k expense line)', async () => {
  const pl = PL_STANDARD.replace('TOTAL_EXPENSE|489000', 'TOTAL_EXPENSES|489000');
  const body = await invoke(pl);
  const fin = body.data.financials;
  /* If the summary-line regex missed it and the generic item regex picked
     it up, plExpenses (adjusted) could end up ~2× the real value. Assert
     it's in the same ballpark as raw. */
  expect(fin.plExpenses < fin.plExpensesRaw + 1, 'TOTAL_EXPENSES leaked into items: raw=' + fin.plExpensesRaw + ' adj=' + fin.plExpenses);
});

test('parsePL — "Net Operating Income" variant populates netIncome', async () => {
  const pl = PL_STANDARD.replace('NET_INCOME|486000', 'Net Operating Income|486000');
  const body = await invoke(pl);
  const netIncome = body.data.financials.netIncome;
  expect(netIncome != null && Math.abs(netIncome - 486000) < 1, 'netIncome not populated on "Net Operating Income": ' + netIncome);
});

(async () => {
  let failed = 0;
  const start = Date.now();
  for (const { name, fn } of CASES) {
    try {
      await fn();
      console.log('✅  ' + name);
    } catch (e) {
      failed++;
      console.error('❌  ' + name + '\n     ' + (e.message || e) + (e.stack ? '\n     ' + e.stack.split('\n')[1].trim() : ''));
    }
  }
  const ms = Date.now() - start;
  if (failed > 0) {
    console.error('\n' + failed + ' of ' + CASES.length + ' test(s) FAILED  (' + ms + 'ms)');
    process.exit(1);
  }
  console.log('\n✅  All ' + CASES.length + ' tests passed  (' + ms + 'ms)');
})().catch(e => { console.error('Crash:', e.message, e.stack); process.exit(1); });
