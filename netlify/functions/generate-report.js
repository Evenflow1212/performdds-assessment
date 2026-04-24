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
  let months = 12, years = [], dateStart = null, dateEnd = null;
  /* Payment Summary breakdown from the Dentrix Practice Analysis PDF
     (2026-04-23). The updated production prompt emits four REVENUE_*
     lines after the code list; parseProduction captures them so the
     Revenue Mix card can populate from Dentrix directly instead of
     relying on the P&L Income section (which collapses to a single
     "Sales" line for many practices). Null when no lines were emitted. */
  let revenueInsurance = null, revenuePatient = null, revenueThirdParty = null, revenueGovernment = null;
  const parseMoney = (s) => {
    let raw = String(s).replace(/[,$]/g, '').trim();
    if (raw.startsWith('(') && raw.endsWith(')')) raw = '-' + raw.slice(1, -1);
    const n = parseFloat(raw);
    return isNaN(n) ? null : n;
  };
  for (const line of (text || '').split('\n')) {
    const dm = line.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
    if (dm && !years.length) {
      const from = new Date(dm[1]), to = new Date(dm[2]);
      months = Math.max(1, Math.round((to - from) / (1000*60*60*24*30.44)));
      dateStart = from.toISOString().slice(0, 10);
      dateEnd = to.toISOString().slice(0, 10);
      for (let y = from.getFullYear(); y <= to.getFullYear(); y++) years.push(y);
      continue;
    }
    /* Payment Summary breakdown — checked BEFORE the code regex so
       "REVENUE_INSURANCE|879888.70" doesn't get mis-parsed as a code. */
    const rev = line.match(/^\s*REVENUE_(INSURANCE|PATIENT|3RDPARTY|THIRDPARTY|GOVERNMENT|GOV)\s*\|\s*(-?[\d,.$()]+)/i);
    if (rev) {
      const key = rev[1].toUpperCase();
      const amt = parseMoney(rev[2]);
      if (amt != null) {
        if      (key === 'INSURANCE')                           revenueInsurance  = amt;
        else if (key === 'PATIENT')                             revenuePatient    = amt;
        else if (key === '3RDPARTY' || key === 'THIRDPARTY')    revenueThirdParty = amt;
        else if (key === 'GOVERNMENT' || key === 'GOV')         revenueGovernment = amt;
      }
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
  /* Only surface the breakdown when at least one bucket populated. */
  const anyRevenue = [revenueInsurance, revenuePatient, revenueThirdParty, revenueGovernment]
    .some(v => Number.isFinite(v));
  const revenueBreakdown = anyRevenue ? {
    insurance:       Number.isFinite(revenueInsurance)  ? revenueInsurance  : 0,
    patient:         Number.isFinite(revenuePatient)    ? revenuePatient    : 0,
    thirdPartyFinance: Number.isFinite(revenueThirdParty) ? revenueThirdParty : 0,
    government:      Number.isFinite(revenueGovernment) ? revenueGovernment : 0,
  } : null;
  return { codes, months, years, dateStart, dateEnd, revenueBreakdown };
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
  /* Recognize summary-line variants Claude emits in the wild. The PL prompt
     asks for TOTAL_INCOME / TOTAL_EXPENSE / NET_INCOME but Haiku sometimes
     echoes the QB label verbatim ("Total Expenses"), wraps it in markdown
     (`**TOTAL_EXPENSE**|...`), pluralizes the underscored key, or keeps
     the "$" / parens formatting from the source PDF. The regexes below
     tolerate all of those. A leading whitespace/markdown prefix is stripped
     before matching so the lines don't have to start at column 0. */
  const stripPrefix = (line) => line.replace(/^[\s>*`#\-]*\**\s*/, '').replace(/\**\s*$/, '');
  /* Trailing `\**\s*` before the `[:|]` separator lets the regex match
     markdown-wrapped Claude output like `**TOTAL_INCOME**|2124318.47`
     where the trailing `**` survives stripPrefix. */
  const RE_INCOME  = /^total[\s_]+(?:for\s+)?(?:income|revenue|sales|gross\s+revenue)\s*\**\s*[:|]\s*\**?([^\s|*]+)/i;
  const RE_EXPENSE = /^total[\s_]+(?:for\s+)?(?:operating\s+)?expenses?\s*\**\s*[:|]\s*\**?([^\s|*]+)/i;
  const RE_NET     = /^net[\s_]+(?:operating[\s_]+)?income\s*\**\s*[:|]\s*\**?([^\s|*]+)/i;
  const parseAmount = (s) => {
    let raw = String(s).replace(/[,$]/g, '').replace(/\*/g, '');
    if (raw.startsWith('(') && raw.endsWith(')')) raw = '-' + raw.slice(1, -1);
    const n = parseFloat(raw);
    return isNaN(n) ? null : n;
  };
  for (const rawLine of (text || '').split('\n')) {
    const line = stripPrefix(rawLine);
    /* Net income first so "Net Operating Income" doesn't trip the expense regex. */
    const sn = line.match(RE_NET);
    if (sn) { const v = parseAmount(sn[1]); if (v != null && netIncome == null) netIncome = v; continue; }
    const sm = line.match(RE_INCOME);
    if (sm) { const v = parseAmount(sm[1]); if (v != null) totalIncome = Math.abs(v); continue; }
    const se = line.match(RE_EXPENSE);
    if (se) { const v = parseAmount(se[1]); if (v != null) totalExpense = Math.abs(v); continue; }
    const secMatch = line.match(/^SECTION\s*\|\s*(.+)/i);
    if (secMatch) { currentSection = secMatch[1].trim(); continue; }
    if (/^DATES?\s*\|/i.test(line)) continue;
    /* Ignore our own REVENUE_* payment-breakdown lines if they leak into the PL text. */
    if (/^REVENUE_/i.test(line)) continue;
    const m = line.match(/^(.+?)\|([-\d,.()+$]+)/);
    if (m) {
      const item = m[1].trim();
      let raw = m[2].replace(/[,$]/g, '');
      if (raw.startsWith('(') && raw.endsWith(')')) raw = '-' + raw.slice(1, -1);
      const amt = parseFloat(raw);
      if (!isNaN(amt) && item && !/total income|total expense|total sales|total revenue|gross profit|net income|net operating|cost of goods|cogs/i.test(item)) {
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
  /* Defensive fallback totals (2026-04-23) — if TOTAL_INCOME / TOTAL_EXPENSE
     didn't come through on their own lines (truncation, format mismatch), sum
     the items by section. Better to surface ballpark numbers than silently
     render "P&L not uploaded" on a P&L the user DID upload. */
  if (totalIncome == null && items.some(i => i.section === 'Income')) {
    totalIncome = items.filter(i => i.section === 'Income').reduce((s, i) => s + i.amount, 0);
    console.warn('parsePL: totalIncome synthesized from Income items =', totalIncome);
  }
  if (totalExpense == null && items.some(i => i.section === 'Expense')) {
    totalExpense = items.filter(i => i.section === 'Expense').reduce((s, i) => s + i.amount, 0);
    console.warn('parsePL: totalExpense synthesized from Expense items =', totalExpense);
  }
  if (totalIncome == null && totalExpense == null && items.length === 0) {
    console.warn('parsePL: empty result. Input head:', (text || '').slice(0, 200).replace(/\n/g, ' | '));
  } else if (totalIncome == null || totalExpense == null) {
    console.warn(`parsePL: partial result — items=${items.length}, totalIncome=${totalIncome}, totalExpense=${totalExpense}, netIncome=${netIncome}`);
  }
  return { items, totalIncome, totalExpense, netIncome };
}

/* ─── Dentrix Patient Summary (2026-04-23) ───
   Extracts top-line patient counts Dave uses to unblock hygiene-capacity
   math. All fields optional — null when the source text didn't include
   that metric. Safe to call with null/empty text: returns all nulls. */
function parsePatientSummary(text) {
  const out = {
    activePatients: null, insuredPatients: null, families: null,
    newPatientsYTD: null, newPatientsMonth: null, referralsYTD: null,
  };
  if (!text) return out;
  const pickInt = (re) => {
    const m = text.match(re);
    if (!m) return null;
    const n = parseInt(String(m[1]).replace(/[,$\s]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  };
  out.activePatients   = pickInt(/(?:^|\n)\s*ACTIVE_PATIENTS\s*\|\s*(-?[\d,]+)/i);
  out.insuredPatients  = pickInt(/(?:^|\n)\s*INSURED_PATIENTS\s*\|\s*(-?[\d,]+)/i);
  out.families         = pickInt(/(?:^|\n)\s*FAMILIES\s*\|\s*(-?[\d,]+)/i);
  out.newPatientsYTD   = pickInt(/(?:^|\n)\s*NEW_PATIENTS_YTD\s*\|\s*(-?[\d,]+)/i);
  out.newPatientsMonth = pickInt(/(?:^|\n)\s*NEW_PATIENTS_MONTH\s*\|\s*(-?[\d,]+)/i);
  out.referralsYTD     = pickInt(/(?:^|\n)\s*REFERRALS_YTD\s*\|\s*(-?[\d,]+)/i);
  return out;
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

/* Role-scoped annualized staff cost: wages + benefits×12 + wages × empCostPct.
   Called separately for the admin/clinical `staff` and the `hygiene` arrays
   so Dave's three-way decomposition (admin-only, hygienist-only, total) can
   use a single source of truth. */
function staffRoleAnnualCost(arr, benefits, empCostPct) {
  const wages = (arr || []).reduce((s, p) => s + (Number(p.rate) || 0) * (Number(p.hours) || 0) * 12, 0);
  const benefitsAnnual = (Number(benefits) || 0) * 12;
  const empCosts = wages * (Number(empCostPct) || 0);
  return wages + benefitsAnnual + empCosts;
}

/* Canonical TOTAL staff-cost-% calc: admin + hygiene, all annualized, divided
   by annualized collections. Kept for backward compat and industry-reference
   benchmarking (25-28%). Per Dave's methodology this is NOT the primary
   coaching metric — use staffCostExHygPct + hygienistCostPct instead. */
function canonicalStaffCostPct(employeeCosts, annualCollections) {
  if (!employeeCosts || !(annualCollections > 0)) return null;
  const staffAnnual =
    staffRoleAnnualCost(employeeCosts.staff,   employeeCosts.staffBenefits, employeeCosts.staffEmpCostPct) +
    staffRoleAnnualCost(employeeCosts.hygiene, employeeCosts.hygBenefits,   employeeCosts.hygEmpCostPct);
  return staffAnnual > 0 ? (staffAnnual / annualCollections) * 100 : null;
}

/* Admin + clinical staff cost as % of annualized collections — excludes the
   hygiene array entirely. This isolates how efficiently the non-clinical
   and non-hygiene team runs; hygiene days/week swing the total-staff figure
   and muddy the signal. Target ≤15%, flag >18%. */
function staffCostExHygPctCalc(employeeCosts, annualCollections) {
  if (!employeeCosts || !(annualCollections > 0)) return null;
  const adminAnnual = staffRoleAnnualCost(
    employeeCosts.staff, employeeCosts.staffBenefits, employeeCosts.staffEmpCostPct
  );
  return adminAnnual > 0 ? (adminAnnual / annualCollections) * 100 : null;
}

/* Hygienist wages as % of HYGIENE PRODUCTION (NOT total collections).
   This normalizes for how many days/week the hygiene department runs —
   a 5-day hygiene practice and a 3-day hygiene practice can have the same
   underlying hygienist productivity but different total-staff ratios.
   Target 30–33%, flag >38%. */
function hygienistCostPctCalc(employeeCosts, annualHygieneProduction) {
  if (!employeeCosts || !(annualHygieneProduction > 0)) return null;
  const hygAnnual = staffRoleAnnualCost(
    employeeCosts.hygiene, employeeCosts.hygBenefits, employeeCosts.hygEmpCostPct
  );
  return hygAnnual > 0 ? (hygAnnual / annualHygieneProduction) * 100 : null;
}

/* ─── SWOT Analysis Generator ─── */
function generateSWOT(prodData, collData, plData, hygieneData, employeeCosts, arPatient, arInsurance, practiceProfile, canonicalStaffPct, staffExHygPct, hygienistPct, hygieneNearFuturePreBooking, q5Inputs, overheadInputs, hygDeptRatioInputs, hygCapacityInputs) {
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

  const hygCodes = ['D1110','D1120','D4910','D4341','D4342','D4346','D4381','D0120','D0140','D0274'];
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

  let labPct = 0, supplyPct = 0, netIncomePct = 0;
  let totalLabCost = 0, totalSupplyCost = 0;
  if (plData && plData.items && netCollections > 0) {
    for (const item of plData.items) {
      if (item.section === 'Income' || item.section === 'COGS') continue;
      const l = item.item.toLowerCase();
      if (/lab\s*(fee|cost|expense)/i.test(l) || l.includes('laboratory')) totalLabCost += item.amount;
      if (/dental.*suppl|job.*suppl/i.test(l)) totalSupplyCost += item.amount;
    }
    labPct = (totalLabCost / netCollections * 100);
    supplyPct = (totalSupplyCost / netCollections * 100);
    if (plData.netIncome != null) netIncomePct = (plData.netIncome / netCollections * 100);
  }

  /* Staff-cost percentages all come from the handler — single source of
     truth with computeReportData. Total is retained for industry-reference
     threats; the decomposed admin/hygienist metrics drive Dave's coaching
     rules per the three-way methodology. */
  const staffCostPct  = Number.isFinite(canonicalStaffPct) ? canonicalStaffPct : 0;
  const staffExHyg    = Number.isFinite(staffExHygPct)     ? staffExHygPct     : null;
  const hygienist     = Number.isFinite(hygienistPct)      ? hygienistPct      : null;

  const totalAR = (arPatient?.total || 0) + (arInsurance?.total || 0);
  const ar90Plus = (arPatient?.d90plus || 0) + (arInsurance?.d90plus || 0);
  const ar90Pct = totalAR > 0 ? (ar90Plus / totalAR * 100) : 0;

  /* ── STRENGTHS ── */
  if (collectionRate >= 95) strengths.push('Collection rate is strong at ' + Math.round(collectionRate) + '%');
  if (hygPct >= 28) strengths.push('Hygiene department is performing well at ' + Math.round(hygPct) + '% of total production');
  if (staffCostPct > 0 && staffCostPct <= 22) strengths.push('Staff costs are well managed at ' + Math.round(staffCostPct) + '% of collections (total, admin + hygiene)');
  if (npPerMonth >= 30) strengths.push('Strong new patient flow at ' + npPerMonth + ' per month');
  if (activePatientEst >= 1000) strengths.push('Practice has a strong active patient base, estimated at approximately ' + activePatientEst);
  if (perioMaintQty > 0 && perioRatio >= 15) strengths.push('Solid soft tissue management protocols appear to be in place');
  if (specTotal > 0 && specPct >= 5) strengths.push('The practice has established in-house specialty services');
  if (totalAR > 0 && ar90Pct < 5) strengths.push('AR management is healthy with minimal aged receivables');
  if (netIncomePct >= 30) strengths.push('Practice net income is strong at ' + Math.round(netIncomePct) + '% of collections');
  if (monthlyProd >= 80000) strengths.push('Production volume is strong at $' + Math.round(monthlyProd).toLocaleString() + ' per month');

  /* ── WEAKNESSES ── */
  if (collectionRate > 0 && collectionRate < 93) weaknesses.push('Collection rate of ' + Math.round(collectionRate) + '% is below the 97% benchmark');
  /* Staff cost — HYBRID model per 2026-04-21 methodology reconciliation.
     Primary coaching anchor is TOTAL staff cost vs 20%. The admin/clinical
     and hygienist-ratio decomposition stays on the scorecard as diagnostic
     color (where the cost lives — front-desk vs hygiene) but doesn't drive
     the primary red flag; that's always on total. Excludes owner draws. */
  if (staffCostPct > 20) {
    weaknesses.push('Total staff cost at ' + staffCostPct.toFixed(1) + '% of collections exceeds the 20% benchmark (includes all staff + hygiene; excludes owner draws)');
  }
  /* Legacy labor-as-percentage hygienist weakness removed 2026-04-22 —
     superseded by the Hygiene Department Ratio SWOT (3:1 production-to-labor
     framing) added later in this function. Keeping both would double-fire
     when hygienistCostPct > 38 with redundant narrative on the same finding. */
  if (hygPct > 0 && hygPct < 25) weaknesses.push('Hygiene production at ' + Math.round(hygPct) + '% is below the 33% target');
  /* Pre-booking discipline at the hygiene chair (2026-04-21). Healthy practices
     maintain 90%+ booked 2–3 weeks out; below 90 is a leading indicator that
     empties will spike. Only fires when hygiene schedule data is present. */
  if (Number.isFinite(hygieneNearFuturePreBooking) && hygieneNearFuturePreBooking < 90) {
    weaknesses.push(`Your pre-booking rate 2–3 weeks out is ${hygieneNearFuturePreBooking.toFixed(0)}% — healthy practices maintain 90%+ at that horizon. Below 90% is a leading indicator that empties will spike. Pre-booking discipline at the hygiene chair (next appointment scheduled before patient leaves) is the fix.`);
  }
  if (perioMaintQty === 0 && prophyQty > 0) weaknesses.push('Perio maintenance appears limited — no D4910 codes present');
  if (srpQty === 0 && prophyQty > 50) weaknesses.push('Periodontal disease appears to be under-diagnosed — no SRP procedures found');
  else if (perioRatio > 0 && perioRatio < 8 && prophyQty > 50) weaknesses.push('Periodontal disease may be under-diagnosed relative to the patient flow');
  if (!hasPanorex) weaknesses.push('The practice does not appear to have a Panorex');
  /* Legacy P&L-derived lab/supplies weaknesses. Suppressed when the user
     filled in the questionnaire's Overhead Breakdown fields — the new
     five-branch Overhead SWOT (2026-04-22) covers those sub-components
     using questionnaire-derived values, and double-firing would leave the
     reader with two nearly-identical findings. When the questionnaire
     fields are null, these legacy P&L-derived weaknesses still fire so
     detailed P&L uploads don't lose coverage. */
  const obQ = (practiceProfile && practiceProfile.overheadBreakdown) || {};
  const userGaveLabSpend      = Number(obQ.annualLabSpend)      > 0;
  const userGaveSuppliesSpend = Number(obQ.annualSuppliesSpend) > 0;
  if (labPct > 6 && !userGaveLabSpend) weaknesses.push('Lab costs at ' + labPct.toFixed(1) + '% of collections exceed the 6% target');
  if (supplyPct > 6 && !userGaveSuppliesSpend) weaknesses.push('Dental supply costs at ' + supplyPct.toFixed(1) + '% exceed the 6% target');
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

  /* ── Setup-check + scorekeeping SWOT rules (2026-04-21 methodology) ─────
     Layered A–E logic keyed off the Practice Management Setup questionnaire
     section. Any setup-foundation weakness that fires is prepended to the
     weakness list (HIGH PRIORITY) because every downstream KPI assumes these
     foundations are in place — if scheduled production can't be trusted, no
     other finding can either. */
  const setupWeaknesses = [];

  /* A. Data foundation — fees on scheduler, fee schedules current, write-offs automatic. */
  const feesAtt    = (pp.feesAttachedToScheduler    || '').toLowerCase();
  const ifsCurrent = (pp.insuranceFeeSchedulesCurrent || '').toLowerCase();
  const woCalc     = (pp.writeOffCalculation         || '').toLowerCase();
  const aTriggers = (feesAtt === 'no' || feesAtt === 'not_sure') ||
                    (ifsCurrent === 'no' || ifsCurrent === 'not_sure') ||
                    (woCalc === 'manual' || woCalc === 'mix');
  if (aTriggers) {
    setupWeaknesses.push("Before reading any of this report, your data foundation needs attention. Scheduled production in your PM software can't be trusted until fees are attached to procedures on the scheduler, insurance fee schedules are current, and write-offs compute automatically. This is the first thing to fix — every other finding below rests on these numbers being accurate.");
  }

  /* B. Frequent manual adjustments — piggybacks on A, or fires its own bullet. */
  if ((pp.frequentManualAdjustments || '').toLowerCase() === 'yes') {
    setupWeaknesses.push("You indicated you're constantly making large write-offs or patient adjustments — that's a signal your fee schedules and adjustment codes aren't set up correctly. Fix the setup and adjustments drop to zero.");
  }

  /* C. No patient-collections system AND patient-AR over-90 > 15%. */
  const arPatTotal    = Number(arPatient?.total)   || 0;
  const arPatOver90   = Number(arPatient?.d90plus) || 0;
  const arPatOver90Pct = arPatTotal > 0 ? (arPatOver90 / arPatTotal) : 0;
  if ((pp.hasPatientCollectionsSystem || '').toLowerCase() === 'no' && arPatOver90Pct > 0.15) {
    setupWeaknesses.push(`Your patient AR over 90 days is ${(arPatOver90Pct * 100).toFixed(1)}% of total patient AR, which exceeds the 15% threshold. Combined with no systematic collections process, this means patient money is being left on the table. Statement rhythm and a documented collections process are where to start.`);
  }

  /* D. No production goal or doesn't know mid-month status → scorekeeping prescription. */
  const hasGoal = (pp.hasProductionGoal || '').toLowerCase();
  const knowsIfAhead = (pp.knowsIfAhead || '').toLowerCase();
  if (hasGoal === 'no' || knowsIfAhead === 'no') {
    setupWeaknesses.push("You indicated you don't track production goals (or don't know mid-month whether you're ahead or behind). Start here, before any other initiative in this report. Dave's methodology: a weekly scorecard capturing days in/out, crown pipeline, doctor $/day, hygiene $/day, empties, and production/collections totals. Without this rhythm, every other improvement below will be hard to sustain — there's no weekly signal telling you if the fix is working.");
  }

  /* ── Q5 production diagnostic (2026-04-22): three-layer weakness ────────
     Alarm (Conversion Ratio ≥ 8:1 OR role-aware doctor $/day below warn)
     → Upstream check (empties leak? exam gap?) → Downstream branch (case
     presentation / financial arrangements). Copy NAMES the leaking layer;
     it does not prescribe the cure. Role-aware Owner/Associate targets stay
     fixed per memory: Owner warn $3,500 / Associate warn $3,000. */
  const q5 = q5Inputs || {};
  const ba_q5 = Number(q5.battingAverage);
  const ownerDaily = Number.isFinite(Number(q5.ownerDocDailyAvg)) ? Number(q5.ownerDocDailyAvg) : null;
  const assocDaily = q5.hasAssociate && Number.isFinite(Number(q5.associateDocDailyAvg)) ? Number(q5.associateDocDailyAvg) : null;
  /* Pick whichever role is tripped first; owner checked before associate. */
  let docBelowWarn = null;
  if (ownerDaily != null && ownerDaily > 0 && ownerDaily < 3500) {
    docBelowWarn = { role: 'Owner', val: ownerDaily, target: 4000 };
  } else if (assocDaily != null && assocDaily > 0 && assocDaily < 3000) {
    docBelowWarn = { role: 'Associate', val: assocDaily, target: 3500 };
  }
  const alarmA = Number.isFinite(ba_q5) && ba_q5 >= 8;
  const alarmB = !!docBelowWarn;
  if (alarmA || alarmB) {
    const fmtDollar = n => '$' + Math.round(n).toLocaleString();
    let framing;
    if (alarmA && alarmB) {
      framing = `Your Conversion Ratio is ${ba_q5.toFixed(1)}:1 (healthy range 4:1-7:1) and your ${docBelowWarn.role} doctor $/day is ${fmtDollar(docBelowWarn.val)} against a ${fmtDollar(docBelowWarn.target)} target.`;
    } else if (alarmA) {
      framing = `Your Conversion Ratio (hygiene visits per crown prepped) is ${ba_q5.toFixed(1)}:1 — the healthy range is 4:1 to 7:1, and above 8:1 trends in the wrong direction.`;
    } else {
      framing = `Your ${docBelowWarn.role} doctor $/day is ${fmtDollar(docBelowWarn.val)} against a ${fmtDollar(docBelowWarn.target)} target.`;
    }

    /* Upstream evaluation — branch priority: empties_leak > exam_gap > downstream. */
    const fillRate    = Number(q5.hygieneFillRate);
    const haveFill    = Number.isFinite(fillRate);
    const empties_leak = haveFill && fillRate < 85;

    const examsCount  = Number(q5.totalExamsCount);
    const hygVisits   = Number(q5.hygieneVisitsForExamCheck);
    const haveExams   = Number.isFinite(examsCount) && Number.isFinite(hygVisits) && hygVisits > 0;
    const examCoverage = haveExams ? (examsCount / hygVisits) : null;
    const exam_gap    = haveExams && examCoverage < 0.90;

    let branch;
    /* Dollar-opportunity math (2026-04-23) — appends a concrete dollar
       figure to each branch using Crown Unit Value + annual visits/crowns.
       Null CUV or null counts → skip the dollar clause silently. */
    const cuv = Number.isFinite(Number(q5.crownUnitValue)) ? Number(q5.crownUnitValue) : null;
    const annualHygProd = Number(q5.annualHygieneProduction) || 0;
    const annualHygVisits = Number(q5.annualHygVisits) || 0;
    const annualCrowns = Number(q5.annualCrowns) || 0;
    const fmt$_q5 = n => '$' + Math.round(n).toLocaleString();
    if (empties_leak) {
      branch = `The leading upstream contributor is hygiene capacity. Recent fill rate is ${fillRate.toFixed(0)}%, which means roughly ${(100 - fillRate).toFixed(0)}% of hygiene slots are going empty. Empty chair time shrinks the pool of exam opportunities, and exams that can't happen can't produce diagnoses. Downstream production — crowns, specialty, and total doctor $/day — is constrained by that upstream bottleneck.`;
      if (cuv != null && cuv > 0 && annualHygVisits > 0 && fillRate > 0 && Number.isFinite(ba_q5) && ba_q5 > 0) {
        const target = annualHygVisits * 95 / fillRate;
        const addedVisits = Math.max(0, target - annualHygVisits);
        const addedCrowns = addedVisits / ba_q5;
        const crownOpp   = addedCrowns * cuv;
        const hygVisitOpp = annualHygVisits > 0 ? addedVisits * (annualHygProd / annualHygVisits) : 0;
        branch += ` Recovering fill rate from ${fillRate.toFixed(0)}% to the 95% healthy floor would add roughly ${Math.round(addedVisits).toLocaleString()} hygiene visits per year. At your batting average of ${ba_q5.toFixed(1)}:1, that's ${addedCrowns.toFixed(1)} additional crowns prepped — and with a Crown Unit Value of ${fmt$_q5(cuv)}, roughly ${fmt$_q5(crownOpp)} of additional general-dentistry production (crowns plus all the supporting dentistry around them). Separately on the hygiene side, those additional ${Math.round(addedVisits).toLocaleString()} visits represent roughly ${fmt$_q5(hygVisitOpp)} of direct hygiene production.`;
      }
    } else if (exam_gap) {
      branch = `Hygiene is filling, but the doctor isn't getting into every hygiene visit for an exam. Total exams (D0150 periodic + D0120 comprehensive) over the period are ${examsCount.toLocaleString()} against ${hygVisits.toLocaleString()} hygiene visits — roughly ${Math.round(examCoverage * 100)}% coverage, against a 90% floor where the pipeline starts to work properly. Exams that don't happen can't produce diagnoses, and undiagnosed work doesn't flow to restorative, specialty, or case acceptance.`;
      if (cuv != null && cuv > 0 && Number.isFinite(ba_q5) && ba_q5 > 0 && hygVisits > 0) {
        const targetExams = 0.90 * hygVisits;
        const addedExams = Math.max(0, targetExams - examsCount);
        const addedCrowns = addedExams / ba_q5;
        const crownOpp = addedCrowns * cuv;
        branch += ` Closing exam coverage from ${Math.round(examCoverage * 100)}% to the 90% floor would add roughly ${Math.round(addedExams).toLocaleString()} exams per year. At your batting average of ${ba_q5.toFixed(1)}:1, that's ${addedCrowns.toFixed(1)} additional crowns prepped — and with a Crown Unit Value of ${fmt$_q5(cuv)}, roughly ${fmt$_q5(crownOpp)} of additional general-dentistry production (crowns plus the supporting dentistry that rides with them).`;
      }
    } else {
      branch = `Hygiene is filling at a healthy rate and the doctor is getting into exams on roughly 90%+ of hygiene visits — so the upstream clinical pipeline looks intact. The gap between diagnosis and production sits downstream: treatment plans are being generated but not converting at the rate a healthy practice shows. That points at case presentation approach or financial arrangements as the operational constraint, not the clinical pipeline.`;
      if (cuv != null && cuv > 0 && annualCrowns > 0) {
        const conversionOpp = 0.10 * annualCrowns * cuv;
        branch += ` At your current Crown Unit Value of ${fmt$_q5(cuv)} per crown, improving case acceptance by 10 percentage points would capture roughly ${fmt$_q5(conversionOpp)} of annual production that's currently being diagnosed but not converting.`;
      }
    }
    /* HIGH PRIORITY — prepended alongside the Q2 setup-foundation weaknesses
       via `highPriorityWeaknesses` below. Kept separate from `setupWeaknesses`
       so the Q2 opportunity copy (which is specifically about data foundation
       and scorekeeping) doesn't fire when only Q5 tripped. */
    var q5Weakness = `${framing} ${branch}`;
  }

  /* ── Overhead diagnostic SWOT (2026-04-22) — five-branch finding ─────────
     Alarm fires on any of: aggregate overhead ≥ 65%, total staff > 20%,
     supplies > 6%, lab > 6%, occupancy > 6%, or marketing < 2% (floor).
     Primary leak = sub-component with the largest absolute-dollar gap vs
     its benchmark. Secondary is included only if its gap ≥ 80% of primary.
     Copy NAMES the finding — no prescriptions in the body. HIGH PRIORITY
     (prepended with Q2/Q5). Any sub-component whose value is null is
     silently skipped in both alarms and ranking. */
  const oi = overheadInputs || {};
  const oAnnColl = Number(oi.annualCollections) > 0 ? Number(oi.annualCollections) : 0;
  const asPct = (v) => (v == null || !Number.isFinite(Number(v))) ? null : Number(v);
  const oOverheadPct = asPct(oi.overheadPct);
  const oStaffPct    = asPct(oi.staffCostPct);
  const oSupPct      = asPct(oi.suppliesPct);
  const oLabPct      = asPct(oi.labPct);
  const oOccPct      = asPct(oi.occupancyPct);
  const oMktPct      = asPct(oi.marketingPct);

  const oAlarmA = oOverheadPct != null && oOverheadPct >= 65;
  const oAlarmB = oStaffPct    != null && oStaffPct    >  20;
  const oAlarmC = oSupPct      != null && oSupPct      >  6;
  const oAlarmD = oLabPct      != null && oLabPct      >  6;
  const oAlarmE = oOccPct      != null && oOccPct      >  6;
  const oAlarmF = oMktPct      != null && oMktPct      <  2;
  const overheadAlarmTripped = oAlarmA || oAlarmB || oAlarmC || oAlarmD || oAlarmE || oAlarmF;

  var overheadWeakness = '';
  if (overheadAlarmTripped) {
    const fmt$ = n => '$' + Math.round(n).toLocaleString();

    /* Rank sub-components by absolute-dollar gap vs their benchmark. Ceiling
       components (staff/supplies/lab/occupancy) fire when actual > benchmark;
       floor component (marketing) fires when actual < benchmark. Any entry
       with null pct or no gap is skipped. */
    const candidates = [];
    const pushCeiling = (key, pct, bench) => {
      if (pct == null || pct <= bench || !(oAnnColl > 0)) return;
      candidates.push({ key, pct, bench, gap: (pct - bench) * oAnnColl / 100, isFloor: false });
    };
    const pushFloor = (key, pct, bench) => {
      if (pct == null || pct >= bench || !(oAnnColl > 0)) return;
      candidates.push({ key, pct, bench, gap: (bench - pct) * oAnnColl / 100, isFloor: true });
    };
    pushCeiling('staff',     oStaffPct, 20);
    pushCeiling('supplies',  oSupPct,    6);
    pushCeiling('lab',       oLabPct,    6);
    pushCeiling('occupancy', oOccPct,    6);
    pushFloor  ('marketing', oMktPct,    2);
    candidates.sort((a, b) => b.gap - a.gap);

    /* Piece 1 — aggregate framing. */
    let pieces = [];
    if (oOverheadPct != null && oAnnColl > 0) {
      pieces.push(`Overhead is ${oOverheadPct.toFixed(1)}% of collections against a 60% target / 65% warn / 70% bad band. At current collections (${fmt$(oAnnColl)}), every percentage point of overhead represents ${fmt$(oAnnColl / 100)} of annual profit.`);
    } else {
      pieces.push('Aggregate overhead % is not available from the data provided, but one or more cost categories sit outside benchmark.');
    }

    /* Piece 2 — primary leak branch. Copy is component-specific and does
       NOT prescribe the fix (lesson library owns prescriptions). */
    if (candidates.length > 0) {
      const primary = candidates[0];
      const componentLabel = {
        staff:     'staff cost',
        supplies:  'supplies',
        lab:       'lab cost',
        occupancy: 'occupancy',
        marketing: 'marketing spend',
      };
      let branch;
      if (primary.key === 'staff') {
        /* Optional role decomposition — fires only when practiceProfile.staffCosts
           contains frontOffice + backOffice + hygiene sub-ratios (future data
           Dave is still collecting). Structure is forward-compatible: adding
           those fields later auto-lights this sentence up without a rewrite. */
        const sc = (pp.staffCosts || {});
        const frontPct = Number(sc.frontOffice);
        const backPct  = Number(sc.backOffice);
        const hygPct   = Number(sc.hygiene);
        const haveRoles = [frontPct, backPct, hygPct].every(v => Number.isFinite(v)) && (frontPct + backPct + hygPct > 0);
        let roleSentence = '';
        if (haveRoles) {
          const entries = [
            { name: 'front office',           val: frontPct },
            { name: 'back office clinical',   val: backPct  },
            { name: 'hygiene',                val: hygPct   },
          ];
          const worst = entries.slice().sort((a, b) => b.val - a.val)[0];
          roleSentence = ` That staff cost decomposes to ${frontPct.toFixed(1)}% front office, ${backPct.toFixed(1)}% back office clinical, and ${hygPct.toFixed(1)}% hygiene. ${worst.name.charAt(0).toUpperCase() + worst.name.slice(1)} sits highest as a share of collections.`;
        }
        branch = `The primary contributor is staff cost at ${primary.pct.toFixed(1)}% against a 20% benchmark — roughly ${fmt$(primary.gap)} of annual opportunity on its own.${roleSentence}`;
      } else if (primary.key === 'supplies') {
        branch = `The primary contributor is supplies at ${primary.pct.toFixed(1)}% against a 6% benchmark — roughly ${fmt$(primary.gap)} of annual opportunity.`;
      } else if (primary.key === 'lab') {
        branch = `The primary contributor is lab cost at ${primary.pct.toFixed(1)}% against a 6% benchmark — roughly ${fmt$(primary.gap)} of annual opportunity.`;
      } else if (primary.key === 'occupancy') {
        branch = `The primary contributor is occupancy (rent + utilities) at ${primary.pct.toFixed(1)}% against a 6% benchmark — roughly ${fmt$(primary.gap)} of annual opportunity. Occupancy is harder to move short-term than variable costs, but the number is worth naming.`;
      } else if (primary.key === 'marketing') {
        branch = `The primary gap here is under-investment in marketing. Marketing spend is ${primary.pct.toFixed(1)}% of collections against a 2% benchmark — roughly ${fmt$(primary.gap)} of annual growth investment that isn't being made. Unlike other overhead components where lower is better, marketing is a floor — practices with no marketing spend trend toward stagnant new-patient numbers.`;
      }
      pieces.push(branch);

      /* Piece 3 — secondary leak framing, only if within 20% of primary. */
      if (candidates.length > 1 && candidates[1].gap >= 0.8 * primary.gap) {
        const sec = candidates[1];
        pieces.push(`Secondary: ${componentLabel[sec.key]} also runs outside its benchmark at ${sec.pct.toFixed(1)}% vs ${sec.bench.toFixed(1)}% — another ~${fmt$(sec.gap)} in annual opportunity.`);
      }
    }

    overheadWeakness = pieces.join(' ');
  }

  /* ── Hygiene Department Ratio SWOT (2026-04-22) — 3:1 benchmark ─────────
     Production-to-labor framing (not labor-as-percentage): healthy hygiene
     departments produce at least $3 for every $1 of hygienist wages.
     Fires when the ratio is strictly below 3 — anything at or above 3:1
     is healthy. Names the gap in dollars and points at the two structural
     paths to close it (raise $/day via empties/perio/adjuncts, or align
     compensation to production). Does NOT prescribe the how.
     Graceful degradation: null or zero on either side → no fire. */
  const hri = hygDeptRatioInputs || {};
  const hrCost = Number(hri.annualHygienistCost);
  const hrProd = Number(hri.annualHygieneProduction);
  var hygDeptRatioWeakness = '';
  if (Number.isFinite(hrCost) && hrCost > 0 && Number.isFinite(hrProd) && hrProd > 0) {
    const hrRatio = hrProd / hrCost;
    if (hrRatio < 3) {
      const fmt$ = n => '$' + Math.round(n).toLocaleString();
      const productionToHitBench = 3 * hrCost;
      const productionGap = productionToHitBench - hrProd;
      hygDeptRatioWeakness = `Your hygiene department produces $${hrRatio.toFixed(2)} for every $1 of hygiene labor cost — against a 3:1 benchmark. At current hygiene wages of ${fmt$(hrCost)}, hitting 3:1 would require annual hygiene production of ${fmt$(productionToHitBench)} against the current ${fmt$(hrProd)}, a gap of roughly ${fmt$(productionGap)}. There are two structural paths to close that gap: raise hygiene $/day (through reducing empties, building a perio program, or adjunctive therapies like Arestin and laser perio), or align hygiene compensation to production. The numbers name the gap; they don't tell you which path fits this practice.`;
    }
  }

  /* ── Hygiene Capacity SWOT (2026-04-23) — HIGH PRIORITY ─────────────────
     Two active-patient estimates (procedure-derived vs software-reported)
     plus a days-required-vs-scheduled utilization figure drive three
     weakness branches and one strength branch. Graceful degradation: null
     fields skip the dependent branches silently. */
  const hci = hygCapacityInputs || {};
  const hcUtil   = Number.isFinite(Number(hci.utilizationPct))       ? Number(hci.utilizationPct)       : null;
  const hcRet    = Number.isFinite(Number(hci.retentionDeltaPct))    ? Number(hci.retentionDeltaPct)    : null;
  const hcProcPts = Number.isFinite(Number(hci.procedureDerivedActivePatients)) ? Number(hci.procedureDerivedActivePatients) : null;
  const hcSoftPts = Number.isFinite(Number(hci.softwareDerivedActivePatients)) ? Number(hci.softwareDerivedActivePatients) : null;
  const hcDaysReq = Number.isFinite(Number(hci.daysRequiredPerMonth)) ? Number(hci.daysRequiredPerMonth) : null;
  const hcDaysSch = Number.isFinite(Number(hci.daysScheduledPerMonth)) ? Number(hci.daysScheduledPerMonth) : null;
  const hcHygProd = Number(hci.annualHygieneProduction) || 0;
  const hcHygDaily = Number(hci.hygDailyAvg) || 0;
  var hygCapWeaknesses = [];
  var hygCapStrengths  = [];
  const fmt$_hc = n => '$' + Math.round(n).toLocaleString();
  const fmtInt_hc = n => Math.round(n).toLocaleString();
  if (hcUtil != null && hcDaysReq != null && hcDaysSch != null) {
    if (hcUtil < 70 && hcDaysSch > 0) {
      const targetAnnualProd = 0.70 * hcDaysSch * 12 * hcHygDaily;
      const underutilOpp = Math.max(0, targetAnnualProd - hcHygProd);
      hygCapWeaknesses.push(`Your hygiene department is running at ${Math.round(hcUtil)}% utilization (${hcDaysReq.toFixed(1)} days required per month vs ${hcDaysSch.toFixed(1)} days scheduled). That's below the 70-90% healthy band. At current hygiene $/day of ${fmt$_hc(hcHygDaily)}, closing the gap to 70% utilization represents roughly ${fmt$_hc(underutilOpp)} of annual hygiene production currently left on the table — either through underused chair time or a recall system that's not bringing patients back.`);
    } else if (hcUtil > 90 && hcProcPts != null && hcProcPts > 0 && hcHygProd > 0) {
      const hygProdPerPatient = hcHygProd / hcProcPts;
      const unservedPatients = hcProcPts * (1 - 90 / hcUtil);
      const capacityOpp = unservedPatients * hygProdPerPatient;
      hygCapWeaknesses.push(`Your hygiene department is running at ${Math.round(hcUtil)}% utilization — above the 90% comfort ceiling. Demand from the active patient base exceeds scheduled hygiene capacity, which creates recall delays, patients pushed out to other practices, and lost production. Roughly ${fmtInt_hc(unservedPatients)} patients from your active base aren't being served at recall cadence. At an average of ${fmt$_hc(hygProdPerPatient)} of annual hygiene production per active patient, that's roughly ${fmt$_hc(capacityOpp)} of hygiene production constrained by capacity.`);
    }
  }
  /* Retention weakness / strength — only when both counts available. */
  if (hcRet != null && hcSoftPts != null && hcProcPts != null && hcSoftPts > 0 && hcHygProd > 0) {
    const hygProdPerPatient = hcHygProd / Math.max(1, hcProcPts);
    if (hcRet > 40) {
      const reactivationOpp = (hcSoftPts - hcProcPts) * 0.5 * hygProdPerPatient;
      hygCapWeaknesses.push(`The software reports ${fmtInt_hc(hcSoftPts)} active patients, but the procedure history over 24 months supports only ${fmtInt_hc(hcProcPts)}. The ${fmtInt_hc(hcSoftPts - hcProcPts)}-patient gap (${hcRet.toFixed(1)}%) represents patients the system considers active who haven't been in for a recall visit. Reactivating half of those lapsed patients would add roughly ${fmt$_hc(reactivationOpp)} of annual hygiene production.`);
    } else if (hcRet < 15) {
      hygCapStrengths.push(`Your procedure-derived active patient count tracks closely to the software's count (${fmtInt_hc(hcProcPts)} vs ${fmtInt_hc(hcSoftPts)}). This suggests patient retention is strong — patients the system considers active are actually being seen.`);
    }
  }

  /* ── Q6 BWV operational-gate weakness (2026-04-22). Independent of Q5. ─ */
  const bca = (pp.biteConsultApproach || '').toLowerCase();
  if (bca === 'during_hygiene') {
    weaknesses.push("You indicated bite/realign consults are fit into the hygiene appointment. This approach consistently underperforms for three structural reasons. First, the conversation needs 10-15 minutes — hygiene doesn't have that time. Second, the patient came in for a cleaning, not a treatment consult; pivoting breaks the expectation they walked in with. Third, leading with a solution before a dedicated diagnosis puts the patient on the defensive and the conversation ends before it starts.");
  } else if (bca === 'none' || bca === 'not_sure') {
    weaknesses.push("You indicated the practice doesn't currently do dedicated bite or realign consults (or isn't sure). For a patient base with crowding, wear, or chipping, the absence of a dedicated-consult pathway means those patients aren't being systematically screened or presented — a production-pipeline gap that shows up in restorative, specialty, and cosmetic numbers.");
  }

  /* E. Prepend any HIGH PRIORITY weaknesses so they appear at the top.
     Order within the prepended block: setup-foundation (Q2) items first,
     then the Q5 production-diagnostic item if it fired. Q2's "first 30 days
     of coaching" opportunity only fires when Q2 weaknesses actually fired
     — not when only Q5 tripped. */
  if (setupWeaknesses.length > 0) {
    opportunities.push('Building out your data foundation and scorekeeping rhythm is typically the first 30 days of coaching. It\'s what makes every other recommendation in this report actionable.');
  }
  const highPriorityWeaknesses = [...setupWeaknesses];
  if (typeof q5Weakness            !== 'undefined' && q5Weakness)            highPriorityWeaknesses.push(q5Weakness);
  if (typeof overheadWeakness      !== 'undefined' && overheadWeakness)      highPriorityWeaknesses.push(overheadWeakness);
  if (typeof hygDeptRatioWeakness  !== 'undefined' && hygDeptRatioWeakness)  highPriorityWeaknesses.push(hygDeptRatioWeakness);
  if (typeof hygCapWeaknesses      !== 'undefined' && hygCapWeaknesses.length) highPriorityWeaknesses.push(...hygCapWeaknesses);
  if (highPriorityWeaknesses.length > 0) {
    weaknesses.unshift(...highPriorityWeaknesses);
  }
  if (typeof hygCapStrengths !== 'undefined' && hygCapStrengths.length) {
    strengths.unshift(...hygCapStrengths);
  }

  /* ── THREATS ──
     "Ownership change → attrition" and "Experienced staff resist changes" rules
     were removed 2026-04-16 per Dave — they only apply in buy/sell contexts,
     not a default owner-running-their-practice assessment. Add back when
     buy/sell report modes ship. */
  if (staffCostPct > 25 && netIncomePct < 20) threats.push('Current overhead levels may prevent the practice from investing in growth');
  if (npPerMonth > 0) {
    const npProd = codeTotal('D0150');
    const npProdPct = totalProd > 0 ? (npProd / totalProd * 100) : 0;
    if (npProdPct > 5) threats.push('The practice may be overly reliant on new patient flow');
  }
  if (specPct > 15) threats.push('Heavy reliance on specialty services means the provider must be able to sustain this production');

  /* Shrinking patient base: if new patient flow is below ~18% of the active
     patient base (industry attrition rule of thumb), the practice is losing
     patients faster than it's replacing them. */
  const prophyAnnualSWOT = codeTotal('D1110') === undefined ? 0 : (prodData?.codes || []).filter(c => (c.code||'').toUpperCase().startsWith('D1110')).reduce((s,c) => s + (c.qty||0), 0);
  const perioMaintAnnualSWOT = (prodData?.codes || []).filter(c => (c.code||'').toUpperCase().startsWith('D4910')).reduce((s,c) => s + (c.qty||0), 0);
  const srpAnnualSWOT = (prodData?.codes || []).filter(c => ['D4341','D4342'].some(p => (c.code||'').toUpperCase().startsWith(p))).reduce((s,c) => s + (c.qty||0), 0);
  const compExamAnnualSWOT = (prodData?.codes || []).filter(c => (c.code||'').toUpperCase().startsWith('D0150')).reduce((s,c) => s + (c.qty||0), 0);
  const activePatSWOT = ((prophyAnnualSWOT / 2) + (perioMaintAnnualSWOT / 4) + (srpAnnualSWOT / 16)) / 0.80;
  const newPatAnnualSWOT = compExamAnnualSWOT;
  if (activePatSWOT > 100 && newPatAnnualSWOT > 0) {
    const replacementNeeded = activePatSWOT * 0.18;  /* ~18% annual attrition */
    if (newPatAnnualSWOT < replacementNeeded * 0.85) {
      const gapPatients = Math.round(replacementNeeded - newPatAnnualSWOT);
      threats.push(`New patient flow (~${Math.round(newPatAnnualSWOT)}/year) is below the ~${Math.round(replacementNeeded)}/year needed to replace natural attrition on an active base of ~${Math.round(activePatSWOT)} patients — the practice may be shrinking by ~${gapPatients} patients/year`);
    }
  }

  /* Insurance aging tail risk: 90+ days bucket above 10% of total insurance AR
     means claims are dragging and cash flow compounds downstream. */
  const insuranceARTotal = Number(arInsurance?.total) || 0;
  const insuranceAR90 = Number(arInsurance?.d90plus) || 0;
  if (insuranceARTotal > 0 && (insuranceAR90 / insuranceARTotal) > 0.10) {
    const pct = Math.round((insuranceAR90 / insuranceARTotal) * 100);
    threats.push(`Insurance AR 90+ is ${pct}% of total insurance receivables ($${Math.round(insuranceAR90).toLocaleString()} of $${Math.round(insuranceARTotal).toLocaleString()}) — slow claims aging tail compounds into write-offs and cash-flow pressure`);
  }

  /* Single-channel revenue concentration: >60% of payor mix in one bucket means
     a single policy change (insurer fee cut, state Medicaid reform, PPO in/out of
     network) can swing the whole top line. */
  if (ppoPct > 60) {
    threats.push(`Payor mix is ${Math.round(ppoPct)}% PPO — single-channel revenue concentration means a PPO fee-schedule cut or network change can swing the top line materially`);
  } else if (hmoPct > 60) {
    threats.push(`Payor mix is ${Math.round(hmoPct)}% HMO — single-channel revenue concentration amplifies the effect of any capitation-rate or contract change`);
  } else if (govPct > 60) {
    threats.push(`Payor mix is ${Math.round(govPct)}% government/Medicaid — single-channel revenue concentration makes the practice vulnerable to state reimbursement changes`);
  } else if (ffsPct > 60 && (Number(pp.npPerMonth) || npPerMonth || 0) < 20) {
    threats.push(`Practice is ${Math.round(ffsPct)}% FFS / out-of-network with limited new-patient flow — a concentrated economic exposure if referrals soften`);
  }

  /* Succession risk: owner 60+ with no associate means there's no transition
     runway in place — a health or lifestyle change collapses practice value fast. */
  const ownerAgeNum = Number(pp.ownerAge) || 0;
  if (ownerAgeNum >= 60 && !pp.hasAssociate) {
    threats.push(`Owner is ${ownerAgeNum} with no associate in place — succession risk: a health event or accelerated exit timeline has no transition runway and compresses practice value`);
  }

  /* Labor cost crowding out growth: anchored on TOTAL staff cost vs 30%
     (2026-04-21 hybrid methodology). At that level the labor load leaves
     no margin to reinvest in marketing, tech, or capacity — and since the
     admin/hygienist split is diagnostic color, the primary threat fires
     on the total figure. */
  if (staffCostPct > 30) {
    threats.push(`Total staff cost at ${staffCostPct.toFixed(1)}% of collections is crowding out growth investment — with this much of every dollar going to labor, every expansion decision (new chair, marketing push, hygiene day) has to clear a higher bar to pencil out`);
  }

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
    totalProd, collTotal, years, prodMonths, hygieneData, patientSummary,
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
  /* Hygiene codes (2026-04-21 methodology, from hygiene-percentage.yaml):
     prophy/perio visits + locally-delivered antimicrobial + debridement
     + periodic/limited exam visit companions + bitewings. D0150
     (comprehensive exam) is NOT hygiene — it's the NP visit anchor. */
  const hygCodes = ['D1110','D1120','D4910','D4341','D4342','D4346','D4381','D0120','D0140','D0274'];
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

  /* ──── Conversion Ratio inputs (knowledge base: kpis/batting-average.yaml) ──── */
  /* Visits (numerator): prophy, perio maint, SRP, comp exam. EXCLUDES D0120
     (periodic exam is a diagnostic companion, not a standalone visit). */
  const VISIT_CODES = ['D1110','D1120','D4910','D4341','D4342','D0150'];
  /* Crowns (denominator): full range per 2026-04-21 reconciliation.
     Directly-enumerated single-unit crowns + veneers; implant crowns
     (D6058-D6067) and bridge units (D6210-D6794) via numeric-range match so
     we don't miss D6246/D6608/etc. if they appear. */
  const CROWN_CODES = [
    /* Porcelain / ceramic */
    'D2740','D2750','D2751','D2752',
    /* Resin */
    'D2710','D2712',
    /* Cast metal / gold */
    'D2780','D2781','D2782','D2783','D2790','D2791','D2792','D2794',
    /* Veneers */
    'D2960','D2961','D2962',
  ];
  const isCrownCode = (raw) => {
    const code = (raw || '').toUpperCase();
    if (CROWN_CODES.includes(code)) return true;
    if (!/^D\d{4}$/.test(code)) return false;
    const n = parseInt(code.slice(1), 10);
    if (n >= 6058 && n <= 6067) return true;   /* implant crowns */
    if (n >= 6210 && n <= 6794) return true;   /* bridge units (pontics + retainers) */
    return false;
  };
  const countCodeMatchingQty = (list) => codes
    .filter(c => list.includes((c.code || '').toUpperCase()))
    .reduce((s, c) => s + (c.qty || 0), 0);
  const visitsCount = countCodeMatchingQty(VISIT_CODES);
  const crownsPreppedCount = codes
    .filter(c => isCrownCode(c.code))
    .reduce((s, c) => s + (c.qty || 0), 0);

  /* Q5 exam-gap inputs (2026-04-22): totalExams = D0150 + D0120 over the period,
     hygieneVisitsForExamCheck = D1110+D1120+D4910+D4341+D4342 (prophy + perio
     maint + SRP — NO D0150, unlike VISIT_CODES). Ratio should sit near 0.90+
     if the doctor is getting into every hygiene visit for an exam. */
  const EXAM_CODES = ['D0150', 'D0120'];
  const HYG_VISIT_CODES = ['D1110', 'D1120', 'D4910', 'D4341', 'D4342'];
  const totalExamsCount           = countCodeMatchingQty(EXAM_CODES);
  const hygieneVisitsForExamCheck = countCodeMatchingQty(HYG_VISIT_CODES);
  const exam0120Count = codes
    .filter(c => (c.code || '').toUpperCase().startsWith('D0120'))
    .reduce((s, c) => s + (c.qty || 0), 0);
  const battingAverage = crownsPreppedCount > 0 ? visitsCount / crownsPreppedCount : null;

  /* ──── Crown Unit Value (2026-04-23) ────
     CUV = (totalProduction − hygieneProduction − specialtyProduction) ÷ crownsPrepped
     = GP / restorative dollars accompanying each crown. No hard benchmark —
     neutral diagnostic. Feeds the Q5 dollar-opportunity math.
     Specialty bucket (different from the existing category split which
     counts SRP/perio maint as perio): endodontics D3xxx, periodontal
     surgery D4260-D4299 (excludes D4341/D4342/D4910), implant surgery
     D6010-D6199 (excludes D6056+ prosthetic — those ARE in the crown
     denominator), oral surgery D7xxx, orthodontics D8xxx. */
  const isCuvSpecialty = (rawCode) => {
    const c = (rawCode || '').toUpperCase();
    if (!/^D\d{4}$/.test(c)) return false;
    const n = parseInt(c.slice(1), 10);
    if (c.startsWith('D3')) return true;                    /* endo */
    if (c.startsWith('D4') && n >= 4260 && n <= 4299) return true;  /* perio surgery */
    if (c.startsWith('D6') && n >= 6010 && n <= 6199) return true;  /* implant surgery */
    if (c.startsWith('D7')) return true;                    /* oral surgery */
    if (c.startsWith('D8')) return true;                    /* ortho */
    return false;
  };
  const cuvSpecialtyProduction = codes
    .filter(c => isCuvSpecialty(c.code))
    .reduce((s, c) => s + (c.total || 0), 0);
  const crownUnitValue = crownsPreppedCount > 0
    ? (totalProd - prodHyg - cuvSpecialtyProduction) / crownsPreppedCount
    : null;

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
  /* Canonical Combined Doctor $/Day = annualDoctor ÷ (ownerDays + associateDays × 12).
     When hasAssociate=true this includes both provider streams; when hasAssociate=false
     totalDocDaysYr = ownerDaysYr and the "combined" card degenerates to owner-only.
     The Executive Report scorecard card, the review page, and kpis.combinedDocDailyAvg
     all read from this one value — keep it the single source of truth. */
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

  /* ──── Hygiene schedule fill-rate + near-future pre-booking (2026-04-21) ────
     The Hub posts `hygieneData` as either:
       - direct numeric fields (fixtures, or a future form rev that pre-computes)
         hygieneData.recentFillRate, hygieneData.nearFuturePreBooking
       - or grid arrays from collectHygieneSchedule():
         hygieneData.recentPast[].data   (evens = totalAppt, odds = patSeen)
         hygieneData.nearFuture[].data   (evens = totalAppt, odds = apptFilled)
     We prefer the direct fields when present; otherwise derive from grids. */
  const sumEvenOdd = (weeks) => {
    let a = 0, b = 0;
    for (const w of (weeks || [])) {
      const d = w?.data || [];
      for (let i = 0; i < d.length; i += 2) {
        a += Number(d[i])     || 0;   /* column a: total appointments available */
        b += Number(d[i + 1]) || 0;   /* column b: seen / filled / confirmed */
      }
    }
    return { a, b };
  };
  let hygieneFillRate = null;
  let hygieneNearFuturePreBooking = null;
  if (hygieneData) {
    if (Number.isFinite(Number(hygieneData.recentFillRate))) {
      hygieneFillRate = Number(hygieneData.recentFillRate);
    } else {
      const { a, b } = sumEvenOdd(hygieneData.recentPast);
      if (a > 0) hygieneFillRate = Math.round((b / a) * 100);
    }
    if (Number.isFinite(Number(hygieneData.nearFuturePreBooking))) {
      hygieneNearFuturePreBooking = Number(hygieneData.nearFuturePreBooking);
    } else {
      const { a, b } = sumEvenOdd(hygieneData.nearFuture);
      if (a > 0) hygieneNearFuturePreBooking = Math.round((b / a) * 100);
    }
  }

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
  /* Two data paths, preferred in order:
       1. prodData.revenueBreakdown — Dentrix Payment Summary (2026-04-23).
          Authoritative when present because it's fed by the PM software's
          own payment classification, not the generic "Sales" catch-all on
          the QuickBooks P&L.
       2. plData income-section items — legacy path, still fires for
          practices on other PM software or when the Dentrix prompt didn't
          emit REVENUE_* lines (older cached prodText).
     Whichever path wins populates the same sourcesOfDollars shape below. */
  const sourcesOfDollars = { insurance: 0, patientCreditCard: 0, patientCheck: 0, patientCash: 0, thirdPartyFinance: 0, government: 0, other: 0 };
  const sourceItems = [];
  let sourcesSource = null;  /* 'dentrix' | 'pl' | null */
  const rb = prodData?.revenueBreakdown;
  if (rb && (rb.insurance || rb.patient || rb.thirdPartyFinance || rb.government)) {
    /* Dentrix path: patient lumps into a single patient bucket (the card
       rolls the three patientCreditCard/Check/Cash slots into patientPayTotal
       anyway), so we stuff the entire patient figure into patientCreditCard
       as a convenience — callers that read patientPayTotal will get the
       same answer. */
    sourcesOfDollars.insurance        = rb.insurance        || 0;
    sourcesOfDollars.patientCreditCard = rb.patient         || 0;
    sourcesOfDollars.thirdPartyFinance = rb.thirdPartyFinance || 0;
    sourcesOfDollars.government       = rb.government       || 0;
    sourceItems.push({ item: 'Dentrix: Insurance payments',  amount: rb.insurance || 0,         bucket: 'insurance' });
    sourceItems.push({ item: 'Dentrix: Patient payments',    amount: rb.patient || 0,           bucket: 'patientCreditCard' });
    sourceItems.push({ item: 'Dentrix: 3rd-party financing', amount: rb.thirdPartyFinance || 0, bucket: 'thirdPartyFinance' });
    sourceItems.push({ item: 'Dentrix: Government/capitation', amount: rb.government || 0,      bucket: 'government' });
    sourcesSource = 'dentrix';
  } else if (plData?.items) {
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
    sourcesSource = 'pl';
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

  /* Staff cost — three metrics per Dave's methodology:
       staffCostPct       = total (admin + hygiene) ÷ annualCollections  — industry reference
       staffCostExHygPct  = admin/clinical only       ÷ annualCollections  — primary coaching anchor
       hygienistCostPct   = hygiene wages             ÷ annualHygieneProd — isolates hygienist productivity
     The last normalizes for how many days/week hygiene runs, so it's
     apples-to-apples across practices with different hygiene footprints. */
  const staffCostPct      = canonicalStaffCostPct(employeeCosts, annualCollections);
  const staffCostExHygPct = staffCostExHygPctCalc(employeeCosts, annualCollections);
  const hygienistCostPct  = hygienistCostPctCalc(employeeCosts, annualHyg);
  /* Raw hygiene labor + production dollars — needed for the Hygiene
     Department Ratio SWOT (2026-04-22). Exposed separately from the
     percentage so the SWOT copy can cite both sides of the 3:1 benchmark. */
  const annualHygienistCost = employeeCosts ? staffRoleAnnualCost(
    employeeCosts.hygiene, employeeCosts.hygBenefits, employeeCosts.hygEmpCostPct
  ) : 0;

  /* ──── Hygiene Capacity Analysis (2026-04-23) ────
     Two independent active-patient estimates plus a days-required-vs-
     scheduled utilization figure. Drives the HIGH-priority Hygiene
     Capacity SWOT and a new scorecard card.
       procedureDerivedActivePatients — built from 24 months of procedure
         counts. Dave's formula expects 24-month data; we scale whatever
         prodMonths the report captured to 24 months before applying it.
       softwareDerivedActivePatients — pulled from the Patient Summary
         PDF (Bug 4's new prompt). Null when Hub didn't upload one.
       utilizationPct — days-required / days-scheduled. Healthy 70-90%. */
  const scaleTo24 = prodMonths > 0 ? 24 / prodMonths : 2;
  const prophyVisits24 = countCodeMatchingQty(['D1110', 'D1120']) * scaleTo24;
  const perioMaint24   = countCodeMatchingQty(['D4910']) * scaleTo24;
  const srpVisits24    = countCodeMatchingQty(['D4341', 'D4342']) * scaleTo24;
  const procedureDerivedActivePatients = (prophyVisits24 + perioMaint24 + srpVisits24) > 0
    ? Math.round((prophyVisits24 / 4 + perioMaint24 / 8 + srpVisits24 / 12) / 0.80)
    : null;
  const softwareDerivedActivePatients = (patientSummary && Number.isFinite(patientSummary.activePatients))
    ? patientSummary.activePatients : null;

  const hygVisitsPerMonth    = (prophyVisits24 + perioMaint24 + srpVisits24) / 24;
  const patsPerHygDay        = Number(pp.patientsPerHygienistPerDay) || 8;
  const daysRequiredPerMonth = patsPerHygDay > 0 ? hygVisitsPerMonth / patsPerHygDay : null;
  const daysScheduledPerMonth = hygieneDaysPerWeek > 0 ? hygieneDaysPerWeek * 4.33 : null;
  const utilizationPct = (daysRequiredPerMonth != null && daysScheduledPerMonth != null && daysScheduledPerMonth > 0)
    ? (daysRequiredPerMonth / daysScheduledPerMonth) * 100
    : null;
  const retentionDeltaPct = (softwareDerivedActivePatients != null && procedureDerivedActivePatients != null && softwareDerivedActivePatients > 0)
    ? ((softwareDerivedActivePatients - procedureDerivedActivePatients) / softwareDerivedActivePatients) * 100
    : null;

  /* ──── Overhead Breakdown (2026-04-22, P&L precedence added 2026-04-23) ──── */
  /* Two data paths per sub-component, preferred in order:
       1. P&L items[] (Expense section) that match the sub-component regex.
          Authoritative when present — actuals from the accountant's books
          beat the dentist's from-memory estimate.
       2. Questionnaire `overheadBreakdown.annual*Spend` — fallback when
          the P&L path produced no matching line items. */
  const ob = pp.overheadBreakdown || {};
  const sumPLExpensesMatching = (re) => {
    if (!plData || !Array.isArray(plData.items)) return null;
    let sum = 0, hit = false;
    for (const it of plData.items) {
      if (it.section !== 'Expense') continue;
      if (re.test(it.item || '')) { sum += it.amount; hit = true; }
    }
    return hit ? sum : null;
  };
  const suppliesFromPL   = sumPLExpensesMatching(/suppl/i);
  const labFromPL        = sumPLExpensesMatching(/\blab\b|laboratory/i);
  const occupancyFromPL  = sumPLExpensesMatching(/\brent\b|\butilit|occupan|property\s*tax|\bbuilding\s*maint/i);
  const marketingFromPL  = sumPLExpensesMatching(/advertis|marketing/i);
  const pickDollar = (fromPL, fromQ) => {
    if (fromPL != null) return { value: fromPL, source: 'pl' };
    const n = Number(fromQ);
    if (Number.isFinite(n) && n > 0) return { value: n, source: 'questionnaire' };
    return { value: null, source: null };
  };
  const suppliesPick  = pickDollar(suppliesFromPL,  ob.annualSuppliesSpend);
  const labPick       = pickDollar(labFromPL,       ob.annualLabSpend);
  const occupancyPick = pickDollar(occupancyFromPL, ob.annualOccupancyCost);
  const marketingPick = pickDollar(marketingFromPL, ob.annualMarketingSpend);
  const toPct = (v) => (v != null && annualCollections > 0) ? (v / annualCollections) * 100 : null;
  const suppliesPct  = toPct(suppliesPick.value);
  const labPctOb     = toPct(labPick.value);
  const occupancyPct = toPct(occupancyPick.value);
  const marketingPct = toPct(marketingPick.value);
  const overheadBreakdownSource = {
    supplies:  suppliesPick.source,
    lab:       labPick.source,
    occupancy: occupancyPick.source,
    marketing: marketingPick.source,
  };

  /* ──── Goal matrix ──── */
  const goalDocDaily = combinedDocDailyAvg || 0;
  const goalHygDaily = hygDailyAvg || 0;
  const gCurrentAnnual = annualProd;

  /* Round displayed $/day targets to nearest $100 — cleaner than $1,002 / $4,215. */
  const round100 = n => Math.round(n / 100) * 100;
  const gShortDocDaily = round100(goalDocDaily * 1.15);
  const gShortHygDaily = round100(goalHygDaily + 200);
  const gShortAnnual = (gShortDocDaily * totalDocDaysYr) + (gShortHygDaily * hygDaysPerYear) + annualSpecialty;

  const gLongDocDaily = round100(goalDocDaily * 1.30);
  const gLongHygDaily = round100(goalHygDaily + 400);
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
    const targetHyg = annualProd * 0.33;
    const hygGap = targetHyg - annualHyg;
    if (hygGap > 5000) opps.push({
      icon: '🦷', value: hygGap, title: 'Hygiene production gap',
      body: `Hygiene is ${hygPct.toFixed(1)}% of production vs the 33% target. Three levers to close this gap: (1) Reduce empties in the hygiene schedule — unfilled slots are lost revenue. (2) Build a perio program — a steady flow of new SRP (D4341/D4342) diagnoses each month that convert to perio maintenance (D4910) shifts hygiene production upward because perio maint bills higher than prophy. (3) Add adjunctive therapies where clinically indicated — Arestin (D4381) and laser-assisted periodontal treatment add revenue per visit without adding chair time. Growing hygiene to benchmark could add up to $${Math.round(hygGap).toLocaleString()} annually.`
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
  /* Staff cost opportunity — anchored on TOTAL staff cost vs 20%
     (2026-04-21 hybrid methodology). Dollar value = (total% - 20) × annual
     collections. The admin/clinical and hygienist-ratio decomposition is
     surfaced in the body as diagnostic color so the dentist knows where
     the cost lives, but the scoreboard is the total figure. */
  if (staffCostPct != null && staffCostPct > 20 && annualCollections > 0) {
    const savings = annualCollections * (staffCostPct/100 - 0.20);
    if (savings > 5000) {
      const adminTxt = staffCostExHygPct != null ? staffCostExHygPct.toFixed(1) + '%' : '—';
      const hygTxt   = hygienistCostPct  != null ? hygienistCostPct.toFixed(1)  + '%' : '—';
      opps.push({
        icon: '👥', value: savings, title: 'Staff cost optimization',
        body: `Total staff cost is ${staffCostPct.toFixed(1)}% of collections vs a 20% benchmark. Reducing total staff cost toward benchmark could free approximately $${Math.round(savings).toLocaleString()} per year. Of that ${staffCostPct.toFixed(1)}% total: admin/clinical is ${adminTxt} (benchmark-free reference) and hygienist wages are ${hygTxt} of hygiene production (benchmark-free reference) — see admin vs hygienist breakdown on the scorecard for where to focus.`
      });
    }
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
      numHygienists: Number(pp.numHygienists) || 0,
      patientsPerHygienistPerDay: Number(pp.patientsPerHygienistPerDay) || 0,
      hasAssociate: !!pp.hasAssociate,
      associateDaysPerMonth,
      crownsPerMonth: pp.crownsPerMonth || null,
      payorMix: mix,
      /* Dentist's own words — surfaced on Report + Review to tie every finding
         back to what the dentist said was wrong. */
      concerns: Array.isArray(pp.concerns) ? pp.concerns : [],
      biggestChallenge: pp.biggestChallenge ? String(pp.biggestChallenge).trim() : '',
      /* Patient Summary metrics from Dentrix Patient Summary PDF when the
         Hub uploads it (2026-04-23). Null when that PDF wasn't included.
         Unblocks hygiene-capacity math and Q5 dollar-opportunity work. */
      patientSummary: patientSummary || null,
    },

    period: {
      prodMonths,
      years,
      dateStart: prodData?.dateStart || null,
      dateEnd:   prodData?.dateEnd   || null,
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
      /* Chart labels get the % appended so readers see the percentage at the
         end of each bar (donut chart removed per Dave's 2026-04-16 feedback). */
      categoriesForChart: prodCategories.map(c => {
        const pct = totalProd > 0 ? (c.value / annualFactor / totalProd * 100) : 0;
        return { label: `${c.label} — ${pct.toFixed(0)}%`, value: Math.round(c.value) };
      }),
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
      staffCostPct,                   /* total — admin + hygiene, ÷ annualCollections (industry ref) */
      staffCostExHygPct,              /* admin/clinical only, ÷ annualCollections (primary coaching anchor) */
      hygienistCostPct,               /* hygiene-only, ÷ annualHygieneProduction (normalized) */
      sourcesOfDollars: {
        dollars: sourcesOfDollars,
        percent: sourcesPct,
        total: sourcesTotal,
        items: sourceItems,
        patientPayTotal,
        patientPayPct,
        /* 2026-04-23: tracks which path populated these figures — 'dentrix'
           when the Payment Summary section of the Practice Analysis PDF
           emitted REVENUE_* lines; 'pl' when we fell back to the P&L Income
           section; null when neither path produced any data. */
        source: sourcesSource,
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
      staffCostExHygPct,
      hygienistCostPct,
      battingAverage,           /* visits ÷ crowns prepped (lower is better; sweet spot 4-6:1) */
      battingAverageInputs: {
        visitsCount,
        crownsPreppedCount,
        exam0120Count,          /* diagnostic companion for BA — compare to visitsCount when BA is high */
      },
      /* Crown Unit Value (2026-04-23): GP production per crown. No hard
         benchmark — neutral diagnostic. Feeds Q5 dollar-opportunity math. */
      crownUnitValue,
      crownUnitValueInputs: {
        cuvSpecialtyProduction,
        crownsPreppedCount,
        totalProd,
        hygieneProduction: prodHyg,
      },
      /* Q5 exam-gap inputs (2026-04-22) — drives the three-layer production
         diagnostic. totalExams vs hygieneVisits tells us whether the doctor
         is getting into hygiene visits for the exam step. */
      totalExamsCount,
      hygieneVisitsForExamCheck,
      /* Hygiene scheduling signals (from hygiene_schedule_form / hub collectHygieneSchedule).
         Null when no hygieneData was supplied. Renderer hides the fill-rate card when null. */
      hygieneFillRate,
      hygieneNearFuturePreBooking,
      /* Overhead Breakdown (2026-04-22, P&L precedence 2026-04-23) — sub-
         component % of collections. Source = 'pl' when the P&L contributed
         a matching line item, 'questionnaire' when we fell back to the
         overheadBreakdown questionnaire value, null when neither path
         produced data. Drives the five-branch Overhead SWOT. */
      overheadSuppliesPct:  suppliesPct,
      overheadLabPct:       labPctOb,
      overheadOccupancyPct: occupancyPct,
      overheadMarketingPct: marketingPct,
      overheadBreakdownSource,
      /* Hygiene Department Ratio inputs (2026-04-22) — raw labor + production
         dollars backing the 3:1 methodology benchmark. Null when either is 0. */
      annualHygienistCost:       annualHygienistCost > 0 ? annualHygienistCost : null,
      annualHygieneProduction:   annualHyg > 0 ? annualHyg : null,
      /* Hygiene Capacity Analysis (2026-04-23) — feeds the HIGH-priority
         Hygiene Capacity SWOT. Null fields graceful-degrade individual
         sub-findings. */
      hygieneCapacity: {
        procedureDerivedActivePatients,
        softwareDerivedActivePatients,
        daysRequiredPerMonth,
        daysScheduledPerMonth,
        utilizationPct,
        retentionDeltaPct,
        hygVisitsPerMonth,
        patientsPerHygPerDay: patsPerHygDay,
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

  /* ── Scorecard cards ──
     Order (2026-04-21 methodology — coaching-ritual flow anchored on production):
       1. Annual Production      (the anchor — topline first)
       2. Combined Doctor $/Day
       3. Hygiene Avg $/Day
       4. Hygiene Fill Rate      (when hygieneSchedule data present)
       5. Hygiene % of Production
       6. Collection Rate
       7. Overhead %
     Staff cost decomposition + Conversion Ratio follow (appended after the
     primary ritual order). */
  const scorecardCards = [
    { lbl: 'Annual Production', val: fmt$(kpis.annualProduction), bench: period.prodMonths ? `Based on ${period.prodMonths}mo, annualized` : '', status: '' },
  ];

  /* 2. Doctor $/day: Combined card. Benchmarks (2026-04-21): owner $4,000/day,
     associate $3,500/day; when both present, show day-weighted blend target. */
  {
    const hasAssoc = practice.associateDaysPerMonth > 0;
    const docVal = kpis.combinedDocDailyAvg || kpis.ownerDocDailyAvg;
    const ownerDaysYr = practice.doctorDays * 12;
    const assocDaysYr = practice.associateDaysPerMonth * 12;
    const totalDays = ownerDaysYr + assocDaysYr;
    const blend = (ownerVal, assocVal) => hasAssoc && totalDays > 0
      ? (ownerVal * ownerDaysYr + assocVal * assocDaysYr) / totalDays
      : ownerVal;
    const targetVal = blend(4000, 3500);
    const warnVal   = blend(3500, 3000);
    const docStatus = (docVal == null || !isFinite(docVal) || docVal <= 0)
      ? ''
      : (docVal >= targetVal ? 'good' : (docVal >= warnVal ? 'warn' : 'bad'));
    const targetLabel = hasAssoc
      ? `Blended target <strong>${fmt$(Math.round(targetVal))}/day</strong> (owner $4k · assoc $3.5k, weighted by days)`
      : 'Target <strong>$4,000/day</strong> (owner / GP)';
    scorecardCards.push({
      lbl: hasAssoc ? 'Combined Doctor $/Day' : 'Doctor $/Day',
      val: fmt$(docVal),
      bench: targetLabel,
      status: docStatus,
    });
  }

  /* 3. Hygiene $/day: payor-mix-dependent benchmarks (2026-04-21).
     PPO/FFS/unknown → $1,000 healthy ($1,200 excellent, $800 floor).
     HMO/Medicaid/capitated (HMO + Gov > 50%) → $500–600 healthy, $400 warn. */
  {
    const mix = practice.payorMix || {};
    const hmoPct = Number(mix.hmo) || 0;
    const govPct = Number(mix.gov) || 0;
    const isCapitated = (hmoPct + govPct) > 50;
    const hygVal = kpis.hygDailyAvg;
    const hygStatus = (hygVal == null || !isFinite(hygVal) || hygVal <= 0)
      ? ''
      : isCapitated
        ? (hygVal >= 500 ? 'good' : (hygVal >= 400 ? 'warn' : 'bad'))
        : (hygVal >= 1000 ? 'good' : (hygVal >= 800 ? 'warn' : 'bad'));
    const hygBench = isCapitated
      ? `Target <strong>$500–600</strong> (HMO/capitated tier) &middot; ${practice.hygieneDaysPerWeek} days/week`
      : `Target <strong>$1,000+</strong> (PPO/FFS tier; $1,200 excellent) &middot; ${practice.hygieneDaysPerWeek} days/week`;
    scorecardCards.push({ lbl: 'Hygiene Avg $/Day', val: fmt$(hygVal), bench: hygBench, status: hygStatus });
  }

  /* 4. Hygiene Fill Rate (2026-04-21) — only rendered when hygieneSchedule
     data was supplied. >=95% good; 85–94 warn; <85 bad. */
  if (kpis.hygieneFillRate != null && Number.isFinite(kpis.hygieneFillRate)) {
    const fr = kpis.hygieneFillRate;
    const frStatus = fr >= 95 ? 'good' : (fr >= 85 ? 'warn' : 'bad');
    scorecardCards.push({
      lbl: 'Hygiene Fill Rate',
      val: fr.toFixed(0) + '%',
      bench: `Past weeks &middot; Empties: ${(100 - fr).toFixed(0)}%`,
      status: frStatus,
    });
  }

  /* 5. Hygiene % of Production. */
  scorecardCards.push({ lbl: 'Hygiene % of Production', val: (kpis.hygienePercent != null && kpis.hygienePercent > 0) ? kpis.hygienePercent.toFixed(1) + '%' : '—', bench: 'Target <strong>33%</strong> (acceptable &ge;30%)', status: (kpis.hygienePercent == null || kpis.hygienePercent <= 0) ? '' : (kpis.hygienePercent >= 30 ? 'good' : (kpis.hygienePercent >= 25 ? 'warn' : 'bad')) });

  /* 6. Collection Rate. */
  scorecardCards.push({ lbl: 'Collection Rate', val: (kpis.collectionRate != null && kpis.collectionRate > 0) ? kpis.collectionRate.toFixed(1) + '%' : '—', bench: 'Target <strong>97%+</strong>', status: statusVs(kpis.collectionRate, 97, true) });

  /* 7. Overhead %. Show raw alongside adjusted when add-backs were applied. */
  const addBackTotal = (financials.ownerAddBacks || 0) + (financials.patientReimbursements || 0);
  const overheadBench = addBackTotal > 0
    ? `Target <strong>≤60%</strong> · raw ${financials.overheadRawPct ? financials.overheadRawPct.toFixed(1) : '—'}%, less $${Math.round(addBackTotal).toLocaleString()} add-backs`
    : 'Target <strong>≤60%</strong>';
  scorecardCards.push({ lbl: 'Overhead %', val: (kpis.overheadPct != null && kpis.overheadPct > 0) ? kpis.overheadPct.toFixed(1) + '%' : '—', bench: overheadBench, status: statusVs(kpis.overheadPct, 60, false) });

  /* Staff-cost decomposition cards — un-flagged diagnostic per 2026-04-21
     hybrid methodology. Primary red flag lives on Total Staff Cost in the
     financials section; these two are here to show WHERE the total cost
     lives (front-desk/admin vs hygiene), not as individually-benchmarked
     metrics. No color status; no "Target" phrasing. */
  if (kpis.staffCostExHygPct != null) {
    const v = kpis.staffCostExHygPct;
    scorecardCards.push({
      lbl: 'Staff Cost (Admin + Clinical)',
      val: v.toFixed(1) + '%',
      bench: 'Front desk, OM, assistants &mdash; excludes hygiene &middot; diagnostic reference',
      status: '',
    });
  }
  if (kpis.hygienistCostPct != null) {
    const v = kpis.hygienistCostPct;
    scorecardCards.push({
      lbl: 'Hygienist Wage Ratio',
      val: v.toFixed(1) + '%',
      /* 2026-04-22: added the 3:1 benchmark note so the card framing lines
         up with the Hygiene Department Ratio SWOT copy — tiers and data
         source are unchanged. */
      bench: '% of hygiene production &middot; diagnostic reference<br>Benchmark: hygiene produces at least $3 for every $1 of wages.',
      status: '',
    });
  }

  /* Hygiene Capacity (2026-04-23) — utilization = days required / scheduled.
     <70 red (under-utilized), 70-90 green (healthy), >90 amber (constrained).
     Card body cites procedure-derived vs software-reported active-patient
     counts so the reader sees both sides. Hidden when utilization null
     (no hygiene schedule days captured). */
  if (kpis.hygieneCapacity && kpis.hygieneCapacity.utilizationPct != null) {
    const hc = kpis.hygieneCapacity;
    const u = hc.utilizationPct;
    const capStatus = u < 70 ? 'bad' : (u <= 90 ? 'good' : 'warn');
    const fmtInt = n => n == null ? '—' : Math.round(n).toLocaleString();
    const procPts = hc.procedureDerivedActivePatients;
    const softPts = hc.softwareDerivedActivePatients;
    const delta = (softPts != null && procPts != null) ? softPts - procPts : null;
    const deltaPct = hc.retentionDeltaPct;
    let benchBody = `${(hc.daysRequiredPerMonth || 0).toFixed(1)} days required vs ${(hc.daysScheduledPerMonth || 0).toFixed(1)} scheduled &middot; procedure-derived active patients: ${fmtInt(procPts)}`;
    if (softPts != null && delta != null && deltaPct != null) {
      benchBody += `, software-reported: ${fmtInt(softPts)} (delta ${delta >= 0 ? '+' : ''}${fmtInt(delta)}, ${deltaPct.toFixed(1)}%)`;
    }
    scorecardCards.push({
      lbl: 'Hygiene Capacity',
      val: u.toFixed(0) + '%',
      bench: benchBody,
      status: capStatus,
    });
  }

  /* Crown Unit Value (2026-04-23) — neutral diagnostic, no benchmark.
     Feeds the Q5 dollar-opportunity math. Lower ≈ crown-dominated revenue;
     higher ≈ more supporting general dentistry per crown prepped. */
  if (kpis.crownUnitValue != null && kpis.crownUnitValue > 0) {
    scorecardCards.push({
      lbl: 'Crown Unit Value',
      val: fmt$(kpis.crownUnitValue),
      bench: 'GP production per crown prepped &middot; diagnostic reference (lower = crown-dominated mix, higher = more supporting GP per crown)',
      status: '',
    });
  }

  /* Conversion Ratio — visits ÷ crowns prepped. Tier update 2026-04-22:
       ≤ 3.0  → warn ("too aggressive", possible over-diagnosis)
       3.0 < x ≤ 7.0  → good  (healthy range)
       7.0 < x ≤ 12.0 → warn  (trending wrong direction)
       > 12.0         → bad   (materially under-diagnosing)
     Lower is better within the good band; at the bottom end, too low flips
     back to a yellow flag because it can indicate over-diagnosis. */
  if (kpis.battingAverage != null && kpis.battingAverage > 0) {
    const ba = kpis.battingAverage;
    let baStatus = '';
    if (ba <= 3.0)       baStatus = 'warn';   /* too aggressive — possible over-diagnosis */
    else if (ba <= 7.0)  baStatus = 'good';   /* healthy band */
    else if (ba <= 12.0) baStatus = 'warn';   /* trending wrong direction */
    else                 baStatus = 'bad';    /* under-diagnosing */
    const baBench = ba <= 3.0
      ? 'Healthy range <strong>3–7:1</strong> · ratio this low can indicate over-diagnosis or aggressive case acceptance — worth reviewing'
      : 'Healthy range <strong>3–7:1</strong> (lower is better within range; &gt;12:1 trends into under-diagnosis)';
    scorecardCards.push({
      lbl: 'Conversion Ratio',
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
    /* Total staff cost (admin + hygiene) — the PRIMARY coaching anchor per
       the 2026-04-21 hybrid methodology. Target ≤20%; the admin/clinical
       and hygienist-ratio decomposition lives on the scorecard as
       benchmark-free diagnostic reference only. */
    { lbl: 'Total Staff Cost (incl. hygiene)', val: (financials.staffCostPct != null && financials.staffCostPct > 0) ? financials.staffCostPct.toFixed(1) + '%' : '—', bench: 'Target <strong>&le;20%</strong> &middot; includes all staff + hygiene (excludes owner draws)', status: statusVs(financials.staffCostPct, 20, false) },
  ];
  /* AR full aging table replaces the compact 90+ cards (Dave 2026-04-16: "show
     the AR as it ages: current, 30-60, 60-90, and over 90"). */
  const arP = ar.patient || {};
  const arI = ar.insurance || {};
  const arHasData = (arP.total || arI.total);
  const arRow = (label, a) => `
    <tr>
      <td><strong>${label}</strong></td>
      <td>${fmt$(a.current)}</td>
      <td>${fmt$(a.d3160)}</td>
      <td>${fmt$(a.d6190)}</td>
      <td>${fmt$(a.d90plus ?? a.over90)}</td>
      <td><strong>${fmt$(a.total)}</strong></td>
    </tr>`;
  const arAgingTable = arHasData ? `
    <div style="margin-top:20px">
      <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#8899aa;margin:0 0 8px;">Accounts Receivable Aging</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px;background:rgba(15,28,46,.4);border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:rgba(42,63,95,.6);color:#cbd5e1;">
            <th style="padding:8px 12px;text-align:left;font-weight:600;"></th>
            <th style="padding:8px 12px;text-align:right;font-weight:600;">Current</th>
            <th style="padding:8px 12px;text-align:right;font-weight:600;">30–60</th>
            <th style="padding:8px 12px;text-align:right;font-weight:600;">60–90</th>
            <th style="padding:8px 12px;text-align:right;font-weight:600;">90+</th>
            <th style="padding:8px 12px;text-align:right;font-weight:600;">Total</th>
          </tr>
        </thead>
        <tbody style="color:#e2e8f0;">
          ${arRow('Patient', arP)}
          ${arRow('Insurance', arI)}
        </tbody>
      </table>
    </div>` : '';
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

  /* ── Pain points block — dentist's own words (concerns checkboxes + freeform "biggest challenge")
     Surface BEFORE the profile facts; this is what the dentist said is wrong, and every finding
     in the Report should ultimately tie back to one of these. */
  /* Full mapping — keys MUST match the questionnaire.html concerns checkbox values.
     Missing entries fall back to the raw token (e.g. "new_patients"), which is what
     prompted this fix. Keep this synced with questionnaire.html:914-926. */
  const concernLabels = {
    'more_profitable': 'More profitable',
    'more_busy':       'Busier practice',
    'pay_staff_more':  'Pay staff more',
    'owner_bonus':     'Take home more income',
    'more_control':    'More control over the practice',
    'staff_issues':    'Staff frustrations',
    'overhead_high':   'Overhead too high',
    'insurance_rates': 'Insurance reimbursements too low',
    'new_patients':    'New patient growth',
    'exit_plan':       'Sale or retirement planning',
    /* Legacy keys (kept for back-compat with older practiceProfile payloads) */
    'insurance_low':   'Insurance reimbursements too low',
    'too_busy':        'Too busy / overwhelmed',
    'marketing':       'Marketing / new patient flow',
    'burned_out':      'Burned out',
    'cant_retire':     "Can't afford to retire",
    'growth_stalled':  'Growth has stalled',
  };
  const concerns = Array.isArray(practice.concerns) ? practice.concerns : [];
  const biggestChallenge = practice.biggestChallenge ? String(practice.biggestChallenge).trim() : '';
  const hasPainPoints = concerns.length > 0 || biggestChallenge.length > 0;
  const painPointsHtml = hasPainPoints ? `
    <div style="background:linear-gradient(135deg,rgba(232,135,42,.08),rgba(232,135,42,.02));border-left:3px solid #e8872a;padding:16px 20px;border-radius:8px;margin-bottom:20px;">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#e8872a;font-weight:700;margin-bottom:10px;">What you told us is wrong</div>
      ${concerns.length > 0 ? `
        <ul style="list-style:none;padding:0;margin:0 0 ${biggestChallenge ? '14px' : '0'} 0;">
          ${concerns.map(c => `<li style="padding:4px 0;color:#e2e8f0;">✓  ${htmlEscape(concernLabels[c] || c)}</li>`).join('')}
        </ul>` : ''}
      ${biggestChallenge ? `
        <blockquote style="font-style:italic;color:#cbd5e1;font-size:15px;line-height:1.5;border-left:2px solid rgba(203,213,225,.3);padding-left:14px;margin:0;">
          "${htmlEscape(biggestChallenge)}"
        </blockquote>` : ''}
    </div>` : '';

  /* ── Chart data for the inlined <script> ── */
  const reportJson = {
    productionByCategory: production.categoriesForChart,
    productionSplit: production.splitForChart,
  };

  /* ── Period label for hero ──
     Prefer the actual date range ("April 2025 – March 2026") when parseProduction
     captured it. Falls back to the year list only when the PDF didn't include an
     explicit range (parseProduction's fallback path populates `years` from the
     current/prior year). */
  const periodLabel = (() => {
    if (!period.prodMonths) return 'Based on uploaded reports';
    const base = `Based on ${period.prodMonths} months of production data`;
    if (period.dateStart && period.dateEnd) {
      const fmt = (iso) => {
        const d = new Date(iso + 'T00:00:00Z');
        return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      };
      return `${base} (${fmt(period.dateStart)} – ${fmt(period.dateEnd)})`;
    }
    if (period.years && period.years.length) return `${base} (${period.years.join(', ')})`;
    return base;
  })();
  const generatedDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  let template = loadReportTemplate();
  const replacements = {
    practiceName: htmlEscape(practice.name || 'Practice Assessment'),
    periodLabel: htmlEscape(periodLabel),
    generatedDate: htmlEscape(generatedDate),
    totalOpportunity: fmt$(opportunities.totalValue),
    scorecardCards: scorecardHtml,
    scorecardExplainer: (kpis.staffCostExHygPct != null || kpis.hygienistCostPct != null) ? `
      <p style="font-size:13px;color:#94a3b8;line-height:1.55;margin-top:18px;max-width:860px;">
        Staff cost is shown three ways. The primary coaching metric is <strong>Total Staff Cost</strong>
        (target &le;20%), shown in the financials section below &mdash; that's the number the red flag
        fires on. The <em>Admin + Clinical</em> and <em>Hygienist Wage Ratio</em> cards above are
        diagnostic only &mdash; they tell you WHERE the total staff cost lives (front-desk / assistants vs
        hygiene), but they're benchmark-free because hygienist wages swing with hygiene days/week and
        a 5-day hygiene schedule will always read higher than a 3-day regardless of efficiency.
      </p>` : '',
    opportunityCards: oppHtml,
    goalRows: goalRowsHtml,
    financialCards: financialHtml,
    arAgingTable: arAgingTable,
    painPoints: painPointsHtml,
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
 * Tabbed spreadsheet-style HTML: each tab = one audit layer.
 * rawTexts = { prodText, collText, plText } — optional raw extracted strings for 3-stage P&L audit.
 */
function renderReviewHtml(data, rawTexts = {}) {
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

  /* Pain points block for the Review page — same data as the Report's "What you
     told us is wrong" section. Surface at the top of Practice Profile. */
  const reviewConcernLabels = {
    'more_profitable': 'More profitable',
    'more_busy':       'Busier practice',
    'pay_staff_more':  'Pay staff more',
    'owner_bonus':     'Take home more income',
    'more_control':    'More control over the practice',
    'staff_issues':    'Staff frustrations',
    'overhead_high':   'Overhead too high',
    'insurance_rates': 'Insurance reimbursements too low',
    'new_patients':    'New patient growth',
    'exit_plan':       'Sale or retirement planning',
    'insurance_low':   'Insurance reimbursements too low',
    'too_busy':        'Too busy / overwhelmed',
    'marketing':       'Marketing / new patient flow',
    'burned_out':      'Burned out',
    'cant_retire':     "Can't afford to retire",
    'growth_stalled':  'Growth has stalled',
  };
  const reviewConcerns = Array.isArray(practice.concerns) ? practice.concerns : [];
  const reviewChallenge = practice.biggestChallenge ? String(practice.biggestChallenge).trim() : '';
  const painPointsBlock = (reviewConcerns.length || reviewChallenge) ? `
    <div style="background:#fff7ed;border-left:4px solid #e8872a;padding:12px 16px;border-radius:6px;margin:0 0 12px 0;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#9a3412;font-weight:700;margin-bottom:6px;">What the dentist said is wrong</div>
      ${reviewConcerns.length ? `<ul style="margin:0 0 ${reviewChallenge ? '10px' : '0'} 0;padding-left:20px;">${reviewConcerns.map(c => `<li>${esc(reviewConcernLabels[c] || c)}</li>`).join('')}</ul>` : ''}
      ${reviewChallenge ? `<blockquote style="margin:0;font-style:italic;color:#555;border-left:2px solid #e8872a;padding-left:10px;">"${esc(reviewChallenge)}"</blockquote>` : ''}
    </div>` : '';

  /* Section 2 — Production Overview (by category) */
  const totalProd = production.total || 0;
  const annualProd = production.annualized || 0;
  const prodCatRows = [
    ['Hygiene', fmtMoney(cat.hygiene), fmtPct(totalProd > 0 ? (cat.hygiene || 0) / totalProd * 100 : 0)],
    ['Doctor (general)', fmtMoney(cat.doctor), fmtPct(totalProd > 0 ? (cat.doctor || 0) / totalProd * 100 : 0)],
    ['Perio', fmtMoney(cat.perio), fmtPct(totalProd > 0 ? (cat.perio || 0) / totalProd * 100 : 0)],
    ['Endo', fmtMoney(cat.endo), fmtPct(totalProd > 0 ? (cat.endo || 0) / totalProd * 100 : 0)],
    ['Oral Surgery', fmtMoney(cat.oralSurgery), fmtPct(totalProd > 0 ? (cat.oralSurgery || 0) / totalProd * 100 : 0)],
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

  /* ─── Code → category helper (mirrors computeReportData logic exactly) ─── */
  const hygCodes_r  = ['D1110','D1120','D4910','D4341','D4342','D4346','D4381','D0120','D0140','D0274'];
  const perioCodes_r = ['D4260','D4261','D4263','D4273','D4275','D4341','D4342','D4910'];
  const endoCodes_r  = ['D3310','D3320','D3330','D3346','D3347','D3348'];
  const surgCodes_r  = ['D7140','D7210','D7220','D7230','D7240','D7250'];
  const orthoCodes_r = ['D8080','D8090','D8010','D8020','D8030','D8040','D8070'];
  const cosmCodes_r  = ['D9972','D9974','D2960','D2961','D2962'];
  const sw = (code, pfxs) => pfxs.some(p => code.startsWith(p));
  function getCodeCategory(rawCode) {
    const c = (rawCode || '').toUpperCase();
    if (hygCodes_r.includes(c)  || sw(c,['D1110','D1120','D4910','D4346','D4381'])) return 'Hygiene';
    if (perioCodes_r.includes(c) || sw(c,['D4260','D4261','D4263','D4273','D4275','D4341','D4342'])) return 'Perio';
    if (endoCodes_r.includes(c)  || sw(c,['D33'])) return 'Endo';
    if (surgCodes_r.includes(c)  || sw(c,['D72'])) return 'Oral Surgery';
    if (orthoCodes_r.includes(c) || sw(c,['D80'])) return 'Ortho';
    if (cosmCodes_r.includes(c)) return 'Cosmetic';
    return 'Doctor';
  }
  const CAT_COLORS = {
    'Hygiene':     '#d1fae5',
    'Perio':       '#fef9c3',
    'Endo':        '#fee2e2',
    'Oral Surgery':'#fce7f3',
    'Ortho':       '#e0e7ff',
    'Cosmetic':    '#f3e8ff',
    'Doctor':      '#f0f9ff',
  };

  const title = esc(practice.name || 'Assessment') + ' — Intake Audit';

  /* ─── Build All Codes rows with category column ─── */
  const codesWithCat = codesSorted.map(c => {
    const cat = getCodeCategory(c.code);
    const bg = CAT_COLORS[cat] || '#fff';
    return `<tr style="background:${bg}">
      <td class="mono">${esc(c.code)}</td>
      <td>${esc(c.desc || '')}</td>
      <td style="font-weight:600;color:#333">${esc(cat)}</td>
      <td class="num">${fmtInt(c.qty)}</td>
      <td class="num">${fmtMoney(c.total)}</td>
      <td class="num">${c.qty > 0 ? fmtMoney((c.total || 0) / c.qty) : '—'}</td>
      <td class="num">${fmtPct(totalProd > 0 ? (c.total || 0) / totalProd * 100 : 0)}</td>
    </tr>`;
  }).join('');

  /* ─── Category subtotal check rows ─── */
  const catTotals = {};
  codesSorted.forEach(c => {
    const cat = getCodeCategory(c.code);
    catTotals[cat] = (catTotals[cat] || 0) + (c.total || 0);
  });
  const catCheckRows = Object.entries(catTotals).map(([cat, sum]) => {
    const storedSum = cat === 'Hygiene' ? (production.byCategory?.hygiene || 0)
      : cat === 'Perio' ? (production.byCategory?.perio || 0)
      : cat === 'Endo'  ? (production.byCategory?.endo || 0)
      : cat === 'Oral Surgery' ? (production.byCategory?.oralSurgery || 0)
      : cat === 'Ortho' ? (production.byCategory?.ortho || 0)
      : cat === 'Cosmetic' ? (production.byCategory?.cosmetic || 0)
      : (production.byCategory?.doctor || 0);
    const diff = Math.abs(sum - storedSum);
    const ok = diff < 1;
    return `<tr style="background:${CAT_COLORS[cat]||'#fff'}">
      <td style="font-weight:600">${cat}</td>
      <td class="num">${fmtMoney(sum)}</td>
      <td class="num">${fmtMoney(storedSum)}</td>
      <td class="num" style="color:${ok?'#16a34a':'#dc2626'};font-weight:700">${ok ? '✓ match' : '✗ off by ' + fmtMoney(diff)}</td>
    </tr>`;
  }).join('');

  /* ─── P&L raw text vs parsed ─── */
  const rawPL  = rawTexts.plText   ? esc(rawTexts.plText).replace(/\n/g,'<br>') : '<em style="color:#999">Not available (report generated without raw text pass-through)</em>';
  const rawProd = rawTexts.prodText ? esc(rawTexts.prodText).replace(/\n/g,'<br>') : '<em style="color:#999">Not available</em>';
  const rawColl = rawTexts.collText ? esc(rawTexts.collText).replace(/\n/g,'<br>') : '<em style="color:#999">Not available</em>';

  /* ─── KPI Math rows ─── */
  const monthlyProd2 = period.prodMonths ? (production.total || 0) / period.prodMonths : 0;
  const monthlyColl2 = period.prodMonths ? (collections.total || 0) / period.prodMonths : 0;
  const kpiMathRows = [
    ['Annual Production',    fmtMoney(production.annualized),   `${fmtMoney(production.total)} ÷ ${period.prodMonths}mo × 12`, ''],
    ['Annual Collections',   fmtMoney(collections.annualized),  `${fmtMoney(collections.total)} ÷ ${period.prodMonths}mo × 12`, ''],
    ['Collection Rate',      fmtPct(kpis.collectionRate),        `${fmtMoney(collections.total)} ÷ ${fmtMoney(production.total)}`, kpis.collectionRate > 100 ? '⚠ >100% — period mismatch?' : ''],
    ['Hygiene %',            fmtPct(kpis.hygienePercent),        `${fmtMoney(production.byCategory?.hygiene)} ÷ ${fmtMoney(production.total)}`, ''],
    ['Owner Doc $/Day',      fmtMoney(kpis.ownerDocDailyAvg),    `annualized doctor prod ÷ owner days/yr`, ''],
    ['Assoc Doc $/Day',      fmtMoney(kpis.associateDocDailyAvg),'annualized assoc prod ÷ assoc days/yr',  ''],
    ['Combined Doc $/Day',   fmtMoney(kpis.combinedDocDailyAvg), `${fmtMoney(production.annualized)} − hygiene ÷ total doc days`, ''],
    ['Hygiene $/Day',        fmtMoney(kpis.hygDailyAvg),         `${fmtMoney(production.byCategory?.hygiene)} × annFactor ÷ hyg days/yr`, ''],
    ['Overhead %',           fmtPct(kpis.overheadPct),           `adj expenses ${fmtMoney(financials.plExpenses)} ÷ P&L income ${fmtMoney(financials.plIncome)}`, ''],
    ['Profit %',             fmtPct(kpis.profitPct),             `100% − overhead%`, ''],
    ['Staff Cost %',         fmtPct(kpis.staffCostPct),          `staff costs ÷ collections`, ''],
    ['P&L Monthly Income',   fmtMoney(monthlyPL),                `${fmtMoney(financials.plIncome)} ÷ 12`, ''],
    ['Code-report Monthly',  fmtMoney(monthlyProd2),             `${fmtMoney(production.total)} ÷ ${period.prodMonths}`, ''],
    ['Coll-report Monthly',  fmtMoney(monthlyColl2),             `${fmtMoney(collections.total)} ÷ ${period.prodMonths}`, ''],
    ['P&L vs Code Match',    fmtPct(monthlyProd2 > 0 ? monthlyPL/monthlyProd2*100 : null), `P&L monthly ÷ code-report monthly`, monthlyPL > 0 && monthlyProd2 > 0 && Math.abs(monthlyPL/monthlyProd2 - 1) > 0.15 ? '⚠ >15% gap' : ''],
  ].map(([label, val, formula, warn]) => `<tr>
    <td>${label}</td>
    <td class="num" style="font-weight:600">${val}</td>
    <td class="note" style="font-size:12px">${formula}</td>
    <td style="color:#dc2626;font-size:12px">${warn}</td>
  </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><title>${title}</title>
<style>
  :root{--fg:#1a1a1a;--muted:#666;--border:#d0d0d0;--bg:#f8fafc;--row-alt:#f1f5f9;--accent:#1e40af;--header:#0f172a;--tab-bg:#e2e8f0;--tab-active:#1e40af;}
  *{box-sizing:border-box;}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;color:var(--fg);background:var(--bg);font-size:13px;line-height:1.4;}
  /* ── Tab chrome ── */
  #tabbar{display:flex;align-items:flex-end;gap:2px;padding:12px 20px 0;background:var(--header);flex-wrap:wrap;}
  .tab-btn{padding:8px 16px;border:none;border-radius:6px 6px 0 0;background:var(--tab-bg);color:#334155;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;border-bottom:3px solid transparent;transition:background .15s;}
  .tab-btn:hover{background:#cbd5e1;}
  .tab-btn.active{background:#fff;color:var(--tab-active);border-bottom:3px solid var(--tab-active);}
  #page-header{padding:10px 24px 8px;background:#fff;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
  .badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;background:#fee2e2;color:#b91c1c;letter-spacing:.04em;}
  .meta{color:var(--muted);font-size:12px;}
  /* ── Pane layout ── */
  .pane{display:none;padding:20px 24px 40px;}
  .pane.active{display:block;}
  /* ── Tables ── */
  table{border-collapse:collapse;width:100%;margin:0 0 20px;}
  th,td{border:1px solid var(--border);padding:5px 9px;text-align:left;vertical-align:middle;}
  th{background:#e8edf3;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#475569;position:sticky;top:0;z-index:1;}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;}
  tbody tr:hover{background:#f0f4ff!important;}
  /* ── Misc ── */
  h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;margin:20px 0 8px;color:var(--header);border-left:4px solid var(--tab-active);padding-left:10px;}
  .note{color:var(--muted);font-size:12px;font-style:italic;}
  .kv td:first-child{width:55%;}
  .kv td:last-child{text-align:right;font-weight:600;font-variant-numeric:tabular-nums;}
  .twocol{display:grid;grid-template-columns:1fr 1fr;gap:20px;}
  pre.raw{background:#1e293b;color:#94a3b8;padding:16px;border-radius:6px;overflow:auto;font-size:11px;line-height:1.6;max-height:500px;white-space:pre-wrap;word-break:break-all;}
  .summary-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:20px;}
  .card{background:#fff;border:1px solid var(--border);border-radius:8px;padding:14px 16px;}
  .card .val{font-size:22px;font-weight:700;color:var(--header);}
  .card .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-top:2px;}
  .search-bar{padding:6px 10px;border:1px solid var(--border);border-radius:4px;font-size:13px;width:260px;margin-bottom:8px;}
  .sticky-table{overflow:auto;max-height:70vh;}
</style>
</head>
<body>
<div id="tabbar">
  <button class="tab-btn active" onclick="showTab('summary')">Summary</button>
  <button class="tab-btn" onclick="showTab('codes')">Production Codes</button>
  <button class="tab-btn" onclick="showTab('collections')">Collections &amp; AR</button>
  <button class="tab-btn" onclick="showTab('pl')">P&amp;L Audit</button>
  <button class="tab-btn" onclick="showTab('targets')">Targets &amp; Goals</button>
  <button class="tab-btn" onclick="showTab('kpimath')">KPI Math</button>
  <button class="tab-btn" onclick="showTab('hygiene')">Hygiene Potential</button>
  <button class="tab-btn" onclick="showTab('profile')">Practice Profile</button>
</div>
<div id="page-header">
  <strong style="font-size:15px">${title}</strong>
  <span class="badge">INTERNAL — NOT A CLIENT DELIVERABLE</span>
  <span class="meta">Generated ${esc(data.generatedAt || '')} • Engine v${esc(data.version || '')} • ${esc(period.prodMonths || 0)} months (${esc((period.years || []).join(', '))})</span>
</div>

<!-- ════ TAB: SUMMARY ════ -->
<div id="pane-summary" class="pane active">
  <div class="summary-cards">
    <div class="card"><div class="val">${fmtMoney(production.annualized)}</div><div class="lbl">Annual Production</div></div>
    <div class="card"><div class="val">${fmtMoney(collections.annualized)}</div><div class="lbl">Annual Collections</div></div>
    <div class="card"><div class="val">${fmtPct(kpis.collectionRate)}</div><div class="lbl">Collection Rate</div></div>
    <div class="card"><div class="val">${fmtPct(kpis.hygienePercent)}</div><div class="lbl">Hygiene %</div></div>
    <div class="card"><div class="val">${fmtMoney(kpis.ownerDocDailyAvg || kpis.combinedDocDailyAvg)}</div><div class="lbl">Doc $/Day</div></div>
    <div class="card"><div class="val">${fmtMoney(kpis.hygDailyAvg)}</div><div class="lbl">Hyg $/Day</div></div>
    <div class="card"><div class="val">${fmtPct(kpis.overheadPct)}</div><div class="lbl">Overhead %</div></div>
    <div class="card"><div class="val">${fmtPct(kpis.profitPct)}</div><div class="lbl">Profit %</div></div>
    <div class="card"><div class="val">${fmtInt(codesSorted.length)}</div><div class="lbl">Codes Analyzed</div></div>
    <div class="card"><div class="val">${esc(period.prodMonths || '—')} mo</div><div class="lbl">Period</div></div>
  </div>
  <h2>Production by Category</h2>
  <table style="max-width:500px">
    <thead><tr><th>Category</th><th class="num">$ (period)</th><th class="num">% of total</th></tr></thead>
    <tbody>${prodCatRows.map(([c, d, p]) => `<tr style="background:${CAT_COLORS[c.split(' ')[0]] || '#fff'}"><td>${c}</td><td class="num">${d}</td><td class="num">${p}</td></tr>`).join('')}
    <tr style="font-weight:700;background:#dbeafe"><td>TOTAL</td><td class="num">${fmtMoney(totalProd)}</td><td class="num">100%</td></tr>
    <tr><td>Annualized (×${(12/(period.prodMonths||12)).toFixed(2)})</td><td class="num">${fmtMoney(annualProd)}</td><td></td></tr>
    </tbody>
  </table>
  ${painPointsBlock}
</div>

<!-- ════ TAB: PRODUCTION CODES ════ -->
<div id="pane-codes" class="pane">
  <h2>Category Cross-Check — code totals vs. engine buckets</h2>
  <table style="max-width:600px">
    <thead><tr><th>Category</th><th class="num">Sum of codes</th><th class="num">Engine bucket</th><th class="num">Match?</th></tr></thead>
    <tbody>${catCheckRows}</tbody>
  </table>
  <h2>All Codes (${codesSorted.length} codes — sorted by $, color = category)</h2>
  <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
    <input id="code-search" class="search-bar" placeholder="Filter by code or description…" oninput="filterCodes(this.value)">
    ${Object.entries(CAT_COLORS).map(([cat,bg])=>`<span style="background:${bg};border:1px solid #ccc;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600">${cat}</span>`).join('')}
  </div>
  <div class="sticky-table">
    <table id="codes-table">
      <thead><tr><th>Code</th><th>Description</th><th>Category</th><th class="num">Qty</th><th class="num">Total $</th><th class="num">Avg $/proc</th><th class="num">% of prod</th></tr></thead>
      <tbody id="codes-tbody">${codesWithCat}</tbody>
    </table>
  </div>
</div>

<!-- ════ TAB: COLLECTIONS & AR ════ -->
<div id="pane-collections" class="pane">
  <div class="twocol">
    <div>
      <h2>Collections Summary</h2>
      <table class="kv"><tbody>
        <tr><td>Collections total (period)</td><td>${fmtMoney(collections.total)}</td></tr>
        <tr><td>Collections months</td><td>${fmtInt(collections.months || period.prodMonths)}</td></tr>
        <tr><td>Collections annualized</td><td>${fmtMoney(collections.annualized)}</td></tr>
        <tr><td>Collection rate (period vs period)</td><td style="font-weight:700;color:${(kpis.collectionRate||0)>100?'#dc2626':'#16a34a'}">${fmtPct(kpis.collectionRate)}</td></tr>
        <tr><td>P&L total income</td><td>${fmtMoney(financials.plIncome)}</td></tr>
        <tr><td>Monthly P&L income</td><td>${fmtMoney(monthlyPL)}</td></tr>
        <tr><td>Monthly collections (report)</td><td>${fmtMoney(monthlyColl2)}</td></tr>
      </tbody></table>
      <h2>Sources of Dollars</h2>
      <table>
        <thead><tr><th>Source</th><th class="num">$</th><th class="num">%</th></tr></thead>
        <tbody>${sodRows}</tbody>
      </table>
    </div>
    <div>
      <h2>AR Aging</h2>
      <table>
        <thead><tr><th></th><th class="num">Current</th><th class="num">31–60</th><th class="num">61–90</th><th class="num">90+</th><th class="num">Total</th></tr></thead>
        <tbody>${arRow('Patient', arP)}${arRow('Insurance', arI)}</tbody>
      </table>
    </div>
  </div>
</div>

<!-- ════ TAB: P&L AUDIT ════ -->
<div id="pane-pl" class="pane">
  <h2>Stage 1 — Raw Extracted Text (what Claude read from the PDF)</h2>
  <pre class="raw">${rawPL}</pre>
  <div class="twocol">
    <div>
      <h2>Stage 2 — Parsed Numbers</h2>
      <table class="kv"><tbody>
        ${finRows.map(([k, v]) => k === '' ? '<tr><td colspan="2" style="border:none;height:6px"></td></tr>' : `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
      </tbody></table>
    </div>
    <div>
      <h2>Stage 3 — Computed / Adjusted</h2>
      <table class="kv"><tbody>
        <tr><td>P&L expenses (raw)</td><td>${fmtMoney(financials.plExpensesRaw)}</td></tr>
        <tr><td>Owner add-backs</td><td>${fmtMoney(financials.ownerAddBacks)}</td></tr>
        <tr><td>Patient reimbursements</td><td>${fmtMoney(financials.patientReimbursements)}</td></tr>
        <tr><td>Adjusted expenses</td><td style="font-weight:700">${fmtMoney(financials.plExpenses)}</td></tr>
        <tr><td colspan="2" style="border:none;height:6px"></td></tr>
        <tr><td>Overhead % (adjusted)</td><td style="font-weight:700">${fmtPct(kpis.overheadPct)}</td></tr>
        <tr><td>Profit %</td><td style="font-weight:700">${fmtPct(kpis.profitPct)}</td></tr>
        <tr><td>Staff cost %</td><td style="font-weight:700">${fmtPct(kpis.staffCostPct)}</td></tr>
      </tbody></table>
      <h2>Budgetary P&amp;L vs Targets</h2>
      <table>
        <thead>
          <tr><th rowspan="2">Line</th><th colspan="2" style="text-align:center">YTD</th><th colspan="2" style="text-align:center">Target</th><th colspan="2" style="text-align:center">Goal</th></tr>
          <tr><th class="num">$</th><th class="num">%</th><th class="num">$</th><th class="num">%</th><th class="num">$</th><th class="num">%</th></tr>
        </thead>
        <tbody>
          ${budgetRow('Monthly collection', monthlyPL, null, null, tgtMonthly, null, goalMonthly)}
          ${budgetRow('Staff cost %', null, kpis.staffCostPct, 18, null, 18, null)}
          ${budgetRow('Overhead %', financials.plExpenses, kpis.overheadPct, 60, null, 55, null)}
          ${budgetRow('Profit %', null, kpis.profitPct, 26, null, 30, null)}
        </tbody>
      </table>
    </div>
  </div>
</div>

<!-- ════ TAB: TARGETS & GOALS ════ -->
<div id="pane-targets" class="pane">
  <h2>Targets &amp; Goals by Stream</h2>
  <table>
    <thead>
      <tr><th rowspan="2">Stream</th><th colspan="3" style="text-align:center;background:#dbeafe">Initial Monthly Target</th><th colspan="3" style="text-align:center;background:#dcfce7">Long Term Monthly Goal</th></tr>
      <tr><th class="num">Days</th><th class="num">$/Day</th><th class="num">Monthly</th><th class="num">Days</th><th class="num">$/Day</th><th class="num">Monthly</th></tr>
    </thead>
    <tbody>
      ${targetsRows}
      <tr style="font-weight:700;background:#dbeafe"><td>MONTHLY TOTAL</td><td colspan="2"></td><td class="num">${fmtMoney(tgtMonthly)}</td><td colspan="2"></td><td class="num">${fmtMoney(goalMonthly)}</td></tr>
      <tr style="font-weight:700"><td>ANNUAL</td><td colspan="2"></td><td class="num">${fmtMoney(tgt.initialAnnual)}</td><td colspan="2"></td><td class="num">${fmtMoney(tgt.longTermAnnual)}</td></tr>
    </tbody>
  </table>
</div>

<!-- ════ TAB: KPI MATH ════ -->
<div id="pane-kpimath" class="pane">
  <h2>KPI Formulas — every number traced to its inputs</h2>
  <table>
    <thead><tr><th>KPI</th><th class="num">Value</th><th>Formula / Inputs</th><th>Flags</th></tr></thead>
    <tbody>${kpiMathRows}</tbody>
  </table>
</div>

<!-- ════ TAB: HYGIENE POTENTIAL ════ -->
<div id="pane-hygiene" class="pane">
  <h2>Hygiene Schedule — Potential Analysis</h2>
  <table>
    <thead><tr><th>Input / Metric</th><th class="num">Value</th><th>Formula / Note</th></tr></thead>
    <tbody>${potentialRows.map(([k, v, n]) => `<tr><td>${k}</td><td class="num">${v}</td><td class="note">${n}</td></tr>`).join('')}</tbody>
  </table>
</div>

<!-- ════ TAB: PRACTICE PROFILE ════ -->
<div id="pane-profile" class="pane">
  <h2>Practice Profile</h2>
  ${painPointsBlock}
  <table class="kv" style="max-width:600px"><tbody>${profileRows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</tbody></table>
</div>

<script>
function showTab(id) {
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('pane-' + id).classList.add('active');
  event.target.classList.add('active');
}
function filterCodes(q) {
  const lower = q.toLowerCase();
  document.querySelectorAll('#codes-tbody tr').forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(lower) ? '' : 'none';
  });
}
</script>
</body></html>`;
}

/* ─── Handler ─── */
/* Export helpers for the verify-generate-report test runner (2026-04-23). */
exports.parseProduction    = parseProduction;
exports.parseCollections   = parseCollections;
exports.parsePL            = parsePL;
exports.parsePatientSummary = parsePatientSummary;

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST,OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    prodText, collText, plText, patientSummaryText = null,
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
    const patientSummary = patientSummaryText ? parsePatientSummary(patientSummaryText) : null;

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

    /* Compute canonical data object first — it performs the authoritative
       hygiene categorization and yields the three staff-cost percentages
       (total, admin-only, hygienist-only) that SWOT's rules need. We then
       run SWOT against those canonical values and splice the result back
       in. Keeps the cost formulas and the coaching rules in lockstep. */
    const dataWithoutSwot = computeReportData({
      prodData, collData, plData, employeeCosts, practiceProfile,
      arPatient, arInsurance, swotData: null, practiceName,
      totalProd, collTotal, years, prodMonths, hygieneData, patientSummary,
    });

    const swotData = generateSWOT(
      prodData, collData, plData, hygieneData, employeeCosts,
      arPatient, arInsurance, practiceProfile,
      dataWithoutSwot.kpis.staffCostPct,
      dataWithoutSwot.kpis.staffCostExHygPct,
      dataWithoutSwot.kpis.hygienistCostPct,
      dataWithoutSwot.kpis.hygieneNearFuturePreBooking,
      {
        battingAverage:       dataWithoutSwot.kpis.battingAverage,
        ownerDocDailyAvg:     dataWithoutSwot.kpis.ownerDocDailyAvg,
        associateDocDailyAvg: dataWithoutSwot.kpis.associateDocDailyAvg,
        combinedDocDailyAvg:  dataWithoutSwot.kpis.combinedDocDailyAvg,
        hasAssociate:         !!dataWithoutSwot.practice.hasAssociate,
        hygieneFillRate:      dataWithoutSwot.kpis.hygieneFillRate,
        totalExamsCount:      dataWithoutSwot.kpis.totalExamsCount,
        hygieneVisitsForExamCheck: dataWithoutSwot.kpis.hygieneVisitsForExamCheck,
        /* Q5 dollar-opportunity inputs (2026-04-23 unblock) — CUV + annual
           hygiene visits + annual crowns let each branch append a concrete
           dollar figure. Null fields → branch skips the dollar clause. */
        crownUnitValue:         dataWithoutSwot.kpis.crownUnitValue,
        annualHygieneProduction: dataWithoutSwot.kpis.annualHygieneProduction,
        annualHygVisits:        dataWithoutSwot.kpis.hygieneVisitsForExamCheck,
        annualCrowns:           dataWithoutSwot.kpis.battingAverageInputs?.crownsPreppedCount || null,
      },
      {
        overheadPct:       dataWithoutSwot.kpis.overheadPct,
        annualCollections: dataWithoutSwot.collections.annualized,
        staffCostPct:      dataWithoutSwot.kpis.staffCostPct,
        suppliesPct:       dataWithoutSwot.kpis.overheadSuppliesPct,
        labPct:            dataWithoutSwot.kpis.overheadLabPct,
        occupancyPct:      dataWithoutSwot.kpis.overheadOccupancyPct,
        marketingPct:      dataWithoutSwot.kpis.overheadMarketingPct,
      },
      {
        annualHygienistCost:     dataWithoutSwot.kpis.annualHygienistCost,
        annualHygieneProduction: dataWithoutSwot.kpis.annualHygieneProduction,
      },
      {
        ...(dataWithoutSwot.kpis.hygieneCapacity || {}),
        annualHygieneProduction: dataWithoutSwot.kpis.annualHygieneProduction,
        hygDailyAvg:             dataWithoutSwot.kpis.hygDailyAvg,
      },
    );

    const data = Object.assign({}, dataWithoutSwot, { swot: swotData });

    /* Render HTML */
    const reportHtml = renderReportHtml(data);
    const reviewHtml = renderReviewHtml(data, { prodText, collText, plText });

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
          /* Parse-success signals (2026-04-23). The Hub uses these to
             distinguish "parse failed — re-upload" from "skipped by user" on
             the completion screen. Previously `plParsed` was the only one and
             everything else assumed presence of text meant success. */
          productionParsed:  !!prodText && codes.length > 0,
          collectionsParsed: !!collText && collTotal > 0,
          plParsed: plData !== null && plData.items.length > 0,
          plTotalsPresent: !!(plData && (plData.totalIncome || plData.totalExpense)),
          arPatientParsed:   !!(arPatient   && typeof arPatient.total   === 'number' && arPatient.total   >= 0 && Object.keys(arPatient).length > 0),
          arInsuranceParsed: !!(arInsurance && typeof arInsurance.total === 'number' && arInsurance.total >= 0 && Object.keys(arInsurance).length > 0),
          arPatientTotal: arPatient?.total || null,
          arInsuranceTotal: arInsurance?.total || null,
          sourcesOfDollarsSource: data?.financials?.sourcesOfDollars?.source || null,
          patientSummaryIncluded: !!patientSummary,
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
