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

function buildEvent(plText, profileOverrides, extras) {
  const ex = extras || {};
  return {
    httpMethod: 'POST',
    body: JSON.stringify({
      prodText, collText,
      plText: plText == null ? PL_STANDARD : plText,
      practiceName: 'Test Dental Group',
      arPatient: ex.arPatient || { total: 45000, d90plus: 8000 },
      arInsurance: ex.arInsurance || { total: 62000, d90plus: 4000 },
      hygieneData: ex.hygieneData != null ? ex.hygieneData : null,
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

async function invoke(plText, profileOverrides, extras) {
  const res = await handler(buildEvent(plText, profileOverrides, extras));
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
  /* Recompute under the 2026-04-29 worksheet × loading-factor methodology.
     Smoke fixture's PL_STANDARD has 'Salaries & Wages|250000' +
     'Payroll Taxes|25000' = $275k staff-related expense. annualWages =
     staff (25+22+20)×160×12 + hyg (42+40)×136×12 = 128640 + 133824 =
     $262,464. loading = 275000/262464 = 1.0478 (in bounds → pl-actual).
     hygCost = 133824 × 1.0478 = $140,217.
     hygienistCostPct = 140217 / hygProd ≈ 29.46%. */
  const hygWages = (42 * 136 + 40 * 136) * 12;
  const adminWages = (25 * 160 + 22 * 160 + 20 * 160) * 12;
  const plStaffTotal = 250000 + 25000;
  const loading = plStaffTotal / (adminWages + hygWages);
  const hygCost = hygWages * loading;
  const expectedFromHyg = (hygCost / hygProd) * 100;
  const expectedFromColl = (hygCost / annualColl) * 100;
  expect(Math.abs(k.hygienistCostPct - expectedFromHyg) < 0.5, `hygienistCostPct=${k.hygienistCostPct} expected≈${expectedFromHyg} (from hygiene production=${hygProd}, loading=${loading.toFixed(4)})`);
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

test('Hygiene Dept Ratio SWOT supersedes legacy labor-as-% weakness when ratio < 3', async () => {
  /* Low hygiene production → ratio well below 3. Same fixture that used to
     exercise the legacy "hygienist > 38%" weakness; it now exercises the new
     Hygiene Department Ratio SWOT (3:1 framing) after the 2026-04-22 refresh. */
  const sparseProd = [
    'DATE RANGE: 01/01/2025 - 12/31/2025',
    'D0120|Periodic Oral Evaluation|1200|78000',
    'D1110|Prophy|2400|120000',
    'D2740|Crown|140|420000',
  ].join('\n');
  const res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify(Object.assign(JSON.parse(buildEvent().body), { prodText: sparseProd })),
  });
  const data = JSON.parse(res.body).data;
  expect(data.kpis.hygienistCostPct > 38, `fixture should drive hygienistCostPct > 38; got ${data.kpis.hygienistCostPct}`);
  /* New HIGH PRIORITY weakness — 3:1 production-to-labor framing. */
  const w = data.swot.weaknesses.find(x => /hygiene department produces \$[\d.]+ for every \$1 of hygiene labor cost/i.test(x));
  expect(w, 'Hygiene Department Ratio weakness did not fire: ' + JSON.stringify(data.swot.weaknesses));
  expect(/3:1 benchmark/.test(w), `weakness should cite 3:1 benchmark, got: ${w}`);
  expect(/two structural paths to close that gap/i.test(w), 'weakness missing two-paths phrase');
  /* Legacy labor-as-% phrasing must be gone. */
  const legacy = data.swot.weaknesses.find(x => /Hygienist productivity below benchmark — wages are /.test(x));
  expect(!legacy, `Legacy hygienist>38 weakness still firing: "${legacy}"`);
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
  /* Band widened 2026-04-29 — staff-cost methodology shifted from
     wages+benefits+empCost overlay to wages × loading-factor. Pigneri's
     PL-actual loading lands ~1.08, dropping staff cost % from ~36 to
     ~31, which trims opp dollars proportionally. */
  expect(staffOpp.value > 100000 && staffOpp.value < 300000, `Pigneri opp in 100k-300k band; got ${staffOpp.value}`);
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

/* ──────────────────────────────────────────────────────────────────────
   Q1-Q4 methodology batch (2026-04-21): hygiene 3-levers copy, setup-check
   SWOT layered rules, scorecard reorder, fill-rate card + pre-booking SWOT.
   ────────────────────────────────────────────────────────────────────── */

test('Q1: hygiene gap body uses 3-levers coaching copy (empties / perio program / adjuncts)', async () => {
  /* Sparse hygiene production to guarantee the opp card fires. */
  const sparseProd = [
    'DATE RANGE: 01/01/2025 - 12/31/2025',
    'D0150|Comp Eval|360|32400',
    'D1110|Prophy|600|60000',
    'D2740|Crown|200|300000',
  ].join('\n');
  const res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify(Object.assign(JSON.parse(buildEvent().body), { prodText: sparseProd })),
  });
  const data = JSON.parse(res.body).data;
  const oppHyg = data.opportunities.all.find(o => /hygiene production gap/i.test(o.title));
  expect(oppHyg, 'hygiene gap opp did not fire');
  expect(/Three levers to close this gap/i.test(oppHyg.body), `body missing "Three levers" framing: ${oppHyg.body}`);
  expect(/Reduce empties/i.test(oppHyg.body), 'body missing empties lever');
  expect(/perio program/i.test(oppHyg.body) && /D4341/.test(oppHyg.body) && /D4910/.test(oppHyg.body), 'body missing perio-program lever with D4341/D4910 refs');
  expect(/Arestin.*D4381/i.test(oppHyg.body) || /D4381.*Arestin/i.test(oppHyg.body), 'body missing Arestin/D4381 adjunctive-therapy lever');
  /* Old copy must be gone. */
  expect(!/doctor.diagnosed treatment pipeline/i.test(oppHyg.body), 'stale "doctor-diagnosed treatment pipeline" phrasing still present');
});

test('Q2b: Setup-check SWOT fires multiple HIGH-PRIORITY weaknesses when all answers are problematic', async () => {
  const body = await invoke(null, {
    feesAttachedToScheduler: 'no',
    insuranceFeeSchedulesCurrent: 'no',
    writeOffCalculation: 'manual',
    frequentManualAdjustments: 'yes',
    hasPatientCollectionsSystem: 'no',
    hasProductionGoal: 'no',
    knowsIfAhead: 'no',
  }, {
    /* Drive AR over-90 > 15% so rule C fires. */
    arPatient: { total: 50000, d90plus: 12000 },
  });
  const w = body.data.swot.weaknesses;
  /* A. data foundation. */
  expect(w.some(x => /data foundation needs attention/i.test(x)), 'rule A (data foundation) did not fire');
  /* B. frequent adjustments. */
  expect(w.some(x => /fee schedules and adjustment codes aren't set up correctly/i.test(x)), 'rule B (adjustments) did not fire');
  /* C. no collections system + AR over 90 > 15%. */
  expect(w.some(x => /patient AR over 90 days is[^]*15% threshold/i.test(x)), 'rule C (AR + collections) did not fire');
  /* D. no production goal / doesn't know mid-month. */
  expect(w.some(x => /don't track production goals/i.test(x) || /weekly scorecard/i.test(x)), 'rule D (scorekeeping) did not fire');
  /* At least 3 setup-foundation weaknesses total. */
  const setupCount = w.filter(x =>
    /data foundation needs attention/i.test(x) ||
    /fee schedules and adjustment codes/i.test(x) ||
    /patient AR over 90 days is[^]*15% threshold/i.test(x) ||
    /weekly scorecard/i.test(x)
  ).length;
  expect(setupCount >= 3, `expected ≥3 setup weaknesses, got ${setupCount}: ${JSON.stringify(w)}`);
  /* Prepended (HIGH PRIORITY) — the first weakness in the list should be one of the setup-foundation bullets. */
  const firstIsSetup =
    /data foundation needs attention/i.test(w[0]) ||
    /fee schedules and adjustment codes/i.test(w[0]) ||
    /patient AR over 90 days is[^]*15% threshold/i.test(w[0]) ||
    /weekly scorecard/i.test(w[0]);
  expect(firstIsSetup, `first weakness should be a setup-foundation item, got: "${w[0]}"`);
});

test('Q2b: Setup-check does NOT fire when all answers are clean', async () => {
  const body = await invoke(null, {
    feesAttachedToScheduler: 'yes',
    insuranceFeeSchedulesCurrent: 'yes',
    writeOffCalculation: 'automatic',
    frequentManualAdjustments: 'no',
    hasPatientCollectionsSystem: 'yes',
    hasProductionGoal: 'yes',
    knowsIfAhead: 'yes',
  });
  const w = body.data.swot.weaknesses;
  expect(!w.some(x => /data foundation needs attention/i.test(x)), 'rule A fired when all setup answers are "yes/automatic"');
  expect(!w.some(x => /weekly scorecard/i.test(x)), 'rule D fired when hasProductionGoal=yes and knowsIfAhead=yes');
  /* Regression: the old generic goal-setting weakness must be gone. */
  expect(!w.some(x => /no destination to measure progress against/i.test(x)), 'stale generic goal-setting weakness still firing');
});

test('Q3: Scorecard order follows coaching-ritual flow (production → doc $/day → hyg $/day → …)', async () => {
  const body = await invoke();
  const html = body.reportHtml;
  /* Extract the order of score-card labels as they appear in the HTML. */
  const labels = [...html.matchAll(/<div class="lbl">([^<]+)<\/div>/g)].map(m => m[1].trim());
  const annualIdx = labels.indexOf('Annual Production');
  const docIdx = labels.findIndex(l => /Doctor \$\/Day/.test(l));
  const hygDollarIdx = labels.indexOf('Hygiene Avg $/Day');
  const hygPctIdx = labels.indexOf('Hygiene % of Production');
  const collIdx = labels.indexOf('Collection Rate');
  const overheadIdx = labels.indexOf('Overhead %');
  expect(annualIdx >= 0, 'Annual Production card missing');
  expect(docIdx > annualIdx, `Doctor $/Day (${docIdx}) should appear after Annual Production (${annualIdx})`);
  expect(hygDollarIdx > docIdx, `Hygiene Avg $/Day (${hygDollarIdx}) should appear after Doctor $/Day (${docIdx})`);
  expect(hygPctIdx > hygDollarIdx, `Hygiene % (${hygPctIdx}) should appear after Hygiene Avg $/Day (${hygDollarIdx})`);
  expect(collIdx > hygPctIdx, `Collection Rate (${collIdx}) should appear after Hygiene % (${hygPctIdx})`);
  expect(overheadIdx > collIdx, `Overhead % (${overheadIdx}) should appear after Collection Rate (${collIdx})`);
});

test('Q4a: Hygiene Fill Rate card renders red when recentFillRate=80', async () => {
  const body = await invoke(null, {}, {
    hygieneData: { recentFillRate: 80, nearFuturePreBooking: 95 },
  });
  const html = body.reportHtml;
  const fillCardMatch = html.match(/<div class="score-card ([^"]*)">\s*<div class="lbl">Hygiene Fill Rate<\/div>\s*<div class="val">80%/);
  expect(fillCardMatch, 'Hygiene Fill Rate card with value 80% not found in HTML');
  expect(/\bbad\b/.test(fillCardMatch[1]), `Fill Rate card at 80% should carry "bad" status, got: "${fillCardMatch[1]}"`);
  /* And green when healthy. */
  const green = await invoke(null, {}, { hygieneData: { recentFillRate: 96, nearFuturePreBooking: 95 } });
  expect(/<div class="score-card good">\s*<div class="lbl">Hygiene Fill Rate/.test(green.reportHtml), 'Fill Rate card should be "good" at 96%');
  /* And missing entirely when no hygieneData. */
  const noHyg = await invoke();
  expect(!/>Hygiene Fill Rate</.test(noHyg.reportHtml), 'Fill Rate card should NOT render when hygieneData is null');
});

test('Q4b: Pre-booking SWOT weakness fires when nearFuturePreBooking=85 (< 90)', async () => {
  const body = await invoke(null, {}, {
    hygieneData: { recentFillRate: 92, nearFuturePreBooking: 85 },
  });
  const w = body.data.swot.weaknesses.find(x => /pre-booking rate 2.3 weeks out/i.test(x));
  expect(w, 'pre-booking weakness did not fire at 85%: ' + JSON.stringify(body.data.swot.weaknesses));
  expect(/85%/.test(w), `weakness should cite 85%, got: "${w}"`);
  expect(/90%\+/.test(w), `weakness should reference the 90%+ healthy threshold, got: "${w}"`);
  /* Does NOT fire when pre-booking is healthy. */
  const healthy = await invoke(null, {}, { hygieneData: { recentFillRate: 92, nearFuturePreBooking: 95 } });
  expect(!healthy.data.swot.weaknesses.some(x => /pre-booking rate 2.3 weeks out/i.test(x)), 'pre-booking weakness should not fire at 95%');
  /* Does NOT fire when hygieneData missing. */
  const noHyg = await invoke();
  expect(!noHyg.data.swot.weaknesses.some(x => /pre-booking rate 2.3 weeks out/i.test(x)), 'pre-booking weakness should not fire when hygieneData null');
});

/* ──────────────────────────────────────────────────────────────────────
   Q5-Q6 methodology batch (2026-04-22): production-diagnostic SWOT
   (alarm → upstream → downstream), BWV operational-gate SWOT,
   Conversion Ratio color-threshold tier update.
   ────────────────────────────────────────────────────────────────────── */

/* Helper — build a Q5-shaped fixture with custom hygiene visit + crown counts
   and optional hygieneData. All Q5 probes use this to drive BA ≈ 10
   (alarm A tripped) while varying upstream signals. */
function q5Fixture({ prodText: pt, hygieneData, profileOverrides }) {
  return {
    httpMethod: 'POST',
    body: JSON.stringify({
      prodText: pt,
      collText,
      plText: PL_STANDARD,
      practiceName: 'Q5 Probe',
      arPatient:   { total: 45000, d90plus: 4000 },
      arInsurance: { total: 62000, d90plus: 4000 },
      employeeCosts: {
        staff:   [{ rate: 25, hours: 160 }, { rate: 22, hours: 160 }, { rate: 20, hours: 160 }],
        hygiene: [{ rate: 42, hours: 136 }, { rate: 40, hours: 136 }],
        staffBenefits: 3500, staffEmpCostPct: 0.10,
        hygBenefits: 1800, hygEmpCostPct: 0.10,
      },
      hygieneData: hygieneData || null,
      practiceProfile: Object.assign({
        name: 'Q5 Probe', zipCode: '12345', doctorDays: 16,
        numHygienists: 4, hasAssociate: false,
        yearsOwned: 12, ownerAge: 48,
        opsActive: 5, opsTotal: 6,
        payorMix: { ppo: 60, hmo: 10, gov: 5, ffs: 25 },
        pmSoftware: 'dentrix',
        /* Setup-check answers clean so Q2 weaknesses don't crowd Q5 in assertions. */
        feesAttachedToScheduler: 'yes', insuranceFeeSchedulesCurrent: 'yes',
        writeOffCalculation: 'automatic', frequentManualAdjustments: 'no',
        hasPatientCollectionsSystem: 'yes', biteConsultApproach: 'dedicated',
        hasProductionGoal: 'yes', knowsIfAhead: 'yes',
      }, profileOverrides || {}),
    }),
  };
}

/* Q5 prod fixtures — all target BA ≈ 10 (alarm A trips) with varying
   exam coverage and hygiene mix. Dollar amounts chosen to keep hygiene%
   in a plausible band and doctor $/day comfortably below warn so that
   alarm B also trips (but the assertions below key off the body copy,
   not the framing variant). */
const Q5_PROD_EMPTIES = [
  'DATE RANGE: 01/01/2025 - 12/31/2025',
  'D1110|Prophy|500|55000','D1120|Child Prophy|200|16000',
  'D4910|Perio Maint|200|28000','D4341|SRP 4+|50|17500','D4342|SRP 1-3|50|12500',
  /* totalExams = D0150 + D0120 = 200 + 600 = 800; hygVisits = 1000; 800/1000 = 0.80 */
  'D0150|Comp Eval|200|20000','D0120|Periodic|600|36000',
  /* BA = visitsCount (1000 + 200) / crowns (120) = 10.0 */
  'D2740|Crown|120|168000',
].join('\n');
const Q5_PROD_EXAM_GAP = [
  'DATE RANGE: 01/01/2025 - 12/31/2025',
  'D1110|Prophy|500|55000','D1120|Child Prophy|200|16000',
  'D4910|Perio Maint|200|28000','D4341|SRP 4+|50|17500','D4342|SRP 1-3|50|12500',
  /* totalExams = 200 + 500 = 700; coverage = 700/1000 = 0.70 */
  'D0150|Comp Eval|200|20000','D0120|Periodic|500|30000',
  'D2740|Crown|120|168000',
].join('\n');
const Q5_PROD_DOWNSTREAM = [
  'DATE RANGE: 01/01/2025 - 12/31/2025',
  'D1110|Prophy|500|55000','D1120|Child Prophy|200|16000',
  'D4910|Perio Maint|200|28000','D4341|SRP 4+|50|17500','D4342|SRP 1-3|50|12500',
  /* totalExams = 300 + 650 = 950; coverage = 950/1000 = 0.95 */
  'D0150|Comp Eval|300|30000','D0120|Periodic|650|39000',
  /* visitsCount = 1000 + 300 = 1300; BA = 1300/130 = 10.0 */
  'D2740|Crown|130|182000',
].join('\n');

test('Q5 EMPTIES branch: alarm trips + fill<85 → upstream empties-leak copy', async () => {
  const res = await handler(q5Fixture({
    prodText: Q5_PROD_EMPTIES,
    hygieneData: { recentFillRate: 78, nearFuturePreBooking: 95 },
  }));
  const data = JSON.parse(res.body).data;
  expect(data.kpis.battingAverage >= 8, `fixture must drive BA>=8; got ${data.kpis.battingAverage}`);
  const q5 = data.swot.weaknesses.find(w => /Conversion Ratio/i.test(w) && /healthy range/i.test(w));
  expect(q5, 'Q5 weakness did not fire: ' + JSON.stringify(data.swot.weaknesses));
  /* Branch-specific copy markers. */
  expect(/Recent fill rate is 78%/.test(q5), `EMPTIES body should cite fill rate 78%, got: ${q5}`);
  expect(/empty chair time shrinks the pool of exam opportunities/i.test(q5), 'EMPTIES body missing "empty chair time" phrasing');
  /* DOWNSTREAM / EXAM-GAP copy must NOT appear. */
  expect(!/case presentation approach or financial arrangements/i.test(q5), 'DOWNSTREAM branch leaked into EMPTIES');
  expect(!/90% coverage, against a 90% floor/i.test(q5), 'EXAM-GAP branch leaked into EMPTIES');
});

test('Q5 EXAM-GAP branch: alarm trips + fill≥85 + coverage<90 → exam-gap copy', async () => {
  const res = await handler(q5Fixture({
    prodText: Q5_PROD_EXAM_GAP,
    hygieneData: { recentFillRate: 95, nearFuturePreBooking: 95 },
  }));
  const data = JSON.parse(res.body).data;
  const q5 = data.swot.weaknesses.find(w => /Conversion Ratio/i.test(w));
  expect(q5, 'Q5 weakness did not fire: ' + JSON.stringify(data.swot.weaknesses));
  expect(/70% coverage/i.test(q5), `EXAM-GAP body should report 70% exam coverage; got: ${q5}`);
  expect(/90% floor/i.test(q5), 'EXAM-GAP body missing 90% floor reference');
  expect(/D0150 periodic \+ D0120 comprehensive/i.test(q5), 'EXAM-GAP body missing D-code list');
  /* Other branches must not appear. */
  expect(!/empty chair time/i.test(q5), 'EMPTIES branch leaked into EXAM-GAP');
  expect(!/case presentation approach or financial arrangements/i.test(q5), 'DOWNSTREAM branch leaked into EXAM-GAP');
});

test('Q5 DOWNSTREAM branch: alarm trips + upstream clean → case-presentation copy', async () => {
  const res = await handler(q5Fixture({
    prodText: Q5_PROD_DOWNSTREAM,
    hygieneData: { recentFillRate: 95, nearFuturePreBooking: 95 },
  }));
  const data = JSON.parse(res.body).data;
  const q5 = data.swot.weaknesses.find(w => /Conversion Ratio/i.test(w));
  expect(q5, 'Q5 weakness did not fire: ' + JSON.stringify(data.swot.weaknesses));
  expect(/case presentation approach or financial arrangements/i.test(q5), `DOWNSTREAM body should cite case presentation / financial arrangements; got: ${q5}`);
  expect(/upstream clinical pipeline looks intact/i.test(q5), 'DOWNSTREAM body missing "upstream clinical pipeline" phrasing');
  expect(!/empty chair time/i.test(q5), 'EMPTIES branch leaked into DOWNSTREAM');
});

test('Q5 DOES NOT fire when BA in healthy band and Owner $/day above warn', async () => {
  /* BA target ≈ 5.5, Owner $/day ≈ $4,300 (> $3,500 warn), hasAssociate=false. */
  const prod = [
    'DATE RANGE: 01/01/2025 - 12/31/2025',
    /* hygVisits = 2500 (D1110 only); exam D0150 qty 272 → visitsCount = 2772 */
    'D1110|Prophy|2500|275000',
    'D0150|Comp Eval|272|27200',
    /* BA = 2772 / 504 = 5.5 */
    'D2740|Crown|504|806400',
  ].join('\n');
  const res = await handler(q5Fixture({ prodText: prod, hygieneData: null }));
  const data = JSON.parse(res.body).data;
  const ba = data.kpis.battingAverage;
  const ownerDaily = data.kpis.ownerDocDailyAvg;
  expect(ba > 5 && ba < 7, `fixture must drive BA into healthy band 5-7; got ${ba}`);
  expect(ownerDaily >= 3500, `fixture must drive Owner $/day >= $3,500; got ${ownerDaily}`);
  const q5 = data.swot.weaknesses.find(w => /Conversion Ratio/i.test(w) && /healthy range 4:1-7:1/i.test(w));
  expect(!q5, `Q5 should not fire when no alarm tripped; fired: ${q5}`);
});

test('Q6 STRONG: biteConsultApproach="during_hygiene" fires three-reason copy', async () => {
  const body = await invoke(null, { biteConsultApproach: 'during_hygiene' });
  const q6 = body.data.swot.weaknesses.find(w => /bite\/realign consults are fit into the hygiene appointment/i.test(w));
  expect(q6, 'Q6 STRONG weakness did not fire: ' + JSON.stringify(body.data.swot.weaknesses));
  expect(/three structural reasons/i.test(q6), 'Q6 STRONG body missing "three structural reasons"');
  expect(/10-15 minutes/.test(q6), 'Q6 STRONG body missing conversation-length reason');
  expect(/came in for a cleaning, not a treatment consult/i.test(q6), 'Q6 STRONG body missing expectation-mismatch reason');
  expect(/leading with a solution before a dedicated diagnosis/i.test(q6), 'Q6 STRONG body missing solution-before-diagnosis reason');
  /* SOFT variant must NOT fire simultaneously. */
  const q6Soft = body.data.swot.weaknesses.find(w => /practice doesn't currently do dedicated bite or realign consults/i.test(w));
  expect(!q6Soft, 'Q6 SOFT fired alongside STRONG — should be mutually exclusive');
});

test('Q6 SOFT: biteConsultApproach="none" fires the soft-variant copy', async () => {
  const body = await invoke(null, { biteConsultApproach: 'none' });
  const q6 = body.data.swot.weaknesses.find(w => /practice doesn't currently do dedicated bite or realign consults/i.test(w));
  expect(q6, 'Q6 SOFT weakness did not fire: ' + JSON.stringify(body.data.swot.weaknesses));
  expect(/production-pipeline gap that shows up in restorative, specialty, and cosmetic/i.test(q6), 'Q6 SOFT body missing restorative/specialty/cosmetic framing');
});

test('Q6: biteConsultApproach="dedicated" fires no BWV weakness', async () => {
  const body = await invoke(null, { biteConsultApproach: 'dedicated' });
  const q6Any = body.data.swot.weaknesses.find(w =>
    /bite\/realign consults are fit into the hygiene appointment/i.test(w) ||
    /practice doesn't currently do dedicated bite or realign consults/i.test(w)
  );
  expect(!q6Any, `Q6 should not fire when approach=dedicated; fired: ${q6Any}`);
});

test('Fix 4: Conversion Ratio card uses 2026-04-22 tier colors (3-7 good, 7-12 warn, >12 bad, ≤3 warn)', async () => {
  /* Craft four prodText variants to probe each tier. Each test asserts the
     Conversion Ratio card HTML carries the expected status class. */
  const cases = [
    { name: 'BA=2 (aggressive)',  ba: 2,  expected: 'warn',
      prod: 'DATE RANGE: 01/01/2025 - 12/31/2025\nD1110|P|200|22000\nD2740|C|100|140000' },
    { name: 'BA=5 (healthy)',     ba: 5,  expected: 'good',
      prod: 'DATE RANGE: 01/01/2025 - 12/31/2025\nD1110|P|500|55000\nD2740|C|100|140000' },
    { name: 'BA=10 (trending)',   ba: 10, expected: 'warn',
      prod: 'DATE RANGE: 01/01/2025 - 12/31/2025\nD1110|P|1000|110000\nD2740|C|100|140000' },
    { name: 'BA=15 (bad)',        ba: 15, expected: 'bad',
      prod: 'DATE RANGE: 01/01/2025 - 12/31/2025\nD1110|P|1500|165000\nD2740|C|100|140000' },
  ];
  for (const c of cases) {
    const res = await handler(q5Fixture({ prodText: c.prod, hygieneData: null }));
    const parsed = JSON.parse(res.body);
    const actualBa = parsed.data.kpis.battingAverage;
    expect(Math.abs(actualBa - c.ba) < 0.6, `${c.name}: expected BA~${c.ba}, got ${actualBa}`);
    const match = parsed.reportHtml.match(/<div class="score-card ([^"]*)">\s*<div class="lbl">Conversion Ratio/);
    expect(match, `${c.name}: Conversion Ratio card not rendered`);
    expect(match[1].trim().includes(c.expected), `${c.name}: expected status "${c.expected}", got "${match[1]}"`);
  }
});

/* ──────────────────────────────────────────────────────────────────────
   Overhead methodology batch (2026-04-22): four new overheadBreakdown
   questionnaire fields + five-branch Overhead SWOT (Staff / Supplies /
   Lab / Occupancy / Marketing floor), HIGH PRIORITY prepended.
   ────────────────────────────────────────────────────────────────────── */

/* Helper: craft an Overhead-SWOT fixture where we directly control the
   four sub-component percentages via annualCollections-targeted spend
   figures, plus the aggregate overhead % via a chosen total-expense
   figure. Staff % is driven by employeeCosts sizing. All setup/BWV
   answers are clean so only Overhead-related weaknesses surface. */
function overheadFixture({ overheadPct, suppliesPct, labPct, occupancyPct, marketingPct, staffPct, withStaffCosts }) {
  /* Fixed scale: annualCollections ≈ $1,000,000 for easy dollar math. */
  const ANNUAL_COLL = 1000000;
  const prod = [
    'DATE RANGE: 01/01/2025 - 12/31/2025',
    'D1110|Prophy|2400|240000','D1120|Child|400|32000',
    'D4910|Perio Maint|600|84000','D4341|SRP 4+|80|28000','D4342|SRP 1-3|20|5000',
    'D0150|Comp Eval|400|36000','D0120|Periodic|1000|40000',
    'D2740|Crown|200|280000',
    'D2750|Crown PM|50|70000',
    'D7140|Extraction|100|30000',
    'D3330|RCT|40|60000',
    'D8090|Ortho|10|60000',
  ].join('\n');
  const coll = `DATES| 01/01/2025 - 12/31/2025\nCHARGES|1050000\nPAYMENTS|${ANNUAL_COLL}`;
  const totalExpense = Math.round(ANNUAL_COLL * overheadPct / 100);
  /* 2026-04-23: P&L expense lines use generic labels that don't match the
     new Overhead Breakdown P&L-precedence regexes (/suppl/, /lab|laboratory/,
     /rent|utilit|occupan/, /advertis|marketing/) so these tests exercise
     the questionnaire-driven path deterministically. */
  const pl = [
    'DATES| 01/01/2025 - 12/31/2025',
    'SECTION|Income', `Sales|${ANNUAL_COLL}`, `TOTAL_INCOME|${ANNUAL_COLL}`,
    'SECTION|Expense',
    'Salaries & Wages|400000','Payroll Taxes|40000',
    'Miscellaneous Expense|130000',
    `Other Expenses|${Math.max(0, totalExpense - 570000)}`,
    `TOTAL_EXPENSE|${totalExpense}`,
    `NET_INCOME|${ANNUAL_COLL - totalExpense}`,
  ].join('\n');
  /* Build employeeCosts so (admin + hyg annual) / $1M ≈ staffPct exactly.
     50/50 split between admin and hyg. Zero benefits, 10% emp-cost uplift —
     pick rate such that rate × 160 × 12 × 1.10 = halfTarget. */
  const halfTarget = ANNUAL_COLL * staffPct / 100 / 2;
  const rateForHalf = Math.max(1, halfTarget / (160 * 12 * 1.10));
  const staff = {
    staff:   [{ rate: rateForHalf, hours: 160 }],
    hygiene: [{ rate: rateForHalf, hours: 160 }],
    staffBenefits: 0, staffEmpCostPct: 0.10,
    hygBenefits: 0, hygEmpCostPct: 0.10,
  };
  const dollarFor = pct => (pct == null ? null : Math.round(ANNUAL_COLL * pct / 100));
  const profile = {
    name: 'Overhead Probe', zipCode: '11111',
    doctorDays: 16, numHygienists: 4, hasAssociate: false,
    yearsOwned: 12, ownerAge: 48, opsActive: 5, opsTotal: 6,
    payorMix: { ppo: 60, hmo: 0, gov: 0, ffs: 40 },
    pmSoftware: 'dentrix',
    feesAttachedToScheduler: 'yes', insuranceFeeSchedulesCurrent: 'yes',
    writeOffCalculation: 'automatic', frequentManualAdjustments: 'no',
    hasPatientCollectionsSystem: 'yes', biteConsultApproach: 'dedicated',
    hasProductionGoal: 'yes', knowsIfAhead: 'yes',
    overheadBreakdown: {
      annualSuppliesSpend:  dollarFor(suppliesPct),
      annualLabSpend:       dollarFor(labPct),
      annualOccupancyCost:  dollarFor(occupancyPct),
      annualMarketingSpend: dollarFor(marketingPct),
    },
  };
  if (withStaffCosts) profile.staffCosts = withStaffCosts;
  return {
    httpMethod: 'POST',
    body: JSON.stringify({
      prodText: prod, collText: coll, plText: pl,
      practiceName: 'Overhead Probe',
      arPatient: { total: 40000, d90plus: 3000 }, arInsurance: { total: 55000, d90plus: 3000 },
      employeeCosts: staff, hygieneData: null, practiceProfile: profile,
    }),
  };
}

async function invokeOverhead(opts) {
  const res = await handler(overheadFixture(opts));
  if (res.statusCode !== 200) throw new Error('HTTP ' + res.statusCode + ': ' + res.body);
  return JSON.parse(res.body);
}

/* Match helper: find the Overhead weakness body (the one that opens with
   "Overhead is X.X%" or "Aggregate overhead %" framing). */
const findOverheadWeakness = (data) => data.swot.weaknesses.find(w =>
  /^Overhead is \d/i.test(w) || /^Aggregate overhead %/i.test(w)
);

test('Overhead SWOT: STAFF PRIMARY — overhead 70%, staff 28%, others at benchmark', async () => {
  const body = await invokeOverhead({
    overheadPct: 70, staffPct: 28,
    suppliesPct: 6, labPct: 6, occupancyPct: 6, marketingPct: 2,
  });
  const w = findOverheadWeakness(body.data);
  expect(w, 'Overhead SWOT did not fire: ' + JSON.stringify(body.data.swot.weaknesses));
  expect(/Overhead is \d+\.\d%/.test(w), 'aggregate framing missing');
  expect(/60% target \/ 65% warn \/ 70% bad band/.test(w), 'aggregate band phrasing missing');
  expect(/every percentage point of overhead represents \$/.test(w), 'aggregate per-point-of-overhead framing missing');
  expect(/primary contributor is staff cost/i.test(w), 'Staff branch not named as primary');
  expect(/20% benchmark/.test(w), 'Staff branch missing 20% benchmark reference');
  /* Subcomponents at benchmark → no secondary row. */
  expect(!/Secondary: /.test(w), 'Secondary line fired unexpectedly when others sit at benchmark');
});

test('Overhead SWOT: STAFF PRIMARY — role decomposition renders when staffCosts populated', async () => {
  const body = await invokeOverhead({
    overheadPct: 70, staffPct: 28,
    suppliesPct: 6, labPct: 6, occupancyPct: 6, marketingPct: 2,
    withStaffCosts: { frontOffice: 6, backOffice: 9, hygiene: 13 },
  });
  const w = findOverheadWeakness(body.data);
  expect(w, 'Overhead SWOT did not fire');
  expect(/decomposes to 6\.0% front office/.test(w), 'role decomposition sentence missing front %');
  expect(/9\.0% back office clinical/.test(w), 'role decomposition missing back office %');
  expect(/13\.0% hygiene/.test(w), 'role decomposition missing hygiene %');
  expect(/Hygiene sits highest/i.test(w), 'worst-role naming missing (expected "Hygiene sits highest")');
});

test('Overhead SWOT: SUPPLIES PRIMARY — overhead 66%, supplies 10%', async () => {
  const body = await invokeOverhead({
    overheadPct: 66, staffPct: 19,
    suppliesPct: 10, labPct: 6, occupancyPct: 6, marketingPct: 2,
  });
  const w = findOverheadWeakness(body.data);
  expect(w, 'Overhead SWOT did not fire');
  expect(/primary contributor is supplies at 10\.0%/.test(w), 'Supplies branch not named as primary');
  expect(/6% benchmark/.test(w), 'Supplies branch missing 6% benchmark reference');
  expect(!/primary contributor is staff cost/i.test(w), 'Staff branch appeared when it should not');
});

test('Overhead SWOT: LAB PRIMARY — overhead 66%, lab 9%', async () => {
  const body = await invokeOverhead({
    overheadPct: 66, staffPct: 19,
    suppliesPct: 6, labPct: 9, occupancyPct: 6, marketingPct: 2,
  });
  const w = findOverheadWeakness(body.data);
  expect(w, 'Overhead SWOT did not fire');
  expect(/primary contributor is lab cost at 9\.0%/.test(w), 'Lab branch not named as primary');
  expect(/6% benchmark/.test(w), 'Lab branch missing 6% benchmark reference');
});

test('Overhead SWOT: OCCUPANCY PRIMARY — includes "harder to move short-term" qualifier', async () => {
  const body = await invokeOverhead({
    overheadPct: 66, staffPct: 19,
    suppliesPct: 6, labPct: 6, occupancyPct: 9, marketingPct: 2,
  });
  const w = findOverheadWeakness(body.data);
  expect(w, 'Overhead SWOT did not fire');
  expect(/primary contributor is occupancy \(rent \+ utilities\) at 9\.0%/.test(w), 'Occupancy branch not named as primary');
  expect(/harder to move short-term/i.test(w), 'Occupancy branch missing "harder to move" qualifier');
});

test('Overhead SWOT: MARKETING FLOOR — overhead 64% (under warn), marketing 0.5%', async () => {
  const body = await invokeOverhead({
    overheadPct: 64, staffPct: 19,
    suppliesPct: 6, labPct: 6, occupancyPct: 6, marketingPct: 0.5,
  });
  const w = findOverheadWeakness(body.data);
  expect(w, 'Overhead SWOT did not fire on marketing floor alone');
  expect(/primary gap here is under-investment in marketing/i.test(w), 'Marketing branch framing missing');
  expect(/Marketing spend is 0\.5% of collections against a 2% benchmark/.test(w), 'Marketing branch missing actual vs 2% phrasing');
  expect(/marketing is a floor/i.test(w), 'Marketing branch missing "floor" explainer');
  expect(/stagnant new-patient numbers/i.test(w), 'Marketing branch missing new-patient consequence');
});

test('Overhead SWOT: TWO-CONTRIBUTOR case — staff primary, lab secondary (within 20%)', async () => {
  /* Dollar-gap math on $1M collections:
       staff 23% → gap (23-20)×$1M/100 = $30,000
       lab    9% → gap  (9- 6)×$1M/100 = $30,000
     Gaps tied at $30k → ratio 1.0 → secondary fires (threshold 0.80).
     Staff pushed before lab in the candidate list, so with equal gaps
     staff stays primary by stable sort. */
  const body = await invokeOverhead({
    overheadPct: 72, staffPct: 23,
    suppliesPct: 6, labPct: 9, occupancyPct: 6, marketingPct: 2,
  });
  const w = findOverheadWeakness(body.data);
  expect(w, 'Overhead SWOT did not fire');
  expect(/primary contributor is staff cost at 2\d\.\d%/.test(w), 'Staff should be named as primary when staff gap ≥ lab gap');
  expect(/Secondary: lab cost also runs outside its benchmark at 9\.0% vs 6\.0%/.test(w), 'Secondary lab line missing');
  expect(/another ~\$/.test(w), 'Secondary missing "another ~$" dollar framing');
});

test('Overhead SWOT: SUB-COMPONENT ALARM with clean aggregate — staff 22%, overhead 62%', async () => {
  const body = await invokeOverhead({
    overheadPct: 62, staffPct: 28,
    suppliesPct: 6, labPct: 6, occupancyPct: 6, marketingPct: 2,
  });
  const w = findOverheadWeakness(body.data);
  expect(w, 'Overhead SWOT did not fire on sub-component alarm alone');
  /* Aggregate 62% is under 65% warn, so aggregate alarm A did not trip —
     but alarm B (staff > 20%) did. Body should still include aggregate
     framing (because overheadPct is non-null) and name Staff as primary. */
  expect(/Overhead is 62\.0%/.test(w), 'aggregate framing should appear since overheadPct != null');
  expect(/primary contributor is staff cost/i.test(w), 'Staff should be named as primary');
});

test('Overhead SWOT: GRACEFUL DEGRADATION — overheadBreakdown null, staff 24%, overhead 68%', async () => {
  const body = await invokeOverhead({
    overheadPct: 68, staffPct: 28,
    suppliesPct: null, labPct: null, occupancyPct: null, marketingPct: null,
  });
  const w = findOverheadWeakness(body.data);
  expect(w, 'Overhead SWOT did not fire when only aggregate + staff alarms tripped');
  expect(/primary contributor is staff cost/i.test(w), 'Staff should be primary');
  /* No supplies/lab/occupancy/marketing text should appear — they were null. */
  expect(!/supplies at \d/.test(w), 'supplies should not appear when annualSuppliesSpend was null');
  expect(!/lab cost at \d/.test(w), 'lab should not appear when annualLabSpend was null');
  expect(!/occupancy \(rent \+ utilities\)/.test(w), 'occupancy should not appear when annualOccupancyCost was null');
  expect(!/under-investment in marketing/i.test(w), 'marketing should not appear when annualMarketingSpend was null');
});

test('Overhead SWOT: NO FIRE — overhead 58%, staff 19%, all sub-components at benchmark', async () => {
  const body = await invokeOverhead({
    overheadPct: 58, staffPct: 19,
    suppliesPct: 6, labPct: 6, occupancyPct: 6, marketingPct: 2,
  });
  const w = findOverheadWeakness(body.data);
  expect(!w, `Overhead SWOT should not fire when nothing exceeds benchmark; fired: ${w}`);
});

test('Overhead SWOT: graceful degradation — no aggregate data but sub-component alarm trips', async () => {
  /* Simulate a practice that uploaded no P&L (overheadPct=null) but filled
     in the Overhead Breakdown fields, with supplies > 6%. Aggregate
     framing should fall back to the "not available" copy. */
  const payload = overheadFixture({
    overheadPct: 0, staffPct: 19,
    suppliesPct: 10, labPct: 6, occupancyPct: 6, marketingPct: 2,
  });
  const body = JSON.parse(payload.body);
  /* Drop plText so overheadPct ends up null. */
  delete body.plText;
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(body) });
  const data = JSON.parse(res.body).data;
  const w = findOverheadWeakness(data);
  expect(w, 'Overhead SWOT did not fire with null aggregate + sub-component alarm');
  expect(/Aggregate overhead % is not available/i.test(w), 'Alt aggregate framing missing');
  expect(/primary contributor is supplies at 10\.0%/.test(w), 'Supplies branch should still render under null aggregate');
});

/* ──────────────────────────────────────────────────────────────────────
   Hygiene Department Ratio SWOT (2026-04-22): 3:1 production-to-labor
   benchmark with two-paths diagnostic copy. Fires when hygiene produces
   < $3 for every $1 of hygienist wages. Graceful degradation when
   either side is zero/null.
   ────────────────────────────────────────────────────────────────────── */

/* Helper — build a fixture with the two controlled values:
     targetHygWagesAnnual: exact annual hygienist cost (admin staff kept tiny)
     targetHygProdAnnual:  hygiene production (as D1110 dollars)
   A doctor production block is added to keep collections / ratios clean so
   no unrelated weaknesses interfere. Null values yield zero-cost or
   zero-production fixtures for the graceful-degradation paths. */
function hygRatioFixture({ targetHygWagesAnnual, targetHygProdAnnual }) {
  /* Wages = rate × 160 hrs/mo × 12 mo × 1.10 (10% emp-cost uplift, no benefits).
     rate = wages / 2112. Zero wages → zero-hour shell so we don't touch
     staffRoleAnnualCost edge paths. */
  const mkHyg = (annualTarget) => {
    if (!annualTarget || annualTarget <= 0) return [];
    const rate = Math.max(1, annualTarget / 2112);
    return [{ rate, hours: 160 }];
  };
  const hygProd = Math.round(Number(targetHygProdAnnual) || 0);
  /* Always include enough doctor production that hygiene % stays healthy
     and collection rate lands near 96% — keeps unrelated weaknesses quiet. */
  const docProd = 600000;
  const prodLines = ['DATE RANGE: 01/01/2025 - 12/31/2025'];
  if (hygProd > 0) prodLines.push(`D1110|Prophy|2400|${hygProd}`);
  prodLines.push(`D2740|Crown|400|${docProd}`);
  const totalProd = hygProd + docProd;
  const collPayments = Math.round(totalProd * 0.96);
  const collText_ = `DATES| 01/01/2025 - 12/31/2025\nCHARGES|${Math.round(totalProd * 1.02)}\nPAYMENTS|${collPayments}`;
  return {
    httpMethod: 'POST',
    body: JSON.stringify({
      prodText: prodLines.join('\n'),
      collText: collText_,
      plText: PL_STANDARD,
      practiceName: 'HygRatio Probe',
      arPatient: { total: 35000, d90plus: 3000 },
      arInsurance: { total: 50000, d90plus: 3000 },
      employeeCosts: {
        staff: [{ rate: 15, hours: 160 }],     /* minimal admin — keeps total staff low */
        hygiene: mkHyg(targetHygWagesAnnual),
        staffBenefits: 0, staffEmpCostPct: 0.10,
        hygBenefits: 0, hygEmpCostPct: 0.10,
      },
      hygieneData: null,
      practiceProfile: {
        name: 'HygRatio', zipCode: '1',
        doctorDays: 16, numHygienists: 2, hasAssociate: false,
        yearsOwned: 12, ownerAge: 48, opsActive: 5, opsTotal: 6,
        payorMix: { ppo: 60, hmo: 0, gov: 0, ffs: 40 },
        pmSoftware: 'dentrix',
        feesAttachedToScheduler: 'yes', insuranceFeeSchedulesCurrent: 'yes',
        writeOffCalculation: 'automatic', frequentManualAdjustments: 'no',
        hasPatientCollectionsSystem: 'yes', biteConsultApproach: 'dedicated',
        hasProductionGoal: 'yes', knowsIfAhead: 'yes',
      },
    }),
  };
}

const findHygRatioWeakness = (data) => data.swot.weaknesses.find(w =>
  /hygiene department produces \$[\d.]+ for every \$1 of hygiene labor cost/i.test(w)
);

test('Hygiene Dept Ratio SWOT: FIRES at ratio 2.2 (wages $100k, prod $220k)', async () => {
  const res = await handler(hygRatioFixture({ targetHygWagesAnnual: 100000, targetHygProdAnnual: 220000 }));
  const data = JSON.parse(res.body).data;
  /* Allow a small rate-rounding tolerance on the derived wages. */
  const cost = data.kpis.annualHygienistCost;
  const prod = data.kpis.annualHygieneProduction;
  expect(Math.abs(cost - 100000) < 200, `annualHygienistCost should be ~$100k; got $${cost}`);
  expect(Math.abs(prod - 220000) < 1,   `annualHygieneProduction should be $220k; got $${prod}`);
  const w = findHygRatioWeakness(data);
  expect(w, 'Hygiene Dept Ratio SWOT did not fire: ' + JSON.stringify(data.swot.weaknesses));
  expect(/\$2\.20 for every \$1/.test(w), `body should cite $2.20 ratio; got: ${w}`);
  expect(/3:1 benchmark/.test(w), 'body missing 3:1 benchmark reference');
  expect(/\$300,000/.test(w), 'body should cite production-to-hit-bench $300,000');
  expect(/\$80,000/.test(w), 'body should cite production gap $80,000');
  expect(/two structural paths to close that gap/i.test(w), 'body missing two-structural-paths phrase');
  expect(/Arestin and laser perio/.test(w), 'body missing adjunctive-therapies mention');
  expect(/align hygiene compensation to production/i.test(w), 'body missing compensation-alignment path');
  expect(/don't tell you which path fits this practice/.test(w), 'body missing closing framing');
  /* Legacy labor-as-% phrasing must be gone — no double-fire narrative. */
  const legacy = data.swot.weaknesses.find(x => /Hygienist productivity below benchmark — wages are /.test(x));
  expect(!legacy, `Legacy hygienist>38 weakness still firing: "${legacy}"`);
});

test('Hygiene Dept Ratio SWOT: AT THRESHOLD — ratio exactly 3.0 does NOT fire', async () => {
  /* 2026-04-29: bumped targetHygProdAnnual to 300100 to avoid an IEEE-754
     edge where 300000 / (rate × 1920 × 1.10) lands a hair *below* 3.0 and
     trips the strict `< 3` rule. The methodology rule is unchanged — at
     the threshold, the SWOT must not fire — but the test fixture needs a
     small margin to be FP-stable across loading-factor source paths. */
  const res = await handler(hygRatioFixture({ targetHygWagesAnnual: 100000, targetHygProdAnnual: 300100 }));
  const data = JSON.parse(res.body).data;
  const w = findHygRatioWeakness(data);
  expect(!w, `Hygiene Dept Ratio SWOT should not fire at ratio=3.0 (strict < threshold); fired: ${w}`);
});

test('Hygiene Dept Ratio SWOT: HEALTHY — ratio 3.5 does NOT fire', async () => {
  const res = await handler(hygRatioFixture({ targetHygWagesAnnual: 100000, targetHygProdAnnual: 350000 }));
  const data = JSON.parse(res.body).data;
  const w = findHygRatioWeakness(data);
  expect(!w, `Hygiene Dept Ratio SWOT should not fire at ratio=3.5; fired: ${w}`);
});

test('Hygiene Dept Ratio SWOT: GRACEFUL DEGRADATION — zero hygienist cost → no fire', async () => {
  const res = await handler(hygRatioFixture({ targetHygWagesAnnual: 0, targetHygProdAnnual: 220000 }));
  expect(res.statusCode === 200, 'handler errored on zero hygienist cost: ' + res.body);
  const data = JSON.parse(res.body).data;
  const w = findHygRatioWeakness(data);
  expect(!w, `SWOT should not fire when annualHygienistCost is zero; fired: ${w}`);
});

test('Hygiene Dept Ratio SWOT: GRACEFUL DEGRADATION — zero hygiene production → no fire', async () => {
  const res = await handler(hygRatioFixture({ targetHygWagesAnnual: 100000, targetHygProdAnnual: 0 }));
  expect(res.statusCode === 200, 'handler errored on zero hygiene production: ' + res.body);
  const data = JSON.parse(res.body).data;
  const w = findHygRatioWeakness(data);
  expect(!w, `SWOT should not fire when annualHygieneProduction is zero; fired: ${w}`);
});

/* ──────────────────────────────────────────────────────────────────────
   Parser bug-fix batch (2026-04-23): Insurance AR column offset,
   P&L silent parse failure, Collections payment breakdown, Active
   patients unblock. Ground-truth shapes come from the fresh Pigneri
   Dentrix output Dave captured on 2026-04-22.
   ────────────────────────────────────────────────────────────────────── */

/* Bug 1 — Insurance AR client-side parser regression.
   The parser lives in assessment_hub.html as `extractARFromPdf`. Here we
   re-extract its numeric-bucket logic inline and drive it against a
   synthetic text flow that matches Dentrix's 6-column layout:
     ESTIMATE | CURRENT | 31-60 | 61-90 | OVER 90 | TOTAL

   This is structured as a unit test against the parser's shape-detection
   rule rather than a whole-PDF round-trip, because pdf.js doesn't run in
   Node. The equivalent shape-rule is captured in `parseInsuranceARNums`
   below — kept identical to the production parser so any drift surfaces. */
function parseInsuranceARNums(allNumsRaw) {
  /* Mirror the live parser's filter — tolerant to legitimate $0 aging
     buckets (over-90 can be exactly zero), but still drops page-number
     noise (bare 1-2 digit integers with no comma/decimal). */
  const allNums = (allNumsRaw || []).filter((s) => {
    const n = parseFloat(String(s).replace(/,/g, ''));
    if (isNaN(n)) return false;
    if (/[,.]/.test(String(s))) return true;
    return n >= 100 || n === 0;
  });
  const parseF = (s) => parseFloat(String(s).replace(/,/g, ''));
  if (allNums.length >= 6) {
    return {
      estimate: parseF(allNums[0]),
      current:  parseF(allNums[1]),
      d3160:    parseF(allNums[2]),
      d6190:    parseF(allNums[3]),
      d90plus:  parseF(allNums[4]),
      total:    parseF(allNums[5]),
    };
  } else if (allNums.length >= 5) {
    return {
      current: parseF(allNums[0]), d3160: parseF(allNums[1]),
      d6190:   parseF(allNums[2]), d90plus: parseF(allNums[3]),
      total:   parseF(allNums[4]),
    };
  } else if (allNums.length >= 4) {
    const c = parseF(allNums[0]), a1 = parseF(allNums[1]);
    const a2 = parseF(allNums[2]), a3 = parseF(allNums[3]);
    return { current: c, d3160: a1, d6190: a2, d90plus: a3, total: c + a1 + a2 + a3 };
  }
  return null;
}

test('Bug 1: Insurance AR 6-column layout skips ESTIMATE', async () => {
  /* Dentrix Insurance Claim Aging Report ALL CLAIMS row (2026-04-22 Pigneri): */
  const nums = ['15,444.05', '49,172', '15,238', '18,802', '0', '83,212'];
  const parsed = parseInsuranceARNums(nums);
  expect(parsed, 'parseInsuranceARNums returned null on 6-num layout');
  expect(parsed.estimate === 15444.05, `estimate should be $15,444.05; got ${parsed.estimate}`);
  expect(parsed.current  === 49172,    `current should be $49,172; got ${parsed.current} (was previously the ESTIMATE column)`);
  expect(parsed.d3160    === 15238,    `31-60 should be $15,238; got ${parsed.d3160}`);
  expect(parsed.d6190    === 18802,    `61-90 should be $18,802; got ${parsed.d6190}`);
  expect(parsed.d90plus  === 0,        `over 90 should be $0; got ${parsed.d90plus}`);
  expect(parsed.total    === 83212,    `total should be $83,212; got ${parsed.total}`);
  /* Regression guard: pre-fix behavior would have produced current=$15,444, d90plus=$18,802, total=sum=$98,656. */
  expect(parsed.total !== 98656, 'Insurance AR total should NOT be sum of estimate+current+31-60+61-90 (old bug signature)');
});

test('Bug 1: Insurance AR 5-column layout (no estimate) parses straight through', async () => {
  const nums = ['49,172', '15,238', '18,802', '0', '83,212'];
  const parsed = parseInsuranceARNums(nums);
  expect(parsed.current === 49172 && parsed.total === 83212, 'five-number layout should map positionally');
});

test('Bug 1: Insurance AR 4-column layout (no estimate, no total) synthesizes total from sum', async () => {
  const nums = ['49,172', '15,238', '18,802', '200'];
  const parsed = parseInsuranceARNums(nums);
  expect(parsed.total === 49172 + 15238 + 18802 + 200, 'four-num layout should synthesize total from aging buckets');
});

/* Bug 2 — P&L silent parse failure. Every variant Claude might emit against
   the JD Troy 2024 QuickBooks P&L should produce non-null totals. */
const { parseProduction: pp, parseCollections: pc, parsePL: pl, parsePatientSummary: pps } = require(require('path').resolve(__dirname, '..', 'netlify', 'functions', 'generate-report.js'));

test('Bug 2: P&L parser accepts TOTAL_INCOME at the TOP (post-2026-04-23 prompt)', () => {
  const txt = [
    'TOTAL_INCOME|2124318.47',
    'TOTAL_EXPENSE|2207517.73',
    'NET_INCOME|-92796.84',
    'SECTION|Income',
    'Patient Income|1800000',
    'Insurance Income|324318.47',
    'SECTION|Expense',
    'Salaries & Wages|889164.04',
    'Lab Fees|75509.00',
    'Dental Supplies|171167.66',
  ].join('\n');
  const r = pl(txt);
  expect(Math.abs(r.totalIncome  - 2124318.47) < 0.01, 'totalIncome missed');
  expect(Math.abs(r.totalExpense - 2207517.73) < 0.01, 'totalExpense missed');
  expect(Math.abs(r.netIncome    - -92796.84)  < 0.01, 'netIncome missed (negative)');
});

test('Bug 2: P&L parser tolerates markdown-bold wrapping around totals', () => {
  const txt = [
    '**TOTAL_INCOME**|2124318.47',
    '**TOTAL_EXPENSE**|2207517.73',
    '**NET_INCOME**|-92796.84',
  ].join('\n');
  const r = pl(txt);
  expect(Math.abs(r.totalIncome  - 2124318.47) < 0.01, 'totalIncome should survive markdown wrapping');
  expect(Math.abs(r.totalExpense - 2207517.73) < 0.01, 'totalExpense should survive markdown wrapping');
});

test('Bug 2: P&L parser tolerates "Total for Expenses" QuickBooks label', () => {
  const txt = [
    'Total for Income|2124318.47',
    'Total for Expenses|2207517.73',
    'Net Income|-92796.84',
  ].join('\n');
  const r = pl(txt);
  expect(Math.abs(r.totalIncome  - 2124318.47) < 0.01, 'Total for Income missed');
  expect(Math.abs(r.totalExpense - 2207517.73) < 0.01, 'Total for Expenses missed');
});

test('Bug 2: P&L parser tolerates $ and ( ) formatting from QuickBooks', () => {
  const txt = [
    'TOTAL_INCOME|$2,124,318.47',
    'TOTAL_EXPENSE|$2,207,517.73',
    'NET_INCOME|($92,796.84)',
  ].join('\n');
  const r = pl(txt);
  expect(Math.abs(r.totalIncome  - 2124318.47) < 0.01, '$ + commas should parse');
  expect(Math.abs(r.totalExpense - 2207517.73) < 0.01, '$ + commas should parse');
  expect(Math.abs(r.netIncome    - -92796.84)  < 0.01, '( ) negative should parse as negative');
});

test('Bug 2: P&L parser synthesizes totals from items when TOTAL_ lines are missing (truncation)', () => {
  /* Simulate the truncated-mid-output case: only line items, no explicit totals. */
  const txt = [
    'SECTION|Income',
    'Patient Income|1000000',
    'Insurance Income|800000',
    'SECTION|Expense',
    'Salaries & Wages|500000',
    'Lab Fees|70000',
  ].join('\n');
  const r = pl(txt);
  expect(Math.abs(r.totalIncome  - 1800000) < 0.01, `totalIncome should be synthesized from income items; got ${r.totalIncome}`);
  expect(Math.abs(r.totalExpense - 570000)  < 0.01, `totalExpense should be synthesized from expense items; got ${r.totalExpense}`);
});

/* Bug 3 — Collections payment breakdown via REVENUE_* lines. Parser should
   now expose prodData.revenueBreakdown; end-to-end verification that the
   Revenue Mix card populates from Dentrix when the breakdown is present. */
test('Bug 3: parseProduction captures REVENUE_* lines as revenueBreakdown', () => {
  const txt = [
    'DATES|01/01/2024 - 12/31/2024',
    'D1110|Prophy|938|117415.00',
    'REVENUE_INSURANCE|879888.70',
    'REVENUE_PATIENT|1971579.00',
    'REVENUE_3RDPARTY|306858.70',
    'REVENUE_GOVERNMENT|0',
  ].join('\n');
  const p = pp(txt);
  expect(p.codes.length === 1, 'should still parse the code row');
  expect(p.revenueBreakdown, 'revenueBreakdown should be non-null');
  expect(p.revenueBreakdown.insurance       === 879888.70, 'insurance bucket wrong');
  expect(p.revenueBreakdown.patient         === 1971579,   'patient bucket wrong');
  expect(p.revenueBreakdown.thirdPartyFinance === 306858.70, '3rd-party bucket wrong');
  expect(p.revenueBreakdown.government      === 0,         'government bucket wrong');
});

test('Bug 3: revenueBreakdown is null when no REVENUE_* lines are present (backward compat)', () => {
  const txt = 'DATES|01/01/2024 - 12/31/2024\nD1110|Prophy|938|117415.00';
  expect(pp(txt).revenueBreakdown == null, 'absence of REVENUE_* should leave revenueBreakdown null');
});

test('Bug 3: sourcesOfDollars prefers Dentrix REVENUE_* breakdown over P&L items', async () => {
  const prodText = [
    'DATE RANGE: 01/01/2024 - 12/31/2024',
    'D1110|Prophy|2400|240000',
    'D2740|Crown|200|280000',
    'REVENUE_INSURANCE|879888.70',
    'REVENUE_PATIENT|1971579.00',
    'REVENUE_3RDPARTY|306858.70',
    'REVENUE_GOVERNMENT|0',
  ].join('\n');
  const res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify(Object.assign(JSON.parse(buildEvent().body), { prodText })),
  });
  const data = JSON.parse(res.body).data;
  const sod = data.financials.sourcesOfDollars;
  expect(sod.source === 'dentrix', `sourcesOfDollars.source should be 'dentrix'; got '${sod.source}'`);
  expect(sod.dollars.insurance       === 879888.70, 'insurance dollars mismatch');
  expect(sod.dollars.patientCreditCard === 1971579, 'patient bucket should have the Dentrix-patient dollar figure');
  expect(sod.dollars.thirdPartyFinance === 306858.70, '3rd-party mismatch');
  expect(sod.dollars.government        === 0, 'government mismatch');
  /* Percent math: total = 879888.70 + 1971579 + 306858.70 + 0 = 3,158,326.40.
     Insurance ~27.9%; Patient ~62.4%; 3rd-party ~9.7%; government 0. */
  expect(Math.abs(sod.percent.insurance - 27.86) < 0.2, `insurance % should be ~27.86; got ${sod.percent.insurance}`);
  expect(Math.abs(sod.percent.thirdPartyFinance - 9.72) < 0.2, `3rd-party % should be ~9.72; got ${sod.percent.thirdPartyFinance}`);
});

test('Bug 3: sourcesOfDollars falls back to P&L when REVENUE_* lines are absent', async () => {
  const body = await invoke();  /* uses default PL_STANDARD, no REVENUE_* in prodText */
  const sod = body.data.financials.sourcesOfDollars;
  expect(sod.source === 'pl', `sourcesOfDollars.source should fall back to 'pl' when Dentrix breakdown missing; got '${sod.source}'`);
});

/* Bug 4 — Active patient count prompt + wire-through. */
test('Bug 4: parsePatientSummary extracts active patient counts', () => {
  const txt = [
    'ACTIVE_PATIENTS|2667',
    'INSURED_PATIENTS|1670',
    'FAMILIES|5927',
    'NEW_PATIENTS_YTD|1581',
    'NEW_PATIENTS_MONTH|29',
    'REFERRALS_YTD|773',
  ].join('\n');
  const r = pps(txt);
  expect(r.activePatients   === 2667, 'active patients');
  expect(r.insuredPatients  === 1670, 'insured patients');
  expect(r.families         === 5927, 'families');
  expect(r.newPatientsYTD   === 1581, 'new YTD');
  expect(r.newPatientsMonth === 29,   'new month');
  expect(r.referralsYTD     === 773,  'referrals');
});

test('Bug 4: patientSummary surfaces on practice when patientSummaryText is posted', async () => {
  const evt = JSON.parse(buildEvent().body);
  evt.patientSummaryText = 'ACTIVE_PATIENTS|2667\nNEW_PATIENTS_YTD|1581';
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  expect(data.practice.patientSummary, 'practice.patientSummary should be populated when patientSummaryText posted');
  expect(data.practice.patientSummary.activePatients === 2667, 'activePatients surface mismatch');
});

test('Bug 4: practice.patientSummary is null when patientSummaryText is absent (backward compat)', async () => {
  const body = await invoke();
  expect(body.data.practice.patientSummary == null, 'patientSummary should be null when not posted');
});

/* Fix 5 — summary signals for Hub badge rendering. */
test('Fix 5: summary exposes productionParsed / collectionsParsed / plParsed flags', async () => {
  const body = await invoke();
  const s = body.summary;
  expect(s.productionParsed === true,  'productionParsed should be true on good fixture');
  expect(s.collectionsParsed === true, 'collectionsParsed should be true on good fixture');
  expect(s.plParsed === true,          'plParsed should be true on good fixture');
  expect(typeof s.arPatientParsed === 'boolean',   'arPatientParsed should be boolean');
  expect(typeof s.arInsuranceParsed === 'boolean', 'arInsuranceParsed should be boolean');
});

/* ──────────────────────────────────────────────────────────────────────
   Bundled batch (2026-04-23): Crown Unit Value, Hygiene Capacity
   Analysis, Q5 dollar-opportunity wiring, Patient Summary upload step,
   Overhead Breakdown P&L precedence.
   ────────────────────────────────────────────────────────────────────── */

/* Helper: Hygiene Capacity fixture. Target a specific utilization band
   by sizing hygiene-day count against procedure-driven days-required. */
function hygCapFixture({ prophyAnnual, perioMaintAnnual, srpAnnual, numHygienists, patsPerHygDay, activePatients }) {
  /* Build 12-month prodText with those visit counts. */
  const lines = ['DATE RANGE: 01/01/2025 - 12/31/2025'];
  if (prophyAnnual)     lines.push(`D1110|Prophy|${prophyAnnual}|${prophyAnnual * 120}`);
  if (perioMaintAnnual) lines.push(`D4910|Perio Maint|${perioMaintAnnual}|${perioMaintAnnual * 140}`);
  if (srpAnnual)        lines.push(`D4341|SRP 4+|${srpAnnual}|${srpAnnual * 350}`);
  /* A minimal crown block so batting average + CUV have a denominator. */
  lines.push('D2740|Crown|200|300000');
  const body = Object.assign(JSON.parse(buildEvent().body), {
    prodText: lines.join('\n'),
    patientSummaryText: activePatients != null
      ? `ACTIVE_PATIENTS|${activePatients}\nNEW_PATIENTS_YTD|200`
      : null,
  });
  body.practiceProfile = Object.assign({}, body.practiceProfile, {
    numHygienists: numHygienists != null ? numHygienists : 4,
    patientsPerHygienistPerDay: patsPerHygDay || 8,
  });
  return { httpMethod: 'POST', body: JSON.stringify(body) };
}

test('Fix 2: Crown Unit Value computes correctly', async () => {
  /* totalProd = $1M, hygProd = $300k (D1110 × $60 × 5000 visits via counts),
     specialtyProd = $100k, crowns = 200 → CUV = ($1M − $300k − $100k) / 200 = $3,000.
     Easiest synthetic: craft prodText with known totals. */
  const prodText = [
    'DATE RANGE: 01/01/2025 - 12/31/2025',
    /* Hygiene bucket: $300,000 */
    'D1110|Prophy|2500|300000',
    /* Specialty bucket (endo + perio surgery + oral surgery + ortho) — $100,000 */
    'D3330|Molar RCT|40|60000',
    'D7140|Extraction|80|24000',
    'D8090|Ortho|4|16000',
    /* Crowns: 200 units, $600,000 */
    'D2740|Crown|200|600000',
  ].join('\n');
  /* totalProd = 300k + 60k + 24k + 16k + 600k = $1,000,000 ✓
     specialty = 60k + 24k + 16k = $100,000 ✓
     crowns = 200; hygiene = $300k
     → CUV = (1,000,000 − 300,000 − 100,000) / 200 = $3,000 */
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(Object.assign(JSON.parse(buildEvent().body), { prodText })) });
  const data = JSON.parse(res.body).data;
  expect(Math.abs(data.kpis.crownUnitValue - 3000) < 1, `CUV should be $3,000; got $${data.kpis.crownUnitValue}`);
});

test('Fix 2: CUV card renders with neutral (empty) status', async () => {
  const body = await invoke();
  const html = body.reportHtml;
  const m = html.match(/<div class="score-card ([^"]*)">\s*<div class="lbl">Crown Unit Value/);
  expect(m, 'Crown Unit Value card not rendered');
  expect(!/\b(good|warn|bad)\b/.test(m[1]), `CUV card should have no status class; got: "${m[1]}"`);
  expect(/GP production per crown prepped/i.test(html), 'CUV bench subtitle missing');
});

test('Fix 3: Hygiene Capacity UNDER-UTILIZED fires at 64% utilization', async () => {
  /* Pigneri-ish: prophy 2500 + perio maint 200 + SRP 50 = 2750 visits over 12 months.
     Scale to 24mo: × 2 = 5500. daysReq/mo = 5500 / 24 / 8 = 28.65 — too many.
     Scale down: prophy 1500 → 1500 × 2 / 24 / 8 = 15.6 days/mo required.
     numHygienists=6 → daysSch = 6 × 4.33 = 25.98 → util ≈ 60% → UNDER-UTILIZED. */
  const res = await handler(hygCapFixture({ prophyAnnual: 1500, perioMaintAnnual: 0, srpAnnual: 0, numHygienists: 6, patsPerHygDay: 8 }));
  const data = JSON.parse(res.body).data;
  const u = data.kpis.hygieneCapacity.utilizationPct;
  expect(u != null && u < 70, `fixture should drive util < 70; got ${u}`);
  const w = data.swot.weaknesses.find(x => /hygiene department is running at \d+% utilization/i.test(x));
  expect(w, 'UNDER-UTILIZED weakness did not fire: ' + JSON.stringify(data.swot.weaknesses));
  expect(/below the 70-90% healthy band/i.test(w), 'UNDER-UTILIZED body missing 70-90 band phrase');
  expect(/left on the table/i.test(w), 'UNDER-UTILIZED body missing "left on the table" phrase');
});

test('Fix 3: Hygiene Capacity CAPACITY-CONSTRAINED fires above 90% utilization', async () => {
  /* 2300 prophy + 200 perio maint + 50 srp = 2550 visits × 2 = 5100 over 24mo.
     daysReq = 5100/24/8 = 26.56; numHygienists 6 → 25.98 scheduled; util ≈ 102% — over 90. */
  const res = await handler(hygCapFixture({ prophyAnnual: 2300, perioMaintAnnual: 200, srpAnnual: 50, numHygienists: 6, patsPerHygDay: 8, activePatients: 2400 }));
  const data = JSON.parse(res.body).data;
  const u = data.kpis.hygieneCapacity.utilizationPct;
  expect(u != null && u > 90, `fixture should drive util > 90; got ${u}`);
  const w = data.swot.weaknesses.find(x => /above the 90% comfort ceiling/i.test(x));
  expect(w, 'CAPACITY-CONSTRAINED weakness did not fire');
  expect(/aren't being served at recall cadence/i.test(w), 'body missing recall-cadence phrasing');
});

test('Fix 3: Hygiene Capacity HEALTHY (80%) does NOT fire', async () => {
  /* Target ~80% util — daysReq ~20.8, daysSch ~25.98 with 6 RDHs. */
  const res = await handler(hygCapFixture({ prophyAnnual: 1900, perioMaintAnnual: 100, srpAnnual: 50, numHygienists: 6, patsPerHygDay: 8, activePatients: 1850 }));
  const data = JSON.parse(res.body).data;
  const u = data.kpis.hygieneCapacity.utilizationPct;
  expect(u != null && u >= 70 && u <= 90, `fixture should drive 70 ≤ util ≤ 90; got ${u}`);
  const w = data.swot.weaknesses.find(x => /running at \d+% utilization/i.test(x));
  expect(!w, `No UNDER or CAPACITY weakness should fire in healthy band; got: "${w}"`);
});

/* Retention SWOT removed 2026-04-24 — Day Sheet methodology pivot. The
   software-reported active patient count (Patient Summary upload) is
   unreliable per Danika; the comparison-against-software branches no
   longer fire regardless of fixture state. The two regression-guard
   tests below replace the old "fires when delta > 40%" / "fires when
   delta < 15%" assertions. */
test('Fix 5: Retention WEAKNESS does NOT fire (Day Sheet methodology pivot 2026-04-24)', async () => {
  /* Same fixture that used to drive retentionDeltaPct > 40 and fire the
     RETENTION-WEAKNESS branch. Branch is now permanently disabled. */
  const res = await handler(hygCapFixture({ prophyAnnual: 2400, perioMaintAnnual: 0, srpAnnual: 0, numHygienists: 6, patsPerHygDay: 8, activePatients: 2800 }));
  const data = JSON.parse(res.body).data;
  const w = data.swot.weaknesses.find(x => /represents patients the system considers active who haven't been in/i.test(x));
  expect(!w, `Retention weakness should no longer fire; got: "${w}"`);
});

test('Fix 5: Retention STRENGTH does NOT fire (Day Sheet methodology pivot 2026-04-24)', async () => {
  const res = await handler(hygCapFixture({ prophyAnnual: 3840, perioMaintAnnual: 0, srpAnnual: 0, numHygienists: 6, patsPerHygDay: 8, activePatients: 2667 }));
  const data = JSON.parse(res.body).data;
  const s = data.swot.strengths.find(x => /patient retention is strong/i.test(x));
  expect(!s, `Retention strength should no longer fire; got: "${s}"`);
});

test('Fix 3: Graceful degradation — patientSummary null skips retention branches', async () => {
  const res = await handler(hygCapFixture({ prophyAnnual: 2400, perioMaintAnnual: 0, srpAnnual: 0, numHygienists: 6, patsPerHygDay: 8, activePatients: null }));
  const data = JSON.parse(res.body).data;
  const retention = data.swot.weaknesses.find(x => /haven't been in for a recall visit/i.test(x));
  const retStrength = data.swot.strengths.find(x => /patient retention is strong/i.test(x));
  expect(!retention && !retStrength, 'retention branches should skip when software-derived count is null');
});

test('Fix 4: Q5 EMPTIES branch appends CUV-based dollar math', async () => {
  /* Same fixture as the Q5 EMPTIES test (BA 10, fill 78) but CUV-derivable from
     prodText. When CUV is computable and fill < 95, the dollar clause should
     appear in the body. */
  const prodText = [
    'DATE RANGE: 01/01/2025 - 12/31/2025',
    'D1110|Prophy|500|55000','D1120|CP|200|16000',
    'D4910|PM|200|28000','D4341|SRP4|50|17500','D4342|SRP1|50|12500',
    'D0150|CE|200|20000','D0120|P|600|36000',
    'D2740|Crown|120|600000',  /* 120 crowns × $5k avg → big CUV */
  ].join('\n');
  const evt = JSON.parse(buildEvent().body);
  evt.prodText = prodText;
  evt.hygieneData = { recentFillRate: 78, nearFuturePreBooking: 95 };
  evt.practiceProfile = Object.assign({}, evt.practiceProfile, {
    feesAttachedToScheduler: 'yes', insuranceFeeSchedulesCurrent: 'yes',
    writeOffCalculation: 'automatic', frequentManualAdjustments: 'no',
    hasPatientCollectionsSystem: 'yes', biteConsultApproach: 'dedicated',
    hasProductionGoal: 'yes', knowsIfAhead: 'yes',
  });
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  const q5 = data.swot.weaknesses.find(w => /Conversion Ratio/i.test(w) && /empty chair time/i.test(w));
  expect(q5, 'Q5 EMPTIES did not fire');
  expect(/Recovering fill rate from \d+% to the 95% healthy floor/i.test(q5), 'EMPTIES body missing CUV-based dollar-math clause');
  expect(/Crown Unit Value of \$/i.test(q5), 'EMPTIES body should reference Crown Unit Value');
  expect(/additional general-dentistry production/i.test(q5), 'EMPTIES body missing GP opportunity framing');
  expect(/direct hygiene production/i.test(q5), 'EMPTIES body missing direct hygiene opp');
});

test('Fix 5: Overhead Breakdown supplies uses P&L when line item present (questionnaire ignored)', async () => {
  const evt = JSON.parse(buildEvent().body);
  /* Questionnaire value says $50k (~5.4%) but P&L has "Dental Supplies|90000" → 9.8% */
  evt.practiceProfile = Object.assign({}, evt.practiceProfile, {
    overheadBreakdown: {
      annualSuppliesSpend: 50000, annualLabSpend: null,
      annualOccupancyCost: null, annualMarketingSpend: null,
    },
  });
  /* Inject a supplies line in the P&L. */
  evt.plText = PL_STANDARD.replace('Dental Supplies|45000', 'Dental Supplies|90000');
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  const src = data.kpis.overheadBreakdownSource || {};
  expect(src.supplies === 'pl', `source should be 'pl' when P&L line item present; got '${src.supplies}'`);
  /* suppliesPct uses P&L supplies — the /suppl/ regex picks up both
     Dental Supplies ($90k) and Office Supplies ($12k) → $102k / $920k ≈ 11.1%.
     Either way, the number should be > 9 (well above the questionnaire's $50k
     mapping, which would yield ~5.4%). */
  const sp = data.kpis.overheadSuppliesPct;
  expect(sp != null && sp > 9, `suppliesPct should reflect P&L supplies (well above the questionnaire $50k); got ${sp}`);
});

test('Fix 5: Overhead Breakdown falls back to questionnaire when P&L has no matching line', async () => {
  const evt = JSON.parse(buildEvent().body);
  evt.practiceProfile = Object.assign({}, evt.practiceProfile, {
    overheadBreakdown: {
      annualSuppliesSpend: null, annualLabSpend: null,
      annualOccupancyCost: null, annualMarketingSpend: 23000,  /* ~2.5% */
    },
  });
  /* Strip marketing/advertising lines from the P&L. */
  evt.plText = PL_STANDARD.replace(/Marketing\|\d+/gi, 'Other Misc|18000');
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  const src = data.kpis.overheadBreakdownSource || {};
  expect(src.marketing === 'questionnaire', `source should fall back to 'questionnaire'; got '${src.marketing}'`);
  const mp = data.kpis.overheadMarketingPct;
  expect(mp != null && mp > 2 && mp < 3, `marketingPct should reflect questionnaire $23k (~2.5%); got ${mp}`);
});

test('Fix 5: Patient Summary upload step does NOT exist in assessment_hub.html (Day Sheet pivot 2026-04-24)', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.resolve(__dirname, '..', 'assessment_hub.html'), 'utf8');
  /* The old step6 card with the Patient Summary title is gone. */
  expect(!/id="file6"[^>]*onchange="handleFile\(6, this\)"/i.test(html), 'file6 upload input should be removed');
  /* The progress-bar entry "Patient Summary" goToStep(6) wiring is gone. */
  expect(!/goToStep\(6\)[\s\S]{0,200}Patient Summary/i.test(html), 'progress-bar entry "Patient Summary" should be removed');
  /* Renumbered: step6 = Employee Costs (was step 7). */
  expect(/id="step6"[\s\S]{0,500}Employee Costs/i.test(html), 'step6 should now be Employee Costs after renumber');
  /* Renumbered: step7 = Hygiene Schedule (was step 8). */
  expect(/id="step7"[\s\S]{0,500}Hygiene Schedule/i.test(html), 'step7 should now be Hygiene Schedule after renumber');
  /* Renumbered: step8 = Generate (was step 9). */
  expect(/id="step8"[\s\S]{0,500}Generate Assessment Report/i.test(html), 'step8 should now be Generate after renumber');
  /* Day Sheet × 3 sub-uploads must be present. */
  expect(/id="file2a"/.test(html), 'file2a (Day Sheet YTD) input missing');
  expect(/id="file2b"/.test(html), 'file2b (Day Sheet Last Year) input missing');
  expect(/id="file2c"/.test(html), 'file2c (Day Sheet Year Before) input missing');
});

/* ──────────────────────────────────────────────────────────────────────
   Day Sheet methodology batch (2026-04-24): replace single Collections
   upload with three Day Sheet uploads (YTD, last full year, year before).
   New tests cover parseDaySheet, handler thread-through, Collections
   Trend SWOT, image vs PDF routing, partial-period math.
   ────────────────────────────────────────────────────────────────────── */

const { parseDaySheet: pds } = require(require('path').resolve(__dirname, '..', 'netlify', 'functions', 'generate-report.js'));

/* Synthetic last-page Day Sheet text (output of the dentrixDaySheet prompt). */
const DAY_SHEET_LAST_FULL_YEAR = [
  'CHARGES_TOTAL|1340000',
  'PAYMENTS_TOTAL|1280000',
  'CREDIT_ADJUSTMENTS|45000',
  'CHARGE_ADJUSTMENTS|12000',
  'CHARGES_BILLED_INSURANCE|820000',
  'NEW_PATIENTS|380',
  'PATIENTS_SEEN|9420',
  'AVG_PROD_PER_PATIENT|142',
  'AVG_CHARGE_PER_PROCEDURE|310',
  'PERIOD_FROM|2025-01-01',
  'PERIOD_TO|2025-12-31',
].join('\n');

/* New test #1 — parseDaySheet extracts CHARGES, PAYMENTS, PATIENTS_SEEN
   from synthetic last-page text. */
test('Day Sheet new #1: parseDaySheet extracts canonical fields from last-page text', () => {
  const r = pds(DAY_SHEET_LAST_FULL_YEAR);
  expect(r.charges      === 1340000, `charges should be 1,340,000; got ${r.charges}`);
  expect(r.payments     === 1280000, `payments should be 1,280,000; got ${r.payments}`);
  expect(r.creditAdjustments === 45000,  'creditAdjustments mismatch');
  expect(r.chargeAdjustments === 12000,  'chargeAdjustments mismatch');
  expect(r.chargesBilledToInsurance === 820000, 'chargesBilledToInsurance mismatch');
  expect(r.newPatientsOfRecord === 380,  'newPatientsOfRecord mismatch');
  expect(r.patientsSeen === 9420,        'patientsSeen mismatch (captured but not used as active patient count)');
  expect(r.avgProdPerPatient === 142,    'avgProdPerPatient mismatch');
  expect(r.avgChargePerProcedure === 310, 'avgChargePerProcedure mismatch');
  expect(r.periodFrom === '2025-01-01',  'periodFrom mismatch');
  expect(r.periodTo === '2025-12-31',    'periodTo mismatch');
});

/* New test #2 — three Day Sheets thread through to daySheets.{ytd,lastYear,yearBefore}.
   Computed monthly averages match expected math. */
test('Day Sheet new #2: three Day Sheets thread through to daySheets + monthly averages', async () => {
  /* YTD: Q1 2026 — 3 months, $300k payments → $100k/mo
     Last full year: 2025 — 12 months, $1.2M payments → $100k/mo
     Year before: 2024 — 12 months, $1.08M payments → $90k/mo */
  const ytdText = ['CHARGES_TOTAL|330000','PAYMENTS_TOTAL|300000','PERIOD_FROM|2026-01-01','PERIOD_TO|2026-03-31'].join('\n');
  const lyText  = ['CHARGES_TOTAL|1320000','PAYMENTS_TOTAL|1200000','PERIOD_FROM|2025-01-01','PERIOD_TO|2025-12-31'].join('\n');
  const ybText  = ['CHARGES_TOTAL|1188000','PAYMENTS_TOTAL|1080000','PERIOD_FROM|2024-01-01','PERIOD_TO|2024-12-31'].join('\n');
  const evt = JSON.parse(buildEvent().body);
  evt.daySheetYtdText = ytdText;
  evt.daySheetLastYearText = lyText;
  evt.daySheetYearBeforeText = ybText;
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  const ds = data.collections.daySheets;
  expect(ds.ytd && ds.ytd.payments === 300000, 'daySheets.ytd.payments should be 300,000');
  expect(ds.lastYear && ds.lastYear.payments === 1200000, 'daySheets.lastYear.payments should be 1,200,000');
  expect(ds.yearBefore && ds.yearBefore.payments === 1080000, 'daySheets.yearBefore.payments should be 1,080,000');
  const t = data.collections.trend;
  expect(Math.abs(t.ytdMonthlyAvgCollections      - 100000) < 1, `ytd monthly avg should be $100k; got ${t.ytdMonthlyAvgCollections}`);
  expect(Math.abs(t.lastYearMonthlyAvgCollections - 100000) < 1, `last year monthly avg should be $100k; got ${t.lastYearMonthlyAvgCollections}`);
  expect(Math.abs(t.yearBeforeMonthlyAvgCollections - 90000) < 1, `year before monthly avg should be $90k; got ${t.yearBeforeMonthlyAvgCollections}`);
  expect(t.ytdMonthsCompleted === 3, `ytd months should be 3 (parsed period); got ${t.ytdMonthsCompleted}`);
});

/* New test #3 — Collections shrinking SWOT fires when YTD monthly avg is 10%
   below last year monthly avg. */
test('Day Sheet new #3: Collections shrinking SWOT fires at 10% below last year', async () => {
  /* YTD = $90k/mo, Last Year = $100k/mo → 10% below. */
  const ytdText = ['CHARGES_TOTAL|300000','PAYMENTS_TOTAL|270000','PERIOD_FROM|2026-01-01','PERIOD_TO|2026-03-31'].join('\n');
  const lyText  = ['CHARGES_TOTAL|1320000','PAYMENTS_TOTAL|1200000','PERIOD_FROM|2025-01-01','PERIOD_TO|2025-12-31'].join('\n');
  const ybText  = ['CHARGES_TOTAL|1188000','PAYMENTS_TOTAL|1080000','PERIOD_FROM|2024-01-01','PERIOD_TO|2024-12-31'].join('\n');
  const evt = JSON.parse(buildEvent().body);
  evt.daySheetYtdText = ytdText;
  evt.daySheetLastYearText = lyText;
  evt.daySheetYearBeforeText = ybText;
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  const w = data.swot.weaknesses.find(x => /Year-to-date monthly collections average/i.test(x));
  expect(w, 'Collections shrinking weakness did not fire at 10% below: ' + JSON.stringify(data.swot.weaknesses.slice(0, 5)));
  expect(/10% below/.test(w), `body should cite 10% below; got: ${w}`);
  expect(/3-year window/i.test(w), 'body should cite 3-year window when year-before present');
});

/* New test #4 — Collections shrinking SWOT does NOT fire within ±5%. */
test('Day Sheet new #4: Collections shrinking SWOT does NOT fire within ±5%', async () => {
  /* YTD = $97k/mo, Last Year = $100k/mo → 3% below (within ±5% band). */
  const ytdText = ['CHARGES_TOTAL|320000','PAYMENTS_TOTAL|291000','PERIOD_FROM|2026-01-01','PERIOD_TO|2026-03-31'].join('\n');
  const lyText  = ['CHARGES_TOTAL|1320000','PAYMENTS_TOTAL|1200000','PERIOD_FROM|2025-01-01','PERIOD_TO|2025-12-31'].join('\n');
  const evt = JSON.parse(buildEvent().body);
  evt.daySheetYtdText = ytdText;
  evt.daySheetLastYearText = lyText;
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  const w = data.swot.weaknesses.find(x => /Year-to-date monthly collections average/i.test(x));
  expect(!w, `Collections shrinking weakness should not fire within ±5%; fired: ${w}`);
});

/* New test #7 — Hygiene Capacity card renders procedure-derived active
   patient count only (no software / delta numbers). */
test('Day Sheet new #7: Hygiene Capacity card renders procedure-derived count only (no software/delta)', async () => {
  /* Use the existing hygCapFixture which can supply both procedure-derived
     and software-reported counts. After the methodology pivot, the card
     should render only the procedure-derived figure. */
  const res = await handler(hygCapFixture({ prophyAnnual: 2300, perioMaintAnnual: 200, srpAnnual: 50, numHygienists: 6, patsPerHygDay: 8, activePatients: 2400 }));
  const body = JSON.parse(res.body);
  const html = body.reportHtml;
  /* Card is rendered. */
  expect(/Hygiene Capacity[\s\S]{0,400}days required/i.test(html), 'Hygiene Capacity card should render with utilization body');
  /* Card body must NOT include software-reported count or delta phrasing. */
  expect(!/software-reported:/i.test(html), 'Hygiene Capacity card should no longer cite "software-reported" count');
  expect(!/\(delta [+-]/i.test(html),       'Hygiene Capacity card should no longer cite a software-vs-procedure delta');
});

/* New test #8 — extract-pdf.js accepts both PDF and PNG inputs. Verifies the
   buildContentBlock helper routes to the right Anthropic content-block shape
   based on media type. (No network call — pure routing rule.) */
test('Day Sheet new #8: extract-pdf.js routes PDF vs PNG to correct Anthropic content block', () => {
  const path = require('path');
  const ep = require(path.resolve(__dirname, '..', 'netlify', 'functions', 'extract-pdf.js'));
  /* PDF inputs land in a 'document' block. */
  const pdfBlock = ep.buildContentBlock('application/pdf', 'BASE64DATA');
  expect(pdfBlock.type === 'document', `pdf should map to type=document; got ${pdfBlock.type}`);
  expect(pdfBlock.source.media_type === 'application/pdf', 'pdf media_type should pass through');
  /* PNG inputs land in an 'image' block. */
  const pngBlock = ep.buildContentBlock('image/png', 'BASE64DATA');
  expect(pngBlock.type === 'image', `png should map to type=image; got ${pngBlock.type}`);
  expect(pngBlock.source.media_type === 'image/png', 'png media_type should pass through');
  /* JPEG inputs land in an 'image' block. */
  const jpgBlock = ep.buildContentBlock('image/jpeg', 'BASE64DATA');
  expect(jpgBlock.type === 'image', `jpeg should map to type=image; got ${jpgBlock.type}`);
  /* sniffMediaType infers from URL extension. */
  expect(ep.sniffMediaType('foo.png') === 'image/png',   'sniffMediaType should detect .png');
  expect(ep.sniffMediaType('foo.jpg') === 'image/jpeg',  'sniffMediaType should detect .jpg');
  expect(ep.sniffMediaType('foo.heic') === 'image/heic', 'sniffMediaType should detect .heic');
  expect(ep.sniffMediaType('foo.pdf') === 'application/pdf', 'sniffMediaType should detect .pdf');
  expect(ep.sniffMediaType('foo')     === 'application/pdf', 'sniffMediaType should default to PDF');
});

/* New test #9 — PERIOD_FROM/PERIOD_TO emitted by parseDaySheet match the
   date range stamped on the Day Sheet. monthsCovered derives from those. */
test('Day Sheet new #9: parseDaySheet preserves PERIOD_FROM/PERIOD_TO + computes monthsCovered', () => {
  /* Full year — 12 months. */
  const fullYear = pds(DAY_SHEET_LAST_FULL_YEAR);
  expect(fullYear.periodFrom === '2025-01-01', 'full year periodFrom');
  expect(fullYear.periodTo   === '2025-12-31', 'full year periodTo');
  expect(fullYear.monthsCovered === 12, `full year monthsCovered should be 12; got ${fullYear.monthsCovered}`);
  /* YTD — 3 months. */
  const ytd = pds(['CHARGES_TOTAL|300000','PAYMENTS_TOTAL|275000','PERIOD_FROM|2026-01-01','PERIOD_TO|2026-03-31'].join('\n'));
  expect(ytd.periodFrom === '2026-01-01', 'ytd periodFrom');
  expect(ytd.periodTo   === '2026-03-31', 'ytd periodTo');
  expect(ytd.monthsCovered === 3, `ytd monthsCovered should be 3; got ${ytd.monthsCovered}`);
});

/* New test #10 — Edge case: Day Sheet covering a partial period. Parser uses
   PERIOD_FROM/PERIOD_TO to compute monthly averages rather than assuming 12. */
test('Day Sheet new #10: partial-period Day Sheet uses parsed dates for monthly average', async () => {
  /* User uploads a 6-month Day Sheet by mistake. PERIOD_FROM/TO drive the
     divisor — $600k payments over 6 months = $100k/mo, NOT $50k/mo. */
  const partial = ['CHARGES_TOTAL|650000','PAYMENTS_TOTAL|600000','PERIOD_FROM|2025-07-01','PERIOD_TO|2025-12-31'].join('\n');
  const r = pds(partial);
  expect(r.monthsCovered === 6, `partial monthsCovered should be 6; got ${r.monthsCovered}`);
  /* Thread it through the handler as last-year's sheet — $100k/mo expected. */
  const evt = JSON.parse(buildEvent().body);
  evt.daySheetLastYearText = partial;
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  const t = data.collections.trend;
  expect(Math.abs(t.lastYearMonthlyAvgCollections - 100000) < 1,
    `partial-period monthly avg should use parsed months (=$100k/mo, not $50k/mo from /12); got ${t.lastYearMonthlyAvgCollections}`);
});

/* Test #5 (Retention SWOT no longer fires) and Test #6 (Patient Summary
   upload step does not exist) live above next to the existing test
   library — they replaced the prior "Fix 3: Retention WEAKNESS fires"
   and "Fix 1: Patient Summary upload slot exists" tests respectively. */

/* ──────────────────────────────────────────────────────────────────────
   Practice Profile label-bug batch (2026-04-28). Single copy fix to the
   affirmative pain-points sub-header on the Executive Report. Root
   cause: case (a) — the literal "What you told us is wrong" was
   attached to a block that affirms (✓) the dentist's stated concerns.
   The "is wrong" wording made the consultant appear to be telling the
   client they were wrong about their own pain points. Fix: drop the
   misleading suffix. No contradictions block exists yet, so renaming
   was sufficient (case b would have required a separate render path).
   ────────────────────────────────────────────────────────────────────── */

test('Label bug new #1: affirmative pain-points sub-header reads "Your stated concerns" (Fix 4 cleanup of duplicate header)', async () => {
  /* Drive the painPoints block by passing concerns + biggestChallenge.
     Updated 2026-04-28 (methodology mini-bundle Fix 4): the inner orange-
     callout was renamed from "What you told us" to "Your stated concerns"
     to eliminate the duplicate-header collision with the outer h2 in
     assessment-report-template.html that already reads "What you told us". */
  const body = await invoke(null, {
    concerns: ['more_profitable', 'overhead_high', 'staff_issues'],
    biggestChallenge: 'Hygiene production has been flat for two years.',
  });
  const html = body.reportHtml;
  const innerHeaderMatch = html.match(/color:#e8872a[^>]*>([^<]+)</);
  expect(innerHeaderMatch, 'pain-points inner sub-header (orange #e8872a) not found in HTML');
  expect(innerHeaderMatch[1].trim() === 'Your stated concerns',
    `inner sub-header should be exactly "Your stated concerns"; got "${innerHeaderMatch[1].trim()}"`);
  /* Outer h2 in the template still reads "What you told us" — the inner
     callout no longer duplicates it. */
  expect(/<h2[^>]*class="section-title"[^>]*>\s*What you told us\s*<\/h2>/.test(html),
    'Outer Practice Profile h2 should still read exactly "What you told us"');
});

test('Label bug new #2: literal "What you told us is wrong" does NOT appear in any rendered report (no contradictions block)', async () => {
  /* No contradictions block exists in the current architecture, so the
     "is wrong" header literal must not appear anywhere — including when
     concerns and biggestChallenge are populated, or when neither is. */
  const withPainPoints = await invoke(null, {
    concerns: ['more_profitable', 'overhead_high'],
    biggestChallenge: 'Test challenge.',
  });
  expect(!/What you told us is wrong/i.test(withPainPoints.reportHtml),
    'Executive Report should not contain "What you told us is wrong" with concerns populated');
  const noPainPoints = await invoke();  /* default fixture has no concerns */
  expect(!/What you told us is wrong/i.test(noPainPoints.reportHtml),
    'Executive Report should not contain "What you told us is wrong" without concerns');
});

/* ──────────────────────────────────────────────────────────────────────
   Methodology mini-bundle batch (2026-04-28). Benefits Package SWOT,
   "I don't know" scorekeeping-gap SWOT, label copy-pass verbatim guards,
   painPoints sub-header rename regression. Builds on Day Sheet bundle
   (commit d53440c) and Practice Profile label fix (commit 2a9d356).
   ────────────────────────────────────────────────────────────────────── */

/* Helper — build a fixture with explicit benefits yes/no toggles + the IDK
   scorekeeping fields. `benefits` is an object with keys matching the
   summarizeBenefits canonical names (holidays, vacation, bonus, k401,
   medical, dental, ce) and values 'yes' | 'no' | null. Defaults to all
   nulls if not supplied. `idk` is an array of practiceProfile keys to set
   to the literal string 'idk'. `tenureYears` lets a test seed staff/hygiene
   tenure values directly without going through the hub parser. */
function methodologyFixture({ benefits, idk, profileOverrides, staffTenure, hygTenure }) {
  const evt = JSON.parse(buildEvent().body);
  /* Default to fully-unanswered benefits — the new yes/no design treats null
     as "didn't fill in" and emits no SWOT bullets. Tests opt in to specific
     yes/no values per scenario. */
  const baseBenefits = { holidays: null, vacation: null, bonus: null, k401: null, medical: null, dental: null, ce: null };
  evt.employeeCosts = Object.assign({}, evt.employeeCosts, {
    benefits: Object.assign({}, baseBenefits, benefits || {}),
  });
  /* Seed tenureYears onto staff / hygiene arrays. The base fixture has 3
     admin + 2 hygienists; tests can pass arrays of any length and the
     helper REPLACES the staff/hygiene array with that count of synthetic
     rows (uniform rate/hours so staffRoleAnnualCost still computes a
     sane number — only the tenure values vary). Pass an empty array
     to clear the array entirely. */
  const _mkRow = (tenureYears) => ({ rate: 20, hours: 160, tenureYears });
  if (Array.isArray(staffTenure)) {
    evt.employeeCosts.staff = staffTenure.map(t => _mkRow(t == null ? null : t));
  }
  if (Array.isArray(hygTenure)) {
    evt.employeeCosts.hygiene = hygTenure.map(t => _mkRow(t == null ? null : t));
  }
  if (Array.isArray(idk) && idk.length) {
    const profileIdk = {};
    idk.forEach(k => { profileIdk[k] = 'idk'; });
    evt.practiceProfile = Object.assign({}, evt.practiceProfile, profileIdk);
  }
  if (profileOverrides) {
    evt.practiceProfile = Object.assign({}, evt.practiceProfile, profileOverrides);
  }
  return { httpMethod: 'POST', body: JSON.stringify(evt) };
}
async function invokeMethodology(opts) {
  const res = await handler(methodologyFixture(opts));
  if (res.statusCode !== 200) throw new Error('HTTP ' + res.statusCode + ': ' + res.body);
  return JSON.parse(res.body);
}

/* All 7 toggles set to 'yes'. */
const BENEFITS_ALL_YES = {
  holidays: 'yes', vacation: 'yes', bonus: 'yes',
  k401: 'yes', medical: 'yes', dental: 'yes', ce: 'yes',
};

test('Methodology #1: Per-field strength bullets fire — one per "yes" toggle (7 distinct entries when all 7 yes)', async () => {
  const body = await invokeMethodology({ benefits: BENEFITS_ALL_YES });
  /* Each of the 7 labels should appear in its own strength bullet. */
  const labels = ['paid holidays','paid vacations','bonus structure','401K','medical insurance','dental coverage','CE allowance'];
  for (const label of labels) {
    const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' offered\\. Confirmed benefit', 'i');
    const found = body.data.swot.strengths.find(x => re.test(x));
    expect(found, `strength bullet for "${label}" did not fire: ` + JSON.stringify(body.data.swot.strengths));
  }
  /* Aggregate "Benefits package above market standard" copy is GONE per
     Dave's per-field design — regression guard against the old aggregate. */
  const aggregateGone = !body.data.swot.strengths.some(x => /Benefits package above market standard/i.test(x));
  expect(aggregateGone, 'old aggregate "Benefits package above market standard" copy must be removed');
});

test('Methodology #2: Per-field weakness bullets fire — one per "no" toggle (3 distinct entries when 3 no, 4 yes)', async () => {
  const benefits = {
    holidays: 'yes', vacation: 'yes', bonus: 'yes', k401: 'yes',
    medical: 'no', dental: 'no', ce: 'no',
  };
  const body = await invokeMethodology({ benefits });
  const noLabels = ['medical insurance','dental coverage','CE allowance'];
  for (const label of noLabels) {
    const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' not offered\\. Missing this benefit raises turnover risk', 'i');
    const found = body.data.swot.weaknesses.find(x => re.test(x));
    expect(found, `weakness bullet for "${label}" did not fire: ` + JSON.stringify(body.data.swot.weaknesses.slice(0, 10)));
  }
  /* The 4 yes labels emit strengths and NO weaknesses. */
  const yesLabels = ['paid holidays','paid vacations','bonus structure','401K'];
  for (const label of yesLabels) {
    const reW = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' not offered', 'i');
    expect(!body.data.swot.weaknesses.some(x => reW.test(x)),
      `"${label}" was set to yes; should not appear in weaknesses`);
  }
  /* Old aggregate weakness copy gone. */
  const aggregateGone = !body.data.swot.weaknesses.some(x => /Benefits package below market standard/i.test(x));
  expect(aggregateGone, 'old aggregate "Benefits package below market standard" copy must be removed');
});

test('Methodology #3: Unanswered (null) toggles emit nothing — no strength/weakness mention for null fields', async () => {
  /* Mix: 2 yes, 1 no, 4 null. The 4 null labels must not appear in either
     strengths or weaknesses. */
  const benefits = { holidays: 'yes', medical: 'yes', dental: 'no' };
  const body = await invokeMethodology({ benefits });
  const nullLabels = ['paid vacations','bonus structure','401K','CE allowance'];
  for (const label of nullLabels) {
    const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    /* Look only for "label offered" / "label not offered" patterns — the
       label might appear in body text from other SWOTs, so we tighten. */
    const reS = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' offered\\.', 'i');
    const reW = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' not offered', 'i');
    expect(!body.data.swot.strengths.some(x => reS.test(x)),
      `null label "${label}" should not appear as a strength bullet`);
    expect(!body.data.swot.weaknesses.some(x => reW.test(x)),
      `null label "${label}" should not appear as a weakness bullet`);
  }
});

test('Methodology #4: Cross-suppression — ratio body suppresses "align comp" when 2+ benefits = no', async () => {
  /* Drive ratio < 3 with a sparse hygiene fixture; benefits = 2 no, 5 yes. */
  const evt = JSON.parse(buildEvent().body);
  evt.prodText = [
    'DATE RANGE: 01/01/2025 - 12/31/2025',
    'D0120|Periodic Eval|1200|78000',
    'D1110|Prophy|2400|120000',
    'D2740|Crown|140|420000',
  ].join('\n');
  evt.employeeCosts = Object.assign({}, evt.employeeCosts, {
    benefits: { holidays: 'yes', vacation: 'yes', bonus: 'yes', k401: 'yes', medical: 'yes', dental: 'no', ce: 'no' },
  });
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  const ratioW = data.swot.weaknesses.find(x => /hygiene department produces \$[\d.]+ for every \$1 of hygiene labor cost/i.test(x));
  expect(ratioW, 'Hyg Dept Ratio weakness must fire on this fixture');
  expect(!/align hygiene compensation to production/i.test(ratioW),
    `align-comp remedy must be suppressed when benefits.no.length >= 2; got: ${ratioW}`);
  expect(/Address the benefits gap above/i.test(ratioW),
    'replacement text "Address the benefits gap above" must be present');
  expect(/funding benefits is the prerequisite/i.test(ratioW),
    'replacement must name funding benefits as the prerequisite');
});

test('Methodology #5: Cross-pass-through — ratio body retains "align comp" when only 1 benefit = no', async () => {
  /* Same ratio fixture, but only 1 "no" — under the 2+ threshold. */
  const evt = JSON.parse(buildEvent().body);
  evt.prodText = [
    'DATE RANGE: 01/01/2025 - 12/31/2025',
    'D0120|Periodic Eval|1200|78000',
    'D1110|Prophy|2400|120000',
    'D2740|Crown|140|420000',
  ].join('\n');
  evt.employeeCosts = Object.assign({}, evt.employeeCosts, {
    benefits: { holidays: 'yes', vacation: 'yes', bonus: 'yes', k401: 'yes', medical: 'yes', dental: 'yes', ce: 'no' },
  });
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  const ratioW = data.swot.weaknesses.find(x => /hygiene department produces \$[\d.]+ for every \$1 of hygiene labor cost/i.test(x));
  expect(ratioW, 'Hyg Dept Ratio weakness must fire on this fixture');
  expect(/align hygiene compensation to production/i.test(ratioW),
    `align-comp remedy must be retained when only 1 benefit = no; got: ${ratioW}`);
  expect(!/Address the benefits gap above/i.test(ratioW),
    'replacement text must NOT appear when only 1 benefit = no');
});

test('Methodology #5b: Cross-pass-through #2 — ratio body retains two-path remedy when ALL benefits null', async () => {
  /* Ratio fixture with no benefits answered (anyAnswered=false → no
     suppression). */
  const evt = JSON.parse(buildEvent().body);
  evt.prodText = [
    'DATE RANGE: 01/01/2025 - 12/31/2025',
    'D0120|Periodic Eval|1200|78000',
    'D1110|Prophy|2400|120000',
    'D2740|Crown|140|420000',
  ].join('\n');
  /* Don't override benefits — base fixture has none. */
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  const ratioW = data.swot.weaknesses.find(x => /hygiene department produces \$[\d.]+ for every \$1 of hygiene labor cost/i.test(x));
  expect(ratioW, 'Hyg Dept Ratio weakness must fire on this fixture');
  expect(/align hygiene compensation to production/i.test(ratioW),
    `align-comp remedy must be retained when no benefits answered; got: ${ratioW}`);
  expect(/There are two structural paths/i.test(ratioW),
    'two-path remedy phrasing must be present when benefits unknown');
});

/* ── Staff tenure SWOT (2026-04-29) ── */

test('Methodology #5c: Staff tenure WEAKNESS fires on avg < 2 years', async () => {
  /* 3 staff @ 1, 1.5, 2 → avg 1.5 → fires (under 2 years). underOnePct = 33%
     also fires the second condition; both paths converge on the weakness. */
  const body = await invokeMethodology({
    benefits: BENEFITS_ALL_YES,  /* full yes — keep cross-ref short */
    staffTenure: [1, 1.5, 2],
    hygTenure: [],
  });
  const w = body.data.swot.weaknesses.find(x => /Staff turnover risk\./.test(x));
  expect(w, 'Staff turnover weakness did not fire at avg 1.5: ' + JSON.stringify(body.data.swot.weaknesses.slice(0, 10)));
  expect(/average tenure is 1\.5 years/i.test(w), `body should cite avg 1.5 years; got: ${w}`);
});

test('Methodology #5d: Staff tenure WEAKNESS fires on ≥30% under 1 year (regardless of avg)', async () => {
  /* 5 staff @ 0.5, 0.5, 5, 6, 8 → avg ≈ 4.0 (above 2), under-1 = 40% → fires
     on the underOnePct path despite a healthy average. */
  const body = await invokeMethodology({
    benefits: BENEFITS_ALL_YES,
    staffTenure: [0.5, 0.5, 5, 6, 8],
    hygTenure: [],
  });
  const w = body.data.swot.weaknesses.find(x => /Staff turnover risk\./.test(x));
  expect(w, 'Staff turnover weakness did not fire at 40% under-1yr: ' + JSON.stringify(body.data.swot.weaknesses.slice(0, 10)));
  expect(/40% .* less than a year/i.test(w) || /\(40%\) have been with the practice less than a year/i.test(w),
    `body should cite 40% under a year; got: ${w}`);
});

test('Methodology #5e: Staff tenure STRENGTH fires on avg ≥5 AND <10% under 1 year', async () => {
  /* 5 staff @ 4, 5, 6, 8, 10 → avg 6.6, 0% under 1 → fires. */
  const body = await invokeMethodology({
    benefits: BENEFITS_ALL_YES,
    staffTenure: [4, 5, 6, 8, 10],
    hygTenure: [],
  });
  const s = body.data.swot.strengths.find(x => /Stable team\./.test(x));
  expect(s, 'Stable-team strength did not fire: ' + JSON.stringify(body.data.swot.strengths));
  expect(/averages 6\.6 years/i.test(s), `body should cite avg 6.6 years; got: ${s}`);
  expect(/0 of 5 \(0%\)/i.test(s), `body should cite 0/5 (0%) under a year; got: ${s}`);
});

test('Methodology #5f: Staff tenure SILENT on borderline (avg 3, 0% under 1)', async () => {
  /* 3 staff @ 2, 3, 4 → avg 3, 0% under 1 → neither branch fires. */
  const body = await invokeMethodology({
    staffTenure: [2, 3, 4],
    hygTenure: [],
  });
  const w = body.data.swot.weaknesses.find(x => /Staff turnover risk\./.test(x));
  const s = body.data.swot.strengths.find(x => /Stable team\./.test(x));
  expect(!w, `Weakness should not fire on borderline (avg 3, 0% under 1); fired: ${w}`);
  expect(!s, `Strength should not fire on borderline (avg 3 < 5); fired: ${s}`);
});

test('Methodology #5g: Staff tenure SILENT when fewer than 2 tenure values supplied', async () => {
  /* Only 1 tenure value supplied — insufficient signal. */
  const body = await invokeMethodology({
    staffTenure: [5],
    hygTenure: [],
  });
  const w = body.data.swot.weaknesses.find(x => /Staff turnover risk\./.test(x));
  const s = body.data.swot.strengths.find(x => /Stable team\./.test(x));
  expect(!w && !s, 'Neither tenure branch should fire with <2 tenure values supplied');
});

test('Methodology #5h: Cross-reference appended to turnover weakness when benefits.no is non-empty', async () => {
  /* Tenure → weakness; benefits → 2 no answers. Body should append the
     "{n} benefits that drive retention" cross-reference sentence. */
  const body = await invokeMethodology({
    benefits: { holidays: 'yes', vacation: 'yes', bonus: 'yes', k401: 'yes', medical: 'no', dental: 'no', ce: 'yes' },
    staffTenure: [1, 1.5, 2],
    hygTenure: [],
  });
  const w = body.data.swot.weaknesses.find(x => /Staff turnover risk\./.test(x));
  expect(w, 'Staff turnover weakness must fire to test cross-ref');
  expect(/missing 2 benefits that drive retention/i.test(w),
    `body should append cross-ref naming 2 benefits; got: ${w}`);
  expect(/medical insurance/i.test(w) && /dental coverage/i.test(w),
    'cross-ref should list the two missing benefits');
  expect(/most direct lever to slow turnover/i.test(w),
    'cross-ref should close with "most direct lever to slow turnover"');
});

test('Methodology #5i: Cross-reference NOT appended when benefits.no is empty', async () => {
  /* Tenure → weakness; benefits → all null (anyAnswered false → no.length=0).
     Body must NOT include the cross-reference. */
  const body = await invokeMethodology({
    /* No benefits override — defaults to all nulls. */
    staffTenure: [1, 1.5, 2],
    hygTenure: [],
  });
  const w = body.data.swot.weaknesses.find(x => /Staff turnover risk\./.test(x));
  expect(w, 'Staff turnover weakness must fire to test cross-ref absence');
  expect(!/benefits that drive retention/i.test(w),
    `cross-ref must NOT appear when benefits.no is empty; got: ${w}`);
});

test('Methodology #5j: Tenure parser handles "8 yrs", "1.5", "6 months", "<1 year", and empty', () => {
  /* Extract parseTenureYears from assessment_hub.html and exercise it
     against the documented input forms. */
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.resolve(__dirname, '..', 'assessment_hub.html'), 'utf8');
  const match = html.match(/function\s+parseTenureYears\s*\(([^)]*)\)\s*\{([\s\S]*?)\n\}/);
  expect(match, 'parseTenureYears function not found in assessment_hub.html');
  const [, argList, body] = match;
  const fn = new Function(argList.trim(), body);
  expect(fn('8 yrs')      === 8,   `"8 yrs" → 8; got ${fn('8 yrs')}`);
  expect(fn('8 years')    === 8,   `"8 years" → 8; got ${fn('8 years')}`);
  expect(fn('8')          === 8,   `"8" → 8; got ${fn('8')}`);
  expect(fn('1.5')        === 1.5, `"1.5" → 1.5; got ${fn('1.5')}`);
  expect(Math.abs(fn('6 months') - 0.5) < 1e-9, `"6 months" → 0.5; got ${fn('6 months')}`);
  expect(Math.abs(fn('6 mo') - 0.5) < 1e-9,     `"6 mo" → 0.5; got ${fn('6 mo')}`);
  expect(fn('<1 year')    === 0.5, `"<1 year" → 0.5; got ${fn('<1 year')}`);
  expect(fn('less than 1') === 0.5, `"less than 1" → 0.5; got ${fn('less than 1')}`);
  expect(fn('') === null,       `"" → null; got ${fn('')}`);
  expect(fn(null) === null,     `null → null; got ${fn(null)}`);
});

test('Methodology #5k: Hub form regression — old benefits free-text inputs are gone, new yes/no radios are present', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.resolve(__dirname, '..', 'assessment_hub.html'), 'utf8');
  /* Old free-text Sick Pay + Other inputs must be removed. */
  expect(!/id="ec_ben_sick"/.test(html), 'old ec_ben_sick input must be removed');
  expect(!/id="ec_ben_other"/.test(html), 'old ec_ben_other input must be removed');
  /* Old free-text holidays/vacation/bonus/401k/medical/dental/ce inputs gone
     too — replaced by _yn radio groups. */
  for (const oldId of ['ec_ben_holidays','ec_ben_vacation','ec_ben_bonus','ec_ben_401k','ec_ben_medical','ec_ben_dental','ec_ben_ce']) {
    const re = new RegExp(`id="${oldId}"`);
    expect(!re.test(html), `old free-text input id="${oldId}" must be removed (replaced by _yn radio)`);
  }
  /* New yes/no radio groups must be present. */
  for (const ynName of ['ec_ben_holidays_yn','ec_ben_vacation_yn','ec_ben_bonus_yn','ec_ben_401k_yn','ec_ben_medical_yn','ec_ben_dental_yn','ec_ben_ce_yn']) {
    const re = new RegExp(`name="${ynName}"`);
    expect(re.test(html), `new yes/no radio name="${ynName}" must be present`);
  }
  /* Tenure column inputs must be present on at least the office manager + RDH 1 rows. */
  expect(/id="ec_tenure_om"/.test(html),  'tenure input for Office Manager must be present');
  expect(/id="ec_tenure_h1"/.test(html),  'tenure input for RDH 1 must be present');
  /* 2026-04-29: the verbose "Hygiene team benefits: monthly cost…" label
     is now ALSO removed alongside the underlying ec_hyg_benefits input —
     loading factor is modeled from the binary toggles + P&L, no manual
     dollar overlay. Regression guard inverts: label must be ABSENT. */
  expect(!html.includes('Hygiene team benefits: monthly cost of health insurance, retirement, and payroll taxes'),
    'verbose hygiene-benefits LOADED-COST label must be removed (input dropped 2026-04-29)');
  expect(!html.includes('Staff team benefits: monthly cost of health insurance, retirement, and payroll taxes'),
    'verbose staff-benefits LOADED-COST label must be removed (input dropped 2026-04-29)');
  /* Underlying inputs gone too. */
  expect(!/id="ec_hyg_benefits"/.test(html), 'ec_hyg_benefits input must be removed');
  expect(!/id="ec_staff_benefits"/.test(html), 'ec_staff_benefits input must be removed');
  expect(!/id="ec_hyg_empcost"/.test(html), 'ec_hyg_empcost input must be removed');
  expect(!/id="ec_staff_empcost"/.test(html), 'ec_staff_empcost input must be removed');
});

test('Methodology #6: Scorekeeping-gap SWOT fires when 2+ "I don\'t know" boxes are checked', async () => {
  const body = await invokeMethodology({
    benefits: BENEFITS_ALL_YES,  /* keep benefits clean to isolate the IDK signal */
    idk: ['docDailyAvg', 'crownsPerMonth'],
  });
  const w = body.data.swot.weaknesses.find(x => /You marked "I don't know" on/i.test(x));
  expect(w, 'Scorekeeping-gap SWOT did not fire with 2 IDK fields: ' + JSON.stringify(body.data.swot.weaknesses.slice(0, 6)));
  expect(/2 of our operational-tracking questions/i.test(w),
    `body should cite "2 of our operational-tracking questions"; got: ${w}`);
  expect(/doctor daily production target/i.test(w), 'body should list doctor daily production target');
  expect(/monthly crown count/i.test(w), 'body should list monthly crown count');
  expect(/can't fix what you don't measure/i.test(w),
    'body should include the "can\'t fix what you don\'t measure" closing line');
});

test('Methodology #7: Scorekeeping-gap SWOT does NOT fire when only 1 "I don\'t know" box is checked', async () => {
  const body = await invokeMethodology({
    benefits: BENEFITS_ALL_YES,
    idk: ['docDailyAvg'],  /* exactly 1 — under threshold */
  });
  const w = body.data.swot.weaknesses.find(x => /You marked "I don't know" on/i.test(x));
  expect(!w, `Scorekeeping-gap SWOT should not fire with only 1 IDK field; fired: ${w}`);
});

test('Methodology #8: Scorekeeping-gap SWOT co-exists with the existing Q2 setup-foundation scorekeeping SWOT', async () => {
  /* Q2 fires on hasProductionGoal=no / knowsIfAhead=no.
     Scorekeeping-gap fires on 2+ IDK fields.
     Both should be present in the SWOT weaknesses list — separate signals. */
  const body = await invokeMethodology({
    benefits: BENEFITS_ALL_YES,
    idk: ['docDailyAvg', 'crownsPerMonth', 'hygDailyAvg'],
    profileOverrides: { hasProductionGoal: 'no', knowsIfAhead: 'no' },
  });
  const q2 = body.data.swot.weaknesses.find(x => /weekly scorecard/i.test(x));
  expect(q2, 'Q2 setup-foundation scorekeeping SWOT must still fire');
  const newGap = body.data.swot.weaknesses.find(x => /You marked "I don't know" on/i.test(x));
  expect(newGap, 'New scorekeeping-gap SWOT must also fire alongside Q2');
  /* They are distinct entries — different opening text. */
  expect(q2 !== newGap, 'Q2 and new SWOT should be distinct weakness entries');
});

test('Methodology #9: All staff-cost overlay inputs + labels removed from assessment_hub.html (2026-04-29)', () => {
  /* 2026-04-29 superseded the 2026-04-28 verbose-label rewrite by dropping
     the underlying inputs entirely. Loading factor now comes from binary
     toggles + P&L. Both the old accountant-shorthand labels AND the
     verbose 2026-04-28 rewrites must now be absent. */
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.resolve(__dirname, '..', 'assessment_hub.html'), 'utf8');
  /* Verbose 2026-04-28 rewrites — gone. */
  expect(!html.includes('Hygiene team benefits: monthly cost of health insurance, retirement, and payroll taxes'),
    'Verbose hygiene-benefits label must be absent (input dropped 2026-04-29)');
  expect(!html.includes('Staff team benefits: monthly cost of health insurance, retirement, and payroll taxes'),
    'Verbose staff-benefits label must be absent (input dropped 2026-04-29)');
  /* Original accountant-shorthand labels — also gone (already from 2026-04-28). */
  expect(!/<label>Hygiene Benefits \(monthly avg\)<\/label>/.test(html),
    'Old "Hygiene Benefits (monthly avg)" label must remain absent');
  expect(!/<label>Staff Benefits \(monthly avg\)<\/label>/.test(html),
    'Old "Staff Benefits (monthly avg)" label must remain absent');
  expect(!/<label>Hygiene Employment Cost %<\/label>/.test(html),
    'Old "Hygiene Employment Cost %" label must remain absent');
  expect(!/<label>Staff Employment Cost %<\/label>/.test(html),
    'Old "Staff Employment Cost %" label must remain absent');
});

test('Methodology #10: painPoints inner sub-header reads "Your stated concerns" (carryover from 2a9d356 cleanup)', async () => {
  const body = await invoke(null, {
    concerns: ['more_profitable', 'overhead_high'],
    biggestChallenge: 'Cleanup carryover.',
  });
  const html = body.reportHtml;
  /* Outer h2 in template — "What you told us". */
  expect(/<h2[^>]*class="section-title"[^>]*>\s*What you told us\s*<\/h2>/.test(html),
    'Outer h2 should read exactly "What you told us"');
  /* Inner orange-callout sub-header — "Your stated concerns" (no longer duplicates the h2). */
  const innerMatch = html.match(/color:#e8872a[^>]*>([^<]+)</);
  expect(innerMatch && innerMatch[1].trim() === 'Your stated concerns',
    `inner sub-header should be "Your stated concerns"; got "${innerMatch ? innerMatch[1].trim() : '(no match)'}"`);
  /* Verbatim "What you told us" must appear ONLY in the outer h2, not inside
     the orange-callout block. Anchor on the orange-callout opening div and
     scan within it. */
  const blockStart = html.indexOf('border-left:3px solid #e8872a');
  expect(blockStart >= 0, 'painPoints block not found');
  const blockSlice = html.slice(blockStart, blockStart + 600);
  expect(!/What you told us/i.test(blockSlice),
    'literal "What you told us" must not appear inside the orange-callout block (duplication regression guard)');
});

test('Label bug new #3: affirmative pain-points block uses ✓ checkmarks, no ⚠ warning iconography leaks in', async () => {
  const body = await invoke(null, {
    concerns: ['more_profitable', 'pay_staff_more', 'new_patients'],
    biggestChallenge: 'Need more new patients.',
  });
  const html = body.reportHtml;
  /* Locate the painPoints block by its orange left-border + checkmark. The
     block's outer div uses border-left:3px solid #e8872a — anchor there. */
  const blockStart = html.indexOf('border-left:3px solid #e8872a');
  expect(blockStart >= 0, 'painPoints block (orange left-border) not found in HTML');
  /* Slice from the block's opening div to the next closing </div>...</div>
     pair. Keep it simple: take a 2,000-char window past the marker. */
  const blockSlice = html.slice(blockStart, blockStart + 2000);
  /* Affirmative iconography: ✓ must appear next to each concern. */
  expect(/✓/.test(blockSlice),
    'painPoints block should contain ✓ checkmark iconography for affirmative concerns');
  /* Warning iconography (⚠ U+26A0 or ⚠️ with VS16) must NOT appear inside
     the affirmative block — that's reserved for a future contradictions block. */
  expect(!/⚠/.test(blockSlice),
    'painPoints block must not contain ⚠ warning iconography (reserved for future contradictions block)');
});

/* ──────────────────────────────────────────────────────────────────────
   Staff cost from worksheet × loading factor (2026-04-29).
   Replaces the 4-input numeric overlay (staffBenefits$ + staffEmpCostPct +
   hygBenefits$ + hygEmpCostPct) with: staff worksheet wages × loading
   factor, where loading is sourced from the P&L when available (sanity-
   bounded 1.0–1.5) or modeled from the binary benefits toggles otherwise.
   ────────────────────────────────────────────────────────────────────── */

/* Loading-factor + staff-cost helpers exported from generate-report.js
   for unit testing without invoking the full handler. */
const {
  modeledLoadingFactor: _modeledLoadingFactor,
  annualWageSum:        _annualWageSum,
  staffCostFromPL:      _staffCostFromPL,
  actualLoadingFactor:  _actualLoadingFactor,
  deriveStaffCosts:     _deriveStaffCosts,
} = require(require('path').resolve(__dirname, '..', 'netlify', 'functions', 'generate-report.js'));

test('Staff Cost #1: modeledLoadingFactor returns 1.10 when all benefits null', () => {
  expect(Math.abs(_modeledLoadingFactor(null) - 1.10) < 1e-9,
    `null benefits should yield 1.10; got ${_modeledLoadingFactor(null)}`);
  expect(Math.abs(_modeledLoadingFactor({}) - 1.10) < 1e-9,
    `empty benefits should yield 1.10; got ${_modeledLoadingFactor({})}`);
  expect(Math.abs(_modeledLoadingFactor({ medical: null, k401: null, bonus: null, dental: null, ce: null }) - 1.10) < 1e-9,
    'all-null toggles should yield 1.10');
});

test('Staff Cost #2: modeledLoadingFactor returns 1.27 when all 5 cost-loading toggles = yes', () => {
  /* medical 0.07 + k401 0.04 + bonus 0.03 + dental 0.02 + ce 0.01 = +0.17 over 1.10 = 1.27. */
  const factor = _modeledLoadingFactor({
    medical: 'yes', k401: 'yes', bonus: 'yes', dental: 'yes', ce: 'yes',
  });
  expect(Math.abs(factor - 1.27) < 1e-9, `all-yes cost-loading should yield 1.27; got ${factor}`);
});

test('Staff Cost #3: modeledLoadingFactor weights vacation/holidays as 0 (already in wages)', () => {
  /* Vacation + holidays = yes, all cost-loading = no → factor stays at 1.10. */
  const factor = _modeledLoadingFactor({
    vacation: 'yes', holidays: 'yes',
    medical: 'no', k401: 'no', bonus: 'no', dental: 'no', ce: 'no',
  });
  expect(Math.abs(factor - 1.10) < 1e-9,
    `vacation+holidays should not change loading; got ${factor}`);
});

test('Staff Cost #4: actualLoadingFactor returns null when P&L is null', async () => {
  /* End-to-end check: drop plText so plData is null; loadingSource should
     be 'modeled-from-toggles' regardless of staff content. */
  const evt = JSON.parse(buildEvent().body);
  delete evt.plText;
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  expect(data.kpis.staffCostLoadingSource === 'modeled-from-toggles',
    `expected modeled when no P&L; got ${data.kpis.staffCostLoadingSource}`);
});

test('Staff Cost #5: actualLoadingFactor returns null when wages = 0 (empty staff table)', async () => {
  const evt = JSON.parse(buildEvent().body);
  evt.employeeCosts = { staff: [], hygiene: [], benefits: { medical: 'yes' } };
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  /* Empty worksheet — totalCost null, loadingSource null, staffCostPct null. */
  expect(data.kpis.staffCostPct == null, `expected null staffCostPct; got ${data.kpis.staffCostPct}`);
  expect(data.kpis.staffCostLoadingSource == null, `loadingSource null when no wages`);
});

test('Staff Cost #6: actualLoadingFactor returns the P&L-derived factor in sanity bounds', async () => {
  /* Fixture: wages staff $400k, hygiene $0, P&L staff line $440k → 1.10 actual. */
  const evt = JSON.parse(buildEvent().body);
  /* Single staff entry sized so wages = exactly $400k.  rate × 160 × 12 =
     400000  →  rate = 400000 / 1920 = 208.333...  */
  evt.employeeCosts = {
    staff: [{ rate: 208.333333333, hours: 160 }],
    hygiene: [],
    benefits: {},
  };
  evt.plText = [
    'TOTAL_INCOME|2000000','TOTAL_EXPENSE|1500000','NET_INCOME|500000',
    'SECTION|Income','Sales|2000000',
    'SECTION|Expense',
    'Salaries & Wages|400000', 'Payroll Taxes|40000',
  ].join('\n');
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  expect(data.kpis.staffCostLoadingSource === 'pl-actual',
    `expected pl-actual; got ${data.kpis.staffCostLoadingSource}`);
  expect(Math.abs(data.kpis.staffCostLoadingFactor - 1.10) < 0.01,
    `factor should be ~1.10; got ${data.kpis.staffCostLoadingFactor}`);
});

test('Staff Cost #7: actualLoadingFactor returns null when loading > 1.5 (sanity-fail → modeled fallback)', async () => {
  /* Tiny worksheet wages, huge P&L staff total — implausible loading > 1.5
     should reject the P&L pull and fall back to modeled. */
  const evt = JSON.parse(buildEvent().body);
  evt.employeeCosts = {
    staff: [{ rate: 10, hours: 160 }],   /* wages = $19,200 */
    hygiene: [],
    benefits: {},
  };
  evt.plText = [
    'TOTAL_INCOME|2000000','TOTAL_EXPENSE|1500000','NET_INCOME|500000',
    'SECTION|Expense',
    'Salaries & Wages|400000','Payroll Taxes|40000',  /* loading would be ~22.9× */
  ].join('\n');
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  expect(data.kpis.staffCostLoadingSource === 'modeled-from-toggles',
    `out-of-bounds P&L should fall back to modeled; got ${data.kpis.staffCostLoadingSource}`);
  expect(Math.abs(data.kpis.staffCostLoadingFactor - 1.10) < 1e-9,
    `modeled factor with no toggles → 1.10; got ${data.kpis.staffCostLoadingFactor}`);
});

test('Staff Cost #8: canonicalStaffCostPct uses P&L actual loading when present', async () => {
  /* admin $400k wages, hyg $200k wages, P&L staff $750k → loading 1.25,
     totalCost $750k. Collections $2.5M → staffCostPct 30.0%. */
  const evt = JSON.parse(buildEvent().body);
  evt.employeeCosts = {
    staff:   [{ rate: 208.333333333, hours: 160 }],   /* $400k */
    hygiene: [{ rate: 104.166666667, hours: 160 }],   /* $200k */
    benefits: {},
  };
  evt.collText = ['DATES| 01/01/2025 - 12/31/2025','CHARGES|2750000','PAYMENTS|2500000'].join('\n');
  evt.plText = [
    'TOTAL_INCOME|2500000','TOTAL_EXPENSE|2000000','NET_INCOME|500000',
    'SECTION|Expense',
    'Salaries & Wages|700000','Payroll Taxes|50000',
  ].join('\n');
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  expect(data.kpis.staffCostLoadingSource === 'pl-actual', 'expected pl-actual');
  expect(Math.abs(data.kpis.staffCostLoadingFactor - 1.25) < 0.01,
    `loading should be ~1.25; got ${data.kpis.staffCostLoadingFactor}`);
  expect(Math.abs(data.kpis.staffCostPct - 30.0) < 0.5,
    `staffCostPct should be ~30%; got ${data.kpis.staffCostPct}`);
});

test('Staff Cost #9: canonicalStaffCostPct uses modeled loading when P&L absent', async () => {
  /* Same wages, no P&L, all-yes benefits → loading 1.27. */
  const evt = JSON.parse(buildEvent().body);
  evt.employeeCosts = {
    staff:   [{ rate: 208.333333333, hours: 160 }],
    hygiene: [{ rate: 104.166666667, hours: 160 }],
    benefits: { medical: 'yes', k401: 'yes', bonus: 'yes', dental: 'yes', ce: 'yes' },
  };
  evt.collText = ['DATES| 01/01/2025 - 12/31/2025','CHARGES|2750000','PAYMENTS|2500000'].join('\n');
  delete evt.plText;
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  expect(data.kpis.staffCostLoadingSource === 'modeled-from-toggles', 'expected modeled');
  expect(Math.abs(data.kpis.staffCostLoadingFactor - 1.27) < 0.01,
    `loading should be 1.27 (all-yes); got ${data.kpis.staffCostLoadingFactor}`);
  /* totalCost = 600000 × 1.27 = 762000; pct = 762000 / 2500000 = 30.48%. */
  expect(Math.abs(data.kpis.staffCostPct - 30.48) < 0.5,
    `staffCostPct should be ~30.48%; got ${data.kpis.staffCostPct}`);
});

test('Staff Cost #10: staffCostExHygPct splits correctly by wage proportion', async () => {
  /* admin $400k wages, hyg $200k wages, all-yes benefits (loading 1.27),
     no P&L → adminCost = 400k × 1.27 = $508k. exHyg vs $2.5M coll = 20.32%. */
  const evt = JSON.parse(buildEvent().body);
  evt.employeeCosts = {
    staff:   [{ rate: 208.333333333, hours: 160 }],
    hygiene: [{ rate: 104.166666667, hours: 160 }],
    benefits: { medical: 'yes', k401: 'yes', bonus: 'yes', dental: 'yes', ce: 'yes' },
  };
  evt.collText = ['DATES| 01/01/2025 - 12/31/2025','CHARGES|2750000','PAYMENTS|2500000'].join('\n');
  delete evt.plText;
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  expect(Math.abs(data.kpis.staffCostExHygPct - 20.32) < 0.5,
    `exHyg should be ~20.32%; got ${data.kpis.staffCostExHygPct}`);
});

test('Staff Cost #11: hygienistCostPct denominator is hygiene production (not collections)', async () => {
  /* hyg wages $200k, all-yes benefits → hygCost $254k. Engineer hygiene
     production to $700k via D1110 quantity. Expected pct ≈ 36.3%. */
  const evt = JSON.parse(buildEvent().body);
  evt.prodText = [
    'DATE RANGE: 01/01/2025 - 12/31/2025',
    'D0150|Comp Eval|400|36000',
    'D1110|Adult Prophy|2400|700000',  /* hygiene = $700k */
    'D2740|Crown|140|420000',
  ].join('\n');
  evt.employeeCosts = {
    staff:   [{ rate: 208.333333333, hours: 160 }],
    hygiene: [{ rate: 104.166666667, hours: 160 }],
    benefits: { medical: 'yes', k401: 'yes', bonus: 'yes', dental: 'yes', ce: 'yes' },
  };
  evt.collText = ['DATES| 01/01/2025 - 12/31/2025','CHARGES|1300000','PAYMENTS|1156000'].join('\n');
  delete evt.plText;
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  /* hygCost = 200000 × 1.27 = 254000; hygProd = 700000; pct = 36.286 */
  expect(Math.abs(data.kpis.hygienistCostPct - 36.29) < 0.5,
    `hygienistCostPct should be ~36.29%; got ${data.kpis.hygienistCostPct}`);
});

test('Staff Cost #12: loading source field is exposed in the data payload', async () => {
  /* P&L present → pl-actual. */
  const evt = JSON.parse(buildEvent().body);
  evt.employeeCosts = { staff: [{ rate: 208.333333333, hours: 160 }], hygiene: [], benefits: {} };
  evt.plText = [
    'TOTAL_INCOME|2000000','TOTAL_EXPENSE|1500000','NET_INCOME|500000',
    'SECTION|Expense','Salaries & Wages|400000','Payroll Taxes|40000',
  ].join('\n');
  let res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  let data = JSON.parse(res.body).data;
  expect(data.kpis.staffCostLoadingSource === 'pl-actual', `pl-actual when P&L drives; got ${data.kpis.staffCostLoadingSource}`);
  expect(data.financials.staffCostLoadingSource === 'pl-actual', 'financials.staffCostLoadingSource also surfaced');
  /* No P&L → modeled. */
  delete evt.plText;
  res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  data = JSON.parse(res.body).data;
  expect(data.kpis.staffCostLoadingSource === 'modeled-from-toggles', 'modeled when toggles drive');
});

test('Staff Cost #13: SWOT staff-cost weakness still fires correctly with new compute (>20%)', async () => {
  /* Smoke fixture (PL_STANDARD has $275k staff line) yields ~31% staffCostPct.
     The 20% benchmark weakness must still fire under the new path. */
  const body = await invoke();
  const w = body.data.swot.weaknesses.find(x => /total staff cost at/i.test(x));
  expect(w, 'staff-cost weakness must fire on smoke fixture (>20%): ' + JSON.stringify(body.data.swot.weaknesses.slice(0, 6)));
  expect(/20% benchmark/.test(w), 'weakness must reference 20% benchmark');
});

test('Staff Cost #14: SWOT staff-cost weakness does NOT fire when staff worksheet empty', async () => {
  const evt = JSON.parse(buildEvent().body);
  evt.employeeCosts = { staff: [], hygiene: [], benefits: {} };
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  /* totalCost null → staffCostPct null → weakness can't fire on a null
     comparison. */
  const w = data.swot.weaknesses.find(x => /total staff cost at \d/i.test(x));
  expect(!w, `weakness must not fire when staff worksheet empty; fired: ${w}`);
});

test('Staff Cost #15: backward-compat — old fixtures with ec_staff_benefits / staffEmpCostPct still work (fields ignored)', async () => {
  /* Fixture passes the dropped fields verbatim — handler must accept,
     ignore them, and produce a valid response (no thrown error). */
  const evt = JSON.parse(buildEvent().body);
  evt.employeeCosts = Object.assign({}, evt.employeeCosts, {
    staffBenefits: 5000, staffEmpCostPct: 0.15,
    hygBenefits: 2000, hygEmpCostPct: 0.12,
  });
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  expect(res.statusCode === 200, 'handler must accept legacy fields without erroring');
  const data = JSON.parse(res.body).data;
  expect(data.kpis.staffCostPct != null, 'staffCostPct still computes when legacy fields are present');
});

test('Staff Cost #16: Hyg Dept Ratio cross-suppression with benefits weakness still works (sanity integration)', async () => {
  /* Combine a ratio-tripping fixture with 2+ "no" benefits — the prior
     batch's cross-suppression must continue working under the new
     loading-factor compute. */
  const evt = JSON.parse(buildEvent().body);
  evt.prodText = [
    'DATE RANGE: 01/01/2025 - 12/31/2025',
    'D0120|Periodic Eval|1200|78000',
    'D1110|Prophy|2400|120000',
    'D2740|Crown|140|420000',
  ].join('\n');
  evt.employeeCosts = Object.assign({}, evt.employeeCosts, {
    benefits: { holidays: 'yes', vacation: 'yes', bonus: 'yes', k401: 'yes', medical: 'yes', dental: 'no', ce: 'no' },
  });
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(evt) });
  const data = JSON.parse(res.body).data;
  const ratioW = data.swot.weaknesses.find(x => /hygiene department produces \$[\d.]+ for every \$1 of hygiene labor cost/i.test(x));
  expect(ratioW, 'Hyg Dept Ratio weakness must fire on this fixture');
  expect(!/align hygiene compensation to production/i.test(ratioW),
    'cross-suppression must still hide align-comp remedy when benefits.no.length >= 2');
  expect(/Address the benefits gap above/i.test(ratioW),
    'replacement text must still appear');
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
