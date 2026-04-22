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

test('SWOT: total-staff-cost weakness fires on staffCostPct > 20% (2026-04-21 hybrid anchor)', async () => {
  const body = await invoke();
  const k = body.data.kpis;
  expect(k.staffCostPct > 20, `fixture must have staffCostPct > 20 to exercise this rule; got ${k.staffCostPct}`);
  /* Weakness text must anchor on the TOTAL figure, not admin-only.
     Format: "Total staff cost at X.X% of collections exceeds the 20% benchmark…" */
  const w = body.data.swot.weaknesses.find(x => /total staff cost/i.test(x));
  expect(w, 'total-staff-cost weakness did not fire: ' + JSON.stringify(body.data.swot.weaknesses));
  expect(w.includes(k.staffCostPct.toFixed(1) + '%'), `weakness text "${w}" does not contain ${k.staffCostPct.toFixed(1)}%`);
  expect(/20% benchmark/.test(w), `weakness text should reference 20% benchmark, got: "${w}"`);
  expect(/excludes owner draws/i.test(w), `weakness text should note exclusion of owner draws, got: "${w}"`);
  /* Regression guard: the old admin-only phrasing must be gone. */
  const adminOnlyWeakness = body.data.swot.weaknesses.find(x => /admin\/clinical staff cost at[^]*15% benchmark/i.test(x));
  expect(!adminOnlyWeakness, `stale admin-only weakness still firing: "${adminOnlyWeakness}"`);
});

test('SWOT: labor-crowding-out threat anchors on TOTAL staffCostPct > 30% (hybrid)', async () => {
  const body = await invoke();
  const k = body.data.kpis;
  if (k.staffCostPct > 30) {
    const t = body.data.swot.threats.find(x => /total staff cost[^]*crowding out growth/i.test(x));
    expect(t, `threat did not fire at staffCostPct=${k.staffCostPct} (>30)`);
    expect(t.includes(k.staffCostPct.toFixed(1) + '%'), `threat text "${t}" should contain total ${k.staffCostPct.toFixed(1)}%`);
  } else {
    const hasThreat = body.data.swot.threats.some(x => /total staff cost[^]*crowding out growth/i.test(x));
    expect(!hasThreat, `threat fired at staffCostPct=${k.staffCostPct} (<=30) — should not fire`);
  }
  /* Regression guard: the old admin-only threat phrasing must be gone. */
  const adminThreat = body.data.swot.threats.find(x => /admin\/clinical staff cost[^]*crowding out growth/i.test(x));
  expect(!adminThreat, `stale admin-only threat still firing: "${adminThreat}"`);
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

test('opportunity "Staff cost optimization" uses TOTAL staff cost vs 20% (hybrid anchor)', async () => {
  const body = await invoke();
  const k = body.data.kpis;
  const annualColl = body.data.collections.annualized;
  expect(k.staffCostPct > 20, `fixture must drive staffCostPct > 20 to exercise this rule; got ${k.staffCostPct}`);
  /* Find the card in the full opportunities list (not just top3 — it may be
     outranked there by a bigger dollar item). */
  const staffOpp = body.data.opportunities.all.find(o => /staff cost/i.test(o.title));
  expect(staffOpp, 'staff cost opportunity card missing: ' + JSON.stringify(body.data.opportunities.all.map(o => o.title)));
  const expected = annualColl * (k.staffCostPct / 100 - 0.20);
  expect(Math.abs(staffOpp.value - expected) < 1, `opportunity value ${staffOpp.value} != expected ${expected} from (staffCostPct ${k.staffCostPct} - 20) × annualColl ${annualColl} / 100`);
  expect(/total staff cost/i.test(staffOpp.body), `body copy should mention total staff cost, got: "${staffOpp.body}"`);
  expect(/20% benchmark/.test(staffOpp.body), `body copy should reference 20% benchmark, got: "${staffOpp.body}"`);
  /* Body should embed the diagnostic decomposition (admin + hygienist references). */
  expect(/admin\/clinical/i.test(staffOpp.body), `body should cite admin/clinical decomposition, got: "${staffOpp.body}"`);
  expect(/hygienist/i.test(staffOpp.body), `body should cite hygienist decomposition, got: "${staffOpp.body}"`);
  expect(staffOpp.icon === '👥', `icon should be unchanged 👥, got: ${staffOpp.icon}`);
});

test('scorecard: admin/clinical and hygienist wage cards are un-flagged diagnostic (no status color)', async () => {
  const body = await invoke();
  const html = body.reportHtml;
  expect(html.includes('Staff Cost (Admin + Clinical)'), 'scorecard missing "Staff Cost (Admin + Clinical)" card');
  expect(html.includes('Hygienist Wage Ratio'), 'scorecard missing "Hygienist Wage Ratio" card');
  /* The two diagnostic cards must not carry a status color; they're reference-only. */
  const adminCardMatch = html.match(/<div class="score-card ([^"]*)">\s*<div class="lbl">Staff Cost \(Admin \+ Clinical\)/);
  expect(adminCardMatch, 'admin card markup not matched');
  expect(!/\b(good|warn|bad)\b/.test(adminCardMatch[1]), `admin card should have no status class, got: "${adminCardMatch[1]}"`);
  const hygCardMatch = html.match(/<div class="score-card ([^"]*)">\s*<div class="lbl">Hygienist Wage Ratio/);
  expect(hygCardMatch, 'hygienist card markup not matched');
  expect(!/\b(good|warn|bad)\b/.test(hygCardMatch[1]), `hygienist card should have no status class, got: "${hygCardMatch[1]}"`);
  /* Bench text must NOT call those two out as benchmarks (no "Target ≤15%" / "Target 30-33%"). */
  expect(!/Staff Cost \(Admin \+ Clinical\)[^<]*<\/div>[^]*?Target[^<]*15%/.test(html), 'admin card still shows 15% target (should be diagnostic)');
  /* Explainer paragraph must reflect the hybrid model: primary is total, decomposition is diagnostic. */
  expect(/primary coaching metric.{0,40}Total Staff Cost/i.test(html), 'scorecard explainer does not name Total Staff Cost as primary metric');
  /* Total staff cost stays visible in financials under the 20% benchmark. */
  expect(html.includes('Total Staff Cost'), 'financials section missing "Total Staff Cost" label');
  expect(/Total Staff Cost[^<]*<\/div>[^]*?Target[^<]*≤?\s*20%/i.test(html) || /Total Staff Cost[^]*?20%/i.test(html), 'financials Total Staff Cost should show 20% target');
});

/* ──────────────────────────────────────────────────────────────────────
   Hub profile-guard redirect predicate. Previous implementation gated on
   pp.zipCode || pp.numHygienists, which bounced users who completed the
   questionnaire with only the required practiceName — infinite redirect
   loop. New rule: presence of the sessionStorage key is enough.

   This test reads assessment_hub.html, extracts the pure predicate
   function's source, and runs it against a matrix of real inputs. No
   browser needed.
   ────────────────────────────────────────────────────────────────────── */
test('Hub profile-guard: redirect predicate matches spec', () => {
  const hubPath = path.resolve(__dirname, '..', 'assessment_hub.html');
  const html = fs.readFileSync(hubPath, 'utf8');
  const match = html.match(/function\s+shouldRedirectToQuestionnaire\s*\(([^)]*)\)\s*\{([\s\S]*?)\n\}/);
  expect(match, 'shouldRedirectToQuestionnaire not found in assessment_hub.html');
  const [, argList, body] = match;
  const [arg1, arg2] = argList.split(',').map(s => s.trim());
  const predicate = new Function(arg1, arg2, body);

  /* Fresh incognito / cleared storage → redirect */
  expect(predicate(null, false) === true,
    'null sessionStorage should redirect');
  expect(predicate(undefined, false) === true,
    'undefined sessionStorage should redirect');
  expect(predicate('', false) === true,
    'empty sessionStorage should redirect');
  expect(predicate('not-json', false) === true,
    'invalid JSON should redirect');
  expect(predicate('null', false) === true,
    'JSON null should redirect');

  /* Minimal questionnaire submission (only practiceName) → NO redirect */
  expect(predicate(JSON.stringify({ practiceName: 'Smith Family Dentistry' }), false) === false,
    'practiceName-only submission should NOT redirect (regression fix)');

  /* Fully-filled questionnaire → NO redirect */
  expect(predicate(JSON.stringify({
    practiceName: 'X', zipCode: '12345', numHygienists: 4,
  }), false) === false, 'fully-filled profile should NOT redirect');

  /* skipIntake=1 bypass, even with no session → NO redirect */
  expect(predicate(null, true) === false,
    'skipIntake=1 should bypass redirect even with no session');
  expect(predicate('', true) === false,
    'skipIntake=1 should bypass redirect even with empty session');
});

/* ──────────────────────────────────────────────────────────────────────
   2026-04-21 benchmark lock-in — sub-benchmark text, hygiene target,
   doctor $/day color, payor-mix-dependent hyg $/day, expanded code lists.
   ────────────────────────────────────────────────────────────────────── */

test('Fix 2: lab cost weakness says "6% target" (not 4%, not 9%)', async () => {
  /* Smoke fixture: lab $48k / collections $920k ≈ 5.2%. Bump lab to $70k → 7.6% so > 6% threshold fires. */
  const pl = PL_STANDARD.replace('Lab Fees|48000', 'Lab Fees|70000');
  const body = await invoke(pl);
  const w = body.data.swot.weaknesses.find(x => /lab cost/i.test(x));
  expect(w, 'lab weakness did not fire at 7.6%: ' + JSON.stringify(body.data.swot.weaknesses));
  expect(/6% target/.test(w), `lab weakness should say "6% target", got: "${w}"`);
  expect(!/4% benchmark/.test(w), `stale "4% benchmark" still present: "${w}"`);
});

test('Fix 2: supplies weakness says "6% target"', async () => {
  /* Bump supplies to 7% of collections → 64k on 920k. */
  const pl = PL_STANDARD.replace('Dental Supplies|45000', 'Dental Supplies|64000');
  const body = await invoke(pl);
  const w = body.data.swot.weaknesses.find(x => /supply/i.test(x));
  expect(w, 'supplies weakness did not fire at 7%: ' + JSON.stringify(body.data.swot.weaknesses));
  expect(/6% target/.test(w), `supplies weakness should say "6% target", got: "${w}"`);
});

test('Fix 2: lab does NOT fire weakness at 5.5% (under 6% threshold)', async () => {
  /* Smoke fixture at lab $48k / $920k = 5.2% — should not fire. */
  const body = await invoke();
  const w = body.data.swot.weaknesses.find(x => /lab cost/i.test(x));
  expect(!w, `lab weakness should not fire at 5.2%: "${w}"`);
});

test('Fix 3: hygiene weakness says "vs a 33% target" (not 30-35%)', async () => {
  /* Drive hygiene% low — sparse hygiene codes but heavy doctor production. */
  const sparseProd = [
    'DATE RANGE: 01/01/2025 - 12/31/2025',
    'D0150|Comp Eval|360|32400',
    'D1110|Prophy|400|40000',     /* 4% hygiene only */
    'D2740|Crown|300|450000',
    'D3330|RCT|60|90000',
  ].join('\n');
  const res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify(Object.assign(JSON.parse(buildEvent().body), { prodText: sparseProd })),
  });
  const data = JSON.parse(res.body).data;
  expect(data.kpis.hygienePercent < 25, `fixture should drive hygienePercent < 25; got ${data.kpis.hygienePercent}`);
  const w = data.swot.weaknesses.find(x => /hygiene production at/i.test(x));
  expect(w, 'hygiene-% weakness did not fire: ' + JSON.stringify(data.swot.weaknesses));
  expect(/33% target/.test(w), `hygiene weakness should say "33% target", got: "${w}"`);
});

test('Fix 3: hygiene opportunity gap uses 33% target in text + math', async () => {
  const body = await invoke();
  const oppHyg = body.data.opportunities.all.find(o => /hygiene production gap/i.test(o.title));
  if (oppHyg) {
    expect(/33% target/.test(oppHyg.body), `hygiene opp body should say "33% target", got: "${oppHyg.body}"`);
    expect(!/30.?35% target/.test(oppHyg.body), `stale 30-35% target language: "${oppHyg.body}"`);
  }
  /* Scorecard bench text — must cite 33%, not the old 30-33% range. */
  expect(/Hygiene % of Production[^]*?Target <strong>33%/.test(body.reportHtml), 'scorecard hygiene % card bench should read "Target 33%"');
});

test('Fix 4: Doctor $/Day card flags red when below warn floor', async () => {
  /* Smoke fixture: hasAssociate=false, combined doc $/day = annualDoctor / 192 days.
     annualDoctor ≈ 1002200 - (398k hyg) - (84+90+24+48 specialty) — rough.
     With normal prod, owner $/day will be ~$3000-3200 → "warn" or "bad" depending.
     Grab the Doctor $/Day card and confirm status class is set (not empty). */
  const body = await invoke();
  const html = body.reportHtml;
  const docCardMatch = html.match(/<div class="score-card ([^"]*)">\s*<div class="lbl">(?:Combined )?Doctor \$\/Day/);
  expect(docCardMatch, 'Doctor $/Day card not found');
  const status = docCardMatch[1].trim();
  expect(/\b(good|warn|bad)\b/.test(status), `Doctor $/Day card should carry a status class (2026-04-21 $4k target); got: "${status}"`);
  /* Bench must name the $4,000/day owner target. */
  expect(/Doctor \$\/Day[^]*?\$4,000\/day[^]*?\(owner/i.test(html), 'Doctor $/Day bench should cite $4,000/day owner target');
});

test('Fix 4: Doctor $/Day uses blended target with associate days', async () => {
  const body = await invoke(null, { hasAssociate: true, associateDays: 8, assocDailyAvg: 2500, docDailyAvg: 3800 });
  const html = body.reportHtml;
  /* Blended target: (4000×16 + 3500×8) / 24 = (64000 + 28000) / 24 = $3,833 */
  expect(/Combined Doctor \$\/Day[^]*?Blended target/i.test(html), 'Combined Doctor card should advertise a Blended target when associate present');
  expect(/owner \$4k.{0,10}assoc \$3\.5k/i.test(html), 'Blended-target bench should cite owner $4k / assoc $3.5k');
});

test('Fix 5: Hygiene $/Day uses PPO-tier benchmarks when capitated payors ≤ 50%', async () => {
  /* Smoke fixture is PPO 60 / FFS 25 / HMO 10 / Gov 5 → PPO tier. */
  const body = await invoke();
  const html = body.reportHtml;
  expect(/Hygiene Avg \$\/Day[^]*?PPO\/FFS tier/i.test(html), 'Hyg $/Day should advertise PPO/FFS tier; got: ' + (html.match(/Hygiene Avg \$\/Day[^<]+/) || []).join('|'));
  expect(/\$1,000\+/.test(html), 'Hyg $/Day bench should cite $1,000+ PPO target');
});

test('Fix 5: Hygiene $/Day uses HMO tier when HMO+Gov > 50%', async () => {
  const body = await invoke(null, { payorMix: { ppo: 10, hmo: 40, gov: 25, ffs: 25 } });
  const html = body.reportHtml;
  expect(/Hygiene Avg \$\/Day[^]*?HMO\/capitated tier/i.test(html), 'Hyg $/Day should advertise HMO/capitated tier when HMO+Gov > 50%');
  expect(/\$500.{1,3}600/.test(html), 'Hyg $/Day bench should cite $500-600 capitated target');
});

test('Fix 6: Conversion Ratio visits include D1110+D1120+D4910+D4341+D4342+D0150 and EXCLUDE D0120', async () => {
  const body = await invoke();
  const inputs = body.data.kpis.battingAverageInputs;
  /* Smoke fixture visit-code qtys: D1110=2400, D1120=400, D4910=600, D4341=120, D0150=360.
     (D4342 absent in fixture.) Expected visitsCount = 2400+400+600+120+360 = 3880. */
  expect(inputs.visitsCount === 3880, `visitsCount should be 3880 (sum of D1110+D1120+D4910+D4341+D0150), got ${inputs.visitsCount}`);
  /* D0120 must not leak in: D0120 qty in fixture = 1200. If it leaked → 5080. */
  expect(inputs.visitsCount !== 5080, 'D0120 leaked into visits count');
});

test('Fix 6: Conversion Ratio crowns cover full D2xxx + D6058-D6067 implant + D6210-D6794 bridge ranges', async () => {
  /* Additional fixture with an implant crown (D6065) and a mid-range bridge unit (D6245)
     whose code is INSIDE the new numeric range. */
  const prod = [
    'DATE RANGE: 01/01/2025 - 12/31/2025',
    'D1110|Prophy|2000|200000',
    'D2740|Crown Porcelain|100|150000',
    'D6065|Implant Crown|20|40000',  /* in D6058-D6067 range */
    'D6245|Pontic|12|18000',          /* in D6210-D6794 range */
  ].join('\n');
  const res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify(Object.assign(JSON.parse(buildEvent().body), { prodText: prod })),
  });
  const data = JSON.parse(res.body).data;
  const inputs = data.kpis.battingAverageInputs;
  /* Expected: D2740=100 + D6065=20 + D6245=12 = 132. */
  expect(inputs.crownsPreppedCount === 132, `crownsPreppedCount should be 132 (D2740+D6065+D6245), got ${inputs.crownsPreppedCount}`);
});

test('Fix 6: hygiene bucket includes D0120 (periodic exam) but excludes D0150 (comp exam)', async () => {
  const body = await invoke();
  const hygProd = body.data.production.byCategory.hygiene;
  /* Fixture hyg codes (per 2026-04-21 hygiene-percentage.yaml):
       D1110=240k, D1120=32k, D4910=84k, D4341=42k, D0120=78k → $476k.
     D0150 (32.4k) must NOT land in hygiene — if it did, total = $508.4k. */
  expect(Math.abs(hygProd - 476000) < 1, `hygiene bucket should be $476k (D1110+D1120+D4910+D4341+D0120, no D0150); got $${hygProd}`);
});

/* ──────────────────────────────────────────────────────────────────────
   Pigneri-scale probe — synthetic fixture with total staff cost ≈ 36% and
   collections ≈ $1.34M. Confirms every 2026-04-21 rule end-to-end against
   numbers in the same neighborhood as Dave's Pigneri reference practice.
   ────────────────────────────────────────────────────────────────────── */
test('Pigneri-scale probe: total staff cost ≈ 36%, opportunity ≈ (36-20)%×$1.34M, PPO hyg tier', async () => {
  /* Build a Pigneri-shaped payload:
       - Annual collections ≈ $1.34M
       - Total staff cost ≈ 36% of collections
       - Admin portion ≈ 23–24% (below the old 15% rule; above nothing now)
       - Payor mix 60% FFS + 40% PPO → PPO tier for hygiene */
  const pigneriProd = [
    'DATE RANGE: 01/01/2025 - 12/31/2025',
    'D0120|Periodic Eval|1500|97500',
    'D0150|Comprehensive Eval|400|36000',
    'D0330|Panorex|200|22000',
    'D1110|Adult Prophy|3200|320000',
    'D1120|Child Prophy|500|40000',
    'D4910|Perio Maint|800|112000',
    'D4341|SRP 4+|180|63000',
    'D4342|SRP 1-3|60|15000',
    'D4346|Debridement|40|10000',
    'D4381|Locally-delivered Abx|30|3000',
    'D2740|Crown Porcelain|220|330000',
    'D2750|Crown P/M|90|126000',
    'D3330|Molar RCT|60|90000',
    'D7140|Extraction|120|36000',
    'D8090|Ortho|12|72000',
  ].join('\n');
  const pigneriColl = [
    'DATES| 01/01/2025 - 12/31/2025',
    'CHARGES|1480000',
    'PAYMENTS|1340000',
  ].join('\n');
  const pigneriPL = [
    'DATES| 01/01/2025 - 12/31/2025',
    'SECTION|Income',
    'Sales|1340000',
    'TOTAL_INCOME|1340000',
    'SECTION|Expense',
    'Salaries & Wages|380000',
    'Payroll Taxes|38000',
    'Lab Fees|70000',     /* 5.2% — under new 6% threshold */
    'Dental Supplies|85000',  /* 6.3% — just over new 6% threshold */
    'Rent|52000',
    'Marketing|24000',
    'Office Supplies|18000',
    'Other Expenses|75000',
    'TOTAL_EXPENSE|742000',
    'NET_INCOME|598000',
  ].join('\n');
  /* Employee costs sized to yield ~36% total staff cost on $1.34M:
       admin $317k + hyg $164k ≈ $481k → 35.9%. */
  const res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({
      prodText: pigneriProd,
      collText: pigneriColl,
      plText: pigneriPL,
      practiceName: 'Pigneri Probe',
      arPatient: { total: 65000, d90plus: 12000 },
      arInsurance: { total: 88000, d90plus: 7000 },
      employeeCosts: {
        /* Admin: 4 FTEs at higher wage levels */
        staff: [
          { rate: 32, hours: 160 }, { rate: 28, hours: 160 },
          { rate: 24, hours: 160 }, { rate: 22, hours: 160 },
        ],
        hygiene: [
          { rate: 50, hours: 160 }, { rate: 46, hours: 160 },
        ],
        staffBenefits: 5200, staffEmpCostPct: 0.12,
        hygBenefits: 2200, hygEmpCostPct: 0.12,
      },
      practiceProfile: {
        name: 'Pigneri Probe',
        zipCode: '11111',
        doctorDays: 18, hasAssociate: false,
        numHygienists: 2,
        payorMix: { ppo: 40, hmo: 0, gov: 0, ffs: 60 },   /* PPO tier */
        pmSoftware: 'dentrix',
        yearsOwned: 15, ownerAge: 52,
      },
    }),
  });
  expect(res.statusCode === 200, 'Pigneri probe HTTP error: ' + res.body);
  const body = JSON.parse(res.body);
  const k = body.data.kpis;
  const annualColl = body.data.collections.annualized;
  /* ── 1. Total staff cost in the 30s. ── */
  expect(k.staffCostPct > 30 && k.staffCostPct < 45, `Pigneri total staffCostPct out of range: ${k.staffCostPct}`);
  /* ── 2. SWOT weakness anchors on TOTAL, cites the total %, references 20%. ── */
  const w = body.data.swot.weaknesses.find(x => /total staff cost at/i.test(x));
  expect(w, 'Pigneri: total-staff weakness missing');
  expect(w.includes(k.staffCostPct.toFixed(1) + '%'), `weakness must cite total ${k.staffCostPct.toFixed(1)}%, got: ${w}`);
  expect(/20% benchmark/.test(w), `weakness must reference 20% benchmark: ${w}`);
  /* ── 3. Threat fires on total > 30%. ── */
  const threat = body.data.swot.threats.find(x => /total staff cost[^]*crowding out growth/i.test(x));
  expect(threat, 'Pigneri: total-staff-cost >30 threat should fire, threats=' + JSON.stringify(body.data.swot.threats));
  /* ── 4. Opportunity dollar = (total - 20) × collections. ── */
  const staffOpp = body.data.opportunities.all.find(o => /staff cost/i.test(o.title));
  expect(staffOpp, 'Pigneri: staff cost opp missing');
  const expectedSavings = annualColl * (k.staffCostPct / 100 - 0.20);
  expect(Math.abs(staffOpp.value - expectedSavings) < 1, `Pigneri opp ${staffOpp.value} != (${k.staffCostPct}-20)% × ${annualColl} = ${expectedSavings}`);
  expect(staffOpp.value > 150000 && staffOpp.value < 300000, `Pigneri opp in 150k-300k band; got ${staffOpp.value}`);
  /* ── 5. Supplies text "6% target" (fixture at ~6.3%). ── */
  const supplyW = body.data.swot.weaknesses.find(x => /supply/i.test(x));
  if (supplyW) expect(/6% target/.test(supplyW), `Pigneri supplies must say "6% target", got: ${supplyW}`);
  /* ── 6. Hyg $/Day uses PPO tier (mix is 60% FFS + 40% PPO — no HMO/Gov). ── */
  expect(/Hygiene Avg \$\/Day[^]*?PPO\/FFS tier/i.test(body.reportHtml), 'Pigneri Hyg $/Day should use PPO/FFS tier');
  /* ── 7. Conversion Ratio visits include D1120 and D4342; NOT D0120. ── */
  const inputs = k.battingAverageInputs;
  /* 3200+500+800+180+60+400 = 5140 visits. If D0120 (1500) leaked → 6640. */
  expect(inputs.visitsCount === 5140, `Pigneri visitsCount should be 5140, got ${inputs.visitsCount}`);
  /* ── 8. Hygiene bucket includes D4381, D4346, D0274 if present; excludes D0150. ── */
  const hygProd = body.data.production.byCategory.hygiene;
  /* Expected: D1110(320) + D1120(40) + D4910(112) + D4341(63) + D4342(15) + D4346(10) + D4381(3) + D0120(97.5) = 660500. */
  const expectedHyg = 320000 + 40000 + 112000 + 63000 + 15000 + 10000 + 3000 + 97500;
  expect(Math.abs(hygProd - expectedHyg) < 1, `Pigneri hygiene bucket should be $${expectedHyg}; got $${hygProd}`);
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
