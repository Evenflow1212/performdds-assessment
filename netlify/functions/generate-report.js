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
function generateSWOT(prodData, collData, plData, hygieneData, employeeCosts, arPatient, arInsurance, practiceProfile) {
  /* practiceProfile carries survey answers — used for payor-mix + goals-absent rules */
  const pp = practiceProfile || {};
  const mix = pp.payorMix || { ppo: pp.payorPPO || 0, hmo: pp.payorHMO || 0, gov: pp.payorGov || 0, ffs: pp.payorFFS || 0 };
  const ffsPct = Number(mix.ffs || 0);
  const ppoPct = Number(mix.ppo || 0);
  const govPct = Number(mix.gov || 0);
  const hmoPct = Number(mix.hmo || 0);
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
  /* Hygiene lift: when hygiene % is below target, offer specific interventions Dave teaches.
     A formal soft-tissue-management program is the biggest lever; Arestin and laser-
     assisted periodontal therapy are the next-tier productivity adjuncts. */
  if (hygPct > 0 && hygPct < 28) {
    opportunities.push('Hygiene is below target at ' + hygPct.toFixed(1) + '% of production. A formal soft-tissue-management program — clear screening criteria that identify patients transitioning from healthy to periodontal disease and route them into appropriate perio care — is the highest-leverage move to raise both hygiene productivity and standard of care');
    opportunities.push('Add-on therapies like Arestin (site-specific antibiotic placement) and laser-assisted periodontal treatment expand the hygienist\'s clinical toolkit and materially lift per-visit production');
  } else if (perioMaintQty === 0 || perioRatio < 10) {
    /* Hygiene % is OK but perio diagnosis is thin — still worth flagging STM. */
    opportunities.push('Developing soft tissue management protocols would increase patient care and hygiene revenue');
  }
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

  /* ── Payor-mix rules (survey-driven, simplified v1) ─────────────────────
     Full spec in BACKLOG.md: cosmetic/boutique exemption and per-state PPO
     intelligence come later. This v1 fires when a practice is heavily FFS
     and new-patient flow is soft — the common impediment case. */
  if (ffsPct >= 70) {
    if (npPerMonth > 0 && npPerMonth < 20) {
      weaknesses.push('New patient flow is low (' + npPerMonth + '/month) while the practice runs at ' + ffsPct + '% out-of-network. Being out of network is an impediment to new-patient acquisition in most markets.');
      opportunities.push('Selectively joining one or two high-paying PPOs would open the practice to more patients without wholesale discounting. Accepting their fee schedule (typically 15–25% below UCR) is the trade-off, which is why carrier selection matters — aim for the top-tier payers in your area. If being out-of-network is core to the practice identity, treat this as something to consider, not a prescription.');
    } else if (npPerMonth >= 30) {
      strengths.push('Strong new-patient flow of ' + npPerMonth + '/month despite running at ' + ffsPct + '% out-of-network — earning a living as a largely FFS practice is genuinely hard, and this volume says the brand is working.');
    }
  }
  /* Mixed PPO + government/HMO → growing PPO is structurally hard */
  if (ppoPct >= 20 && (govPct + hmoPct) >= 20) {
    weaknesses.push('The practice blends meaningful PPO volume (' + ppoPct + '%) with government/HMO volume (' + (govPct + hmoPct) + '%). Growing the PPO portion is typically hard in this configuration — the pace and style that Medicaid/HMO economics require works against the experience PPO patients expect.');
  }

  /* ── Goals & Vision rule (survey-driven) ────────────────────────────────
     When the dentist admits they don't have production goals or don't know
     mid-month whether they're ahead or behind, that's foundational — every
     other improvement is downstream of "are you measuring anything." */
  const hasGoal = pp.hasProductionGoal || '';
  const knowsIfAhead = pp.knowsIfAhead || '';
  const goalsGap = (hasGoal === 'no' || hasGoal === 'sort_of') ||
                   (knowsIfAhead === 'no' || knowsIfAhead === 'sometimes');
  if (goalsGap) {
    weaknesses.push('Without a clearly stated production goal and a weekly/monthly tracking rhythm, every other improvement surfaced in this report is hard to sustain — there\'s no destination to measure progress against.');
    opportunities.push('Building out production goals and a scorekeeping cadence is typically the first 30 days of coaching. It\'s the foundation that makes every other recommendation actionable.');
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

  /* ──── Batting Average inputs (knowledge base: kpis/batting-average.yaml) ──── */
  const VISIT_CODES = ['D1110','D1120','D4910','D4341','D4342','D0150'];
  const CROWN_CODES = [
    /* Porcelain / ceramic */
    'D2740','D2750','D2751','D2752',
    /* Resin */
    'D2710','D2712',
    /* Cast metal / gold */
    'D2780','D2781','D2782','D2783','D2790','D2791','D2792','D2794',
    /* Veneers */
    'D2960','D2961','D2962',
    /* Implant crowns */
    'D6058','D6059','D6060','D6061','D6062','D6063','D6064','D6065','D6066','D6067',
    /* Bridge units (pontics + abutment crowns + cantilever retainers) */
    'D6210','D6211','D6212','D6214','D6240','D6241','D6242','D6243','D6245','D6250','D6251','D6252','D6253',
    'D6545','D6548','D6549','D6710','D6720','D6721','D6722','D6740','D6750','D6751','D6752','D6753',
    'D6780','D6781','D6782','D6783','D6790','D6791','D6792','D6793','D6794',
  ];
  const countCodeMatchingQty = (list) => codes
    .filter(c => list.includes((c.code || '').toUpperCase()))
    .reduce((s, c) => s + (c.qty || 0), 0);
  const visitsCount = countCodeMatchingQty(VISIT_CODES);
  const crownsPreppedCount = countCodeMatchingQty(CROWN_CODES);
  const exam0120Count = codes
    .filter(c => (c.code || '').toUpperCase().startsWith('D0120'))
    .reduce((s, c) => s + (c.qty || 0), 0);
  const battingAverage = crownsPreppedCount > 0 ? visitsCount / crownsPreppedCount : null;

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

  const surveyAssocDaily = pp.assocDailyAvg && pp.assocDailyAvg !== 'idk' ? Number(pp.assocDailyAvg) : null;

  let ownerDocDailyAvg = null;
  let associateDocDailyAvg = null;
  let hasOwnerSplit = false;  /* true → show Owner + Associate + Combined cards */
  const combinedDocDailyAvg = totalDocDaysYr > 0 ? annualDoctor / totalDocDaysYr : null;

  if (associateDaysYr > 0 && surveyDocDaily > 0 && surveyAssocDaily > 0) {
    /* Both survey values given — use them directly, no derivation. */
    ownerDocDailyAvg = surveyDocDaily;
    associateDocDailyAvg = surveyAssocDaily;
    hasOwnerSplit = true;
  } else if (associateDaysYr > 0 && surveyDocDaily > 0 && ownerDaysYr > 0) {
    /* Owner $/day given; derive associate from remainder. */
    ownerDocDailyAvg = surveyDocDaily;
    const assocAnnual = annualDoctor - (ownerDocDailyAvg * ownerDaysYr);
    associateDocDailyAvg = assocAnnual > 0 ? assocAnnual / associateDaysYr : null;
    hasOwnerSplit = !!(associateDocDailyAvg && associateDocDailyAvg > 0);
  } else if (associateDaysYr > 0 && surveyAssocDaily > 0 && ownerDaysYr > 0) {
    /* Associate $/day given; derive owner from remainder. */
    associateDocDailyAvg = surveyAssocDaily;
    const ownerAnnual = annualDoctor - (associateDocDailyAvg * associateDaysYr);
    ownerDocDailyAvg = ownerAnnual > 0 ? ownerAnnual / ownerDaysYr : null;
    hasOwnerSplit = !!(ownerDocDailyAvg && ownerDocDailyAvg > 0);
  } else {
    /* No reliable split available — show combined only. */
    ownerDocDailyAvg = combinedDocDailyAvg;
    associateDocDailyAvg = null;
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

  /* ──── Sources of Dollars — where collections come from ──── */
  /* Categorize income-section P&L items by payment source pattern. Most QB-style P&Ls
     list patient payment methods explicitly (CC Payments, Check Payments, Cash Payments,
     Care Credit / Lending Club) and route everything else through a generic "Sales" line
     that represents insurance-posted revenue. Pattern matching is defensive — unknown
     line items fall through to "Other". */
  const sourcesOfDollars = { insurance: 0, patientCreditCard: 0, patientCheck: 0, patientCash: 0, thirdPartyFinance: 0, government: 0, other: 0 };
  const sourceItems = [];
  if (plData?.items) {
    for (const item of plData.items) {
      if (item.section !== 'Income') continue;
      const l = (item.item || '').toLowerCase();
      let bucket = 'other';
      if (/care\s*credit|lending\s*club|cherry|alphaeon|sunbit|proceed\s*finance/i.test(l)) bucket = 'thirdPartyFinance';
      else if (/\bcc\b|credit\s*card/i.test(l)) bucket = 'patientCreditCard';
      else if (/check\s*payment|\bcheck\b/i.test(l)) bucket = 'patientCheck';
      else if (/cash\s*payment|\bcash\b/i.test(l)) bucket = 'patientCash';
      else if (/capitation|medicaid|medi[-\s]?cal|medicare|hmo|dmo|dental\s*insurance|insurance\s*pay/i.test(l)) bucket = 'government';
      else if (/^sales$|^total\s*sales$|insurance\s*income|patient\s*insurance|insurance\s*receipts/i.test(l)) bucket = 'insurance';
      /* Best-guess default: a bare "Sales" line on a QuickBooks dental P&L is usually insurance-posted revenue */
      else if (/\bsales\b/i.test(l)) bucket = 'insurance';
      sourcesOfDollars[bucket] += item.amount;
      sourceItems.push({ item: item.item, amount: item.amount, bucket });
    }
  }
  const sourcesTotal = Object.values(sourcesOfDollars).reduce((s, v) => s + v, 0);
  const sourcesPct = {};
  Object.keys(sourcesOfDollars).forEach(k => {
    sourcesPct[k] = sourcesTotal > 0 ? (sourcesOfDollars[k] / sourcesTotal) * 100 : 0;
  });
  /* Roll up patient-pay methods for a simpler "patient pay" aggregate */
  const patientPayTotal = sourcesOfDollars.patientCreditCard + sourcesOfDollars.patientCheck + sourcesOfDollars.patientCash;
  const patientPayPct = sourcesTotal > 0 ? (patientPayTotal / sourcesTotal) * 100 : 0;
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

  /* ──── Targets & Goal synthesis (per Dave's Pigneri reference workbook) ────
     Structure: per-stream rows with {days, daily, monthly}. Initial Monthly
     Target = current capacity with a modest productivity lift. Long Term
     Monthly Goal = stretch per BACKLOG rules (+$250 hyg/day, +$500 doc/day,
     etc.). Specialty days auto-derived from actual specialty production
     ÷ industry daily target. */
  const codeQtyAnnual = (prefixes) => {
    const list = Array.isArray(prefixes) ? prefixes : [prefixes];
    const matches = (codes || []).filter(c =>
      list.some(pfx => (c.code || '').toUpperCase().startsWith(pfx.toUpperCase()))
    );
    const qty = matches.reduce((s, c) => s + (c.qty || 0), 0);
    return qty * annualFactor;
  };
  const monthlyFromAnnual = (d) => Math.round(d / 12);
  const daysFromMonthly = (monthlyDollars, dailyRate) =>
    (monthlyDollars > 0 && dailyRate > 0) ? Math.max(1, Math.round(monthlyDollars / dailyRate)) : 0;

  const hygDaysPerMonth = Math.round(hygieneDaysPerWeek * 4);
  const docDailyCurrent = Math.round(ownerDocDailyAvg || combinedDocDailyAvg || 0);
  const hygDailyCurrent = Math.round(hygDailyAvg || 0);

  /* Initial Monthly Target daily rates (industry benchmarks + modest lift) */
  const initialGeneralDaily = Math.max(4500, docDailyCurrent + 250);
  const initialAssocDaily = 3000;
  const initialHygDaily = Math.max(1000, hygDailyCurrent + 200);
  const initialOtherDaily = 20000;

  /* Specialty monthly production from the byCategory split */
  const monthlyPerio = monthlyFromAnnual(prodPerio * annualFactor);
  const monthlyEndo = monthlyFromAnnual(prodEndo * annualFactor);
  const monthlySurg = monthlyFromAnnual(prodSurg * annualFactor);
  const monthlyOrtho = monthlyFromAnnual(prodOrtho * annualFactor);

  const buildTargetsRow = (days, daily, cost, costPct) => ({
    days, daily, monthly: days * daily,
    ...(cost != null ? { cost } : {}),
    ...(costPct != null ? { costPct } : {}),
  });

  /* Cost semantics by stream: general dentist / associate / hygiene / cap
     use `cost` = $ per day (so G = cost × days). Specialties (perio / endo /
     oralSurg / ortho / other) use `costPct` = fraction of monthly production
     (so G = costPct × monthly). */
  const targetsInitial = {
    generalDentist: buildTargetsRow(doctorDays, initialGeneralDaily, 0, null),
    associateGP:    buildTargetsRow(associateDaysPerMonth, initialAssocDaily, 700, null),
    hygiene:        buildTargetsRow(hygDaysPerMonth, initialHygDaily, 600, null),
    perioSurgery:   buildTargetsRow(daysFromMonthly(monthlyPerio, 5000), 5000, null, 0.50),
    endo:           buildTargetsRow(daysFromMonthly(monthlyEndo, 5000), 5000, null, 0.50),
    oralSurgery:    buildTargetsRow(daysFromMonthly(monthlySurg, 8000), 8000, null, 0.50),
    ortho:          buildTargetsRow(daysFromMonthly(monthlyOrtho, 5000), 5000, null, 0),
    cap:            buildTargetsRow(0, 0, 0, null),
    other:          buildTargetsRow(0, initialOtherDaily, null, 0.50),
  };
  const targetsInitialMonthly = Object.values(targetsInitial).reduce((s, r) => s + r.monthly, 0);
  const targetsInitialAnnual = targetsInitialMonthly * 12;

  /* Long Term Monthly Goal (stretch) */
  const longTermGeneralDaily = initialGeneralDaily + 500;
  const longTermHygDaily = initialHygDaily + 250;
  const targetsLongTerm = {
    generalDentist: buildTargetsRow(doctorDays, longTermGeneralDaily, 0, null),
    associateGP:    buildTargetsRow(associateDaysPerMonth, initialAssocDaily, 700, null),
    hygiene:        buildTargetsRow(hygDaysPerMonth, longTermHygDaily, 600, null),
    perioSurgery:   buildTargetsRow(targetsInitial.perioSurgery.days, 10000, null, 0.50),
    endo:           buildTargetsRow(targetsInitial.endo.days, 5000, null, 0.50),
    oralSurgery:    buildTargetsRow(targetsInitial.oralSurgery.days, 8000, null, 0.50),
    ortho:          buildTargetsRow(targetsInitial.ortho.days + 1, 5000, null, 0),  /* +1 ortho day per BACKLOG rule */
    cap:            buildTargetsRow(0, 9000, 0, null),
    other:          buildTargetsRow(0, initialOtherDaily, null, 0.50),
  };
  const targetsLongTermMonthly = Object.values(targetsLongTerm).reduce((s, r) => s + r.monthly, 0);
  const targetsLongTermAnnual = targetsLongTermMonthly * 12;

  /* ──── Hygiene Potential (rows 38–53 of the reference workbook) ────
     Active patient estimate from procedure volume, then potential appts
     at industry compliance rates, then hygiene-days-required-per-month. */
  const prophyAnnual = codeQtyAnnual('D1110');
  const perioMaintAnnual = codeQtyAnnual('D4910');
  const srpAnnual = codeQtyAnnual(['D4341', 'D4342']);
  const compExamAnnual = codeQtyAnnual('D0150');

  const patientsFromProphy = prophyAnnual / 2;
  const patientsFromPerioMaint = perioMaintAnnual / 4;
  const patientsFromSRP = srpAnnual / 16;
  const hardActivePatients = patientsFromProphy + patientsFromPerioMaint + patientsFromSRP;
  const activePatientEstimate = hardActivePatients > 0 ? Math.round(hardActivePatients / 0.80) : 0;
  const newPatientsPerMo = compExamAnnual > 0 ? Math.round(compExamAnnual / 12) : 0;

  const perioDiseasePct = 0.30;   /* template default; can be overridden in future */
  const probingPerioPct = 0.10;

  const totalPatientsPerYear = activePatientEstimate + newPatientsPerMo * 12;
  const potentialAdultProphy = Math.round(totalPatientsPerYear * (1 - perioDiseasePct) * 2 * 0.80);
  const potentialPerioMaint = Math.round(totalPatientsPerYear * perioDiseasePct * 4 * 0.50);
  const potentialSRP = Math.round((potentialAdultProphy + potentialPerioMaint) * probingPerioPct * 2 * 0.75);
  const potentialApptsTotal = potentialAdultProphy + potentialPerioMaint + potentialSRP;

  const patientsPerHygPerDay = Number(pp.patientsPerHygienistPerDay) || 8;
  const daysRequiredPerMo = patientsPerHygPerDay > 0 && potentialApptsTotal > 0
    ? Math.round((potentialApptsTotal / patientsPerHygPerDay) / 12)
    : 0;
  const capacityGapDays = Math.max(0, daysRequiredPerMo - hygDaysPerMonth);
  const capacityGapVisitsPerMo = capacityGapDays * patientsPerHygPerDay;
  const hygVisitValue = hygDailyAvg && patientsPerHygPerDay > 0 ? hygDailyAvg / patientsPerHygPerDay : 145;  /* fallback industry $/visit */
  const capacityGapAnnualDollars = Math.round(capacityGapVisitsPerMo * 12 * hygVisitValue);

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
      sourcesOfDollars: {
        dollars: sourcesOfDollars,
        percent: sourcesPct,
        total: sourcesTotal,
        items: sourceItems,
        patientPayTotal,
        patientPayPct,
      },
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
      hasOwnerSplit,            /* true → show Owner + Associate + Combined; false → show Combined only */
      hygDailyAvg,
      overheadPct,
      profitPct,
      staffCostPct,
      battingAverage,           /* visits ÷ crowns prepped (lower is better; sweet spot 4-6:1) */
      battingAverageInputs: {
        visitsCount,
        crownsPreppedCount,
        exam0120Count,          /* diagnostic companion for BA — compare to visitsCount when BA is high */
      },
    },

    goals: {
      current: { docDaily: goalDocDaily, hygDaily: goalHygDaily, annual: gCurrentAnnual },
      shortTerm: { docDaily: gShortDocDaily, hygDaily: gShortHygDaily, annual: gShortAnnual },
      longTerm: { docDaily: gLongDocDaily, hygDaily: gLongHygDaily, annual: gLongAnnual },
      totalDocDaysPerYear: totalDocDaysYr,
      hygDaysPerYear,

      /* Per-stream Targets & Goal matrix — mirrors the reference workbook
         structure (general / associate / hygiene / specialties) with
         {days, daily, monthly} on each row. Initial = current-capacity
         lift, Long Term = stretch. */
      targets: {
        initial: targetsInitial,
        initialMonthly: targetsInitialMonthly,
        initialAnnual: targetsInitialAnnual,
        longTerm: targetsLongTerm,
        longTermMonthly: targetsLongTermMonthly,
        longTermAnnual: targetsLongTermAnnual,
      },

      /* Hygiene capacity potential — what the practice COULD be doing
         given its actual patient base (active patient estimate from
         procedure counts + industry compliance rates). */
      hygienePotential: {
        activePatientEstimate,
        newPatientsPerMo,
        perioDiseasePct,
        probingPerioPct,
        hardActivePatientsFromProcedures: Math.round(hardActivePatients),
        potentialAppts: {
          adultProphy: potentialAdultProphy,
          perioMaint: potentialPerioMaint,
          srp: potentialSRP,
          total: potentialApptsTotal,
        },
        patientsPerHygienistPerDay: patientsPerHygPerDay,
        daysRequiredPerMo,
        currentHygDaysPerMo: hygDaysPerMonth,
        capacityGapDays,
        capacityGapVisitsPerMo,
        capacityGapAnnualDollars,
        hygVisitValue: Math.round(hygVisitValue),
      },
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
  ];
  /* Doctor $/day: only one card — Combined — because owner-vs-associate production
     can't be reliably derived from practice totals alone. The split logic still exists
     in computeReportData (ownerDocDailyAvg, associateDocDailyAvg, hasOwnerSplit) and
     will be wired back in once we parse per-provider production from the PDFs. */
  {
    const hasAssoc = practice.associateDaysPerMonth > 0;
    scorecardCards.push({
      lbl: hasAssoc ? 'Combined Doctor $/Day' : 'Doctor $/Day',
      val: fmt$(kpis.combinedDocDailyAvg || kpis.ownerDocDailyAvg),
      bench: hasAssoc
        ? `${goals.totalDocDaysPerYear} total doctor-days/yr across owner + associate`
        : `${practice.doctorDays} days/mo &middot; ${practice.doctorDays * 12} days/yr`,
      status: '',
    });
  }
  scorecardCards.push({ lbl: 'Hygiene Avg $/Day', val: fmt$(kpis.hygDailyAvg), bench: `${practice.hygieneDaysPerWeek} days/week`, status: '' });
  /* Overhead bench: show raw overhead alongside adjusted when we did any add-back. */
  const addBackTotal = (financials.ownerAddBacks || 0) + (financials.patientReimbursements || 0);
  const overheadBench = addBackTotal > 0
    ? `Target <strong>≤60%</strong> · raw ${financials.overheadRawPct ? financials.overheadRawPct.toFixed(1) : '—'}%, less $${Math.round(addBackTotal).toLocaleString()} add-backs`
    : 'Target <strong>≤60%</strong>';
  scorecardCards.push({ lbl: 'Overhead %', val: (kpis.overheadPct != null && kpis.overheadPct > 0) ? kpis.overheadPct.toFixed(1) + '%' : '—', bench: overheadBench, status: statusVs(kpis.overheadPct, 60, false) });

  /* Batting Average — visits ÷ crowns prepped. Lower is better; sweet spot 4-6:1. */
  if (kpis.battingAverage != null && kpis.battingAverage > 0) {
    const ba = kpis.battingAverage;
    /* Status: green for 4-6:1 sweet spot; warn for 3:1 or under (overtreatment) and 7-9:1; red at 10+:1 */
    let baStatus = '';
    if (ba >= 4 && ba <= 6) baStatus = 'good';
    else if (ba >= 3 && ba < 4) baStatus = 'warn';       /* approaching overtreatment floor */
    else if (ba < 3) baStatus = 'warn';                   /* too aggressive; possible overtreatment */
    else if (ba <= 9) baStatus = 'warn';                  /* 7-9, mild underperformance */
    else baStatus = 'bad';                                 /* 10+, materially under-diagnosing */
    const baBench = ba < 3
      ? 'Sweet spot <strong>4–6:1</strong> · under 3:1 can mean overtreatment'
      : 'Sweet spot <strong>4–6:1</strong> (lower is better)';
    scorecardCards.push({
      lbl: 'Batting Average',
      val: ba.toFixed(1) + ':1',
      bench: `${baBench} · ${kpis.battingAverageInputs.visitsCount.toLocaleString()} visits · ${kpis.battingAverageInputs.crownsPreppedCount.toLocaleString()} crowns`,
      status: baStatus,
    });
  }

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

  /* ── Sources of Dollars cards + summary sentence ── */
  const sod = financials.sourcesOfDollars || {};
  const sodPct = sod.percent || {};
  const sodDollars = sod.dollars || {};
  const pctFmt = v => v != null ? v.toFixed(1) + '%' : '—';
  const sodCards = [
    { lbl: 'From Insurance', val: pctFmt(sodPct.insurance), bench: fmt$(sodDollars.insurance) },
    { lbl: 'From Patient Pay', val: pctFmt(sod.patientPayPct), bench: `${fmt$(sod.patientPayTotal)} (CC + check + cash)` },
    { lbl: 'From 3rd-party Finance', val: pctFmt(sodPct.thirdPartyFinance), bench: fmt$(sodDollars.thirdPartyFinance) },
    { lbl: 'From Government / HMO', val: pctFmt(sodPct.government), bench: fmt$(sodDollars.government) },
  ].filter(c => c.val !== '—' || c.bench !== '$0');
  const sourcesHtml = sod.total > 0 ? sodCards.map(c => `
    <div class="score-card">
      <div class="lbl">${htmlEscape(c.lbl)}</div>
      <div class="val">${c.val}</div>
      <div class="bench">${c.bench}</div>
    </div>
  `).join('') : '<div style="color:#8899aa">P&L income breakdown not available in the uploaded report.</div>';
  const sourcesSummary = sod.total > 0
    ? `Of the <strong>${fmt$(sod.total)}</strong> collected over the last ${period.prodMonths || 12} months, approximately <strong>${pctFmt(sodPct.insurance)}</strong> came through insurance, <strong>${pctFmt(sod.patientPayPct)}</strong> directly from patients (credit card, check, cash combined), ${sodPct.thirdPartyFinance > 0 ? `<strong>${pctFmt(sodPct.thirdPartyFinance)}</strong> through third-party finance (Care Credit and similar), ` : ''}and <strong>${pctFmt(sodPct.government)}</strong> from government programs or HMO/capitation.`
    : '';

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
    sourcesOfDollarsCards: sourcesHtml,
    sourcesSummary: sourcesSummary,
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

/*
 * renderReviewHtml — internal intake-data review page for Dave's eyes.
 * Renders the canonical data object as a spreadsheet-ish HTML document so
 * he can eyeball every number + formula without the SheetJS/Excel roundtrip
 * hell. Sections mirror the reference workbook. Not a client deliverable.
 */
function renderReviewHtml(data) {
  const esc = htmlEscape;
  const fmtMoney = n => (n == null || !isFinite(n)) ? '—' : '$' + Math.round(Number(n)).toLocaleString();
  const fmtInt   = n => (n == null || !isFinite(n)) ? '—' : Math.round(Number(n)).toLocaleString();
  const fmtPct   = n => (n == null || !isFinite(n)) ? '—' : Number(n).toFixed(1) + '%';
  const fmtPctF  = n => (n == null || !isFinite(n)) ? '—' : (Number(n) * 100).toFixed(0) + '%';  /* for fractions like 0.30 → 30% */

  const { practice = {}, period = {}, production = {}, collections = {}, financials = {}, ar = {}, kpis = {}, goals = {} } = data;
  const mix = practice.payorMix || {};
  const cat = production.byCategory || {};
  const tgt = goals.targets || {};
  const hp = goals.hygienePotential || {};
  const sod = financials.sourcesOfDollars || {};
  const sodD = sod.dollars || {};
  const arP = ar.patient || {};
  const arI = ar.insurance || {};

  /* Section 1 — Practice Profile */
  const profileRows = [
    ['Practice name', esc(practice.name)],
    ['Website', esc(practice.website)],
    ['ZIP code', esc(practice.zipCode)],
    ['PM software', esc(practice.pmSoftware)],
    ['Years owned', practice.yearsOwned ?? '—'],
    ['Owner age', practice.ownerAge ?? '—'],
    ['Operatories (active / total)', `${practice.opsActive || '—'} / ${practice.opsTotal || '—'}`],
    ['Doctor days / month', practice.doctorDays ?? '—'],
    ['Hygiene days / week (hygienist-person-days)', practice.hygieneDaysPerWeek ?? '—'],
    ['Number of hygienists', practice.numHygienists ?? '—'],
    ['Patients per hygienist / day', practice.patientsPerHygienistPerDay ?? '—'],
    ['Has associate', practice.hasAssociate ? 'Yes' : 'No'],
    ['Associate days / month', practice.associateDaysPerMonth ?? '—'],
    ['Payor mix — PPO', fmtPct(mix.ppo)],
    ['Payor mix — HMO', fmtPct(mix.hmo)],
    ['Payor mix — Gov / Medicaid', fmtPct(mix.gov)],
    ['Payor mix — FFS / OON', fmtPct(mix.ffs)],
    ['Stated crowns / month', practice.crownsPerMonth ?? '—'],
  ];

  /* Section 2 — Production Overview (by category) */
  const totalProd = production.total || 0;
  const annualProd = production.annualized || 0;
  const prodCatRows = [
    ['Hygiene', fmtMoney(cat.hygiene), fmtPct(totalProd > 0 ? (cat.hygiene || 0) / totalProd * 100 : 0)],
    ['Doctor (general)', fmtMoney(cat.doctor), fmtPct(totalProd > 0 ? (cat.doctor || 0) / totalProd * 100 : 0)],
    ['Perio', fmtMoney(cat.perio), fmtPct(totalProd > 0 ? (cat.perio || 0) / totalProd * 100 : 0)],
    ['Endo', fmtMoney(cat.endo), fmtPct(totalProd > 0 ? (cat.endo || 0) / totalProd * 100 : 0)],
    ['Oral Surgery', fmtMoney(cat.surg), fmtPct(totalProd > 0 ? (cat.surg || 0) / totalProd * 100 : 0)],
    ['Ortho', fmtMoney(cat.ortho), fmtPct(totalProd > 0 ? (cat.ortho || 0) / totalProd * 100 : 0)],
    ['Cosmetic', fmtMoney(cat.cosmetic), fmtPct(totalProd > 0 ? (cat.cosmetic || 0) / totalProd * 100 : 0)],
  ];

  /* Section 3 — All Codes */
  const codesSorted = [...(production.codes || [])].sort((a, b) => (b.total || 0) - (a.total || 0));
  const codesRows = codesSorted.map(c => `
    <tr>
      <td class="mono">${esc(c.code)}</td>
      <td>${esc(c.desc || '')}</td>
      <td class="num">${fmtInt(c.qty)}</td>
      <td class="num">${fmtMoney(c.total)}</td>
      <td class="num">${c.qty > 0 ? fmtMoney((c.total || 0) / c.qty) : '—'}</td>
      <td class="num">${fmtPct(totalProd > 0 ? (c.total || 0) / totalProd * 100 : 0)}</td>
    </tr>`).join('');

  /* Section 4 — Hygiene Schedule / POTENTIAL */
  const potentialRows = [
    ['Active adult patient estimate', fmtInt(hp.activePatientEstimate), 'hard estimate from prophy / perio maint / SRP counts ÷ 0.80 compliance'],
    ['New patients / month', fmtInt(hp.newPatientsPerMo), 'from D0150 comprehensive exam count ÷ 12'],
    ['Perio disease presence', fmtPctF(hp.perioDiseasePct), 'default benchmark; override once Hub collects'],
    ['Probing perio positive', fmtPctF(hp.probingPerioPct), 'default benchmark'],
    ['Potential adult prophy / year (80% compliance)', fmtInt(hp.potentialAppts?.adultProphy), '(active + new×12) × (1 − perio%) × 2 × 0.8'],
    ['Potential perio maintenance / year (50%)', fmtInt(hp.potentialAppts?.perioMaint), '(active + new×12) × perio% × 4 × 0.5'],
    ['Potential SRP / year (75%)', fmtInt(hp.potentialAppts?.srp), '(adultProphy + perioMaint) × probing% × 2 × 0.75'],
    ['<b>Total required visits / year</b>', '<b>' + fmtInt(hp.potentialAppts?.total) + '</b>', ''],
    ['Patients scheduled per hygienist / day', fmtInt(hp.patientsPerHygienistPerDay), 'from survey'],
    ['<b>Hygiene days required / month</b>', '<b>' + fmtInt(hp.daysRequiredPerMo) + '</b>', 'total visits ÷ patients/day ÷ 12'],
    ['Current hygiene days / month', fmtInt(hp.currentHygDaysPerMo), 'hygieneDaysPerWeek × 4'],
    ['<b>Capacity gap — days</b>', '<b>' + fmtInt(hp.capacityGapDays) + '</b>', 'required − current'],
    ['Capacity gap — visits / month', fmtInt(hp.capacityGapVisitsPerMo), 'gapDays × patients/day'],
    ['<b>Capacity gap — annual $</b>', '<b>' + fmtMoney(hp.capacityGapAnnualDollars) + '</b>', 'gapVisits × 12 × hygiene $/visit ($' + fmtInt(hp.hygVisitValue) + ')'],
  ];

  /* Section 5 — Financial Overview: current period + AR + collections by payor */
  const plIncome = financials.plIncome || 0;
  const monthlyPL = plIncome / 12;
  const monthlyProd = period.prodMonths ? (production.total || 0) / period.prodMonths : 0;
  const monthlyColl = period.prodMonths ? (collections.total || 0) / period.prodMonths : 0;
  const finRows = [
    ['Months in production period', fmtInt(period.prodMonths)],
    ['Annual production', fmtMoney(annualProd)],
    ['Annual collections', fmtMoney(collections.annualized)],
    ['Collection rate', fmtPct(kpis.collectionRate)],
    ['', ''],
    ['Monthly collection (from P&L)', fmtMoney(monthlyPL)],
    ['Monthly collection (from practice reports)', fmtMoney(monthlyColl)],
    ['Monthly production (from ADA code report)', fmtMoney(monthlyProd)],
    ['P&L : ADA collection %', fmtPct(monthlyProd > 0 ? (monthlyPL / monthlyProd * 100) : 0)],
    ['', ''],
    ['P&L total income', fmtMoney(plIncome)],
    ['P&L expenses (raw)', fmtMoney(financials.plExpensesRaw)],
    ['Owner add-backs', fmtMoney(financials.ownerAddBacks)],
    ['Patient reimbursements', fmtMoney(financials.patientReimbursements)],
    ['P&L expenses (adjusted)', fmtMoney(financials.plExpenses)],
    ['Overhead % (adjusted)', fmtPct(kpis.overheadPct)],
    ['Profit margin', fmtPct(kpis.profitPct)],
    ['Staff cost % of collections', fmtPct(kpis.staffCostPct)],
  ];

  /* AR table */
  const arRow = (label, a) => `
    <tr>
      <td>${label}</td>
      <td class="num">${fmtMoney(a.current)}</td>
      <td class="num">${fmtMoney(a.d3160)}</td>
      <td class="num">${fmtMoney(a.d6190)}</td>
      <td class="num">${fmtMoney(a.d90plus)}</td>
      <td class="num"><b>${fmtMoney(a.total)}</b></td>
    </tr>`;

  /* Sources of Dollars table */
  const sodRows = [
    ['Patient — Credit Card', sodD.patientCreditCard, sod.percent?.patientCreditCard],
    ['Patient — Check', sodD.patientCheck, sod.percent?.patientCheck],
    ['Patient — Cash', sodD.patientCash, sod.percent?.patientCash],
    ['Insurance', sodD.insurance, sod.percent?.insurance],
    ['Government / Capitation', sodD.government, sod.percent?.government],
    ['3rd-party Finance', sodD.thirdPartyFinance, sod.percent?.thirdPartyFinance],
    ['Other', sodD.other, sod.percent?.other],
  ].map(([label, v, pct]) => `<tr><td>${label}</td><td class="num">${fmtMoney(v)}</td><td class="num">${fmtPct(pct)}</td></tr>`).join('');

  /* Section 6 — Targets & Goal (Initial + Long Term side by side) */
  const ini = tgt.initial || {};
  const lt = tgt.longTerm || {};
  const targetsStream = (k, lbl) => {
    const r = ini[k] || {};
    const l = lt[k] || {};
    return `<tr>
      <td>${lbl}</td>
      <td class="num">${fmtInt(r.days)}</td>
      <td class="num">${fmtMoney(r.daily)}</td>
      <td class="num">${fmtMoney((r.days || 0) * (r.daily || 0))}</td>
      <td class="num">${fmtInt(l.days)}</td>
      <td class="num">${fmtMoney(l.daily)}</td>
      <td class="num">${fmtMoney((l.days || 0) * (l.daily || 0))}</td>
    </tr>`;
  };
  const targetsRows = [
    targetsStream('generalDentist', 'general dentist'),
    targetsStream('associateGP', 'associate GP'),
    targetsStream('hygiene', 'hygiene'),
    targetsStream('perioSurgery', 'perio surgery'),
    targetsStream('endo', 'endo'),
    targetsStream('oralSurgery', 'oral surgery'),
    targetsStream('ortho', 'ortho'),
    targetsStream('cap', 'cap'),
    targetsStream('other', 'other'),
  ].join('');

  /* Section 7 — Budgetary P&L (3-column: YTD / Target / Goal) */
  const tgtMonthly = tgt.initialMonthly || 0;
  const goalMonthly = tgt.longTermMonthly || 0;
  const plPctOfIncome = (amt) => plIncome > 0 ? (amt || 0) / plIncome * 100 : null;
  const budgetRow = (label, ytdAmt, ytdPct, tgtPct, tgtAmt, gPct, gAmt) => `
    <tr>
      <td>${label}</td>
      <td class="num">${ytdAmt != null ? fmtMoney(ytdAmt) : ''}</td>
      <td class="num">${ytdPct != null ? fmtPct(ytdPct) : ''}</td>
      <td class="num">${tgtAmt != null ? fmtMoney(tgtAmt) : ''}</td>
      <td class="num">${tgtPct != null ? fmtPct(tgtPct) : ''}</td>
      <td class="num">${gAmt != null ? fmtMoney(gAmt) : ''}</td>
      <td class="num">${gPct != null ? fmtPct(gPct) : ''}</td>
    </tr>`;

  const title = esc(practice.name || 'Assessment') + ' — Intake Data Review';

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><title>${title}</title>
<style>
  :root { --fg:#1a1a1a; --muted:#666; --border:#d0d0d0; --bg:#fafafa; --row-alt:#f4f4f4; --accent:#1e40af; --header:#0f172a; --red:#dc2626; --green:#16a34a; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 32px; font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif; color:var(--fg); background:#fff; font-size:14px; line-height:1.4; }
  h1 { font-size:22px; margin:0 0 4px; color:var(--header); }
  h2 { font-size:15px; text-transform:uppercase; letter-spacing:.08em; margin:28px 0 8px; padding:8px 12px; background:var(--header); color:#fff; border-radius:4px; }
  .meta { color:var(--muted); font-size:13px; margin-bottom:8px; }
  table { border-collapse:collapse; width:100%; margin:0 0 4px; }
  th, td { border:1px solid var(--border); padding:6px 10px; text-align:left; vertical-align:top; }
  th { background:var(--bg); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  tbody tr:nth-child(even) { background:var(--row-alt); }
  .mono { font-family:'SF Mono','Monaco','Menlo',monospace; font-size:13px; }
  .note { color:var(--muted); font-size:12px; font-style:italic; }
  .kv td:first-child { width:60%; color:var(--fg); }
  .kv td:last-child { text-align:right; font-weight:500; font-variant-numeric:tabular-nums; }
  .twocol { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  .badge { display:inline-block; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:600; background:#e0e7ff; color:var(--accent); }
  footer { margin-top:32px; padding-top:16px; border-top:1px solid var(--border); color:var(--muted); font-size:12px; }
</style>
</head>
<body>
  <h1>${title}</h1>
  <div class="meta">Generated ${esc(data.generatedAt || '')} • Engine v${esc(data.version || '')} • ${esc(period.prodMonths || 0)} months of data (${esc((period.years || []).join(', '))})</div>
  <div><span class="badge">INTERNAL — NOT A CLIENT DELIVERABLE</span></div>

  <h2>Practice Profile</h2>
  <table class="kv"><tbody>${profileRows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</tbody></table>

  <h2>Production Overview</h2>
  <table>
    <thead><tr><th>Category</th><th class="num">12mo $</th><th class="num">% of total</th></tr></thead>
    <tbody>${prodCatRows.map(([c, d, p]) => `<tr><td>${c}</td><td class="num">${d}</td><td class="num">${p}</td></tr>`).join('')}
    <tr style="font-weight:600;background:#eef"><td>TOTAL</td><td class="num">${fmtMoney(totalProd)}</td><td class="num">100%</td></tr>
    <tr><td>Annualized production</td><td class="num">${fmtMoney(annualProd)}</td><td class="num"></td></tr>
    </tbody>
  </table>

  <h2>All Codes (${codesSorted.length} codes, sorted by $)</h2>
  <table>
    <thead><tr><th>Code</th><th>Description</th><th class="num">Qty</th><th class="num">Total $</th><th class="num">Avg $/proc</th><th class="num">% of prod</th></tr></thead>
    <tbody>${codesRows}</tbody>
  </table>

  <h2>Hygiene Schedule — Potential</h2>
  <table class="kv">
    <thead><tr><th>Input / Metric</th><th class="num">Value</th><th>Formula / Note</th></tr></thead>
    <tbody>${potentialRows.map(([k, v, n]) => `<tr><td>${k}</td><td class="num">${v}</td><td class="note">${n}</td></tr>`).join('')}</tbody>
  </table>

  <h2>Financial Overview</h2>
  <div class="twocol">
    <div>
      <table class="kv"><tbody>${finRows.map(([k, v]) => k === '' ? '<tr><td colspan="2" style="border:none;height:4px"></td></tr>' : `<tr><td>${k}</td><td class="num">${v}</td></tr>`).join('')}</tbody></table>
    </div>
    <div>
      <h3 style="font-size:13px;margin:0 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;">Accounts Receivable Aging</h3>
      <table>
        <thead><tr><th></th><th class="num">Current</th><th class="num">30–60</th><th class="num">60–90</th><th class="num">90+</th><th class="num">Total</th></tr></thead>
        <tbody>${arRow('Patient', arP)}${arRow('Insurance', arI)}</tbody>
      </table>
      <h3 style="font-size:13px;margin:16px 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;">Sources of Dollars</h3>
      <table>
        <thead><tr><th>Source</th><th class="num">$</th><th class="num">% of income</th></tr></thead>
        <tbody>${sodRows}</tbody>
      </table>
    </div>
  </div>

  <h2>Targets &amp; Goal</h2>
  <table>
    <thead>
      <tr><th rowspan="2">Stream</th><th colspan="3" style="text-align:center">Initial Monthly Target</th><th colspan="3" style="text-align:center">Long Term Monthly Goal</th></tr>
      <tr><th class="num">Days</th><th class="num">$/Day</th><th class="num">Monthly</th><th class="num">Days</th><th class="num">$/Day</th><th class="num">Monthly</th></tr>
    </thead>
    <tbody>
      ${targetsRows}
      <tr style="font-weight:700;background:#eef">
        <td>MONTHLY TOTAL</td>
        <td class="num" colspan="2"></td><td class="num">${fmtMoney(tgtMonthly)}</td>
        <td class="num" colspan="2"></td><td class="num">${fmtMoney(goalMonthly)}</td>
      </tr>
      <tr style="font-weight:600">
        <td>ANNUAL</td>
        <td class="num" colspan="2"></td><td class="num">${fmtMoney(tgt.initialAnnual)}</td>
        <td class="num" colspan="2"></td><td class="num">${fmtMoney(tgt.longTermAnnual)}</td>
      </tr>
    </tbody>
  </table>

  <h2>Budgetary P&amp;L — current reality vs. target vs. goal</h2>
  <table>
    <thead>
      <tr><th rowspan="2">Line</th><th colspan="2" style="text-align:center">YTD (from P&amp;L)</th><th colspan="2" style="text-align:center">Target</th><th colspan="2" style="text-align:center">Goal</th></tr>
      <tr><th class="num">$</th><th class="num">% inc</th><th class="num">$</th><th class="num">% tgt</th><th class="num">$</th><th class="num">% goal</th></tr>
    </thead>
    <tbody>
      ${budgetRow('Collection (monthly)', monthlyPL, null, null, tgtMonthly, null, goalMonthly)}
      ${budgetRow('Staff cost % of collections', null, kpis.staffCostPct, 18, null, 18, null)}
      ${budgetRow('Overhead % (adjusted)', financials.plExpenses, kpis.overheadPct, 60, null, 55, null)}
      ${budgetRow('Profit margin', null, kpis.profitPct, 26, null, 30, null)}
    </tbody>
  </table>
  <div class="note" style="margin-top:4px">Full line-by-line P&amp;L breakdown (associates / hygienists / lab / supplies / rent / etc.) and target vs. goal cross-references live in <code>d.financials.sourcesOfDollars.items</code> and the Targets &amp; Goal detail table above. Expanding the Budgetary P&amp;L here is the next step once the per-line P&amp;L category mapping is surfaced on the data object.</div>

  <footer>
    Review-only rendering of the canonical data object at <code>d</code>. Source: <code>netlify/functions/generate-report.js → renderReviewHtml()</code>. Any value wrong here is wrong in the engine — fix the computation, not the rendering.
  </footer>
</body></html>`;
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
    const swotData = generateSWOT(prodData, collData, plData, hygieneData, employeeCosts, arPatient, arInsurance, practiceProfile);

    /* Compute canonical data object */
    const data = computeReportData({
      prodData, collData, plData, employeeCosts, practiceProfile,
      arPatient, arInsurance, swotData, practiceName,
      totalProd, collTotal, years, prodMonths,
    });

    /* Render HTML */
    const reportHtml = renderReportHtml(data);
    const reviewHtml = renderReviewHtml(data);

    const elapsed = Date.now() - t0;
    console.log(`generate-report: ${codes.length} codes, ${prodMonths}mo, ${elapsed}ms, ${reportHtml.length + reviewHtml.length} chars of HTML`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        success: true,
        data,
        reportHtml,
        reviewHtml,
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
