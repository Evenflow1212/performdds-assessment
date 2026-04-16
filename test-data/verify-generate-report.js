/* End-to-end smoke test for netlify/functions/generate-report.js
 *
 * Run from repo root:    node test-data/verify-generate-report.js
 *
 * Builds a synthetic pipe-delimited payload (matches what parse-pdf.js
 * produces after a real Hub run), invokes the handler in-process, and
 * sanity-checks the response shape + KPI magnitudes.
 */
'use strict';
const path = require('path');
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

const plText = [
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

const event = {
  httpMethod: 'POST',
  body: JSON.stringify({
    prodText, collText, plText,
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

(async () => {
  const res = await handler(event);
  console.log('HTTP status:', res.statusCode);
  if (res.statusCode !== 200) {
    console.error('FAIL body:', res.body);
    process.exit(1);
  }
  const body = JSON.parse(res.body);
  console.log('success:', body.success);
  console.log('summary:', JSON.stringify(body.summary, null, 2));
  console.log('data top-level keys:', Object.keys(body.data));
  console.log('kpis:', JSON.stringify(body.data.kpis, null, 2));
  console.log('opportunities.top3 count:', body.data.opportunities.top3.length);
  console.log('opportunities.totalValue: $' + Math.round(body.data.opportunities.totalValue).toLocaleString());
  console.log('reportHtml length:', body.reportHtml.length, 'chars');
  /* Sanity checks */
  const k = body.data.kpis;
  const failures = [];
  if (!(k.annualProduction > 900000 && k.annualProduction < 1200000)) failures.push('annualProduction out of expected band: ' + k.annualProduction);
  if (!(k.collectionRate > 80 && k.collectionRate < 100)) failures.push('collectionRate out of band: ' + k.collectionRate);
  if (!(k.hygienePercent > 25 && k.hygienePercent < 50)) failures.push('hygienePercent out of band: ' + k.hygienePercent);
  if (!(k.overheadPct > 30 && k.overheadPct < 80)) failures.push('overheadPct out of band: ' + k.overheadPct);
  if (body.reportHtml.length < 10000) failures.push('reportHtml suspiciously short: ' + body.reportHtml.length);
  if (/\{\{[a-zA-Z]+\}\}/.test(body.reportHtml)) failures.push('reportHtml has un-substituted {{placeholder}}');
  if (failures.length) { console.error('\nFAILURES:\n- ' + failures.join('\n- ')); process.exit(1); }

  /* Optional: write rendered HTML to disk for visual inspection */
  const fs = require('fs');
  const outPath = path.resolve(__dirname, 'output', 'smoke-test-report.html');
  fs.writeFileSync(outPath, body.reportHtml);
  console.log('\nRendered report written to', outPath);
  console.log('\n✅ PASS — all sanity checks OK');
})().catch(e => { console.error('Crash:', e.message, e.stack); process.exit(1); });
