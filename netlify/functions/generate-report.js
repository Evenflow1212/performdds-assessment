'use strict';
/*
 * generate-report.js — NEW primary endpoint for the assessment pipeline.
 *
 * Replaces the old generate-workbook.js (which produced a 12-tab Excel file
 * via a fragile two-pass XML manipulation system). This function:
 *
 *   1. Parses the text Claude extracted from the uploaded Dentrix PDFs.
 *   2. Computes every KPI + SWOT + opportunities into a clean data object.
 *   3. Renders the HTML Executive Report from the same data.
 *   4. Returns { data, reportHtml } — no Excel.
 *
 * The Hub stores `data` in memory so the user can download it as JSON or
 * CSV; the HTML is opened in a new tab for viewing / print-to-PDF.
 *
 * Expected POST payload:
 *   { prodText, collText, plText,
 *     practiceName, arPatient, arInsurance,
 *     hygieneData, employeeCosts, practiceProfile }
 *
 * Version: v41-report-only (Phase 1 of the Excel removal refactor)
 */

const fs = require('fs');
const path = require('path');

const ENGINE_VERSION = 'v41-report-only';

/* ─── Parsers (text from Claude → structured data) ─── */
function parseProduction(text) {
  const codes = [];
  let months = 12, years = [];
  for (const line of (text || '').split('\n')) {
    const dm = line.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
    if (dm && !years.length) {
      const from = new Date(dm[1]), to = new Date(dm[2]);
      months = Math.max(1, Math.round((to - from) / (1000*60*60*24*30.44)));
      for (let y = from.getFullYear(); y <= to.getFullYear(); y++) years.push(y);
      continue;
    }
    /* Match: CODE|DESC|QTY|TOTAL — codes can start with letter or digit */
    const m4 = line.match(/^([A-Z0-9][A-Z0-9.\-]{0,11})\|(.+?)\|(\d+)\|([\d,.]+)/i);
    if (m4) {
      const code = m4[1].toUpperCase(), desc = m4[2].trim();
      const qty = parseInt(m4[3]), total = parseFloat(m4[4].replace(/,/g,''));
      if (!isNaN(qty) && !isNaN(total)) codes.push({code, desc, qty, total});
      continue;
    }
    const m3 = line.match(/^([A-Z0-9][A-Z0-9.\-]{0,11})\|(\d+)\|([\d,.]+)/i);
    if (m3) {
      const code = m3[1].toUpperCase(), qty = parseInt(m3[2]), total = parseFloat(m3[3].replace(/,/g,''));
      if (!isNaN(qty) && !isNaN(total)) codes.push({code, desc:'', qty, total});
    }
  }
  if (!years.length) { const n = new Date(); years = [n.getFullYear()-1, n.getFullYear()]; }
  return { codes, months, years };
}

function parseCollections(text) {
  let charges = null, payments = null, months = null;
  for (const line of (text || '').split('\n')) {
    const dm = line.match(/DATES?\|.*?(\d{2}\/\d{2}\/\d{4})\s*[-–]\s*(\d{2}\/\d{2}\/\d{4})/i);
    if (dm) { const f = new Date(dm[1]), t = new Date(dm[2]); months = Math.max(1, Math.round((t-f)/(1000*60*60*24*30.44))); }
    const cm = line.match(/CHARGES?\|([\d,]+\.?\d*)/i);
    if (cm) charges = parseFloat(cm[1].replace(/,/g,''));
    const pm = line.match(/PAYMENTS?\|([\d,]+\.?\d*)/i);
    if (pm) payments = Math.abs(parseFloat(pm[1].replace(/,/g,'')));
  }
  return { charges, payments, months };
}

function parsePL(text) {
  const items = [];
  let totalIncome = null, totalExpense = null, netIncome = null;
  let currentSection = 'Expense';
  for (const line of (text || '').split('\n')) {
    const sm = line.match(/^TOTAL_INCOME\|([-\d,.]+)/i);
    if (sm) { totalIncome = Math.abs(parseFloat(sm[1].replace(/,/g,''))); continue; }
    const se = line.match(/^TOTAL_EXPENSE\|([-\d,.]+)/i);
    if (se) { totalExpense = Math.abs(parseFloat(se[1].replace(/,/g,''))); continue; }
    const sn = line.match(/^NET_INCOME\|([-\d,.]+)/i);
    if (sn) { netIncome = parseFloat(sn[1].replace(/,/g,'')); continue; }
    const secMatch = line.match(/^SECTION\|(.+)/i);
    if (secMatch) { currentSection = secMatch[1].trim(); continue; }
    if (/^DATES?\|/i.test(line)) continue;
    const m = line.match(/^(.+?)\|([-\d,.()+]+)/);
    if (m) {
      const item = m[1].trim();
      let raw = m[2].replace(/,/g,'');
      if (raw.startsWith('(') && raw.endsWith(')')) raw = '-' + raw.slice(1,-1);
      const amt = parseFloat(raw);
      if (!isNaN(amt) && item && !/total income|total expense|total sales|gross profit|net income|net operating|cost of goods|cogs/i.test(item)) {
        items.push({ item, amount: Math.abs(amt), section: currentSection });
      }
    }
  }
  /* Fallback: if no items tagged as Income but we have totalIncome, re-tag common income line items. */
  const hasIncome = items.some(i => i.section === 'Income');
  if (!hasIncome && totalIncome) {
    const incomePatterns = /^(sales|cc payment|cash payment|check payment|care credit|credit card|insurance payment|patient payment|collections|revenue|income|refunds? received|interest income|other income|dental income|service revenue)/i;
    for (const it of items) {
      if (incomePatterns.test(it.item)) it.section = 'Income';
    }
  }
  return { items, totalIncome, totalExpense, netIncome };
}

/* ─── P&L categorization ─── */
function plCategory(item) {
  const l = item.toLowerCase();
  if (/depreciat|amortiz/i.test(l)) return null;
  if (/car.*truck/i.test(l)) return 'O';
  if (/meal|entertainment|dining/i.test(l)) return 'O';
  if (/travel\b/i.test(l)) return 'O';
  if (/401k|retirement/i.test(l)) return 'O';
  if (/\bassociate\b/i.test(l)) return 'B';
  if (/\bhygien/i.test(l)) return 'C';
  if (/\bspecialist|specialty\b/i.test(l) && !/suppl/i.test(l)) return 'D';
  if (/\blab\b|laboratory/i.test(l)) return 'E';
  if (/dental.*suppl|job.*suppl/i.test(l)) return 'F';
  if (/specialist.*suppl/i.test(l)) return 'G';
  if (/payroll.*(wage|salar)|\bwages?\b|\bsalary\b|\bsalaries\b/i.test(l)) return 'H';
  if (/payroll.*tax/i.test(l)) return 'H';
  if (/payroll.*fee/i.test(l)) return 'H';
  if (/uniform|laundry/i.test(l)) return 'H';
  if (/\bbonus\b/i.test(l)) return 'I';
  if (/^rent|lease/i.test(l)) return 'J';
  if (/repair|maintenance/i.test(l)) return 'J';
  if (/advertis|marketing/i.test(l)) return 'K';
  if (/office.*suppl|software/i.test(l)) return 'L';
  return 'M';
}

/* ─── SWOT Analysis Generator ─── */
function generateSWOT(prodData, collData, plData, hygieneData, employeeCosts, arPatient, arInsurance) {
  const strengths = [], weaknesses = [], opportunities = [], threats = [];

  const { codes, months: prodMonths } = prodData;
  const totalProd = codes.reduce((s,c) => s + c.total, 0);
  const monthlyProd = prodMonths > 0 ? totalProd / prodMonths : 0;

  let netCollections = collData?.payments || plData?.totalIncome || 0;
  const collMonths = collData?.months || prodMonths || 1;
  if (netCollections > 0 && collMonths > prodMonths && prodMonths > 0) {
    netCollections = Math.round(netCollections / collMonths * prodMonths * 100) / 100;
  }
  const collectionRate = totalProd > 0 && netCollections > 0 ? (netCollections / totalProd * 100) : 0;

  const codeQty = (prefix) => codes.filter(c => c.code.startsWith(prefix)).reduce((s,c) => s + c.qty, 0);
  const codeTotal = (prefix) => codes.filter(c => c.code.startsWith(prefix)).reduce((s,c) => s + c.total, 0);

  const compExams = codeQty('D0150');
  const npPerMonth = prodMonths > 0 ? Math.round(compExams / prodMonths) : 0;

  const prophyQty = codeQty('D1110') + codeQty('D1120');
  const perioMaintQty = codeQty('D4910');
  const activePatientEst = Math.round((prophyQty + perioMaintQty) / (prodMonths / 12));

  const hygCodes = ['D1110','D1120','D4910','D4341','D4342','D4346','D4381','D0120','D0274'];
  let hygProd = 0;
  for (const hc of hygCodes) hygProd += codeTotal(hc);
  const hygPct = totalProd > 0 ? (hygProd / totalProd * 100) : 0;

  const srpQty = codeQty('D4341') + codeQty('D4342');
  const perioRatio = prophyQty > 0 ? (srpQty / prophyQty * 100) : 0;

  const endoTotal = codeTotal('D3310') + codeTotal('D3320') + codeTotal('D3330') + codeTotal('D3346') + codeTotal('D3347') + codeTotal('D3348');
  const osTotal = codeTotal('D7140') + codeTotal('D7210') + codeTotal('D7220') + codeTotal('D7230') + codeTotal('D7240') + codeTotal('D7250');
  const implantTotal = codeTotal('D6010') + codeTotal('D6011') + codeTotal('D6012') + codeTotal('D6013') + codeTotal('D6100') + codeTotal('D6104');
  const orthoTotal = codeTotal('D8040') + codeTotal('D8080') + codeTotal('D8090') + codeTotal('D8220');
  const specTotal = endoTotal + osTotal + implantTotal + orthoTotal;
  const specPct = totalProd > 0 ? (specTotal / totalProd * 100) : 0;

  const hasPanorex = codeQty('D0330') > 0;

  let staffCostPct = 0, labPct = 0, supplyPct = 0, netIncomePct = 0;
  let totalStaffCost = 0, totalLabCost = 0, totalSupplyCost = 0;
  if (plData && plData.items && netCollections > 0) {
    for (const item of plData.items) {
      if (item.section === 'Income' || item.section === 'COGS') continue;
      const cat = plCategory(item.item);
      if (cat === 'H') totalStaffCost += item.amount;
      const l = item.item.toLowerCase();
      if (/lab\s*(fee|cost|expense)/i.test(l) || l.includes('laboratory')) totalLabCost += item.amount;
      if (/dental.*suppl|job.*suppl/i.test(l)) totalSupplyCost += item.amount;
    }
    staffCostPct = (totalStaffCost / netCollections * 100);
    labPct = (totalLabCost / netCollections * 100);
    supplyPct = (totalSupplyCost / netCollections * 100);
    if (plData.netIncome != null) netIncomePct = (plData.netIncome / netCollections * 100);
  }

  /* Fallback: derive staff cost from employee-cost form if P&L doesn't give it. */
  if (employeeCosts && netCollections > 0 && totalStaffCost === 0) {
    let totalWages = 0;
    (employeeCosts.staff || []).forEach(p => { totalWages += (p.rate || 0) * (p.hours || 0) * 4.33; });
    (employeeCosts.hygiene || []).forEach(p => { totalWages += (p.rate || 0) * (p.hours || 0) * 4.33; });
    if (totalWages > 0) {
      const annualWages = totalWages * 12;
      const empStaffPct = annualWages / netCollections * 100;
      if (empStaffPct > 0) staffCostPct = empStaffPct;
    }
  }

  const totalAR = (arPatient?.total || 0) + (arInsurance?.total || 0);
  const ar90Plus = (arPatient?.d90plus || 0) + (arInsurance?.d90plus || 0);
  const ar90Pct = totalAR > 0 ? (ar90Plus / totalAR * 100) : 0;

  /* ── STRENGTHS ── */
  if (collectionRate >= 95) strengths.push('Collection rate is strong at ' + Math.round(collectionRate) + '%');
  if (hygPct >= 28) strengths.push('Hygiene department is performing well at ' + Math.round(hygPct) + '% of total production');
  if (staffCostPct > 0 && staffCostPct <= 22) strengths.push('Staff costs are well managed at ' + Math.round(staffCostPct) + '% of collections');
  if (npPerMonth >= 30) strengths.push('Strong new patient flow at ' + npPerMonth + ' per month');
  if (activePatientEst >= 1000) strengths.push('Practice has a strong active patient base, estimated at approximately ' + activePatientEst);
  if (perioMaintQty > 0 && perioRatio >= 15) strengths.push('Solid soft tissue management protocols appear to be in place');
  if (specTotal > 0 && specPct >= 5) strengths.push('The practice has established in-house specialty services');
  if (totalAR > 0 && ar90Pct < 5) strengths.push('AR management is healthy with minimal aged receivables');
  if (netIncomePct >= 30) strengths.push('Practice net income is strong at ' + Math.round(netIncomePct) + '% of collections');
  if (monthlyProd >= 80000) strengths.push('Production volume is strong at $' + Math.round(monthlyProd).toLocaleString() + ' per month');

  /* ── WEAKNESSES ── */
  if (collectionRate > 0 && collectionRate < 93) weaknesses.push('Collection rate of ' + Math.round(collectionRate) + '% is below the 98% benchmark');
  if (staffCostPct > 25) weaknesses.push('Staff wages at ' + Math.round(staffCostPct) + '% of collections significantly exceed the 20% benchmark');
  if (hygPct > 0 && hygPct < 25) weaknesses.push('Hygiene production at ' + Math.round(hygPct) + '% is below the 30-35% target');
  if (perioMaintQty === 0 && prophyQty > 0) weaknesses.push('Perio maintenance appears limited — no D4910 codes present');
  if (srpQty === 0 && prophyQty > 50) weaknesses.push('Periodontal disease appears to be under-diagnosed — no SRP procedures found');
  else if (perioRatio > 0 && perioRatio < 8 && prophyQty > 50) weaknesses.push('Periodontal disease may be under-diagnosed relative to the patient flow');
  if (!hasPanorex) weaknesses.push('The practice does not appear to have a Panorex');
  if (labPct > 5) weaknesses.push('Lab costs at ' + labPct.toFixed(1) + '% of collections exceed the 4% benchmark');
  if (supplyPct > 5) weaknesses.push('Dental supply costs at ' + supplyPct.toFixed(1) + '% are above benchmark');
  if (totalAR > 0 && ar90Pct > 10) weaknesses.push('Aged AR over 90 days at ' + Math.round(ar90Pct) + '% needs attention');
  if (npPerMonth > 0 && npPerMonth < 15) weaknesses.push('New patient flow is low at ' + npPerMonth + ' per month');
  if (activePatientEst > 0 && activePatientEst < 500) weaknesses.push('Active patient base is small, estimated at approximately ' + activePatientEst);
  if (netIncomePct > 0 && netIncomePct < 15) weaknesses.push('Net income at ' + Math.round(netIncomePct) + '% of collections is below the 30% target');

  /* ── OPPORTUNITIES ── */
  if (perioMaintQty === 0 || perioRatio < 10) opportunities.push('Developing soft tissue management protocols would increase patient care and hygiene revenue');
  if (hygPct > 0 && hygPct < 28) opportunities.push('Additional hygiene capacity could significantly increase patient flow and production');
  if (specTotal === 0) opportunities.push('Bringing specialists in-house would increase the range of treatment and revenue');
  if (collectionRate > 0 && collectionRate < 95) {
    const potentialRecovery = Math.round((0.98 - collectionRate/100) * totalProd);
    if (potentialRecovery > 0) opportunities.push('Improved collection systems could recover approximately $' + potentialRecovery.toLocaleString() + ' annually');
  }
  if (staffCostPct > 25) {
    const targetSavings = Math.round((staffCostPct/100 - 0.20) * netCollections / 12);
    if (targetSavings > 0) opportunities.push('Staff cost optimization could improve profitability by approximately $' + targetSavings.toLocaleString() + ' monthly');
  }
  if (npPerMonth > 0 && npPerMonth < 20) opportunities.push('Focused marketing could improve new patient flow');
  if (orthoTotal === 0) opportunities.push('Clear aligner therapy represents an untapped revenue opportunity');
  if (!hasPanorex) opportunities.push('A panoramic machine would assist in growing in-house specialty services');
  if (totalAR > 0 && ar90Pct > 10) {
    opportunities.push('Focused AR management could recover a significant portion of the $' + Math.round(ar90Plus).toLocaleString() + ' in 90+ day receivables');
  }

  /* ── THREATS ── */
  threats.push('A change in ownership or management style can lead to patient and staff attrition');
  if (staffCostPct > 25 && netIncomePct < 20) threats.push('Current overhead levels may prevent the practice from investing in growth');
  if (npPerMonth > 0) {
    const npProd = codeTotal('D0150');
    const npProdPct = totalProd > 0 ? (npProd / totalProd * 100) : 0;
    if (npProdPct > 5) threats.push('The practice may be overly reliant on new patient flow');
  }
  if (specPct > 15) threats.push('Heavy reliance on specialty services means the provider must be able to sustain this production');
  threats.push('Experienced staff may resist changes in philosophy or management style');

  /* Ensure minimum bullets per section */
  if (strengths.length === 0) strengths.push('Further data is needed to fully assess practice strengths');
  if (weaknesses.length === 0) weaknesses.push('No significant weaknesses were identified from the available data');
  if (opportunities.length === 0) opportunities.push('A comprehensive review of the practice operations could identify growth opportunities');
  if (threats.length === 0) threats.push('Market conditions and competitive landscape should be evaluated');

  return { strengths, weaknesses, opportunities, threats };
}

/* ─── HTML template loader ─── */
let _cachedReportTemplate = null;
function loadReportTemplate() {
  if (_cachedReportTemplate) return _cachedReportTemplate;
  const candidates = [
    path.resolve(__dirname, '..', '..', 'assessment-report-template.html'),
    path.resolve(__dirname, 'assessment-report-template.html'),
    path.resolve(process.cwd(), 'assessment-report-template.html'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      _cachedReportTemplate = fs.readFileSync(p, 'utf8');
      console.log('Report template loaded from:', p, '(' + _cachedReportTemplate.length + ' chars)');
      return _cachedReportTemplate;
    }
  }
  throw new Error('assessment-report-template.html not found in any expected location');
}

function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/*
 * computeReportData — the heart of the assessment.
 *
 * Takes raw parsed inputs + practice profile and returns the canonical data
 * object that drives everything: scorecard, opportunities, goals, SWOT, profile.
 * This is the object we return to the Hub as JSON — and the same object
 * renderReportHtml() reads to produce the HTML.
 */
function computeReportData(input) {
  const {
    prodData, collData, plData, employeeCosts, practiceProfile,
    arPatient, arInsurance, swotData, practiceName,
    totalProd, collTotal, years, prodMonths,
  } = input;

  const codes = prodData?.codes || [];
  const pp = practiceProfile || {};

  /* Normalize practice profile fields (names have drifted over time) */
  const zipCode = pp.zipCode || pp.zip || '';
  const website = pp.website || '';
  const pmSoftware = pp.pmSoftware || pp.software || '';
  const mix = pp.payorMix || { ppo: pp.payorPPO || 0, hmo: pp.payorHMO || 0, gov: pp.payorGov || 0, ffs: pp.payorFFS || 0 };
  const opsActive = pp.opsActive || pp.activeOps || null;
  const opsTotal = pp.opsTotal || pp.totalOps || null;
  const doctorDays = Number(pp.doctorDays) || 16;
  const hygieneDaysPerWeek = Number(pp.numHygienists) || Number(pp.hygieneDays) || 0;

  /* ──── Categorize production into hygiene / specialty / doctor ──── */
  const hygCodes = ['D1110','D1120','D4910','D4341','D4342','D4346','D4381','D0120','D0150','D0140','D0274'];
  const perioCodes = ['D4260','D4261','D4263','D4273','D4275','D4341','D4342','D4910'];
  const endoCodes = ['D3310','D3320','D3330','D3346','D3347','D3348'];
  const surgCodes = ['D7140','D7210','D7220','D7230','D7240','D7250'];
  const orthoCodes = ['D8080','D8090','D8010','D8020','D8030','D8040','D8070'];
  const cosmeticCodes = ['D9972','D9974','D2960','D2961','D2962'];
  const startsWithAny = (code, prefixes) => prefixes.some(p => code.startsWith(p));

  let prodHyg = 0, prodPerio = 0, prodEndo = 0, prodSurg = 0, prodOrtho = 0, prodCosmetic = 0, prodOther = 0;
  codes.forEach(c => {
    const code = (c.code || '').toUpperCase();
    const val = c.total || 0;
    if (hygCodes.includes(code) || startsWithAny(code, ['D1110','D1120','D4910','D4346','D4381'])) prodHyg += val;
    else if (perioCodes.includes(code) || startsWithAny(code, ['D4260','D4261','D4263','D4273','D4275','D4341','D4342'])) prodPerio += val;
    else if (endoCodes.includes(code) || startsWithAny(code, ['D33'])) prodEndo += val;
    else if (surgCodes.includes(code) || startsWithAny(code, ['D72'])) prodSurg += val;
    else if (orthoCodes.includes(code) || startsWithAny(code, ['D80'])) prodOrtho += val;
    else if (cosmeticCodes.includes(code)) prodCosmetic += val;
    else prodOther += val;  /* doctor general dentistry: fillings, crowns, etc. */
  });

  /* Annualize if prodMonths != 12 */
  const annualFactor = prodMonths && prodMonths !== 12 ? (12 / prodMonths) : 1;
  const annualProd = totalProd * annualFactor;
  const annualCollections = (collTotal || 0) * annualFactor;
  const annualHyg = prodHyg * annualFactor;
  const annualSpecialty = (prodPerio + prodEndo + prodSurg + prodOrtho + prodCosmetic) * annualFactor;
  const annualDoctor = (totalProd - prodHyg - prodPerio - prodEndo - prodSurg - prodOrtho - prodCosmetic) * annualFactor;

  /* ──── Daily averages (owner / associate / combined) ──── */
  const associateDaysPerMonth = pp.hasAssociate ? (Number(pp.associateDays) || 0) : 0;
  const ownerDaysYr = doctorDays * 12;
  const associateDaysYr = associateDaysPerMonth * 12;
  const totalDocDaysYr = ownerDaysYr + associateDaysYr;
  const surveyDocDaily = pp.docDailyAvg && pp.docDailyAvg !== 'idk' ? Number(pp.docDailyAvg) : null;

  let ownerDocDailyAvg = null;
  let associateDocDailyAvg = null;
  const combinedDocDailyAvg = totalDocDaysYr > 0 ? annualDoctor / totalDocDaysYr : null;

  if (surveyDocDaily && surveyDocDaily > 0 && ownerDaysYr > 0) {
    ownerDocDailyAvg = surveyDocDaily;
    if (associateDaysYr > 0) {
      const assocAnnual = annualDoctor - (ownerDocDailyAvg * ownerDaysYr);
      associateDocDailyAvg = assocAnnual > 0 ? assocAnnual / associateDaysYr : null;
    }
  } else {
    ownerDocDailyAvg = combinedDocDailyAvg;
  }

  const hygDaysPerYear = hygieneDaysPerWeek * 52;
  const hygDailyAvg = hygDaysPerYear > 0 ? annualHyg / hygDaysPerYear : null;

  /* ──── KPI benchmarks ──── */
  const collectionRate = annualProd > 0 ? (annualCollections / annualProd) * 100 : null;
  const hygPct = annualProd > 0 ? (prodHyg / totalProd) * 100 : null;
  const plExpensesRaw = plData?.totalExpense || plData?.totalExpenses || 0;
  const plIncome = plData?.totalIncome || 0;

  /* Adjust expenses for overhead % per Dave's methodology:
     subtract owner add-backs (car/truck, meals/entertainment, travel, 401k)
     and patient reimbursements (refunds, not operational expenses).
     Everything else — including associate/hygienist/specialist pay — stays,
     because those are real operational costs of running the practice. */
  let ownerAddBacks = 0;
  let patientReimbursements = 0;
  const ownerAddBackItems = [];
  if (plData?.items) {
    for (const item of plData.items) {
      if (item.section === 'Income' || item.section === 'COGS') continue;
      const cat = plCategory(item.item);
      if (cat === 'O') {
        ownerAddBacks += item.amount;
        ownerAddBackItems.push({ item: item.item, amount: item.amount });
      }
      if (/patient.*reimburs|refund/i.test(item.item)) {
        patientReimbursements += item.amount;
      }
    }
  }
  const plExpenses = Math.max(0, plExpensesRaw - ownerAddBacks - patientReimbursements);
  const overheadPct = (plIncome > 0 && plExpenses > 0) ? (plExpenses / plIncome) * 100 : null;
  const overheadRawPct = (plIncome > 0 && plExpensesRaw > 0) ? (plExpensesRaw / plIncome) * 100 : null;
  const profitPct = overheadPct != null ? 100 - overheadPct : null;

  /* Staff cost % of collections */
  let staffCostPct = null;
  if (employeeCosts && annualCollections > 0) {
    const sumRole = (arr, benefits, empCostPct) => {
      const wages = (arr || []).reduce((s, p) => s + (Number(p.rate) || 0) * (Number(p.hours) || 0) * 12, 0);
      const benefitsAnnual = (Number(benefits) || 0) * 12;
      const empCosts = wages * (Number(empCostPct) || 0);
      return wages + benefitsAnnual + empCosts;
    };
    const staffAnnual =
      sumRole(employeeCosts.staff, employeeCosts.staffBenefits, employeeCosts.staffEmpCostPct) +
      sumRole(employeeCosts.hygiene, employeeCosts.hygBenefits, employeeCosts.hygEmpCostPct);
    if (staffAnnual > 0) staffCostPct = (staffAnnual / annualCollections) * 100;
  }

  /* ──── Goal matrix ──── */
  const goalDocDaily = combinedDocDailyAvg || 0;
  const goalHygDaily = hygDailyAvg || 0;
  const gCurrentAnnual = annualProd;

  const gShortDocDaily = goalDocDaily * 1.15;
  const gShortHygDaily = goalHygDaily + 200;
  const gShortAnnual = (gShortDocDaily * totalDocDaysYr) + (gShortHygDaily * hygDaysPerYear) + annualSpecialty;

  const gLongDocDaily = goalDocDaily * 1.30;
  const gLongHygDaily = goalHygDaily + 400;
  const gLongAnnual = (gLongDocDaily * totalDocDaysYr) + (gLongHygDaily * hygDaysPerYear) + annualSpecialty;

  /* ──── Opportunities (top 3 by $) ──── */
  const opps = [];
  if (collectionRate > 0 && collectionRate < 95) {
    const target = 0.97;
    const gap = annualProd * target - annualCollections;
    if (gap > 5000) opps.push({
      icon: '💰', value: gap, title: 'Collection rate opportunity',
      body: `Current collection rate is ${collectionRate.toFixed(1)}% vs a 97% industry benchmark. Closing that gap at current production levels would recover roughly $${Math.round(gap).toLocaleString()} in annual collections.`
    });
  }
  if (hygPct < 30 && annualProd > 0) {
    const targetHyg = annualProd * 0.32;
    const hygGap = targetHyg - annualHyg;
    if (hygGap > 5000) opps.push({
      icon: '🦷', value: hygGap, title: 'Hygiene production gap',
      body: `Hygiene is ${hygPct.toFixed(1)}% of production vs a 30-33% target. Growing hygiene to the benchmark could add up to $${Math.round(hygGap).toLocaleString()} annually — and each new hygiene patient opens a doctor-diagnosed treatment pipeline.`
    });
  }
  if (overheadPct > 65 && plIncome > 0) {
    const targetOverhead = 0.60;
    const savings = plIncome * (overheadPct/100 - targetOverhead);
    if (savings > 5000) opps.push({
      icon: '📉', value: savings, title: 'Overhead reduction',
      body: `Overhead is ${overheadPct.toFixed(1)}% of income vs a 60% target for a well-run practice. Bringing it closer to benchmark could free up $${Math.round(savings).toLocaleString()} in additional profit annually.`
    });
  }
  if (staffCostPct != null && staffCostPct > 22 && annualCollections > 0) {
    const savings = annualCollections * (staffCostPct/100 - 0.20);
    if (savings > 5000) opps.push({
      icon: '👥', value: savings, title: 'Staff cost optimization',
      body: `Staff costs are ${staffCostPct.toFixed(1)}% of collections vs a 20% benchmark. Right-sizing toward benchmark could free approximately $${Math.round(savings).toLocaleString()} per year without cutting people — often a mix of schedule optimization and hygiene productivity.`
    });
  }
  const docLift = annualDoctor * 0.15;
  if (docLift > 10000) opps.push({
    icon: '📈', value: docLift, title: 'Doctor production lift (15%)',
    body: `A 15% short-term lift in doctor production is realistic with tighter scheduling and better case presentation — roughly $${Math.round(docLift).toLocaleString()} per year at current day counts.`
  });

  opps.sort((a, b) => b.value - a.value);
  const topOpps = opps.slice(0, 3);
  const totalOpportunity = topOpps.reduce((s, o) => s + o.value, 0);

  /* ──── Chart data for production bar + pie ──── */
  const prodCategories = [
    { label: 'General Dentistry', value: annualDoctor },
    { label: 'Hygiene', value: annualHyg },
    { label: 'Perio', value: prodPerio * annualFactor },
    { label: 'Endo', value: prodEndo * annualFactor },
    { label: 'Oral Surgery', value: prodSurg * annualFactor },
    { label: 'Ortho', value: prodOrtho * annualFactor },
    { label: 'Cosmetic', value: prodCosmetic * annualFactor },
  ].filter(c => c.value > 0).sort((a, b) => b.value - a.value);
  const prodSplit = [
    { label: 'Doctor', value: annualDoctor },
    { label: 'Hygiene', value: annualHyg },
    { label: 'Specialty', value: annualSpecialty },
  ].filter(c => c.value > 0);

  /* ──── Assemble canonical data object ──── */
  return {
    version: ENGINE_VERSION,
    generatedAt: new Date().toISOString(),

    practice: {
      name: practiceName || '',
      website, zipCode, pmSoftware,
      yearsOwned: pp.yearsOwned || null,
      ownerAge: pp.ownerAge || null,
      opsActive, opsTotal,
      doctorDays,
      hygieneDaysPerWeek,
      hasAssociate: !!pp.hasAssociate,
      associateDaysPerMonth,
      crownsPerMonth: pp.crownsPerMonth || null,
      payorMix: mix,
    },

    period: {
      prodMonths,
      years,
      annualFactor,
    },

    production: {
      total: totalProd,
      annualized: annualProd,
      byCategory: {
        doctor: annualDoctor,
        hygiene: annualHyg,
        perio: prodPerio * annualFactor,
        endo: prodEndo * annualFactor,
        oralSurgery: prodSurg * annualFactor,
        ortho: prodOrtho * annualFactor,
        cosmetic: prodCosmetic * annualFactor,
      },
      split: { doctor: annualDoctor, hygiene: annualHyg, specialty: annualSpecialty },
      categoriesForChart: prodCategories.map(c => ({ label: c.label, value: Math.round(c.value) })),
      splitForChart: prodSplit.map(c => ({ label: c.label, value: Math.round(c.value) })),
      codes: codes,
    },

    collections: {
      total: collTotal,
      annualized: annualCollections,
      collectionRate,
    },

    financials: {
      plIncome,
      plExpenses,                 /* adjusted: raw - owner add-backs - reimbursements */
      plExpensesRaw,              /* straight from the P&L */
      ownerAddBacks,              /* total subtracted for owner perks */
      ownerAddBackItems,          /* line-by-line so Dave can see what was pulled */
      patientReimbursements,      /* refunds subtracted */
      overheadPct,                /* adjusted (the one on the scorecard) */
      overheadRawPct,             /* raw, unadjusted — shown as a secondary number */
      profitPct,
      netIncome: plData?.netIncome != null ? plData.netIncome : null,
      staffCostPct,
    },

    ar: {
      patient: arPatient || null,
      insurance: arInsurance || null,
    },

    kpis: {
      annualProduction: annualProd,
      collectionRate,
      hygienePercent: hygPct,
      ownerDocDailyAvg,
      associateDocDailyAvg,
      combinedDocDailyAvg,
      hygDailyAvg,
      overheadPct,
      profitPct,
      staffCostPct,
    },

    goals: {
      current: { docDaily: goalDocDaily, hygDaily: goalHygDaily, annual: gCurrentAnnual },
      shortTerm: { docDaily: gShortDocDaily, hygDaily: gShortHygDaily, annual: gShortAnnual },
      longTerm: { docDaily: gLongDocDaily, hygDaily: gLongHygDaily, annual: gLongAnnual },
      totalDocDaysPerYear: totalDocDaysYr,
      hygDaysPerYear,
    },

    opportunities: {
      top3: topOpps,
      totalValue: totalOpportunity,
      all: opps,
    },

    swot: swotData || { strengths: [], weaknesses: [], opportunities: [], threats: [] },
  };
}

/*
 * renderReportHtml — turns the canonical data object into the HTML deliverable
 * by replacing {{placeholders}} in assessment-report-template.html.
 */
function renderReportHtml(data) {
  const { practice, period, production, collections, financials,
          kpis, goals, opportunities, swot, ar } = data;

  const fmt$ = n => n != null && isFinite(n) ? '$' + Math.round(n).toLocaleString() : '—';
  const fmt$k = n => n != null && isFinite(n) ? '$' + Math.round(n/1000).toLocaleString() + 'k' : '—';

  const statusVs = (val, target, higherIsBetter, warnPct = 0.90) => {
    if (val == null || !isFinite(val) || val === 0 || target == null) return '';
    const ratio = val / target;
    if (higherIsBetter) return ratio >= 1 ? 'good' : (ratio >= warnPct ? 'warn' : 'bad');
    return ratio <= 1 ? 'good' : (ratio <= (2 - warnPct) ? 'warn' : 'bad');
  };

  /* ── Scorecard cards ── */
  const scorecardCards = [
    { lbl: 'Annual Production', val: fmt$(kpis.annualProduction), bench: period.prodMonths ? `Based on ${period.prodMonths}mo, annualized` : '', status: '' },
    { lbl: 'Collection Rate', val: (kpis.collectionRate != null && kpis.collectionRate > 0) ? kpis.collectionRate.toFixed(1) + '%' : '—', bench: 'Target <strong>97%+</strong>', status: statusVs(kpis.collectionRate, 97, true) },
    { lbl: 'Hygiene % of Production', val: (kpis.hygienePercent != null && kpis.hygienePercent > 0) ? kpis.hygienePercent.toFixed(1) + '%' : '—', bench: 'Target <strong>30–33%</strong>', status: statusVs(kpis.hygienePercent, 30, true) },
    { lbl: 'Owner Doctor $/Day', val: fmt$(kpis.ownerDocDailyAvg), bench: `${practice.doctorDays} days/mo &middot; ${practice.doctorDays * 12} days/yr`, status: '' },
  ];
  if (practice.associateDaysPerMonth > 0) {
    scorecardCards.push({ lbl: 'Associate $/Day', val: fmt$(kpis.associateDocDailyAvg), bench: `${practice.associateDaysPerMonth} days/mo &middot; ${practice.associateDaysPerMonth * 12} days/yr`, status: '' });
    scorecardCards.push({ lbl: 'Combined Doctor $/Day', val: fmt$(kpis.combinedDocDailyAvg), bench: `${goals.totalDocDaysPerYear} total doctor-days/yr`, status: '' });
  }
  scorecardCards.push({ lbl: 'Hygiene Avg $/Day', val: fmt$(kpis.hygDailyAvg), bench: `${practice.hygieneDaysPerWeek} days/week`, status: '' });
  /* Overhead bench: show raw overhead alongside adjusted when we did any add-back. */
  const addBackTotal = (financials.ownerAddBacks || 0) + (financials.patientReimbursements || 0);
  const overheadBench = addBackTotal > 0
    ? `Target <strong>≤60%</strong> · raw ${financials.overheadRawPct ? financials.overheadRawPct.toFixed(1) : '—'}%, less $${Math.round(addBackTotal).toLocaleString()} add-backs`
    : 'Target <strong>≤60%</strong>';
  scorecardCards.push({ lbl: 'Overhead %', val: (kpis.overheadPct != null && kpis.overheadPct > 0) ? kpis.overheadPct.toFixed(1) + '%' : '—', bench: overheadBench, status: statusVs(kpis.overheadPct, 60, false) });

  const scorecardHtml = scorecardCards.map(c => `
    <div class="score-card ${c.status}">
      <div class="lbl">${htmlEscape(c.lbl)}</div>
      <div class="val">${c.val}</div>
      ${c.bench ? `<div class="bench">${c.bench}</div>` : ''}
    </div>
  `).join('');

  /* ── Opportunity cards ── */
  const oppHtml = opportunities.top3.length ? opportunities.top3.map(o => `
    <div class="opp-card">
      <div class="opp-icon">${o.icon}</div>
      <div class="opp-value">${fmt$(o.value)}</div>
      <div class="opp-unit">per year</div>
      <div class="opp-title">${htmlEscape(o.title)}</div>
      <div class="opp-body">${htmlEscape(o.body)}</div>
    </div>
  `).join('') : '<div style="color:#8899aa">No major opportunities identified — practice appears to be performing close to benchmarks across the board.</div>';

  /* ── Goal matrix rows ── */
  const goalRows = [
    { label: 'Combined Doctor $/Day', c: goals.current.docDaily, s: goals.shortTerm.docDaily, l: goals.longTerm.docDaily, fmt: fmt$ },
    { label: 'Hygiene $/Day', c: goals.current.hygDaily, s: goals.shortTerm.hygDaily, l: goals.longTerm.hygDaily, fmt: fmt$ },
    { label: 'Annual Doctor Production', c: production.byCategory.doctor, s: goals.shortTerm.docDaily * goals.totalDocDaysPerYear, l: goals.longTerm.docDaily * goals.totalDocDaysPerYear, fmt: fmt$k },
    { label: 'Annual Hygiene Production', c: production.byCategory.hygiene, s: goals.shortTerm.hygDaily * goals.hygDaysPerYear, l: goals.longTerm.hygDaily * goals.hygDaysPerYear, fmt: fmt$k },
  ];
  const goalRowsHtml = goalRows.map(r => `
    <tr>
      <td class="row-label">${htmlEscape(r.label)}</td>
      <td><span class="val current">${r.fmt(r.c)}</span></td>
      <td><span class="val short">${r.fmt(r.s)}</span></td>
      <td><span class="val long">${r.fmt(r.l)}</span></td>
    </tr>
  `).join('') + `
    <tr class="total">
      <td>Total Annual Production</td>
      <td><span class="val current">${fmt$k(goals.current.annual)}</span></td>
      <td><span class="val short">${fmt$k(goals.shortTerm.annual)}</span></td>
      <td><span class="val long">${fmt$k(goals.longTerm.annual)}</span></td>
    </tr>
  `;

  /* ── Financial cards ── */
  const financialCards = [
    { lbl: 'Annual Revenue (P&L)', val: financials.plIncome > 0 ? fmt$(financials.plIncome) : '—', bench: financials.plIncome > 0 ? 'From P&L statement' : 'P&L not uploaded' },
    { lbl: 'Annual Expenses', val: financials.plExpenses > 0 ? fmt$(financials.plExpenses) : '—', bench: financials.plExpenses > 0 ? '' : 'Not available in P&L' },
    { lbl: 'Profit Margin', val: (financials.profitPct != null && financials.profitPct > 0 && financials.profitPct < 100) ? financials.profitPct.toFixed(1) + '%' : '—', bench: 'Target <strong>≥35%</strong>', status: statusVs(financials.profitPct, 35, true) },
    { lbl: 'Staff Cost / Collections', val: (financials.staffCostPct != null && financials.staffCostPct > 0) ? financials.staffCostPct.toFixed(1) + '%' : '—', bench: 'Target <strong>≤22%</strong>', status: statusVs(financials.staffCostPct, 22, false) },
    { lbl: 'Patient AR (90+ days)', val: fmt$(ar.patient?.over90 || ar.patient?.d90plus), bench: ar.patient?.total ? `of ${fmt$(ar.patient.total)} total` : '' },
    { lbl: 'Insurance AR (90+ days)', val: fmt$(ar.insurance?.over90 || ar.insurance?.d90plus), bench: ar.insurance?.total ? `of ${fmt$(ar.insurance.total)} total` : '' },
  ];
  const financialHtml = financialCards.map(c => `
    <div class="score-card ${c.status || ''}">
      <div class="lbl">${htmlEscape(c.lbl)}</div>
      <div class="val">${c.val}</div>
      ${c.bench ? `<div class="bench">${c.bench}</div>` : ''}
    </div>
  `).join('');

  /* ── SWOT lists ── */
  const swotLi = items => (items && items.length ? items.map(i => `<li>${htmlEscape(i)}</li>`).join('') : '<li style="color:#8899aa">—</li>');

  /* ── Practice profile rows ── */
  const softwareNames = { dentrix: 'Dentrix', eaglesoft: 'Eaglesoft', opendental: 'Open Dental', other: 'Other' };
  const mix = practice.payorMix || {};
  const profileRows = [
    ['Practice Name', practice.name],
    ['Website', practice.website],
    ['Zip Code', practice.zipCode],
    ['Practice Management Software', softwareNames[practice.pmSoftware] || practice.pmSoftware],
    ['Years Owned', practice.yearsOwned ? practice.yearsOwned + ' years' : ''],
    ['Owner Age', practice.ownerAge ? practice.ownerAge + ' years old' : ''],
    ['Operatories', (practice.opsActive && practice.opsTotal) ? `${practice.opsActive} active of ${practice.opsTotal}` : ''],
    ['Doctor Days / Month', practice.doctorDays ? practice.doctorDays + ' days' : ''],
    ['Hygiene Days / Week', practice.hygieneDaysPerWeek ? practice.hygieneDaysPerWeek + ' days' : ''],
    ['In-Network PPO', (mix.ppo || 0) + '%'],
    ['HMO', (mix.hmo || 0) + '%'],
    ['Medicaid / Gov', (mix.gov || 0) + '%'],
    ['Fee-for-Service', (mix.ffs || 0) + '%'],
    ['Has Associate Doctor', practice.hasAssociate ? `Yes (${practice.associateDaysPerMonth || 0} days/mo)` : 'No'],
    ['Crowns / Month', practice.crownsPerMonth || ''],
  ].filter(r => r[1] !== '' && r[1] != null);
  const profileHtml = profileRows.map(r => `
    <div class="profile-row"><span class="k">${htmlEscape(r[0])}</span><span class="v">${htmlEscape(r[1])}</span></div>
  `).join('');

  /* ── Chart data for the inlined <script> ── */
  const reportJson = {
    productionByCategory: production.categoriesForChart,
    productionSplit: production.splitForChart,
  };

  /* ── Period label for hero ── */
  const periodLabel = period.prodMonths
    ? `Based on ${period.prodMonths} months of production data` + (period.years && period.years.length ? ` (${period.years.join(', ')})` : '')
    : 'Based on uploaded reports';
  const generatedDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  let template = loadReportTemplate();
  const replacements = {
    practiceName: htmlEscape(practice.name || 'Practice Assessment'),
    periodLabel: htmlEscape(periodLabel),
    generatedDate: htmlEscape(generatedDate),
    totalOpportunity: fmt$(opportunities.totalValue),
    scorecardCards: scorecardHtml,
    opportunityCards: oppHtml,
    goalRows: goalRowsHtml,
    financialCards: financialHtml,
    swotStrengths: swotLi(swot.strengths),
    swotWeaknesses: swotLi(swot.weaknesses),
    swotOpportunities: swotLi(swot.opportunities),
    swotThreats: swotLi(swot.threats),
    profileRows: profileHtml,
    engineVersion: htmlEscape(data.version || ''),
    reportJson: JSON.stringify(reportJson),
  };
  for (const [key, val] of Object.entries(replacements)) {
    template = template.split('{{' + key + '}}').join(val);
  }
  return template;
}

/* ─── Handler ─── */
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST,OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    prodText, collText, plText,
    practiceName = '',
    arPatient = {}, arInsurance = {},
    hygieneData = null, employeeCosts = null,
    practiceProfile = null,
  } = body;

  if (!prodText) {
    return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'prodText required' }) };
  }

  try {
    const t0 = Date.now();

    /* Parse PDFs → structured data */
    const prodData = parseProduction(prodText);
    const collData = collText ? parseCollections(collText) : null;
    const plData = plText ? parsePL(plText) : null;

    const codes = prodData.codes || [];
    const totalProd = codes.reduce((s, c) => s + c.total, 0);
    const prodMonths = prodData.months;
    const years = prodData.years;

    /* Collections total — pro-rate if the collections period differs */
    let collTotal = collData?.payments || plData?.totalIncome || 0;
    const collMonths = collData?.months || prodMonths || 1;
    if (collTotal > 0 && collMonths > prodMonths && prodMonths > 0) {
      collTotal = Math.round(collTotal / collMonths * prodMonths * 100) / 100;
    }

    /* SWOT */
    const swotData = generateSWOT(prodData, collData, plData, hygieneData, employeeCosts, arPatient, arInsurance);

    /* Compute canonical data object */
    const data = computeReportData({
      prodData, collData, plData, employeeCosts, practiceProfile,
      arPatient, arInsurance, swotData, practiceName,
      totalProd, collTotal, years, prodMonths,
    });

    /* Render HTML */
    const reportHtml = renderReportHtml(data);

    const elapsed = Date.now() - t0;
    console.log(`generate-report: ${codes.length} codes, ${prodMonths}mo, ${elapsed}ms, ${reportHtml.length} chars of HTML`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        success: true,
        data,
        reportHtml,
        summary: {
          version: ENGINE_VERSION,
          codesFound: codes.length,
          totalProduction: totalProd.toFixed(2),
          months: prodMonths,
          years,
          netCollections: collTotal,
          plParsed: plData !== null && plData.items.length > 0,
          arPatientTotal: arPatient?.total || null,
          arInsuranceTotal: arInsurance?.total || null,
          timingMs: elapsed,
        },
      }),
    };
  } catch (err) {
    console.error('generate-report error:', err.message, err.stack?.slice(0, 500));
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
