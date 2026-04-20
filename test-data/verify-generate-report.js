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

function buildEvent(plText, profileOverrides) {
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
      practiceProfile: Object.assign({
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
      }, profileOverrides || {}),
    }),
  };
}

async function invoke(plText, profileOverrides) {
  const res = await handler(buildEvent(plText, profileOverrides));
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

/* ──────────────────────────────────────────────────────────────────────
   Fix 1 lock-in — Combined Doctor $/Day must use total (owner + associate)
   days when hasAssociate=true. The canonical value is the single source of
   truth for the scorecard, the review page, and kpis.combinedDocDailyAvg.
   ────────────────────────────────────────────────────────────────────── */
test('combinedDocDailyAvg — includes associate days when hasAssociate=true', async () => {
  const body = await invoke(null, { hasAssociate: true, associateDays: 8, assocDailyAvg: 2500 });
  const k = body.data.kpis;
  const prod = body.data.production;
  /* 16 owner days/mo + 8 assoc days/mo = 288 total days/yr */
  const expectedDenom = (16 + 8) * 12;
  const expected = (prod.byCategory?.doctor || 0) / expectedDenom;
  expect(Math.abs(k.combinedDocDailyAvg - expected) < 1, `combinedDocDailyAvg=${k.combinedDocDailyAvg} expected≈${expected} (doctor=${prod.byCategory?.doctor}, denom=${expectedDenom})`);
  /* Scorecard should show the same number */
  const scorecardMatch = body.reportHtml.match(/Combined Doctor \$\/Day[^$]*\$([\d,]+)/);
  expect(scorecardMatch, 'scorecard did not render "Combined Doctor $/Day" card');
  const scorecardVal = parseFloat(scorecardMatch[1].replace(/,/g, ''));
  expect(Math.abs(scorecardVal - k.combinedDocDailyAvg) < 2, `scorecard $/Day ${scorecardVal} != data ${k.combinedDocDailyAvg}`);
});

/* ──────────────────────────────────────────────────────────────────────
   Fix 4 lock-in — concerns render as human-readable labels on the Report.
   The raw token "new_patients" previously leaked through because the
   concernLabels map was missing that key.
   ────────────────────────────────────────────────────────────────────── */
test('concerns render as human-readable labels, not raw tokens', async () => {
  const body = await invoke(null, {
    concerns: ['new_patients', 'more_profitable', 'overhead_high', 'staff_issues'],
  });
  const html = body.reportHtml;
  expect(!/\bnew_patients\b/.test(html), 'raw token "new_patients" leaked into report HTML');
  expect(!/\bmore_profitable\b/.test(html), 'raw token "more_profitable" leaked into report HTML');
  expect(!/\boverhead_high\b/.test(html), 'raw token "overhead_high" leaked into report HTML');
  expect(html.includes('New patient growth'), 'missing "New patient growth" label');
  expect(html.includes('More profitable'), 'missing "More profitable" label');
  expect(html.includes('Overhead too high'), 'missing "Overhead too high" label');
});

/* ──────────────────────────────────────────────────────────────────────
   Fix 5 lock-in — periodLabel uses human-readable date range when a
   date range is captured from the PDF (not bare "(2025, 2026)").
   ────────────────────────────────────────────────────────────────────── */
test('period label shows human-readable date range', async () => {
  const body = await invoke();
  const html = body.reportHtml;
  expect(/January 2025 . December 2025/.test(html), 'period label missing "January 2025 – December 2025": ' + (html.match(/Based on \d+ months[^<]*/) || []).join(''));
  /* Should not still show the bare year list. */
  expect(!/Based on 12 months of production data \(2025\)/.test(html), 'old year-list period label still present');
});

/* ──────────────────────────────────────────────────────────────────────
   Fix 3 lock-in — collection-rate benchmark is 97% everywhere.
   ────────────────────────────────────────────────────────────────────── */
test('collection-rate benchmark: 97% only — no 98% references in report HTML', async () => {
  const body = await invoke();
  const html = body.reportHtml;
  expect(!/98%/.test(html), 'report HTML still contains "98%" text');
});

/* ──────────────────────────────────────────────────────────────────────
   Fix 6 lock-in — threat rules fire on suggestive inputs.
   ────────────────────────────────────────────────────────────────────── */
test('SWOT threats: concentrated payor mix fires', async () => {
  const body = await invoke(null, { payorMix: { ppo: 75, hmo: 0, gov: 0, ffs: 25 } });
  const threats = body.data.swot.threats;
  expect(threats.some(t => /PPO/.test(t) && /concentration/i.test(t)), 'PPO concentration threat did not fire: ' + JSON.stringify(threats));
});

test('SWOT threats: succession risk fires when owner ≥ 60 and no associate', async () => {
  const body = await invoke(null, { ownerAge: 63, hasAssociate: false });
  const threats = body.data.swot.threats;
  expect(threats.some(t => /succession/i.test(t)), 'succession-risk threat did not fire: ' + JSON.stringify(threats));
});

test('SWOT threats: insurance AR 90+ tail risk fires when >10% of insurance AR is 90+', async () => {
  /* Override the baseEvent's arInsurance via a direct handler call rather than
     through invoke() — invoke() doesn't thread AR overrides. */
  const evt = buildEvent();
  const body = JSON.parse(evt.body);
  body.arInsurance = { total: 100000, d90plus: 15000 };  /* 15% tail */
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(body) });
  const data = JSON.parse(res.body).data;
  expect(data.swot.threats.some(t => /insurance ar 90\+/i.test(t) || /aging tail/i.test(t)), 'insurance AR aging tail threat did not fire: ' + JSON.stringify(data.swot.threats));
});

/* ──────────────────────────────────────────────────────────────────────
   Three-way staff-cost decomposition (2026-04-20 methodology). Hygienist
   wages scale with hygiene days/week, so benchmarking total staff cost as
   one blob conflates admin efficiency with hygiene scheduling. Three
   separate metrics; SWOT and threats anchor on the decomposed ones.
   ────────────────────────────────────────────────────────────────────── */

test('staff-cost decomposition: all three metrics compute without NaN', async () => {
  const body = await invoke();
  const k = body.data.kpis;
  expect(k.staffCostPct      != null && Number.isFinite(k.staffCostPct),      'staffCostPct is null/NaN: ' + k.staffCostPct);
  expect(k.staffCostExHygPct != null && Number.isFinite(k.staffCostExHygPct), 'staffCostExHygPct is null/NaN: ' + k.staffCostExHygPct);
  expect(k.hygienistCostPct  != null && Number.isFinite(k.hygienistCostPct),  'hygienistCostPct is null/NaN: ' + k.hygienistCostPct);
});

test('staff-cost decomposition: staffCostExHygPct strictly less than staffCostPct (hygiene not leaked)', async () => {
  const body = await invoke();
  const k = body.data.kpis;
  expect(k.staffCostExHygPct < k.staffCostPct, `staffCostExHygPct (${k.staffCostExHygPct}) should be < staffCostPct (${k.staffCostPct}); equal → hygiene double-counted or leaked into admin`);
});

test('staff-cost decomposition: hygienistCostPct denominator is hygiene production (not collections)', async () => {
  const body = await invoke();
  const k = body.data.kpis;
  const hygProd = body.data.production.byCategory.hygiene;
  const annualColl = body.data.collections.annualized;
  /* Recompute from hygiene employee-cost fixture to verify denominator. */
  const hygWages = (42 * 136 + 40 * 136) * 12;
  const hygBenefits = 1800 * 12;
  const hygEmp = hygWages * 0.10;
  const hygAnnual = hygWages + hygBenefits + hygEmp;
  const expectedFromHyg = (hygAnnual / hygProd) * 100;
  const expectedFromColl = (hygAnnual / annualColl) * 100;
  expect(Math.abs(k.hygienistCostPct - expectedFromHyg) < 0.5, `hygienistCostPct=${k.hygienistCostPct} expected≈${expectedFromHyg} (from hygiene production=${hygProd})`);
  /* If the denominator were collections, hygienistCostPct would equal this
     alternate value — assert it's DIFFERENT to prove the denominator. */
  expect(Math.abs(k.hygienistCostPct - expectedFromColl) > 1, `hygienistCostPct looks like it was divided by collections (${expectedFromColl}) not hygiene production (${expectedFromHyg})`);
});

test('SWOT: admin/clinical weakness fires when staffCostExHygPct > 15% and uses that exact number', async () => {
  const body = await invoke();
  const k = body.data.kpis;
  expect(k.staffCostExHygPct > 15, `fixture must have staffCostExHygPct > 15 to exercise this rule; got ${k.staffCostExHygPct}`);
  const w = body.data.swot.weaknesses.find(x => /admin\/clinical staff cost/i.test(x));
  expect(w, 'admin/clinical weakness did not fire: ' + JSON.stringify(body.data.swot.weaknesses));
  expect(w.includes(k.staffCostExHygPct.toFixed(1) + '%'), `weakness text "${w}" does not contain ${k.staffCostExHygPct.toFixed(1)}%`);
});

test('SWOT: labor-crowding-out threat anchors on staffCostExHygPct > 20% (not total)', async () => {
  /* Fixture: admin wages push admin-only ratio over 20% while total still
     matters less. Staff array wages alone ≈ $128k + $30k benefits + emp costs ≈
     $170k on $920k collections ≈ 18.5%; bump the admin rates to cross 20. */
  const body = await invoke(null, {});
  const k = body.data.kpis;
  /* Our smoke fixture has staffCostExHygPct ≈ 19.9% — below the threat
     threshold (20%). Verify the threat does NOT fire here so we're sure the
     gate isn't just firing on total. */
  if (k.staffCostExHygPct <= 20) {
    const hasThreat = body.data.swot.threats.some(t => /admin\/clinical staff cost[^]*crowding out growth/i.test(t));
    expect(!hasThreat, `threat fired at staffCostExHygPct=${k.staffCostExHygPct} (<=20) — should not fire`);
  } else {
    const hasThreat = body.data.swot.threats.some(t => /admin\/clinical staff cost[^]*crowding out growth/i.test(t));
    expect(hasThreat, `threat did not fire at staffCostExHygPct=${k.staffCostExHygPct} (>20)`);
  }
});

test('SWOT: hygienist-productivity weakness fires when hygienistCostPct > 38%', async () => {
  /* Low hygiene production → high hygienistCostPct. Use only hygiene codes
     with low totals to spike the ratio, employeeCosts same as baseline. */
  const sparseProd = [
    'DATE RANGE: 01/01/2025 - 12/31/2025',
    'D0120|Periodic Oral Evaluation|1200|78000',
    'D1110|Prophy|2400|120000',  /* half the normal wages-vs-production makes ratio blow up */
    'D2740|Crown|140|420000',
  ].join('\n');
  const res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify(Object.assign(JSON.parse(buildEvent().body), { prodText: sparseProd })),
  });
  const data = JSON.parse(res.body).data;
  expect(data.kpis.hygienistCostPct > 38, `fixture should drive hygienistCostPct > 38; got ${data.kpis.hygienistCostPct}`);
  const w = data.swot.weaknesses.find(x => /hygienist productivity/i.test(x));
  expect(w, 'hygienist-productivity weakness did not fire: ' + JSON.stringify(data.swot.weaknesses));
  expect(w.includes(data.kpis.hygienistCostPct.toFixed(1) + '%'), `weakness text "${w}" does not contain ${data.kpis.hygienistCostPct.toFixed(1)}%`);
});

test('scorecard shows both admin/clinical and hygienist wage cards', async () => {
  const body = await invoke();
  const html = body.reportHtml;
  expect(html.includes('Staff Cost (Admin + Clinical)'), 'scorecard missing "Staff Cost (Admin + Clinical)" card');
  expect(html.includes('Hygienist Wage Ratio'), 'scorecard missing "Hygienist Wage Ratio" card');
  expect(/Staff cost is shown three ways/.test(html), 'scorecard explainer paragraph missing');
  /* Total staff cost stays visible in financials under a clarified label. */
  expect(html.includes('Total Staff Cost'), 'financials section missing "Total Staff Cost" label');
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
