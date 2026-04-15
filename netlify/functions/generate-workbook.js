'use strict';
const ExcelJS = require('exceljs');
const fetch   = require('node-fetch');
const JSZip   = require('jszip');
const fs      = require('fs');
const path    = require('path');

/* Module-level template cache — survives across warm invocations */
let _cachedTemplateBuf = null;

/* Cell collector for sheets 1-8: maps sheet name → cell address → value */
let _cellCollector = {};

/* Strikethrough tracking — module-level so injectValuesIntoTemplate can access */
let _acStrikeRows = [];          // All Codes rows used in Production Worksheet
let _battingAvgText = 'N/A';     // Batting average ratio text for Production Worksheet
let _baStyles = null;            // Batting Average box style indices — set during Pass 2
let _collStyles = null;          // Collections by Payor style indices — set during Pass 2
let _swotTargetSheetNum = 11;    // SWOT sheet number — varies based on extra sheets present
let _plInputExpenseNames = new Set();  // P&L expenses written to P&L Input sheet
let _plInputLastDataRow = 47;         // Last P&L Input expense row with data (rows after this are hidden)

/**
 * Collect cell values without writing to ExcelJS.
 * Signature stays the same so all existing sv() calls work unchanged.
 * Pass either a sheet object with .name or a string sheet name.
 */
function sv(sheetName, addr, val) {
  const name = typeof sheetName === 'string' ? sheetName : (sheetName?.name || sheetName);
  if (!_cellCollector[name]) _cellCollector[name] = {};
  if (val !== null && val !== undefined) {
    _cellCollector[name][addr] = val;
  }
}

/* ─── Parsers (text from Claude → structured data) ─── */
function parseProduction(text) {
  const codes = [];
  let months = 12, years = [];
  for (const line of text.split('\n')) {
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
  for (const line of text.split('\n')) {
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
  for (const line of text.split('\n')) {
    const sm = line.match(/^TOTAL_INCOME\|([-\d,.]+)/i);
    if (sm) { totalIncome = Math.abs(parseFloat(sm[1].replace(/,/g,''))); continue; }
    const se = line.match(/^TOTAL_EXPENSE\|([-\d,.]+)/i);
    if (se) { totalExpense = Math.abs(parseFloat(se[1].replace(/,/g,''))); continue; }
    const sn = line.match(/^NET_INCOME\|([-\d,.]+)/i);
    if (sn) { netIncome = parseFloat(sn[1].replace(/,/g,'')); continue; }
    const secMatch = line.match(/^SECTION\|(.+)/i);
    if (secMatch) { currentSection = secMatch[1].trim(); console.log('P&L section marker:', currentSection); continue; }
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
  /* Fallback: if no items tagged as Income but we have totalIncome,
     identify income items by common dental practice income names */
  const hasIncome = items.some(i => i.section === 'Income');
  if (!hasIncome && totalIncome) {
    const incomePatterns = /^(sales|cc payment|cash payment|check payment|care credit|credit card|insurance payment|patient payment|collections|revenue|income|refunds? received|interest income|other income|dental income|service revenue)/i;
    for (const it of items) {
      if (incomePatterns.test(it.item)) {
        it.section = 'Income';
      }
    }
    console.log('P&L fallback: re-tagged', items.filter(i => i.section === 'Income').length, 'items as Income');
  }

  return { items, totalIncome, totalExpense, netIncome };
}

/* ─── P&L categorization ─── */
function plCategory(item) {
  const l = item.toLowerCase();
  /* P&L Input columns: B=Associates, C=Hygienist, D=Specialists, E=Lab,
     F=Dental Supplies, G=Specialist Supplies, H=Staff Costs, I=Staff Bonus,
     J=Rent & Parking, K=Marketing, L=Office Supplies, M=Other,
     N=Salary/Wages (primary), O=Owner/Add-Back */

  /* EXCLUDED — non-cash items */
  if (/depreciat|amortiz/i.test(l)) return null;

  /* Owner add-backs (column O) */
  if (/car.*truck/i.test(l)) return 'O';
  if (/meal|entertainment|dining/i.test(l)) return 'O';
  if (/travel\b/i.test(l)) return 'O';
  if (/401k|retirement/i.test(l)) return 'O';

  /* Associates, Hygienists, Specialists (columns B, C, D) */
  if (/\bassociate\b/i.test(l)) return 'B';
  if (/\bhygien/i.test(l)) return 'C';
  if (/\bspecialist|specialty\b/i.test(l) && !/suppl/i.test(l)) return 'D';

  /* Lab (column E) */
  if (/\blab\b|laboratory/i.test(l)) return 'E';

  /* Dental Supplies (column F) */
  if (/dental.*suppl|job.*suppl/i.test(l)) return 'F';

  /* Specialist Supplies (column G) */
  if (/specialist.*suppl/i.test(l)) return 'G';

  /* Wages & Staff Costs (column H) */
  if (/payroll.*(wage|salar)|\bwages?\b|\bsalary\b|\bsalaries\b/i.test(l)) return 'H';
  if (/payroll.*tax/i.test(l)) return 'H';
  if (/payroll.*fee/i.test(l)) return 'H';
  if (/uniform|laundry/i.test(l)) return 'H';

  /* Staff Bonus (column I) */
  if (/\bbonus\b/i.test(l)) return 'I';

  /* Rent & Parking (column J) */
  if (/^rent|lease/i.test(l)) return 'J';
  if (/repair|maintenance/i.test(l)) return 'J';

  /* Marketing (column K) */
  if (/advertis|marketing/i.test(l)) return 'K';

  /* Office Supplies (column L) */
  if (/office.*suppl|software/i.test(l)) return 'L';

  /* Everything else → Other (column M) */
  return 'M';
}

/* ─── SWOT Analysis Generator ─── */
function generateSWOT(prodData, collData, plData, hygieneData, employeeCosts, arPatient, arInsurance, practiceName) {
  const strengths = [];
  const weaknesses = [];
  const opportunities = [];
  const threats = [];

  const { codes, months: prodMonths } = prodData;
  const totalProd = codes.reduce((s,c) => s + c.total, 0);
  const monthlyProd = prodMonths > 0 ? totalProd / prodMonths : 0;

  /* Derive key metrics — pro-rate collections if period differs from production */
  let netCollections = collData?.payments || plData?.totalIncome || 0;
  const collMonths = collData?.months || prodMonths || 1;
  if (netCollections > 0 && collMonths > prodMonths && prodMonths > 0) {
    netCollections = Math.round(netCollections / collMonths * prodMonths * 100) / 100;
  }
  const collectionRate = totalProd > 0 && netCollections > 0 ? (netCollections / totalProd * 100) : 0;
  const monthlyCollections = netCollections > 0 && prodMonths > 0 ? netCollections / prodMonths : 0;

  /* Code lookups */
  const codeQty = (prefix) => codes.filter(c => c.code.startsWith(prefix)).reduce((s,c) => s + c.qty, 0);
  const codeTotal = (prefix) => codes.filter(c => c.code.startsWith(prefix)).reduce((s,c) => s + c.total, 0);
  const exactQty = (code) => { const f = codes.find(c => c.code === code); return f ? f.qty : 0; };

  /* NP flow (D0150 = comp exams) — prefix match for sub-codes like D0150.1 */
  const compExams = codeQty('D0150');
  const npPerMonth = prodMonths > 0 ? Math.round(compExams / prodMonths) : 0;

  /* Active patient estimate (prophy + perio maint per year) — use prefix match for sub-codes */
  const prophyQty = codeQty('D1110') + codeQty('D1120');
  const perioMaintQty = codeQty('D4910');
  const activePatientEst = Math.round((prophyQty + perioMaintQty) / (prodMonths / 12));

  /* Hygiene production */
  const hygCodes = ['D1110','D1120','D4910','D4341','D4342','D4346','D4381','D0120','D0274'];
  let hygProd = 0;
  for (const hc of hygCodes) { hygProd += codeTotal(hc); }
  const hygPct = totalProd > 0 ? (hygProd / totalProd * 100) : 0;

  /* Perio metrics — use prefix match for sub-codes (D4341.1, D4342.1, etc.) */
  const srpQty = codeQty('D4341') + codeQty('D4342');
  const perioRatio = prophyQty > 0 ? (srpQty / prophyQty * 100) : 0;

  /* Specialty production (endo, oral surgery, implants, ortho, perio surgery) */
  const endoTotal = codeTotal('D3310') + codeTotal('D3320') + codeTotal('D3330') + codeTotal('D3346') + codeTotal('D3347') + codeTotal('D3348');
  const osTotal = codeTotal('D7140') + codeTotal('D7210') + codeTotal('D7220') + codeTotal('D7230') + codeTotal('D7240') + codeTotal('D7250');
  const implantTotal = codeTotal('D6010') + codeTotal('D6011') + codeTotal('D6012') + codeTotal('D6013') + codeTotal('D6100') + codeTotal('D6104');
  const orthoTotal = codeTotal('D8040') + codeTotal('D8080') + codeTotal('D8090') + codeTotal('D8220');
  const specTotal = endoTotal + osTotal + implantTotal + orthoTotal;
  const specPct = totalProd > 0 ? (specTotal / totalProd * 100) : 0;

  /* Panorex */
  const hasPanorex = codeQty('D0330') > 0;

  /* P&L-derived metrics */
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

  /* Employee cost from form data — only use as FALLBACK when P&L staff cost is unavailable.
     P&L captures total payroll; the form only has partial staff entered by the consultant. */
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

  /* AR metrics */
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

/* ─── Production Worksheet mappings ─── */
const LEFT = {'D0120':10,'D0140':11,'D0150':12,'D0180':13,'D0210':16,'D0274':17,'D0330':18,
  'D1110':21,'D1120':22,'D4910':23,'D4381':25,'D4346':26,'D2740':31,'D2750':32};
const SRP_CODES = ['D4341','D4342'];

const RIGHT = {};
const R = (codes, row) => codes.forEach(c => { RIGHT[c] = row; });
R(['D2960','D2961','D2962'], 3);
R(['D2610','D2620','D2630'], 4);
R(['D2642','D2643','D2644'], 5);
R(['D2710','D2712','D2720','D2721','D2722'], 6);
R(['D2780','D2781','D2782','D2783','D2790','D2791','D2792','D2794'], 7);
R(['D6058','D6059','D6060','D6061','D6062','D6063','D6064','D6065','D6066','D6067','D6068'], 8);
R(['D6210','D6211','D6212','D6214','D6240','D6241','D6242','D6243','D6245','D6250','D6251','D6252','D6253',
   'D6545','D6548','D6549','D6710','D6720','D6721','D6722','D6740','D6750','D6751','D6752','D6753',
   'D6780','D6781','D6782','D6783','D6790','D6791','D6792','D6793','D6794'], 12);
R(['D6050','D6051','D6056','D6057'], 14);
R(['D7880','D7881','D9940','D9944','D9945','D9946'], 21);
R(['D8040'], 22); R(['D8080'], 23); R(['D8090'], 24); R(['D8220'], 25);
R(['D8680','D8681'], 26);
R(['D5110','D5120','D5130','D5140'], 31);
R(['D5211','D5212'], 32); R(['D5213','D5214'], 33); R(['D5225','D5226'], 34);
R(['D6082','D6083','D6084','D6085','D6086','D6087'], 35);
R(['D5410','D5411','D5421','D5422'], 36);
R(['D5511','D5512','D5520','D5611','D5612','D5621','D5622','D5630','D5640','D5650','D5660'], 37);
R(['D5710','D5711','D5720','D5721','D5730','D5731','D5740','D5741','D5750','D5751','D5760','D5761'], 38);
R(['D5810','D5811','D5820','D5821'], 39);
R(['D3310'], 43); R(['D3320'], 44); R(['D3330'], 45);
R(['D3346','D3347','D3348'], 46);
R(['D4249'], 51); R(['D4266'], 52); R(['D4267'], 53); R(['D4273'], 54); R(['D4283'], 56);
R(['D4260','D4261','D4263','D4264','D4270','D4271','D4275','D4276','D4277','D4278','D4285',
   'D4210','D4211','D4240','D4241','D4245'], 52);
R(['D7922'], 58); R(['D7953'], 59); R(['D6104'], 60); R(['D7140'], 61);
R(['D7210','D7220','D7230','D7240','D7241'], 62); R(['D6010','D6011','D6012','D6013'], 63);
R(['D6100'], 64); R(['D7250'], 65); R(['D7286','D7287','D7288'], 66); R(['D7952','D7951'], 67);
R(['D7310','D7311','D7320','D7321','D7410','D7411','D7412','D7440','D7450','D7451','D7460',
   'D7461','D7465','D7471','D7472','D7473','D7510','D7511','D7920','D7921','D7950','D7955',
   'D7960','D7961','D7962','D7970','D7971'], 66);

function baseCode(code) { return code.replace(/\.\d+$/, ''); }

/* ═══════════════════════════════════════════════════════════════════════════
   INJECT VALUES INTO TEMPLATE: Use JSZip to directly modify template XML.
   For sheets 1-8: Use regex to find and replace existing cells.
   For sheets 9-10: Convert ExcelJS shared strings to inline strings.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Inject collected cell values into template XML.
 * For sheets 1-8: direct regex injection preserving styles.
 * For sheets 9-10: resolve shared strings to inline strings.
 */
async function injectValuesIntoTemplate(templateBuf, sheetNameMap, sheets9to10Buf, swotData, practiceName, extraSheetNames, practiceProfile) {
  const templateZip = await JSZip.loadAsync(templateBuf);

  /* ─── Preserve template's original styles.xml and Content_Types ─── */
  /* Something in the JSZip/ExcelJS pipeline contaminates these files.
     We save them now and restore (with modifications) at the very end. */
  const _originalStylesXml = await templateZip.file('xl/styles.xml')?.async('string');
  const _originalContentTypes = await templateZip.file('[Content_Types].xml')?.async('string');
  console.log('Preserved template styles.xml:', _originalStylesXml?.length, 'chars');

  /* Process template sheets (1-8) with collected values */
  for (let sheetNum = 1; sheetNum <= 8; sheetNum++) {
    /* Get collected values for this sheet */
    let sheetName = null;
    for (const [name, num] of Object.entries(sheetNameMap)) {
      if (num === sheetNum) {
        sheetName = name;
        break;
      }
    }
    if (!sheetName) continue;

    const sheetCells = _cellCollector[sheetName] || {};
    const hasCellData = Object.keys(sheetCells).length > 0;

    /* IMPORTANT: Always process every sheet — even sheets with no cell data need
       column width, row height, and IFERROR fixes applied in Pass 1. */

    const xmlPath = `xl/worksheets/sheet${sheetNum}.xml`;
    let xml = await templateZip.file(xmlPath)?.async('string');
    if (!xml) continue;

    /* Track which cells were matched */
    const matched = new Set();

    /* Single regex pass to find and replace existing cells */
    let _regexMatches = 0, _dataHits = 0, _replaced = 0, _formulaSkip = 0;
    xml = xml.replace(/<c\s[^>]*?r="([^"]+)"[^/>]*(?:\/?>(?:[^]*?<\/c>)?)/gs, (fullMatch, cellRef) => {
      _regexMatches++;
      const val = sheetCells[cellRef];
      if (val === null || val === undefined) return fullMatch;
      _dataHits++;

      /* Mark this cell as existing in template (even if we skip it) */
      matched.add(cellRef);

      /* If cell has a formula BUT we have explicit data from sv(), overwrite it.
         sv() calls are intentional — we want the value to replace the formula.
         Template formulas that should be preserved won't have sv() calls. */
      const templateHasFormula = fullMatch.includes('<f>') || fullMatch.includes('<f ');
      if (templateHasFormula) {
        _formulaSkip++;
        console.log('Overwriting formula in', cellRef, 'with value', val);
      }
      _replaced++;

      /* Preserve template style */
      const styleMatch = fullMatch.match(/\ss="(\d+)"/);
      const styleAttr = styleMatch ? ` s="${styleMatch[1]}"` : '';

      if (typeof val === 'string') {
        return `<c r="${cellRef}"${styleAttr} t="inlineStr"><is><t>${escapeXml(val)}</t></is></c>`;
      } else {
        return `<c r="${cellRef}"${styleAttr} t="n"><v>${escapeXml(String(val))}</v></c>`;
      }
    });

    /* Insert new cells that didn't exist in template.
       For All Codes (sheet 2) and P&L Input (sheet 8), use template-correct styles
       instead of s="0" so formatting matches and strikethrough can apply. */
    const newCellsByRow = {};

    /* All Codes (sheet 2) alternating style map:
       Even rows: A/B=458, C=459, D/E=460, F=461
       Odd rows:  A/B=462, C=463, D/E=464, F=465 */
    const AC_EVEN = {A:'458',B:'458',C:'459',D:'460',E:'460',F:'461'};
    const AC_ODD  = {A:'462',B:'462',C:'463',D:'464',E:'464',F:'465'};

    for (const [cellRef, val] of Object.entries(sheetCells)) {
      if (matched.has(cellRef)) continue;
      if (val === null || val === undefined) continue;

      const colLetter = cellRef.match(/^[A-Z]+/)[0];
      const rowNum = cellRef.match(/\d+$/)[0];
      const rNum = parseInt(rowNum);

      /* Determine correct style for this sheet */
      let styleId = '0';
      if (sheetNum === 2 && rNum >= 2 && 'ABCDEF'.includes(colLetter)) {
        styleId = (rNum % 2 === 0) ? (AC_EVEN[colLetter] || '458') : (AC_ODD[colLetter] || '462');
      } else if (sheetNum === 8 && rNum >= 6 && rNum <= 50) {
        /* Use template styles: 2 for col A (Candara 10pt text), 316 for cols B+ ($#,##0 dollar) */
        styleId = (colLetter === 'A') ? '2' : '316';
      }

      let cellXml;
      if (typeof val === 'string') {
        cellXml = `<c r="${cellRef}" s="${styleId}" t="inlineStr"><is><t>${escapeXml(val)}</t></is></c>`;
      } else {
        cellXml = `<c r="${cellRef}" s="${styleId}" t="n"><v>${escapeXml(String(val))}</v></c>`;
      }

      if (!newCellsByRow[rowNum]) newCellsByRow[rowNum] = [];
      newCellsByRow[rowNum].push(cellXml);
    }

    /* Batch-insert new cells */
    for (const [rowNum, cells] of Object.entries(newCellsByRow)) {
      const rowPattern = new RegExp(`(<row\\s+r="${rowNum}"[^>]*>)`);
      const rowMatch = xml.match(rowPattern);
      if (rowMatch) {
        xml = xml.replace(rowPattern, rowMatch[1] + cells.join(''));
      } else {
        xml = xml.replace(/<\/sheetData>/, `<row r="${rowNum}">${cells.join('')}</row></sheetData>`);
      }
    }

    /* Fix template bugs on Employee Costs (sheet 6) */
    if (sheetNum === 6) {
      /* F9 has date format s="644" instead of General s="641" */
      xml = xml.replace(/<c r="F9" s="644"/, '<c r="F9" s="641"');
      /* ALL staff/hygiene G-column cells are hardcoded 0 — add =E*F formulas */
      const ecFormulaRows = [7, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 27, 28, 29];
      ecFormulaRows.forEach(r => {
        /* Match G{r} with any style, value=0 or empty */
        xml = xml.replace(
          new RegExp(`<c\\s[^>]*r="G${r}"[^>]*>.*?</c>`, 's'),
          `<c r="G${r}" s="642"><f>E${r}*F${r}</f><v></v></c>`
        );
        /* Also handle self-closing <c .../> tags */
        xml = xml.replace(
          new RegExp(`<c\\s[^>]*r="G${r}"[^/]*/>`, 's'),
          `<c r="G${r}" s="642"><f>E${r}*F${r}</f><v></v></c>`
        );
      });
      /* Benefits rows 35-42 — keep content, don't clear */
    }

    /* ── All Codes (sheet 2): apply strikethrough to rows used in Production Worksheet ── */
    if (sheetNum === 2 && _acStrikeRows.length > 0) {
      /* Template uses alternating styles:
         Even rows: 458,459,460,461 → strikethrough: 756,757,758,759
         Odd rows:  462,463,464,465 → strikethrough: 752,753,754,755
         All 8 strikethrough styles are added in post-processing (copies with fontId="66"). */
      const strikeMap = {
        '458':'756','459':'757','460':'758','461':'759',
        '462':'752','463':'753','464':'754','465':'755'
      };
      const strikeRowSet = new Set(_acStrikeRows.map(String));
      let strikeApplied = 0;
      xml = xml.replace(/<c\s([^>]*?)r="([A-Z]+)(\d+)"([^>]*?)s="(458|459|460|461|462|463|464|465)"([^>]*?)(?:\/?>(?:[\s\S]*?<\/c>)?)/g,
        (full, pre, col, rowNum, mid, styleId, post) => {
          if (strikeRowSet.has(rowNum)) {
            strikeApplied++;
            return full.replace(`s="${styleId}"`, `s="${strikeMap[styleId]}"`);
          }
          return full;
        });
      console.log('All Codes: applied strikethrough to ' + strikeApplied + ' cells across ' + _acStrikeRows.length + ' rows');
    }

    /* ── Financial Overview (sheet 4): fix #DIV/0! and column widths ── */
    if (sheetNum === 4) {
      /* Wrap row 45 percentage formulas in IFERROR */
      ['B','C','D','E','F','G','H'].forEach(c => {
        xml = xml.replace(
          new RegExp(`<f>${c}44/I44</f>`),
          `<f>IFERROR(${c}44/I44,0)</f>`
        );
      });
      /* Widen columns B-H for AR dollar amounts and payment data.
         Replace entire <cols> section to ensure widths are applied regardless of attribute order. */
      xml = xml.replace(/<cols>[\s\S]*?<\/cols>/,
        `<cols>
<col min="1" max="1" width="1.66" customWidth="1" style="383"/>
<col min="2" max="2" width="16" customWidth="1" style="383"/>
<col min="3" max="3" width="14" customWidth="1" style="383"/>
<col min="4" max="4" width="15" customWidth="1" style="383"/>
<col min="5" max="5" width="15" customWidth="1" style="383"/>
<col min="6" max="6" width="14" customWidth="1" style="383"/>
<col min="7" max="7" width="14" customWidth="1" style="383"/>
<col min="8" max="8" width="14" customWidth="1" style="383"/>
<col min="9" max="9" width="26.5" customWidth="1" style="383"/>
<col min="10" max="10" width="1.66" customWidth="1" style="383"/>
<col min="11" max="25" width="10.83" customWidth="1" style="383"/>
</cols>`);
      console.log('Financial Overview: fixed IFERROR and column widths');
    }

    /* ── Budgetary P&L (sheet 7): fix #DIV/0! and column widths ── */
    if (sheetNum === 7) {
      /* Wrap all division formulas in IFERROR to prevent #DIV/0! */
      xml = xml.replace(/<f>([^<]*?\/[^<]*?)<\/f>/g, (full, formula) => {
        if (formula.startsWith('IFERROR')) return full; /* already wrapped */
        if (/\/[A-Z$]+\d+/.test(formula) || /\/\d/.test(formula)) {
          return `<f>IFERROR(${formula},0)</f>`;
        }
        return full;
      });
      /* Widen percentage columns C, F, I so #DIV/0! text doesn't show ##### */
      xml = xml.replace(/<cols>[\s\S]*?<\/cols>/,
        `<cols>
<col min="1" max="1" width="1.17" customWidth="1" style="383"/>
<col min="2" max="2" width="19.66" customWidth="1" style="383"/>
<col min="3" max="3" width="8" customWidth="1" style="383"/>
<col min="4" max="4" width="13" customWidth="1" style="383"/>
<col min="5" max="5" width="1.66" customWidth="1" style="383"/>
<col min="6" max="6" width="8" customWidth="1" style="383"/>
<col min="7" max="7" width="13" customWidth="1" style="383"/>
<col min="8" max="8" width="1.66" customWidth="1" style="383"/>
<col min="9" max="9" width="8" customWidth="1" style="383"/>
<col min="10" max="10" width="13" customWidth="1" style="383"/>
<col min="11" max="11" width="1.17" customWidth="1" style="383"/>
</cols>`);
      /* Fix row heights: row 4 (practice name) and row 32 (section header) need to be taller */
      xml = xml.replace(/<row\s+r="(\d+)"([^>]*)>/g, (full, rNum, attrs) => {
        const r = parseInt(rNum);
        if (r === 4 || r === 32) {
          let a = attrs.replace(/\s*customHeight="[^"]*"/g, '').replace(/\s+ht="[^"]*"/g, '');
          return `<row r="${rNum}"${a} ht="24" customHeight="1">`;
        }
        if (r === 5) {
          let a = attrs.replace(/\s*customHeight="[^"]*"/g, '').replace(/\s+ht="[^"]*"/g, '');
          return `<row r="${rNum}"${a} ht="22" customHeight="1">`;
        }
        return full;
      });
      console.log('Budgetary P&L: fixed IFERROR, column widths, and row heights');
    }

    /* ── P&L Input (sheet 8): ensure data rows are visible ── */
    if (sheetNum === 8) {
      /* Template has customHeight="1" which forces 12.75pt even if content overflows.
         Remove customHeight on data rows (6-50) so Excel auto-sizes, and set minimum 15pt.
         Row 5 is the header row — make it 30pt so column labels aren't cut off. */
      xml = xml.replace(/<row\s+r="(\d+)"([^>]*)>/g, (full, rNum, attrs) => {
        const r = parseInt(rNum);
        if (r === 5) {
          let a = attrs.replace(/\s*customHeight="[^"]*"/g, '').replace(/\s+ht="[^"]*"/g, '');
          return `<row r="${rNum}"${a} ht="30" customHeight="1">`;
        }
        if (r >= 6 && r <= 50) {
          let newAttrs = attrs.replace(/\s*customHeight="1"/g, '');
          newAttrs = newAttrs.replace(/ht="[^"]*"/, 'ht="15"');
          return `<row r="${rNum}"${newAttrs}>`;
        }
        return full;
      });
      /* Widen columns — F, G, K, P wider to avoid ###### on totals */
      xml = xml.replace(/<cols>[\s\S]*?<\/cols>/,
        `<cols>
<col min="1" max="1" width="40" customWidth="1" style="2"/>
<col min="2" max="5" width="14" customWidth="1" style="316"/>
<col min="6" max="6" width="16" customWidth="1" style="316"/>
<col min="7" max="7" width="18" customWidth="1" style="316"/>
<col min="8" max="8" width="18" customWidth="1" style="316"/>
<col min="9" max="10" width="14" customWidth="1" style="316"/>
<col min="11" max="11" width="16" customWidth="1" style="316"/>
<col min="12" max="15" width="14" customWidth="1" style="316"/>
<col min="16" max="17" width="18" customWidth="1" style="316"/>
</cols>`);
      console.log('P&L Input: fixed row heights and column widths');
    }

    console.log(`Sheet ${sheetNum}: matched=${_regexMatches} hits=${_dataHits} replaced=${matched.size} formulaSkip=${_formulaSkip} newCells=${Object.values(newCellsByRow).flat().length}`);
    templateZip.file(xmlPath, xml);
  }

  /* Track which extra sheets (9-12) were created — declared here so Content_Types
     registration (in Pass 2) can reference them even when sheets9to10Buf is null */
  let hasSheet9 = false, hasSheet10 = false, hasSheet11 = false, hasSheet12 = false;
  let _pass2WorkbookXml = null;  /* Reordered workbook.xml — declared early for same reason as hasSheet vars */

  /* Process sheets 9-10 from ExcelJS workbook (if present) */
  if (sheets9to10Buf) {
    const excelZip = await JSZip.loadAsync(sheets9to10Buf);

    /* Resolve shared strings from ExcelJS */
    const sharedStrings = [];
    const sstXml = await excelZip.file('xl/sharedStrings.xml')?.async('string');
    if (sstXml) {
      const siPattern = /<si>([\s\S]*?)<\/si>/g;
      let siMatch;
      while ((siMatch = siPattern.exec(sstXml)) !== null) {
        const siContent = siMatch[1];
        const texts = [];
        const tPattern = /<t[^>]*>([^<]*)<\/t>/g;
        let tMatch;
        while ((tMatch = tPattern.exec(siContent)) !== null) {
          texts.push(tMatch[1]);
        }
        sharedStrings.push(texts.join(''));
      }
      console.log('ExcelJS shared strings resolved:', sharedStrings.length);
    }

    /* Discover ExcelJS sheet file paths dynamically (ExcelJS may name them sheet1/sheet2, not sheet9/sheet10) */
    const excelSheetFiles = Object.keys(excelZip.files)
      .filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/sheet(\d+)/)[1]);
        const nb = parseInt(b.match(/sheet(\d+)/)[1]);
        return na - nb;
      });
    console.log('ExcelJS sheet files found:', excelSheetFiles);

    /* Map ExcelJS sheets → template sheet9, sheet10, sheet11, sheet12 */
    const targetSheetNums = [9, 10, 11, 12];
    for (let idx = 0; idx < excelSheetFiles.length && idx < 4; idx++) {
      const srcPath = excelSheetFiles[idx];
      const targetNum = targetSheetNums[idx];
      const targetPath = `xl/worksheets/sheet${targetNum}.xml`;
      let xml = await excelZip.file(srcPath)?.async('string');
      if (xml) {
        /* Replace all t="s" cells with inline strings */
        /* NOTE: sharedStrings text is already XML-escaped from the source XML,
           so do NOT apply escapeXml again (that causes double-encoding: & → &amp;amp;) */
        xml = xml.replace(/<c\s([^>]*?)t="s"([^>]*)>\s*<v>(\d+)<\/v>\s*<\/c>/g, (full, pre, post, idxStr) => {
          const i = parseInt(idxStr, 10);
          if (i < sharedStrings.length) {
            const text = sharedStrings[i];
            return `<c ${pre}t="inlineStr"${post}><is><t>${text}</t></is></c>`;
          }
          return full;
        });
        /* ── P&L Raw Import: strikethrough expenses used in P&L Input ── */
        /* Detect P&L Raw Import sheet by content (position varies based on Practice Profile presence) */
        const isPLRawSheet = xml.includes('P&amp;L Raw Import') || xml.includes('P&amp;L Raw');
        if (isPLRawSheet && _plInputExpenseNames.size > 0) {
          let strikeCount = 0;
          xml = xml.replace(
            /<c\s([^>]*?)r="A(\d+)"([^>]*?)>\s*<is>\s*<t>([^<]*)<\/t>\s*<\/is>\s*<\/c>/g,
            (full, pre, rowNum, post, text) => {
              if (!full.includes('t="inlineStr"')) return full;
              const attrs = pre + 'r="A' + rowNum + '"' + post;
              /* Decode XML entities for comparison */
              const decoded = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").toLowerCase().trim();
              if (_plInputExpenseNames.has(decoded)) {
                strikeCount++;
                return `<c ${attrs}><is><r><rPr><strike/></rPr><t>${text}</t></r></is></c>`;
              }
              return full;
            }
          );
          console.log('P&L Raw Import: applied strikethrough to', strikeCount, 'expense rows (of', _plInputExpenseNames.size, 'tracked)');
        }

        templateZip.file(targetPath, xml);
        if (targetNum === 9) hasSheet9 = true;
        if (targetNum === 10) hasSheet10 = true;
        if (targetNum === 11) hasSheet11 = true;
        if (targetNum === 12) hasSheet12 = true;
        console.log(`ExcelJS ${srcPath} → ${targetPath}: converted shared strings to inline`);
      }
    }

    /* Copy rels for ExcelJS sheets, remapping to sheet9/10/11 */
    for (let idx = 0; idx < excelSheetFiles.length && idx < 4; idx++) {
      const srcNum = excelSheetFiles[idx].match(/sheet(\d+)/)[1];
      const targetNum = targetSheetNums[idx];
      const srcRels = `xl/worksheets/_rels/sheet${srcNum}.xml.rels`;
      const targetRels = `xl/worksheets/_rels/sheet${targetNum}.xml.rels`;
      const content = await excelZip.file(srcRels)?.async('nodebuffer');
      if (content) templateZip.file(targetRels, content);
    }

    /* Copy media and drawings */
    for (const filePath of Object.keys(excelZip.files)) {
      if (filePath.startsWith('xl/media/') && !templateZip.file(filePath)) {
        const content = await excelZip.file(filePath)?.async('nodebuffer');
        if (content) templateZip.file(filePath, content);
      }
      if (filePath.match(/xl\/drawings\/(drawing|_rels)/) && !templateZip.file(filePath)) {
        const content = await excelZip.file(filePath)?.async('nodebuffer');
        if (content) templateZip.file(filePath, content);
      }
    }

    /* Dynamically register extra sheets in workbook.xml using extraSheetNames */
    const hasSheets = [hasSheet9, hasSheet10, hasSheet11, hasSheet12];
    const sheetNums = [9, 10, 11, 12];
    const rIdStart = 11; /* rId11, rId12, rId13, rId14 */

    let workbookXml = await templateZip.file('xl/workbook.xml')?.async('string');
    if (workbookXml && hasSheets.some(Boolean)) {
      const sheetsPattern = /<sheets>([\s\S]*?)<\/sheets>/;
      const sheetsMatch = workbookXml.match(sheetsPattern);
      if (sheetsMatch) {
        let sheetsContent = sheetsMatch[1];
        const sheetIds = [];
        const idPattern = /sheetId="(\d+)"/g;
        let idMatch;
        while ((idMatch = idPattern.exec(sheetsContent)) !== null) {
          sheetIds.push(parseInt(idMatch[1]));
        }
        const maxId = sheetIds.length > 0 ? Math.max(...sheetIds) : 8;

        for (let i = 0; i < 4; i++) {
          const rId = 'rId' + (rIdStart + i);
          if (hasSheets[i] && !sheetsContent.includes(rId)) {
            const name = (extraSheetNames && extraSheetNames[i]) ? extraSheetNames[i].replace(/&/g, '&amp;') : ('Extra Sheet ' + (i+1));
            sheetsContent += `<sheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" name="${name}" sheetId="${maxId + 1 + i}" state="visible" r:id="${rId}"/>`;
          }
        }

        workbookXml = workbookXml.replace(sheetsPattern, `<sheets>${sheetsContent}</sheets>`);

        /* ── Reorder: move Practice Profile sheet to FIRST tab position ── */
        if (hasSheet9 && extraSheetNames && extraSheetNames[0] === 'Practice Profile') {
          const reorderMatch = workbookXml.match(/<sheets>([\s\S]*?)<\/sheets>/);
          if (reorderMatch) {
            let inner = reorderMatch[1];
            /* Find the Practice Profile <sheet> entry */
            const ppPattern = /<sheet[^>]*name="Practice Profile"[^>]*\/>/;
            const ppMatch = inner.match(ppPattern);
            if (ppMatch) {
              /* Remove it from current position, prepend it */
              inner = inner.replace(ppPattern, '');
              inner = ppMatch[0] + inner;
              workbookXml = workbookXml.replace(/<sheets>[\s\S]*?<\/sheets>/, `<sheets>${inner}</sheets>`);
              console.log('Workbook.xml: moved Practice Profile to first tab');
            }
          }
        }
        _pass2WorkbookXml = workbookXml;

        templateZip.file('xl/workbook.xml', workbookXml);
      }
    }

    let wbRelsXml = await templateZip.file('xl/_rels/workbook.xml.rels')?.async('string');
    if (wbRelsXml) {
      for (let i = 0; i < 4; i++) {
        const sheetFile = `sheet${sheetNums[i]}.xml`;
        const rId = 'rId' + (rIdStart + i);
        if (hasSheets[i] && !wbRelsXml.includes(sheetFile)) {
          wbRelsXml = wbRelsXml.replace(/<\/Relationships>/, `<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/${sheetFile}" Id="${rId}"/></Relationships>`);
        }
      }
      templateZip.file('xl/_rels/workbook.xml.rels', wbRelsXml);
    }

    /* Content_Types handled in post-processing from preserved original */
  }

  console.log('Template injection complete');

  /* ═══ PRE-PASS 1 VERIFICATION: check styles.xml is intact in templateZip ═══ */
  const prePassStyles = await templateZip.file('xl/styles.xml')?.async('string');
  const preXfs = prePassStyles?.match(/cellXfs count="(\d+)"/);
  console.log('PRE-PASS1 VERIFY: cellXfs=' + (preXfs?preXfs[1]:'MISSING!') + ' len=' + (prePassStyles?.length||0));
  if (!prePassStyles || parseInt(preXfs?.[1]||'0') < 700) {
    console.error('CRITICAL: styles.xml was corrupted BEFORE Pass 1! Forcing restore...');
    if (_originalStylesXml) {
      templateZip.file('xl/styles.xml', _originalStylesXml);
      console.log('Force-restored styles.xml from saved original');
    }
  }

  /* ═══ PRE-PASS 1: Log template sheet inventory ═══ */
  const templateSheetFiles = Object.keys(templateZip.files).filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort();
  console.log('PRE-PASS1 template sheets:', templateSheetFiles.length, ':', templateSheetFiles.join(', '));
  console.log('PRE-PASS1 hasSheet flags: 9=' + hasSheet9 + ' 10=' + hasSheet10 + ' 11=' + hasSheet11 + ' 12=' + hasSheet12);

  /* ═══ PASS 1: Generate the xlsx from templateZip ═══ */
  const pass1Buf = await templateZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  console.log('Pass 1 output:', pass1Buf.length, 'bytes');

  /* ═══ POST-PASS 1 VERIFICATION: check if contamination occurred ═══ */
  const pass1Zip = await JSZip.loadAsync(pass1Buf);
  const pass1SheetFiles = Object.keys(pass1Zip.files).filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort();
  console.log('POST-PASS1 sheets:', pass1SheetFiles.length, ':', pass1SheetFiles.join(', '));
  const pass1Styles = await pass1Zip.file('xl/styles.xml')?.async('string');
  const p1Xfs = pass1Styles?.match(/cellXfs count="(\d+)"/);
  const p1HasSS = !!pass1Zip.file('xl/sharedStrings.xml');
  console.log('POST-PASS1 VERIFY: cellXfs=' + (p1Xfs?p1Xfs[1]:'MISSING!') + ' sharedStrings=' + p1HasSS + ' len=' + (pass1Styles?.length||0));

  if (parseInt(p1Xfs?.[1]||'0') < 700) {
    console.error('*** CONTAMINATION DETECTED in Pass 1 output! cellXfs=' + (p1Xfs?p1Xfs[1]:'?') + ' (expected 752+). Will fix in Pass 2.');
  }

  /* ═══ PASS 2: Post-process — restore template styles, remove contamination ═══ */
  /* If Pass 1 output has contaminated styles (ExcelJS rewrites ~350 cellXfs),
     Pass 2 restores the original template's styles.xml (752 cellXfs) and applies fixes. */
  const fixZip = pass1Zip; /* Reuse already-loaded zip instead of loading again */

  /* Restore original template styles.xml — fix only the grey placeholder font */
  /* CRITICAL FALLBACK: If _originalStylesXml is somehow null, re-read from template */
  let stylesSource = _originalStylesXml;
  if (!stylesSource) {
    console.error('CRITICAL: _originalStylesXml is null! Re-reading from template...');
    const fallbackZip = await JSZip.loadAsync(templateBuf);
    stylesSource = await fallbackZip.file('xl/styles.xml')?.async('string');
    console.log('Fallback styles loaded:', stylesSource?.length, 'chars');
  }
  /* CRITICAL: declare stylesXml in outer scope so fresh zip build can access it directly.
     JSZip .file(path, content) writes do NOT persist for .file(path).async() reads
     on the same loaded zip — we MUST keep the JS variable and use it in the fresh zip. */
  let _pass2StylesXml = null;
  /* _pass2WorkbookXml declared earlier (line ~654) to avoid temporal dead zone */
  let _swotStyles = null;  /* SWOT style indices — set during Pass 2, used for SWOT XML generation */
  let _ppStyles = null;    /* Practice Profile style indices — set during Pass 2, used for PP XML generation */

  if (stylesSource) {
    let stylesXml = stylesSource;
    /* Only remove strikethrough from fonts that have grey color FF888888 (font 31 = placeholder).
       Fonts 47-49 have legitimate strikethrough for All Codes & P&L Raw Import — keep those. */
    stylesXml = stylesXml.replace(/<font>([\s\S]*?)<\/font>/g, (fullFont, inner) => {
      if (inner.includes('FF888888') && inner.includes('<strike')) {
        let fixed = inner.replace(/<strike\s*(?:val="1"\s*)?\/>\s*/g, '');
        fixed = fixed.replace(/<color rgb="FF888888"\/>/g, '<color rgb="FF000000"/>');
        return `<font>${fixed}</font>`;
      }
      return fullFont;
    });
    /* === Normalize ALL fonts to Candara; standardize sizes to clean hierarchy === */
    /* Size ladder: 36 → 24 → 20 → 18 → 16 → 14 (body).
       Body text (9-12pt) → 14pt.  Oddball header sizes: 28→24, 23→24, 22→20.
       Tiny footnote fonts (6-8pt) left as-is. */
    stylesXml = stylesXml.replace(/<font>([\s\S]*?)<\/font>/g, (full, inner) => {
      let m = inner.replace(/<name val="[^"]*"\s*\/>/g, '<name val="Candara"/>');
      m = m.replace(/<sz val="(9|1[012])"\s*\/>/g, '<sz val="14"/>');
      m = m.replace(/<sz val="28"\s*\/>/g, '<sz val="24"/>');
      m = m.replace(/<sz val="23"\s*\/>/g, '<sz val="24"/>');
      m = m.replace(/<sz val="22"\s*\/>/g, '<sz val="20"/>');
      return `<font>${m}</font>`;
    });
    console.log('Pass 2: normalized all fonts to Candara, standardized size hierarchy');

    /* === Add strikethrough font (index 66) for All Codes used-code rows === */
    /* Font 66: copy of font 31 (Arial 10pt black) but WITH strikethrough */
    const fontsMatch = stylesXml.match(/<fonts[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/fonts>/);
    if (fontsMatch) {
      const fontCount = parseInt(fontsMatch[1]);
      const fontsContent = fontsMatch[2];
      /* Extract individual <font>...</font> entries */
      const fontEntries = [];
      const fontRe = /<font>([\s\S]*?)<\/font>/g;
      let fm;
      while ((fm = fontRe.exec(fontsContent)) !== null) fontEntries.push(fm[0]);
      if (fontEntries.length >= 32) {
        /* Font 31 after our fix is Arial 10pt black (no strike). Add strike back for the new font. */
        let newFont = fontEntries[31].replace('<font>', '<font><strike/>');
        /* Append new font 66 */
        const newFontsContent = fontsContent + newFont;
        stylesXml = stylesXml.replace(fontsMatch[0],
          `<fonts count="${fontCount + 1}">${newFontsContent}</fonts>`);
        console.log('Pass 2: added strikethrough font at index', fontCount, '(new count', fontCount + 1, ')');
      }
    }

    /* === Add cellXfs 752-759: strikethrough copies of 462-465 AND 458-461 with fontId="66" === */
    /* 752-755 = copies of 462-465 (odd row styles) with strikethrough font
       756-759 = copies of 458-461 (even row styles) with strikethrough font */
    const xfsMatch = stylesXml.match(/<cellXfs[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/);
    if (xfsMatch) {
      const xfCount = parseInt(xfsMatch[1]);
      const xfsContent = xfsMatch[2];
      const xfEntries = [];
      const xfRe = /<xf\s[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g;
      let xm;
      while ((xm = xfRe.exec(xfsContent)) !== null) xfEntries.push(xm[0]);
      if (xfEntries.length >= 466) {
        let newXfs = '';
        /* 752-755: strikethrough copies of odd-row styles 462-465 */
        for (let i = 462; i <= 465; i++) {
          newXfs += xfEntries[i].replace(/fontId="\d+"/, 'fontId="66"');
        }
        /* 756-759: strikethrough copies of even-row styles 458-461 */
        for (let i = 458; i <= 461; i++) {
          newXfs += xfEntries[i].replace(/fontId="\d+"/, 'fontId="66"');
        }
        const newXfsContent = xfsContent + newXfs;
        stylesXml = stylesXml.replace(xfsMatch[0],
          `<cellXfs count="${xfCount + 8}">${newXfsContent}</cellXfs>`);
        console.log('Pass 2: added cellXfs 752-759 (8 strikethrough styles), new count', xfCount + 8);
      }
    }

    /* === Convert ALL blue/yellow fills to dark navy (FF1A1A2E) with white text === */
    /* Template uses FF3574B7 (medium blue), FF2C6AA0 (darker blue), FFFFFF00 (yellow)
       for section banners on Production Worksheet and Financial Overview.
       Change them ALL to dark navy and make the text white. */
    {
      /* Step 1: Replace fill colors within <fill> elements only */
      stylesXml = stylesXml.replace(/<fill>[\s\S]*?<\/fill>/g, (full) => {
        return full.replace(/FFFFFF00/g, 'FF1A1A2E').replace(/FF3574B7/g, 'FF1A1A2E').replace(/FF2C6AA0/g, 'FF1A1A2E');
      });

      /* Step 2: Find which fill indices now contain dark navy */
      const _fillsM = stylesXml.match(/<fills[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/fills>/);
      const _fillArr = [];
      if (_fillsM) {
        const _flRe = /<fill>[\s\S]*?<\/fill>/g;
        let _flm;
        while ((_flm = _flRe.exec(_fillsM[2])) !== null) _fillArr.push(_flm[0]);
      }
      const navyFillIds = new Set();
      _fillArr.forEach((f, i) => { if (f.includes('FF1A1A2E') && f.includes('solid')) navyFillIds.add(i); });

      /* Step 3: Parse fonts and cellXfs */
      const _fntM = stylesXml.match(/<fonts[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/fonts>/);
      const _xfM = stylesXml.match(/<cellXfs[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/);

      if (_fntM && _xfM && navyFillIds.size > 0) {
        const fontArr = [];
        const _fnRe = /<font>[\s\S]*?<\/font>/g;
        let _fnm;
        while ((_fnm = _fnRe.exec(_fntM[2])) !== null) fontArr.push(_fnm[0]);
        let fontCount = parseInt(_fntM[1]);

        const xfArr = [];
        const _xfRe = /<xf\s[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g;
        let _xm;
        while ((_xm = _xfRe.exec(_xfM[2])) !== null) xfArr.push(_xm[0]);

        /* Step 4: Find unique fontIds used by navy-fill cellXfs, create white copies */
        const fontIdsNeeded = new Set();
        xfArr.forEach(xf => {
          const fillM = xf.match(/fillId="(\d+)"/);
          if (fillM && navyFillIds.has(parseInt(fillM[1]))) {
            const fontM = xf.match(/fontId="(\d+)"/);
            if (fontM) fontIdsNeeded.add(parseInt(fontM[1]));
          }
        });

        const fontIdMap = {};
        let newFonts = '';
        let nextFontIdx = fontCount;
        fontIdsNeeded.forEach(fid => {
          if (fid < fontArr.length) {
            let wf = fontArr[fid];
            /* Remove any existing color tags and add white */
            wf = wf.replace(/<color[^/]*\/>/g, '');
            wf = wf.replace(/<color [^>]*>[^<]*<\/color>/g, '');
            wf = wf.replace('<font>', '<font><color rgb="FFFFFFFF"/>');
            newFonts += wf;
            fontIdMap[fid] = nextFontIdx;
            nextFontIdx++;
          }
        });

        if (newFonts) {
          stylesXml = stylesXml.replace(_fntM[0],
            `<fonts count="${nextFontIdx}">${_fntM[2]}${newFonts}</fonts>`);

          /* Step 5: Update cellXfs — change fontId for navy-fill entries */
          let modified = false;
          for (let i = 0; i < xfArr.length; i++) {
            const fillM = xfArr[i].match(/fillId="(\d+)"/);
            if (fillM && navyFillIds.has(parseInt(fillM[1]))) {
              const fontM = xfArr[i].match(/fontId="(\d+)"/);
              if (fontM && fontIdMap[parseInt(fontM[1])] !== undefined) {
                xfArr[i] = xfArr[i].replace(/fontId="\d+"/, `fontId="${fontIdMap[parseInt(fontM[1])]}"`);
                modified = true;
              }
            }
          }
          if (modified) {
            stylesXml = stylesXml.replace(_xfM[0],
              `<cellXfs count="${xfArr.length}">${xfArr.join('')}</cellXfs>`);
          }
          console.log('Pass 2: converted blue fills→dark navy, created ' + Object.keys(fontIdMap).length + ' white fonts, updated cellXfs');
        }
      } else {
        console.log('Pass 2: fill color replacement done (no cellXfs font changes needed)');
      }
    }

    /* === Add SWOT Analysis styles to template styles.xml === */
    /* These give us proper colored section headers, fills, and borders for the SWOT sheet.
       We parse current counts (which include the strikethrough additions above), then append. */
    {
      const _fm2 = stylesXml.match(/<fonts[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/fonts>/);
      const _flm = stylesXml.match(/<fills[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/fills>/);
      const _brm = stylesXml.match(/<borders[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/borders>/);
      const _xm2 = stylesXml.match(/<cellXfs[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/);

      if (_fm2 && _flm && _brm && _xm2) {
        const fi = parseInt(_fm2[1]);   /* current font count */
        const fli = parseInt(_flm[1]);  /* current fill count */
        const bri = parseInt(_brm[1]);  /* current border count */
        const xi = parseInt(_xm2[1]);   /* current cellXf count */

        /* ── 7 new fonts ── */
        const SF_TITLE  = fi, SF_S = fi+1, SF_W = fi+2, SF_O = fi+3, SF_T = fi+4, SF_BUL = fi+5, SF_FOOT = fi+6;
        const swotFonts =
          '<font><b/><sz val="20"/><color rgb="FF1A1A2E"/><name val="Candara"/></font>' +
          '<font><b/><sz val="14"/><color rgb="FF10B981"/><name val="Candara"/></font>' +
          '<font><b/><sz val="14"/><color rgb="FFEF4444"/><name val="Candara"/></font>' +
          '<font><b/><sz val="14"/><color rgb="FF3574B7"/><name val="Candara"/></font>' +
          '<font><b/><sz val="14"/><color rgb="FFF59E0B"/><name val="Candara"/></font>' +
          '<font><sz val="14"/><color rgb="FF333333"/><name val="Candara"/></font>' +
          '<font><i/><sz val="10"/><color rgb="FF94A3B8"/><name val="Candara"/></font>';
        stylesXml = stylesXml.replace(_fm2[0],
          `<fonts count="${fi + 7}">${_fm2[2]}${swotFonts}</fonts>`);

        /* ── 4 new fills (light section backgrounds) ── */
        const SFL_S = fli, SFL_W = fli+1, SFL_O = fli+2, SFL_T = fli+3;
        const swotFills =
          '<fill><patternFill patternType="solid"><fgColor rgb="FFECFDF5"/><bgColor indexed="64"/></patternFill></fill>' +
          '<fill><patternFill patternType="solid"><fgColor rgb="FFFEF2F2"/><bgColor indexed="64"/></patternFill></fill>' +
          '<fill><patternFill patternType="solid"><fgColor rgb="FFEFF6FF"/><bgColor indexed="64"/></patternFill></fill>' +
          '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFBEB"/><bgColor indexed="64"/></patternFill></fill>';
        stylesXml = stylesXml.replace(_flm[0],
          `<fills count="${fli + 4}">${_flm[2]}${swotFills}</fills>`);

        /* ── 6 new borders ── */
        const SB_TITLE = bri, SB_S = bri+1, SB_W = bri+2, SB_O = bri+3, SB_T = bri+4, SB_BUL = bri+5;
        const swotBorders =
          '<border><left/><right/><top/><bottom style="medium"><color rgb="FF3574B7"/></bottom><diagonal/></border>' +
          '<border><left style="thick"><color rgb="FF10B981"/></left><right/><top/><bottom style="thin"><color rgb="FF10B981"/></bottom><diagonal/></border>' +
          '<border><left style="thick"><color rgb="FFEF4444"/></left><right/><top/><bottom style="thin"><color rgb="FFEF4444"/></bottom><diagonal/></border>' +
          '<border><left style="thick"><color rgb="FF3574B7"/></left><right/><top/><bottom style="thin"><color rgb="FF3574B7"/></bottom><diagonal/></border>' +
          '<border><left style="thick"><color rgb="FFF59E0B"/></left><right/><top/><bottom style="thin"><color rgb="FFF59E0B"/></bottom><diagonal/></border>' +
          '<border><left style="thin"><color rgb="FFE2E8F0"/></left><right/><top/><bottom/><diagonal/></border>';
        stylesXml = stylesXml.replace(_brm[0],
          `<borders count="${bri + 6}">${_brm[2]}${swotBorders}</borders>`);

        /* ── 7 new cellXfs ── */
        const SX_TITLE = xi, SX_S = xi+1, SX_W = xi+2, SX_O = xi+3, SX_T = xi+4, SX_BUL = xi+5, SX_FOOT = xi+6;
        const swotXfs =
          `<xf numFmtId="0" fontId="${SF_TITLE}" fillId="0" borderId="${SB_TITLE}" xfId="0" applyFont="1" applyBorder="1"/>` +
          `<xf numFmtId="0" fontId="${SF_S}" fillId="${SFL_S}" borderId="${SB_S}" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>` +
          `<xf numFmtId="0" fontId="${SF_W}" fillId="${SFL_W}" borderId="${SB_W}" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>` +
          `<xf numFmtId="0" fontId="${SF_O}" fillId="${SFL_O}" borderId="${SB_O}" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>` +
          `<xf numFmtId="0" fontId="${SF_T}" fillId="${SFL_T}" borderId="${SB_T}" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>` +
          `<xf numFmtId="0" fontId="${SF_BUL}" fillId="0" borderId="${SB_BUL}" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top" indent="1"/></xf>` +
          `<xf numFmtId="0" fontId="${SF_FOOT}" fillId="0" borderId="0" xfId="0" applyFont="1"/>`;
        stylesXml = stylesXml.replace(_xm2[0],
          `<cellXfs count="${xi + 7}">${_xm2[2]}${swotXfs}</cellXfs>`);

        _swotStyles = { SX_TITLE, SX_S, SX_W, SX_O, SX_T, SX_BUL, SX_FOOT };
        console.log('Pass 2: added SWOT styles — fonts ' + fi + '-' + (fi+6) + ', fills ' + fli + '-' + (fli+3) + ', borders ' + bri + '-' + (bri+5) + ', xfs ' + xi + '-' + (xi+6));
      } else {
        console.warn('Pass 2: could not parse styles.xml for SWOT additions');
      }
    }

    /* === Add Practice Profile styles to template styles.xml === */
    /* Similar approach to SWOT: append fonts, fills, borders, cellXfs.
       Re-parse current counts since SWOT additions changed them. */
    {
      const _fmP = stylesXml.match(/<fonts[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/fonts>/);
      const _flP = stylesXml.match(/<fills[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/fills>/);
      const _brP = stylesXml.match(/<borders[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/borders>/);
      const _xfP = stylesXml.match(/<cellXfs[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/);

      if (_fmP && _flP && _brP && _xfP) {
        const pfi = parseInt(_fmP[1]);
        const pfli = parseInt(_flP[1]);
        const pbri = parseInt(_brP[1]);
        const pxi = parseInt(_xfP[1]);

        /* 8 new fonts */
        const PF_TITLE = pfi, PF_SUB = pfi+1, PF_SECT = pfi+2, PF_LBL = pfi+3, PF_VAL = pfi+4, PF_CHECK = pfi+5, PF_NOTE = pfi+6, PF_FOOT = pfi+7;
        const ppFonts =
          '<font><b/><sz val="18"/><color rgb="FFFFFFFF"/><name val="Candara"/></font>' +   /* TITLE: white bold 18pt */
          '<font><sz val="10"/><color rgb="FFB0C4DE"/><name val="Candara"/></font>' +       /* SUB: light blue 10pt */
          '<font><b/><sz val="12"/><color rgb="FF2B5797"/><name val="Candara"/></font>' +   /* SECT: blue bold 12pt */
          '<font><sz val="10"/><color rgb="FF64748B"/><name val="Candara"/></font>' +       /* LBL: grey 10pt */
          '<font><b/><sz val="10"/><color rgb="FF1E293B"/><name val="Candara"/></font>' +   /* VAL: dark bold 10pt */
          '<font><sz val="10"/><color rgb="FF1E293B"/><name val="Candara"/></font>' +       /* CHECK: dark 10pt */
          '<font><i/><sz val="10"/><color rgb="FF64748B"/><name val="Candara"/></font>' +   /* NOTE: grey italic 10pt */
          '<font><i/><sz val="8"/><color rgb="FFA0AEC0"/><name val="Candara"/></font>';     /* FOOT: light grey italic 8pt */
        stylesXml = stylesXml.replace(_fmP[0],
          `<fonts count="${pfi + 8}">${_fmP[2]}${ppFonts}</fonts>`);

        /* 3 new fills: navy banner, light grey section, stripe */
        const PFL_BANNER = pfli, PFL_SECT = pfli+1, PFL_STRIPE = pfli+2;
        const ppFills =
          '<fill><patternFill patternType="solid"><fgColor rgb="FF2B5797"/><bgColor indexed="64"/></patternFill></fill>' +
          '<fill><patternFill patternType="solid"><fgColor rgb="FFEEF2F7"/><bgColor indexed="64"/></patternFill></fill>' +
          '<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill>';
        stylesXml = stylesXml.replace(_flP[0],
          `<fills count="${pfli + 3}">${_flP[2]}${ppFills}</fills>`);

        /* 2 new borders: accent bottom (medium blue), thin bottom (grey) */
        const PBR_ACCENT = pbri, PBR_THIN = pbri+1;
        const ppBorders =
          '<border><left/><right/><top/><bottom style="medium"><color rgb="FF2B5797"/></bottom><diagonal/></border>' +
          '<border><left/><right/><top/><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border>';
        stylesXml = stylesXml.replace(_brP[0],
          `<borders count="${pbri + 2}">${_brP[2]}${ppBorders}</borders>`);

        /* 10 new cellXfs */
        const PX_BANNER = pxi;      /* navy fill, white bold 18pt */
        const PX_SUB = pxi+1;       /* navy fill, light blue 10pt */
        const PX_SECT = pxi+2;      /* light grey fill, blue bold, accent border */
        const PX_LBL = pxi+3;       /* no fill, grey label, thin border */
        const PX_VAL = pxi+4;       /* no fill, dark bold value, thin border */
        const PX_LBL_S = pxi+5;     /* stripe fill, grey label, thin border */
        const PX_VAL_S = pxi+6;     /* stripe fill, dark bold value, thin border */
        const PX_CHECK = pxi+7;     /* no fill, dark check text, thin border */
        const PX_NOTE = pxi+8;      /* no fill, grey italic note */
        const PX_FOOT = pxi+9;      /* no fill, light grey italic 8pt */

        const ppXfs =
          `<xf numFmtId="0" fontId="${PF_TITLE}" fillId="${PFL_BANNER}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>` +
          `<xf numFmtId="0" fontId="${PF_SUB}" fillId="${PFL_BANNER}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top"/></xf>` +
          `<xf numFmtId="0" fontId="${PF_SECT}" fillId="${PFL_SECT}" borderId="${PBR_ACCENT}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>` +
          `<xf numFmtId="0" fontId="${PF_LBL}" fillId="0" borderId="${PBR_THIN}" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>` +
          `<xf numFmtId="0" fontId="${PF_VAL}" fillId="0" borderId="${PBR_THIN}" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>` +
          `<xf numFmtId="0" fontId="${PF_LBL}" fillId="${PFL_STRIPE}" borderId="${PBR_THIN}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>` +
          `<xf numFmtId="0" fontId="${PF_VAL}" fillId="${PFL_STRIPE}" borderId="${PBR_THIN}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>` +
          `<xf numFmtId="0" fontId="${PF_CHECK}" fillId="0" borderId="${PBR_THIN}" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>` +
          `<xf numFmtId="0" fontId="${PF_NOTE}" fillId="0" borderId="${PBR_THIN}" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>` +
          `<xf numFmtId="0" fontId="${PF_FOOT}" fillId="0" borderId="0" xfId="0" applyFont="1"/>`;
        stylesXml = stylesXml.replace(_xfP[0],
          `<cellXfs count="${pxi + 10}">${_xfP[2]}${ppXfs}</cellXfs>`);

        _ppStyles = { PX_BANNER, PX_SUB, PX_SECT, PX_LBL, PX_VAL, PX_LBL_S, PX_VAL_S, PX_CHECK, PX_NOTE, PX_FOOT };
        console.log('Pass 2: added Practice Profile styles — fonts ' + pfi + '-' + (pfi+7) + ', fills ' + pfli + '-' + (pfli+2) + ', borders ' + pbri + '-' + (pbri+1) + ', xfs ' + pxi + '-' + (pxi+9));
      } else {
        console.warn('Pass 2: could not parse styles.xml for Practice Profile additions');
      }
    }

    /* === Add Batting Average box styles === */
    /* Bold-bordered box in Production Worksheet G38:G39 (column G only).
       Re-parse counts (SWOT additions may have changed them). */
    {
      const _fm3 = stylesXml.match(/<fonts[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/fonts>/);
      const _flm3 = stylesXml.match(/<fills[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/fills>/);
      const _brm3 = stylesXml.match(/<borders[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/borders>/);
      const _xm3 = stylesXml.match(/<cellXfs[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/);

      if (_fm3 && _flm3 && _brm3 && _xm3) {
        let fi3 = parseInt(_fm3[1]);
        let fli3 = parseInt(_flm3[1]);
        let bri3 = parseInt(_brm3[1]);
        let xi3 = parseInt(_xm3[1]);

        /* 2 new fonts */
        const BA_FNT_TITLE = fi3;
        const BA_FNT_VALUE = fi3 + 1;
        const baFonts =
          '<font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="Candara"/></font>' +     /* title: bold 12pt white */
          '<font><b/><sz val="20"/><color rgb="FFFFFFFF"/><name val="Candara"/></font>';       /* value: bold 20pt white */
        stylesXml = stylesXml.replace(_fm3[0],
          `<fonts count="${fi3 + 2}">${_fm3[2]}${baFonts}</fonts>`);

        /* 2 new fills */
        const BA_FILL_HEADER = fli3;       /* dark navy header */
        const BA_FILL_BODY = fli3 + 1;     /* dark navy body */
        const baFills =
          '<fill><patternFill patternType="solid"><fgColor rgb="FF1A1A2E"/><bgColor indexed="64"/></patternFill></fill>' +
          '<fill><patternFill patternType="solid"><fgColor rgb="FF1A1A2E"/><bgColor indexed="64"/></patternFill></fill>';
        stylesXml = stylesXml.replace(_flm3[0],
          `<fills count="${fli3 + 2}">${_flm3[2]}${baFills}</fills>`);

        /* 2 new borders: top half and bottom half of the box */
        const BA_BDR_TOP = bri3;
        const BA_BDR_BOT = bri3 + 1;
        const bdrColor = 'FF1A1A2E';  /* dark navy */
        const baBorders =
          `<border><left style="thin"><color rgb="${bdrColor}"/></left><right style="thin"><color rgb="${bdrColor}"/></right><top style="thin"><color rgb="${bdrColor}"/></top><bottom style="thin"><color rgb="${bdrColor}"/></bottom><diagonal/></border>` +
          `<border><left style="thin"><color rgb="${bdrColor}"/></left><right style="thin"><color rgb="${bdrColor}"/></right><top style="thin"><color rgb="${bdrColor}"/></top><bottom style="thin"><color rgb="${bdrColor}"/></bottom><diagonal/></border>`;
        stylesXml = stylesXml.replace(_brm3[0],
          `<borders count="${bri3 + 2}">${_brm3[2]}${baBorders}</borders>`);

        /* 2 new cellXfs */
        const BA_XF_TITLE = xi3;
        const BA_XF_VALUE = xi3 + 1;
        const baXfs =
          `<xf numFmtId="0" fontId="${BA_FNT_TITLE}" fillId="${BA_FILL_HEADER}" borderId="${BA_BDR_TOP}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +
          `<xf numFmtId="0" fontId="${BA_FNT_VALUE}" fillId="${BA_FILL_BODY}" borderId="${BA_BDR_BOT}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>`;
        stylesXml = stylesXml.replace(_xm3[0],
          `<cellXfs count="${xi3 + 2}">${_xm3[2]}${baXfs}</cellXfs>`);

        _baStyles = { BA_XF_TITLE, BA_XF_VALUE };
        console.log('Pass 2: added BA box styles — fonts ' + fi3 + '-' + (fi3+1) + ', fills ' + fli3 + '-' + (fli3+1) + ', borders ' + bri3 + '-' + (bri3+1) + ', xfs ' + xi3 + '-' + (xi3+1));
      } else {
        console.warn('Pass 2: could not parse styles.xml for BA box additions');
      }
    }

    /* === Add Collections by Payor styles (dark navy + white text) === */
    {
      const _fm4 = stylesXml.match(/<fonts[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/fonts>/);
      const _flm4 = stylesXml.match(/<fills[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/fills>/);
      const _xm4 = stylesXml.match(/<cellXfs[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/);

      if (_fm4 && _flm4 && _xm4) {
        let fi4 = parseInt(_fm4[1]);
        let fli4 = parseInt(_flm4[1]);
        let xi4 = parseInt(_xm4[1]);

        /* 3 new fonts: white regular 14, white bold 14, white bold 20 (header) */
        const CL_FNT_REG = fi4;
        const CL_FNT_BOLD = fi4 + 1;
        const CL_FNT_HDR = fi4 + 2;
        const clFonts =
          '<font><sz val="14"/><color rgb="FFFFFFFF"/><name val="Candara"/></font>' +
          '<font><b/><sz val="14"/><color rgb="FFFFFFFF"/><name val="Candara"/></font>' +
          '<font><b/><sz val="20"/><color rgb="FFFFFFFF"/><name val="Candara"/></font>';
        stylesXml = stylesXml.replace(_fm4[0],
          `<fonts count="${fi4 + 3}">${_fm4[2]}${clFonts}</fonts>`);

        /* 1 new fill: dark navy */
        const CL_FILL = fli4;
        const clFills = '<fill><patternFill patternType="solid"><fgColor rgb="FF1A1A2E"/><bgColor indexed="64"/></patternFill></fill>';
        stylesXml = stylesXml.replace(_flm4[0],
          `<fills count="${fli4 + 1}">${_flm4[2]}${clFills}</fills>`);

        /* 5 new cellXfs */
        const CL_XF_HDR = xi4;       /* header row: bold 20pt white, dark navy, left-aligned */
        const CL_XF_LABEL = xi4 + 1; /* category label: regular white, dark navy, center */
        const CL_XF_DOLLAR = xi4 + 2; /* dollar amount: bold white, dark navy, $#,##0 */
        const CL_XF_PCT = xi4 + 3;   /* percentage: regular white, dark navy, 0% */
        const CL_XF_SPACER = xi4 + 4; /* spacer: dark navy fill, no text */
        const clXfs =
          `<xf numFmtId="0" fontId="${CL_FNT_HDR}" fillId="${CL_FILL}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>` +
          `<xf numFmtId="0" fontId="${CL_FNT_REG}" fillId="${CL_FILL}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
          `<xf numFmtId="166" fontId="${CL_FNT_BOLD}" fillId="${CL_FILL}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +
          `<xf numFmtId="9" fontId="${CL_FNT_REG}" fillId="${CL_FILL}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +
          `<xf numFmtId="0" fontId="${CL_FNT_REG}" fillId="${CL_FILL}" borderId="0" xfId="0" applyFont="1" applyFill="1"/>`;
        stylesXml = stylesXml.replace(_xm4[0],
          `<cellXfs count="${xi4 + 5}">${_xm4[2]}${clXfs}</cellXfs>`);

        _collStyles = { CL_XF_HDR, CL_XF_LABEL, CL_XF_DOLLAR, CL_XF_PCT, CL_XF_SPACER };
        console.log('Pass 2: added Collections styles — fonts ' + fi4 + '-' + (fi4+2) + ', fill ' + fli4 + ', xfs ' + xi4 + '-' + (xi4+4));
      } else {
        console.warn('Pass 2: could not parse styles.xml for Collections additions');
      }
    }

    fixZip.file('xl/styles.xml', stylesXml);
    _pass2StylesXml = stylesXml;  /* Save for fresh zip build — bypasses JSZip read bug */
    console.log('Pass 2: restored styles.xml:', stylesXml.length, 'chars');
  }

  /* === Normalize theme.xml default fonts to Candara === */
  /* ExcelJS generates theme.xml with Calibri as major/minor font.
     Cells without explicit applyFont inherit from the theme, so we must update it. */
  let _pass2ThemeXml = null;
  {
    const themeRaw = await pass1Zip.file('xl/theme/theme1.xml')?.async('string');
    if (themeRaw) {
      _pass2ThemeXml = themeRaw.replace(/typeface="[^"]*"/g, 'typeface="Candara"');
      fixZip.file('xl/theme/theme1.xml', _pass2ThemeXml);
      console.log('Pass 2: normalized theme.xml fonts to Candara');
    }
  }

  /* Restore template Content_Types and append additions for sheets 9-10 */
  let _pass2ContentTypes = null;
  if (_originalContentTypes) {
    let ct = _originalContentTypes;
    if (hasSheet9 && !ct.includes('sheet9.xml')) {
      ct = ct.replace(/<\/Types>/, '<Override PartName="/xl/worksheets/sheet9.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
    }
    if (hasSheet10 && !ct.includes('sheet10.xml')) {
      ct = ct.replace(/<\/Types>/, '<Override PartName="/xl/worksheets/sheet10.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
    }
    if (hasSheet11 && !ct.includes('sheet11.xml')) {
      ct = ct.replace(/<\/Types>/, '<Override PartName="/xl/worksheets/sheet11.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
    }
    if (hasSheet12 && !ct.includes('sheet12.xml')) {
      ct = ct.replace(/<\/Types>/, '<Override PartName="/xl/worksheets/sheet12.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
    }
    if (!ct.includes('Extension="jpeg"') && !ct.includes('Extension="jpg"')) {
      ct = ct.replace(/<\/Types>/, '<Default Extension="jpeg" ContentType="image/jpeg"/></Types>');
    }
    if (!ct.includes('Extension="png"')) {
      ct = ct.replace(/<\/Types>/, '<Default Extension="png" ContentType="image/png"/></Types>');
    }
    /* Check for drawing overrides */
    for (const filePath of Object.keys(fixZip.files)) {
      if (filePath.match(/^xl\/drawings\/drawing\d+\.xml$/) && !ct.includes(filePath)) {
        ct = ct.replace(/<\/Types>/, `<Override PartName="/${filePath}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
      }
    }
    fixZip.file('[Content_Types].xml', ct);
    _pass2ContentTypes = ct;  /* Save for fresh zip build — bypasses JSZip read bug */
    console.log('Pass 2: restored Content_Types');
  }

  /* ═══ PASS 2 sheet-level fixes: column widths, IFERROR ═══ */
  /* These must happen in Pass 2 because ExcelJS contamination rewrites sheet XML
     during Pass 1, changing style="383" to style="1" and potentially resetting column widths. */
  const sheetFixes = {
    'xl/worksheets/sheet1.xml': (xml) => {
      /* Production Worksheet: fix cells with General number format.
         Template formula cells have fmt=General → show raw decimals.
         Bulk-fix by column: E=integer, G=dollar, N=dollar.
         Use robust regex that handles s= before or after r= in attributes. */
      function swapStyle(xml, ref, newStyle) {
        /* Try s= after r= */
        let result = xml.replace(
          new RegExp(`(<c\\s[^>]*?r="${ref}"[^>]*?)\\ss="\\d+"`, 's'),
          `$1 s="${newStyle}"`
        );
        if (result !== xml) return result;
        /* Try s= before r= */
        return xml.replace(
          new RegExp(`(<c\\s[^>]*?)s="\\d+"([^>]*?r="${ref}")`, 's'),
          `$1s="${newStyle}"$2`
        );
      }
      /* E column: per-month quantities → integer format s="419" */
      const eRows = [10,11,12,13,16,17,18,21,22,23,24,25,26,27,30,31,32,33,34,35,36,39,40,41,42,43,44];
      eRows.forEach(r => { xml = swapStyle(xml, 'E'+r, '419'); });
      /* G column: total dollars → dollar format s="427" */
      const gRows = [5,6,20,21,22,23,24,25,26,27,28,30,31,32,33,34,35,36];
      gRows.forEach(r => { xml = swapStyle(xml, 'G'+r, '427'); });
      /* N column: avg fee → dollar format s="428" */
      const nRows = [3,5,7,8,9,12,14,18,21,24,26,28,31,33,35,39,40,43,44,45,47,50,51,52,53,55,56,57,58,60,61,68];
      nRows.forEach(r => { xml = swapStyle(xml, 'N'+r, '428'); });
      console.log('Pass 2 sheet1: fixed ' + eRows.length + ' E-cells, ' + gRows.length + ' G-cells, ' + nRows.length + ' N-cells');

      /* ── Batting Average box: column G only (G39 title, G40 value) ── */
      /* Template has merged F38:G38 .. F41:G41.  We remove those merges
         so the box lives in column G alone (width ≈23 → more square).       */

      /* 1. Remove F:G merges for rows 38-41 */
      xml = xml.replace(/<mergeCell ref="F38:G38"\/>/g, '');
      xml = xml.replace(/<mergeCell ref="F39:G39"\/>/g, '');
      xml = xml.replace(/<mergeCell ref="F40:G40"\/>/g, '');
      xml = xml.replace(/<mergeCell ref="F41:G41"\/>/g, '');

      /* 2. Helper to replace or insert a cell */
      function baReplace(xml, ref, style, text) {
        const re = new RegExp(`<c\\s[^>]*r="${ref}"[^/>]*(?:/>|>[\\s\\S]*?</c>)`, 's');
        const replacement = text
          ? `<c r="${ref}" s="${style}" t="inlineStr"><is><t>${text}</t></is></c>`
          : `<c r="${ref}" s="${style}"/>`;
        if (re.test(xml)) {
          xml = xml.replace(re, replacement);
        }
        return xml;
      }

      /* 3. Insert styled cells into G39 and G40 (moved down 1 row from G38/G39).
            G39/G40 don't exist as separate <c> elements (hidden by merge),
            so we insert them after the F39/F40 cells. */
      const baTitle = _baStyles ? String(_baStyles.BA_XF_TITLE) : '402';
      const baValue = _baStyles ? String(_baStyles.BA_XF_VALUE) : '411';

      /* Strip old F39/F40 BA styles (reset to template default empty) */
      xml = baReplace(xml, 'F39', '52', null);
      xml = baReplace(xml, 'F40', '52', null);

      /* Insert G39 after F39 cell */
      xml = xml.replace(
        /(<c r="F39"[^/>]*(?:\/>|>[\s\S]*?<\/c>))/s,
        `$1<c r="G39" s="${baTitle}" t="inlineStr"><is><t>BATTING AVERAGE</t></is></c>`
      );
      /* Insert G40 after F40 cell */
      xml = xml.replace(
        /(<c r="F40"[^/>]*(?:\/>|>[\s\S]*?<\/c>))/s,
        `$1<c r="G40" s="${baValue}" t="inlineStr"><is><t>${_battingAvgText}</t></is></c>`
      );

      /* 4. Set row heights so the box is more square and text isn't clipped */
      xml = xml.replace(/<row\s([^>]*r="39"[^>]*)>/, (m, attrs) => {
        attrs = attrs.replace(/\bht="[^"]*"/, '').replace(/\bcustomHeight="[^"]*"/, '');
        return `<row ${attrs.trim()} ht="25" customHeight="1">`;
      });
      xml = xml.replace(/<row\s([^>]*r="40"[^>]*)>/, (m, attrs) => {
        attrs = attrs.replace(/\bht="[^"]*"/, '').replace(/\bcustomHeight="[^"]*"/, '');
        return `<row ${attrs.trim()} ht="40" customHeight="1">`;
      });

      console.log('Pass 2 sheet1: injected BA box in G39:G40 (' + _battingAvgText + ') styles: title=' + baTitle + ' value=' + baValue);

      /* ── Row 28: Un-merge HYGIENE SUMMARY (B28:G28 → B28:C28) and add G28 total ── */
      /* Remove the wide B28:G28 merge so G28 can hold the hygiene total */
      xml = xml.replace(/<mergeCell ref="B28:G28"\/>/g, '');
      /* Add a narrower merge B28:F28 so the label stays visible but G28 is free */
      const mc28Match = xml.match(/<mergeCells[^>]*count="(\d+)"/);
      if (mc28Match) {
        /* Insert new B28:F28 merge and update count */
        xml = xml.replace(/<\/mergeCells>/, '<mergeCell ref="B28:F28"/></mergeCells>');
        /* We removed one merge (B28:G28) and added one (B28:F28) so count stays same */
      }
      /* Insert G28 cell with the hygiene total value using currency style.
         Find the row 28 element and add G28 after the last cell in it. */
      const hygTotalVal = (_cellCollector['Production Worksheet'] || {})['G28'];
      if (hygTotalVal !== undefined) {
        /* Try to insert G28 into row 28 — find the last cell in row 28 and add after it */
        if (xml.match(/<row\s[^>]*r="28"[^>]*>/)) {
          /* Row 28 exists — insert G28 before </row> for row 28 */
          xml = xml.replace(
            /(<row\s[^>]*r="28"[^>]*>[\s\S]*?)(<\/row>)/,
            `$1<c r="G28" s="411" t="n"><v>${hygTotalVal}</v></c>$2`
          );
          console.log('Pass 2 sheet1: added G28 hygiene total = ' + hygTotalVal);
        }
      }

      return xml;
    },
    'xl/worksheets/sheet4.xml': (xml) => {
      /* Financial Overview: widen columns for AR dollar amounts */
      xml = xml.replace(/<cols>[\s\S]*?<\/cols>/, `<cols>
<col min="1" max="1" width="1.66" customWidth="1" style="383"/>
<col min="2" max="2" width="16" customWidth="1" style="383"/>
<col min="3" max="3" width="14" customWidth="1" style="383"/>
<col min="4" max="4" width="15" customWidth="1" style="383"/>
<col min="5" max="5" width="15" customWidth="1" style="383"/>
<col min="6" max="6" width="14" customWidth="1" style="383"/>
<col min="7" max="7" width="14" customWidth="1" style="383"/>
<col min="8" max="8" width="14" customWidth="1" style="383"/>
<col min="9" max="9" width="26.5" customWidth="1" style="383"/>
<col min="10" max="10" width="1.66" customWidth="1" style="383"/>
<col min="11" max="25" width="10.83" customWidth="1" style="383"/>
</cols>`);

      /* Hide monthly rows 8-19 (no per-month data available from Dentrix reports).
         Set hidden="1" and ht="0" so they collapse. */
      /* Comprehensive row height map for Financial Overview.
         Template default is 12.75 which is too tight. Set every row explicitly. */
      const foRowHeights = {
        /* 8-19: hidden monthly rows */
        8:0, 9:0, 10:0, 11:0, 12:0, 13:0, 14:0, 15:0, 16:0, 17:0, 18:0, 19:0,
        /* Section 1: Historical Production */
        5:28, 6:20, 7:20,
        20:22, 21:20, 22:22,
        /* Spacer */
        23:20,
        /* Section 2: P&L Collection comparison */
        24:24, 25:20, 26:20, 27:22, 28:20,
        /* Spacer */
        29:20,
        /* Section 3: Accounts Receivable */
        30:24, 31:20, 32:20, 33:20, 34:22,
        35:12,
        36:20, 37:20, 38:20,
        /* Spacer */
        39:24,
        /* Section 4: Collections by Payment Type */
        40:24, 41:10, 42:20, 43:20, 44:26, 45:22
      };
      function stripHt(a) {
        return a.replace(/\s*customHeight="[^"]*"/g, '').replace(/\s*hidden="[^"]*"/g, '').replace(/\s+ht="[^"]*"/g, '');
      }
      xml = xml.replace(/<row\s+r="(\d+)"([^>]*)>/g, (full, rNum, attrs) => {
        const r = parseInt(rNum);
        const ht = foRowHeights[r];
        if (ht === undefined) return full;
        if (ht === 0) {
          return `<row r="${rNum}"${stripHt(attrs)} ht="0" hidden="1" customHeight="1">`;
        }
        return `<row r="${rNum}"${stripHt(attrs)} ht="${ht}" customHeight="1">`;
      });

      /* IFERROR on row 45 */
      ['B','C','D','E','F','G','H'].forEach(c => {
        xml = xml.replace(new RegExp(`<f>${c}44/I44</f>`), `<f>IFERROR(${c}44/I44,0)</f>`);
      });

      /* Collections header (B40) and spacer row (41) — apply dark navy style */
      if (_collStyles) {
        /* B40: replace style with dark navy header */
        xml = xml.replace(/(<c\s[^>]*r="B40"\s[^>]*?)s="\d+"/, `$1s="${_collStyles.CL_XF_HDR}"`);
        /* Row 41 spacer cells: apply dark navy spacer style */
        xml = xml.replace(/(<c\s[^>]*r="[B-I]41"\s[^>]*?)s="\d+"/g, `$1s="${_collStyles.CL_XF_SPACER}"`);
      }

      /* Fix AR patient row 32: cells E32-H32 have FFF1F5F9 fill + bold that doesn't
         match insurance row 33. Copy the style from row 33 cells to row 32 cells. */
      /* Find the style index used by E33 (insurance row) and apply to E32-H32 */
      const row33StyleMatch = xml.match(/<c\s[^>]*r="E33"[^>]*s="(\d+)"/);
      if (row33StyleMatch) {
        const insurStyle = row33StyleMatch[1];
        ['E32','F32','G32','H32'].forEach(cellRef => {
          xml = xml.replace(
            new RegExp(`(<c\\s[^>]*r="${cellRef}"[^>]*?)s="\\d+"`),
            `$1s="${insurStyle}"`
          );
        });
        console.log('Pass 2 sheet4: AR patient row 32 style normalized to match row 33 (s=' + insurStyle + ')');
      }

      console.log('Pass 2 sheet4: cols fixed, monthly rows hidden, spacing improved, collections restyled');
      return xml;
    },
    'xl/worksheets/sheet5.xml': (xml) => {
      /* Targets & Goal: increase row heights so every row is clearly readable.
         Template default is 12.75 which is too tight. Set every content row explicitly. */
      const tgRowHeights = {
        1: 8,       /* top margin */
        2: 48,      /* main title */
        3: 20,      /* subtitle / description */
        4: 18, 5: 18, 6: 18, 7: 18, 8: 18, 9: 18, 10: 18,
        11: 18, 12: 18, 13: 18, 14: 18, 15: 18, 16: 18, 17: 18, 18: 18,
        19: 34,     /* section divider (was 30) */
        20: 18, 21: 18, 22: 18, 23: 18, 24: 18, 25: 18, 26: 18,
        27: 18, 28: 18, 29: 18, 30: 18, 31: 18, 32: 18,
        33: 76,     /* large section header (was 73.5) */
        34: 18, 35: 18, 36: 18, 37: 18, 38: 18, 39: 18, 40: 18,
        41: 18, 42: 18, 43: 18, 44: 18, 45: 18
      };
      function stripHtTG(a) {
        return a.replace(/\s*customHeight="[^"]*"/g, '').replace(/\s*hidden="[^"]*"/g, '').replace(/\s+ht="[^"]*"/g, '');
      }
      xml = xml.replace(/<row\s+r="(\d+)"([^>]*)>/g, (full, rNum, attrs) => {
        const r = parseInt(rNum);
        const ht = tgRowHeights[r];
        if (ht === undefined) return full;
        return `<row r="${rNum}"${stripHtTG(attrs)} ht="${ht}" customHeight="1">`;
      });
      console.log('Pass 2 sheet5: Targets & Goal row heights set for all content rows');
      return xml;
    },
    'xl/worksheets/sheet7.xml': (xml) => {
      /* Budgetary P&L: wrap division formulas in IFERROR, widen cols */
      xml = xml.replace(/<f>([^<]*?\/[^<]*?)<\/f>/g, (full, formula) => {
        if (formula.startsWith('IFERROR')) return full;
        if (/\/[A-Z$]+\d+/.test(formula) || /\/\d/.test(formula)) {
          return `<f>IFERROR(${formula},0)</f>`;
        }
        return full;
      });
      xml = xml.replace(/<cols>[\s\S]*?<\/cols>/, `<cols>
<col min="1" max="1" width="1.17" customWidth="1" style="383"/>
<col min="2" max="2" width="19.66" customWidth="1" style="383"/>
<col min="3" max="3" width="8" customWidth="1" style="383"/>
<col min="4" max="4" width="13" customWidth="1" style="383"/>
<col min="5" max="5" width="1.66" customWidth="1" style="383"/>
<col min="6" max="6" width="8" customWidth="1" style="383"/>
<col min="7" max="7" width="13" customWidth="1" style="383"/>
<col min="8" max="8" width="1.66" customWidth="1" style="383"/>
<col min="9" max="9" width="8" customWidth="1" style="383"/>
<col min="10" max="10" width="13" customWidth="1" style="383"/>
<col min="11" max="11" width="1.17" customWidth="1" style="383"/>
</cols>`);
      return xml;
    },
    'xl/worksheets/sheet8.xml': (xml) => {
      /* P&L Input: comprehensive fix for spacing — cell styles, column widths, row heights */

      /* 1. Fix column widths — replace entire <cols> section so column A is wide enough
            for expense names and data columns are sized for dollar amounts.
            Col A=40 (text, style=2), data cols=14-16 (dollar amounts, style=316) */
      xml = xml.replace(/<cols>[\s\S]*?<\/cols>/,
        `<cols>
<col min="1" max="1" width="40" customWidth="1" style="2"/>
<col min="2" max="5" width="14" customWidth="1" style="316"/>
<col min="6" max="6" width="16" customWidth="1" style="316"/>
<col min="7" max="7" width="18" customWidth="1" style="316"/>
<col min="8" max="8" width="18" customWidth="1" style="316"/>
<col min="9" max="10" width="14" customWidth="1" style="316"/>
<col min="11" max="11" width="16" customWidth="1" style="316"/>
<col min="12" max="15" width="14" customWidth="1" style="316"/>
<col min="16" max="17" width="18" customWidth="1" style="316"/>
</cols>`);

      /* 2. Fix cell styles — force clean styles on ALL data cells rows 6-47.
            s="2" for col A (Candara 10pt, no bold, text), s="316" for cols B+ ($#,##0 dollar format).
            These are fontId=4 (Candara 10pt non-bold), no wrapText, no fill, no border. */
      xml = xml.replace(/<c\s([^>]*?)r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
        (full, pre, col, rowNum, post, inner) => {
          const r = parseInt(rowNum);
          if (r >= 6 && r <= 47) {
            const correctStyle = (col === 'A') ? '2' : '316';
            const styleMatch = full.match(/\ss="(\d+)"/);
            if (!styleMatch) {
              return full.replace(`r="${col}${rowNum}"`, `r="${col}${rowNum}" s="${correctStyle}"`);
            } else {
              return full.replace(/\ss="\d+"/, ` s="${correctStyle}"`);
            }
          }
          return full;
        });

      /* 3. Fix row heights — set explicit heights for header and data rows.
            Hide empty rows between last data row and summary row 48. */
      const lastDataRow = _plInputLastDataRow;
      xml = xml.replace(/<row\s+r="(\d+)"([^>]*)>/g, (full, rNum, attrs) => {
        const r = parseInt(rNum);
        if (r === 5) {
          /* Row 5 is the column header row — needs to be tall enough to show full labels */
          let a = attrs.replace(/\s*customHeight="[^"]*"/g, '').replace(/\s+ht="[^"]*"/g, '').replace(/\s*hidden="[^"]*"/g, '');
          return `<row r="${rNum}"${a} ht="30" customHeight="1">`;
        }
        if (r >= 6 && r <= lastDataRow) {
          /* Visible data rows */
          let a = attrs.replace(/\s*customHeight="[^"]*"/g, '').replace(/\s+ht="[^"]*"/g, '').replace(/\s*hidden="[^"]*"/g, '');
          return `<row r="${rNum}"${a} ht="20" customHeight="1">`;
        }
        if (r > lastDataRow && r <= 47) {
          /* Empty rows after last expense — hide them */
          let a = attrs.replace(/\s*customHeight="[^"]*"/g, '').replace(/\s+ht="[^"]*"/g, '').replace(/\s*hidden="[^"]*"/g, '');
          return `<row r="${rNum}"${a} ht="0" hidden="1" customHeight="1">`;
        }
        if (r >= 48 && r <= 51) {
          /* Summary/formula rows — keep visible */
          let a = attrs.replace(/\s*customHeight="[^"]*"/g, '').replace(/\s+ht="[^"]*"/g, '').replace(/\s*hidden="[^"]*"/g, '');
          return `<row r="${rNum}"${a} ht="20" customHeight="1">`;
        }
        return full;
      });

      console.log('Pass 2 sheet8: fixed cols, cell styles, row heights; hiding rows ' + (lastDataRow+1) + '-47');
      return xml;
    },
    'xl/worksheets/sheet3.xml': (xml) => {
      /* Hygiene Schedule: fix cramped row heights and #DIV/0! errors */

      /* 1. Increase row heights — template default is 12.75 which is too tight */
      const hsRowHeights = {
        1:8, 2:44, 3:7, 4:30,
        /* Data section rows 5-16: bump from 12.75 to 20 */
        5:20, 6:20, 7:20, 8:18, 9:20, 10:20, 11:20, 12:20, 13:20,
        14:20, 15:20, 16:20, 17:8,
        /* Next 7 days */
        18:22, 19:20, 20:20, 21:20, 22:6,
        /* Near future */
        23:20, 24:20, 25:20, 26:20, 27:20, 28:20, 29:20, 30:20, 31:6,
        /* Future future */
        32:20, 33:20, 34:20, 35:20, 36:22,
        /* Potential section */
        37:24, 38:20, 39:20, 40:20, 41:20, 42:20, 43:20, 44:20,
        45:20, 46:20, 47:20, 48:20, 49:20, 50:20, 51:20, 52:20, 53:20,
        54:8, 55:25
      };
      xml = xml.replace(/<row\s+r="(\d+)"([^>]*)>/g, (full, rNum, attrs) => {
        const r = parseInt(rNum);
        const ht = hsRowHeights[r];
        if (ht === undefined) return full;
        let a = attrs.replace(/\s*customHeight="[^"]*"/g, '').replace(/\s+ht="[^"]*"/g, '').replace(/\s*hidden="[^"]*"/g, '');
        return `<row r="${rNum}"${a} ht="${ht}" customHeight="1">`;
      });

      /* 2. Wrap division formulas with IFERROR to prevent #DIV/0! */
      /* N15: =K15/F15 → =IFERROR(K15/F15,"") */
      xml = xml.replace(/<f>K15\/F15<\/f>/g, '<f>IFERROR(K15/F15,"")</f>');
      /* N21: =K21/F21 */
      xml = xml.replace(/<f>K21\/F21<\/f>/g, '<f>IFERROR(K21/F21,"")</f>');
      /* N30: =K30/F30 */
      xml = xml.replace(/<f>K30\/F30<\/f>/g, '<f>IFERROR(K30/F30,"")</f>');
      /* O34: division of sums */
      xml = xml.replace(/<f>\(D34\+F34\+H34\+J34\+L34\+N34\)\/\(C34\+E34\+G34\+I34\+K34\+M34\)<\/f>/g,
        '<f>IFERROR((D34+F34+H34+J34+L34+N34)/(C34+E34+G34+I34+K34+M34),"")</f>');
      /* O35: division of sums */
      xml = xml.replace(/<f>\(D35\+F35\+H35\+J35\+L35\+N35\)\/\(C35\+E35\+G35\+I35\+K35\+M35\)<\/f>/g,
        '<f>IFERROR((D35+F35+H35+J35+L35+N35)/(C35+E35+G35+I35+K35+M35),"")</f>');

      /* N15: =K15/F15 may also appear as IFERROR already, handle alternate form */
      xml = xml.replace(/<f>K15\/F16<\/f>/g, '<f>IFERROR(K15/F16,"")</f>');

      console.log('Pass 2 sheet3: fixed Hygiene Schedule row heights and IFERROR wrappers');
      return xml;
    },
    'xl/worksheets/sheet6.xml': (xml) => {
      /* Employee Costs: clear template placeholder names and text */
      function clearCell(xml, ref, style) {
        const re = new RegExp(`<c\\s[^>]*r="${ref}"[^/>]*(?:/>|>[\\s\\S]*?</c>)`, 's');
        const replacement = `<c r="${ref}" s="${style}"/>`;
        return re.test(xml) ? xml.replace(re, replacement) : xml;
      }
      /* Only clear D27/D28 if Pass 1 didn't write hygienist names there */
      const ecCollector = _cellCollector['Employee Costs'] || {};
      if (!ecCollector['D27']) xml = clearCell(xml, 'D27', '639');  /* Jodi Kalik → blank */
      if (!ecCollector['D28']) xml = clearCell(xml, 'D28', '639');  /* Liesa Mcghee → blank */
      xml = clearCell(xml, 'D35', '659');  /* As CA law → blank */

      console.log('Pass 2 sheet6: cleared template placeholders (D27 skipped=' + !!ecCollector['D27'] + ', D28 skipped=' + !!ecCollector['D28'] + ')');
      return xml;
    }
  };

  /* CRITICAL: Read sheet XML from pass1Zip (NOT fixZip) — pass1Zip was loaded from a buffer
     so .file().async() reads work correctly. Store results in _pass2SheetFixes for fresh zip. */
  const _pass2SheetFixes = {};
  for (const [path, fixFn] of Object.entries(sheetFixes)) {
    let xml = await pass1Zip.file(path)?.async('string');
    if (xml) {
      xml = fixFn(xml);
      _pass2SheetFixes[path] = xml;  /* Save for fresh zip build */
      fixZip.file(path, xml);
      console.log('Pass 2: applied fixes to', path);
    }
  }

  /* === Generate SWOT sheet XML directly (bypasses ExcelJS style contamination) === */
  if (swotData && _swotStyles) {
    let swotRows = '';
    let sr = 1;

    /* Title row */
    swotRows += `<row r="${sr}" ht="40" customHeight="1"><c r="B${sr}" s="${_swotStyles.SX_TITLE}" t="inlineStr"><is><t>${escapeXml('SWOT Analysis \u2014 ' + (practiceName || 'Practice'))}</t></is></c></row>`;
    sr++;
    swotRows += `<row r="${sr}" ht="12" customHeight="1"/>`;
    sr++;

    const swotSections = [
      { title: 'STRENGTHS',     items: swotData.strengths || [],     xf: _swotStyles.SX_S },
      { title: 'WEAKNESSES',    items: swotData.weaknesses || [],    xf: _swotStyles.SX_W },
      { title: 'OPPORTUNITIES', items: swotData.opportunities || [], xf: _swotStyles.SX_O },
      { title: 'THREATS',       items: swotData.threats || [],       xf: _swotStyles.SX_T }
    ];

    for (const sec of swotSections) {
      /* Section header */
      swotRows += `<row r="${sr}" ht="30" customHeight="1"><c r="B${sr}" s="${sec.xf}" t="inlineStr"><is><t>${escapeXml(sec.title)}</t></is></c></row>`;
      sr++;
      /* Bullet items */
      for (const item of sec.items) {
        swotRows += `<row r="${sr}" ht="28" customHeight="1"><c r="B${sr}" s="${_swotStyles.SX_BUL}" t="inlineStr"><is><t>${escapeXml('\u2022  ' + item)}</t></is></c></row>`;
        sr++;
      }
      /* Spacer */
      swotRows += `<row r="${sr}" ht="16" customHeight="1"/>`;
      sr++;
    }

    /* Footer */
    sr++;
    const _dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    swotRows += `<row r="${sr}"><c r="B${sr}" s="${_swotStyles.SX_FOOT}" t="inlineStr"><is><t>${escapeXml('Generated by Perform DDS Assessment System \u2014 ' + _dateStr)}</t></is></c></row>`;

    const swotSheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      '<cols><col min="1" max="1" width="3" customWidth="1"/><col min="2" max="2" width="90" customWidth="1"/></cols>' +
      '<sheetData>' + swotRows + '</sheetData>' +
      '</worksheet>';

    /* SWOT sheet number depends on how many ExcelJS sheets precede it */
    const swotSheetNum = _swotTargetSheetNum || 11;
    _pass2SheetFixes['xl/worksheets/sheet' + swotSheetNum + '.xml'] = swotSheetXml;
    console.log('Pass 2: generated SWOT XML directly for sheet' + swotSheetNum + ' (' + swotSheetXml.length + ' chars, ' + sr + ' rows, styles: ' + JSON.stringify(_swotStyles) + ')');
  }

  /* === Generate Practice Profile sheet XML directly (bypasses ExcelJS style contamination) === */
  if (practiceProfile && _ppStyles) {
    const pp = practiceProfile;
    let ppRows = '';
    let pr = 1;
    const PS = _ppStyles;

    /* Helper: generate a cell element */
    const ppCell = (col, row, style, text) =>
      `<c r="${col}${row}" s="${style}" t="inlineStr"><is><t>${escapeXml(text || '')}</t></is></c>`;
    const ppCellEmpty = (col, row, style) =>
      `<c r="${col}${row}" s="${style}"/>`;

    /* Helper: full-width banner row (B-E cells with same style) */
    const bannerRow = (row, style, text, height) => {
      let r = `<row r="${row}" ht="${height}" customHeight="1">`;
      r += ppCellEmpty('A', row, style);
      r += ppCell('B', row, style, text);
      r += ppCellEmpty('C', row, style);
      r += ppCellEmpty('D', row, style);
      r += ppCellEmpty('E', row, style);
      r += ppCellEmpty('F', row, style);
      r += `</row>`;
      return r;
    };

    /* Helper: section header row */
    const sectRow = (row, text) => {
      let r = `<row r="${row}" ht="28" customHeight="1">`;
      for (const c of ['A','B','C','D','E','F']) r += (c === 'B') ? ppCell(c, row, PS.PX_SECT, text) : ppCellEmpty(c, row, PS.PX_SECT);
      r += '</row>';
      return r;
    };

    /* Helper: data row with label/value pairs */
    let _ppParity = 0;
    const dataRowXml = (row, lbl1, val1, lbl2, val2) => {
      const sl = (_ppParity % 2 === 0) ? PS.PX_LBL : PS.PX_LBL_S;
      const sv = (_ppParity % 2 === 0) ? PS.PX_VAL : PS.PX_VAL_S;
      let r = `<row r="${row}" ht="24" customHeight="1">`;
      r += ppCellEmpty('A', row, sl);
      r += ppCell('B', row, sl, lbl1);
      r += ppCell('C', row, sv, val1 || '\u2014');
      r += (lbl2) ? ppCell('D', row, sl, lbl2) : ppCellEmpty('D', row, sl);
      r += (val2) ? ppCell('E', row, sv, val2 || '\u2014') : ppCellEmpty('E', row, sv);
      r += ppCellEmpty('F', row, sl);
      r += '</row>';
      _ppParity++;
      return r;
    };

    /* Row 1: Title banner */
    ppRows += bannerRow(pr, PS.PX_BANNER, pp.website || practiceName || 'Practice Assessment', 44);
    pr++;
    /* Row 2: Subtitle */
    ppRows += bannerRow(pr, PS.PX_SUB, 'Practice Profile  |  Dental AI Toolkit Assessment', 20);
    pr++;
    /* Row 3: spacer */
    ppRows += `<row r="${pr}" ht="8" customHeight="1"/>`;
    pr++;

    /* ═══ PRACTICE BASICS ═══ */
    ppRows += sectRow(pr, 'PRACTICE BASICS'); pr++;
    _ppParity = 0;
    const softwareNames = { dentrix: 'Dentrix', eaglesoft: 'Eaglesoft', opendental: 'Open Dental', other: 'Other' };
    ppRows += dataRowXml(pr, 'Zip Code', pp.zipCode || '\u2014', 'Practice Website', pp.website || '\u2014'); pr++;
    ppRows += dataRowXml(pr, 'Years Owned', pp.yearsOwned ? pp.yearsOwned + ' years' : '\u2014', 'Owner Age', pp.ownerAge ? pp.ownerAge + ' years old' : '\u2014'); pr++;
    ppRows += dataRowXml(pr, 'Practice Management Software', softwareNames[pp.pmSoftware] || pp.pmSoftware || '\u2014', null, null); pr++;
    pr++; /* spacer */

    /* ═══ PAYOR MIX ═══ */
    ppRows += sectRow(pr, 'PAYOR MIX'); pr++;
    _ppParity = 0;
    const mix = pp.payorMix || {};
    ppRows += dataRowXml(pr, 'In-Network PPO', (mix.ppo || 0) + '%', 'HMO', (mix.hmo || 0) + '%'); pr++;
    ppRows += dataRowXml(pr, 'Medicaid / Government', (mix.gov || 0) + '%', 'Fee-for-Service / OON', (mix.ffs || 0) + '%'); pr++;
    pr++;

    /* ═══ SCHEDULE & TEAM ═══ */
    ppRows += sectRow(pr, 'SCHEDULE & TEAM'); pr++;
    _ppParity = 0;
    ppRows += dataRowXml(pr, 'Doctor Days per Month', pp.doctorDays ? pp.doctorDays + ' days' : '\u2014', 'Hygiene Days per Week', pp.numHygienists ? pp.numHygienists + ' days' : '\u2014'); pr++;
    const assocText = pp.hasAssociate ? ('Yes  \u2014  ' + (pp.associateDays || 0) + ' days per month') : 'No';
    ppRows += dataRowXml(pr, 'Has Associate Doctor', assocText, 'Operatories Active', (pp.opsActive || '\u2014') + ' of ' + (pp.opsTotal || '\u2014') + ' total'); pr++;
    pr++;

    /* ═══ DAILY PRODUCTION & BENCHMARKS ═══ */
    ppRows += sectRow(pr, 'DAILY PRODUCTION & BENCHMARKS'); pr++;
    _ppParity = 0;
    const docAvg = pp.docDailyAvg === 'idk' ? "Doesn't know" : (pp.docDailyAvg ? '$' + Number(pp.docDailyAvg).toLocaleString() + ' / day' : '\u2014');
    const hygAvg = pp.hygDailyAvg === 'idk' ? "Doesn't know" : (pp.hygDailyAvg ? '$' + Number(pp.hygDailyAvg).toLocaleString() + ' / day' : '\u2014');
    ppRows += dataRowXml(pr, 'Doctor Daily Average', docAvg, 'Hygiene Daily Average', hygAvg); pr++;
    const crowns = pp.crownsPerMonth === 'idk' ? "Doesn't know" : (pp.crownsPerMonth || '\u2014');
    ppRows += dataRowXml(pr, 'Crowns per Month', crowns, null, null); pr++;
    const goalMap = { yes: 'Yes', no: 'No', sort_of: 'Sort of' };
    const aheadMap = { yes: 'Yes', no: 'No', sometimes: 'Sometimes' };
    ppRows += dataRowXml(pr, 'Has Daily Production Goal', goalMap[pp.hasProductionGoal] || '\u2014', 'Tracks If Ahead/Behind', aheadMap[pp.knowsIfAhead] || '\u2014'); pr++;
    pr++;

    /* ═══ GOALS & VISION ═══ */
    ppRows += sectRow(pr, 'GOALS & VISION'); pr++;
    _ppParity = 0;
    const yearsMap = { '1-5': '1 \u2013 5 years', '5-10': '5 \u2013 10 years', '10-15': '10 \u2013 15 years', 'not-on-radar': 'Not on my radar' };
    ppRows += dataRowXml(pr, 'Years to Continue Practicing', yearsMap[pp.yearsToWork] || pp.yearsToWork || '\u2014', null, null); pr++;
    pr++;

    /* ═══ TOP CONCERNS ═══ */
    const concerns = pp.concerns || [];
    if (concerns.length > 0) {
      ppRows += sectRow(pr, 'TOP CONCERNS'); pr++;
      const concernLabels = {
        more_profitable: 'Want to be more profitable',
        more_busy: 'Want to be busier',
        pay_staff_more: 'Want to pay staff more',
        owner_bonus: 'Want to take home more',
        more_control: 'Want more control over the practice',
        staff_issues: 'Staff issues',
        overhead_high: 'Overhead is too high',
        insurance_rates: 'Insurance reimbursements too low',
        new_patients: 'Need more new patients',
        exit_plan: 'Considering selling or retiring'
      };
      for (let ci = 0; ci < concerns.length; ci += 2) {
        const leftText = '\u2713  ' + (concernLabels[concerns[ci]] || concerns[ci]);
        const rightText = (ci + 1 < concerns.length) ? '\u2713  ' + (concernLabels[concerns[ci + 1]] || concerns[ci + 1]) : null;
        let r = `<row r="${pr}" ht="24" customHeight="1">`;
        r += ppCellEmpty('A', pr, PS.PX_CHECK);
        r += ppCell('B', pr, PS.PX_CHECK, leftText);
        r += ppCellEmpty('C', pr, PS.PX_CHECK);
        r += rightText ? ppCell('D', pr, PS.PX_CHECK, rightText) : ppCellEmpty('D', pr, PS.PX_CHECK);
        r += ppCellEmpty('E', pr, PS.PX_CHECK);
        r += ppCellEmpty('F', pr, PS.PX_CHECK);
        r += '</row>';
        ppRows += r;
        pr++;
      }
      pr++;
    }

    /* ═══ ADDITIONAL NOTES ═══ */
    if (pp.biggestChallenge) {
      ppRows += sectRow(pr, 'ADDITIONAL NOTES'); pr++;
      let r = `<row r="${pr}" ht="50" customHeight="1">`;
      r += ppCellEmpty('A', pr, PS.PX_NOTE);
      r += ppCell('B', pr, PS.PX_NOTE, pp.biggestChallenge);
      r += ppCellEmpty('C', pr, PS.PX_NOTE);
      r += ppCellEmpty('D', pr, PS.PX_NOTE);
      r += ppCellEmpty('E', pr, PS.PX_NOTE);
      r += ppCellEmpty('F', pr, PS.PX_NOTE);
      r += '</row>';
      ppRows += r;
      pr++;
    }

    /* ═══ Footer ═══ */
    pr++;
    const _ppDateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    ppRows += `<row r="${pr}"><c r="B${pr}" s="${PS.PX_FOOT}" t="inlineStr"><is><t>${escapeXml('Generated by Dental AI Toolkit  \u2022  ' + _ppDateStr)}</t></is></c></row>`;

    /* Merge cells for banner (B1:E1, B2:E2) and notes */
    let ppMerges = '<mergeCells count="2"><mergeCell ref="B1:E1"/><mergeCell ref="B2:E2"/></mergeCells>';

    const ppSheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      '<cols><col min="1" max="1" width="3" customWidth="1"/><col min="2" max="2" width="34" customWidth="1"/><col min="3" max="3" width="30" customWidth="1"/><col min="4" max="4" width="34" customWidth="1"/><col min="5" max="5" width="30" customWidth="1"/><col min="6" max="6" width="3" customWidth="1"/></cols>' +
      '<sheetData>' + ppRows + '</sheetData>' +
      ppMerges +
      '</worksheet>';

    /* Practice Profile is always sheet9 (first extra sheet, reordered to first tab) */
    _pass2SheetFixes['xl/worksheets/sheet9.xml'] = ppSheetXml;
    console.log('Pass 2: generated Practice Profile XML directly for sheet9 (' + ppSheetXml.length + ' chars, ' + pr + ' rows)');
  }

  /* Remove sharedStrings.xml (template has none — ExcelJS injects one) */
  if (fixZip.file('xl/sharedStrings.xml')) {
    fixZip.remove('xl/sharedStrings.xml');
    console.log('Pass 2: removed sharedStrings.xml');
  }

  /* Remove sharedStrings reference from workbook.xml.rels */
  /* CRITICAL: Read from pass1Zip, not fixZip */
  let wbRels = await pass1Zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  let _pass2WbRels = null;
  if (wbRels && wbRels.includes('sharedStrings')) {
    wbRels = wbRels.replace(/<Relationship[^>]*sharedStrings[^>]*\/>/g, '');
    _pass2WbRels = wbRels;  /* Save for fresh zip build */
    fixZip.file('xl/_rels/workbook.xml.rels', wbRels);
    console.log('Pass 2: removed sharedStrings ref from workbook.xml.rels');
  } else {
    _pass2WbRels = wbRels;  /* No change needed but still save for fresh zip */
  }

  /* === VERIFICATION: confirm styles.xml was actually restored === */
  const verifyStyles = await fixZip.file('xl/styles.xml')?.async('string');
  if (verifyStyles) {
    const vXfs = verifyStyles.match(/cellXfs count="(\d+)"/);
    const vFonts = verifyStyles.match(/fonts count="(\d+)"/);
    const vBlue = verifyStyles.includes('FF4472C4');
    const vYellow = verifyStyles.includes('FFFFFF00');
    console.log('VERIFY fixZip styles: cellXfs=' + (vXfs?vXfs[1]:'?') + ' fonts=' + (vFonts?vFonts[1]:'?') + ' blue=' + vBlue + ' yellow=' + vYellow);
  } else {
    console.error('VERIFY: fixZip has NO styles.xml!');
  }

  /* ═══ FRESH ZIP BUILD: create brand-new zip, copying files one by one ═══ */
  /* CRITICAL FIX (v12): Use _pass2* JS variables directly instead of reading from fixZip.
     JSZip .file(path, content) writes do NOT persist for .file(path).async() reads
     on the same loaded zip instance. Previous versions read back contaminated originals. */
  const freshZip = new JSZip();

  const msXfs = _pass2StylesXml?.match(/cellXfs count="(\d+)"/);
  console.log('Pass 2 styles (from JS variable): cellXfs=' + (msXfs?msXfs[1]:'NULL!') + ' len=' + (_pass2StylesXml?.length||0));

  /* Copy all files from pass1 to fresh zip, with replacements from JS variables */
  for (const filePath of Object.keys(pass1Zip.files)) {
    if (pass1Zip.files[filePath].dir) continue;

    /* Skip sharedStrings.xml entirely */
    if (filePath === 'xl/sharedStrings.xml') {
      console.log('Fresh zip: skipped sharedStrings.xml');
      continue;
    }

    /* Replace styles.xml with our modified version FROM JS VARIABLE */
    if (filePath === 'xl/styles.xml' && _pass2StylesXml) {
      freshZip.file(filePath, _pass2StylesXml);
      console.log('Fresh zip: replaced styles.xml (' + _pass2StylesXml.length + ' chars) FROM JS VARIABLE');
      continue;
    }

    /* Replace Content_Types with our restored version FROM JS VARIABLE */
    if (filePath === '[Content_Types].xml' && _pass2ContentTypes) {
      freshZip.file(filePath, _pass2ContentTypes);
      console.log('Fresh zip: replaced [Content_Types].xml FROM JS VARIABLE');
      continue;
    }

    /* Replace fixed sheets FROM JS VARIABLE */
    if (_pass2SheetFixes[filePath]) {
      freshZip.file(filePath, _pass2SheetFixes[filePath]);
      console.log('Fresh zip: replaced', filePath, 'FROM JS VARIABLE');
      continue;
    }

    /* Replace workbook.xml.rels FROM JS VARIABLE */
    if (filePath === 'xl/_rels/workbook.xml.rels' && _pass2WbRels) {
      freshZip.file(filePath, _pass2WbRels);
      console.log('Fresh zip: replaced workbook.xml.rels FROM JS VARIABLE');
      continue;
    }

    /* Replace workbook.xml with reordered version FROM JS VARIABLE (Practice Profile first) */
    if (filePath === 'xl/workbook.xml' && _pass2WorkbookXml) {
      freshZip.file(filePath, _pass2WorkbookXml);
      console.log('Fresh zip: replaced workbook.xml (reordered tabs) FROM JS VARIABLE');
      continue;
    }

    /* Replace theme.xml with Candara-normalized version FROM JS VARIABLE */
    if (filePath === 'xl/theme/theme1.xml' && _pass2ThemeXml) {
      freshZip.file(filePath, _pass2ThemeXml);
      console.log('Fresh zip: replaced theme1.xml FROM JS VARIABLE');
      continue;
    }

    /* Copy everything else as-is from pass1Zip (reads from buffer-loaded zip work fine) */
    const content = await pass1Zip.file(filePath)?.async('nodebuffer');
    if (content) freshZip.file(filePath, content);
  }

  /* ── Safety net: add any _pass2SheetFixes entries NOT already in freshZip ── */
  /* This covers sheets created by ExcelJS that may not have survived pass1 generation */
  for (const [fixPath, fixContent] of Object.entries(_pass2SheetFixes)) {
    if (!freshZip.file(fixPath)) {
      freshZip.file(fixPath, fixContent);
      console.log('Fresh zip SAFETY NET: added missing', fixPath, '(' + fixContent.length + ' chars)');
    }
  }

  /* ── Safety net: ensure workbook.xml uses our reordered version ── */
  if (_pass2WorkbookXml && freshZip.file('xl/workbook.xml')) {
    const currentWb = await freshZip.file('xl/workbook.xml')?.async('string');
    if (currentWb && !currentWb.includes('Practice Profile') && _pass2WorkbookXml.includes('Practice Profile')) {
      freshZip.file('xl/workbook.xml', _pass2WorkbookXml);
      console.log('Fresh zip SAFETY NET: re-applied _pass2WorkbookXml (was missing Practice Profile entry)');
    }
  }

  /* ── Safety net: ensure wbRels uses our version (no sharedStrings, correct extra sheet refs) ── */
  if (_pass2WbRels) {
    freshZip.file('xl/_rels/workbook.xml.rels', _pass2WbRels);
    console.log('Fresh zip SAFETY NET: force-applied _pass2WbRels');
  }

  /* ── Safety net: ensure Content_Types includes all extra sheets ── */
  if (_pass2ContentTypes) {
    freshZip.file('[Content_Types].xml', _pass2ContentTypes);
    console.log('Fresh zip SAFETY NET: force-applied _pass2ContentTypes');
  }

  /* ── Log final sheet inventory ── */
  const freshSheetFiles = Object.keys(freshZip.files).filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort();
  console.log('Fresh zip sheet files:', freshSheetFiles.join(', '));

  const finalBuf = await freshZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  console.log('Fresh zip final output:', finalBuf.length, 'bytes');

  /* Final verification */
  const verifyFinal = await JSZip.loadAsync(finalBuf);
  const vfStyles = await verifyFinal.file('xl/styles.xml')?.async('string');
  const vfHasSS = !!verifyFinal.file('xl/sharedStrings.xml');
  const _diag = {
    pass2StylesNull: _pass2StylesXml === null,
    pass2StylesLen: _pass2StylesXml?.length || 0,
    pass2CTNull: _pass2ContentTypes === null,
    pass2SheetFixKeys: Object.keys(_pass2SheetFixes),
    pass2WbRelsNull: _pass2WbRels === null,
    origStylesLen: _originalStylesXml?.length || 0,
    stylesSourceNull: !stylesSource,
    p1Xfs: p1Xfs?.[1] || '?',
    finalXfs: '?',
    finalHasSS: vfHasSS,
    finalStylesStart: vfStyles?.substring(0, 60) || 'NONE'
  };
  if (vfStyles) {
    const vfXfs = vfStyles.match(/cellXfs count="(\d+)"/);
    const vfCount = parseInt(vfXfs?.[1]||'0');
    _diag.finalXfs = String(vfCount);
    console.log('FINAL VERIFY: cellXfs=' + vfCount + ' sharedStrings=' + vfHasSS + ' len=' + vfStyles.length);
    if (vfCount < 700) {
      console.error('!!! STILL CONTAMINATED after fresh zip! cellXfs=' + vfCount);
    } else {
      console.log('FINAL OUTPUT CLEAN: ' + vfCount + ' cellXfs');
    }
  }

  return { buf: finalBuf, _diag };
}

/* Helper: escape XML special characters */
function escapeXml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* Helper: escape regex special characters */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ─── Build the workbook from pre-parsed text ─── */
async function buildXlsx(prodText, collText, plText, practiceName, arPatient, arInsurance, hygieneData, employeeCosts, plImageB64, practiceProfile) {
  /* Reset collectors for this invocation */
  _cellCollector = {};
  _acStrikeRows = [];
  _plInputExpenseNames = new Set();
  _plInputLastDataRow = 47;
  _battingAvgText = 'N/A';
  _baStyles = null;
  _swotTargetSheetNum = 11;
  _collStyles = null;

  /* Sheet name → sheet number mapping */
  const sheetNameMap = {
    'Production Worksheet': 1,
    'All Codes - Production Report': 2,
    'Hygiene Schedule': 3,
    'Financial Overview': 4,
    'Targets & Goal': 5,
    'Employee Costs': 6,
    'Budgetary P&L': 7,
    'P&L Input': 8
  };

  /* Create simple sheet objects with .name property for sv() calls */
  const wsPW = { name: 'Production Worksheet' };
  const wsAC = { name: 'All Codes - Production Report' };
  const wsHS = { name: 'Hygiene Schedule' };
  const wsFO = { name: 'Financial Overview' };
  const wsTG = { name: 'Targets & Goal' };
  const wsEC = { name: 'Employee Costs' };
  const wsBPL = { name: 'Budgetary P&L' };
  const wsPI = { name: 'P&L Input' };

  /* Parse the Claude output text into structured data */
  const prodData = parseProduction(prodText || '');
  const collData = collText ? parseCollections(collText) : null;
  const plData = plText ? parsePL(plText) : null;

  const { codes, months: prodMonths, years } = prodData;
  const totalProd = codes.reduce((s,c) => s + c.total, 0);

  console.log('Parsed:', codes.length, 'codes,', prodMonths, 'months, years:', years.join(','));
  if (collData) console.log('Collections:', collData.payments, 'over', collData.months, 'months');
  if (plData) console.log('P&L:', plData.items.length, 'items, income:', plData.totalIncome);

  /* Load template buffer for post-processor (reads from local bundle or HTTP) */
  let wb, templateBuf;
  const t0 = Date.now();
  try {
    if (_cachedTemplateBuf) {
      templateBuf = _cachedTemplateBuf;
      console.log('Template from cache:', templateBuf.length, 'bytes in', Date.now()-t0, 'ms');
    } else {
      const localPath = path.resolve(__dirname, '..', '..', 'Blank_Assessment_Template.xlsx');
      const localPath2 = path.resolve(__dirname, 'Blank_Assessment_Template.xlsx');
      const localPath3 = path.resolve(process.cwd(), 'Blank_Assessment_Template.xlsx');
      if (fs.existsSync(localPath)) {
        templateBuf = fs.readFileSync(localPath);
        console.log('Template from local (../..):', templateBuf.length, 'bytes in', Date.now()-t0, 'ms');
      } else if (fs.existsSync(localPath2)) {
        templateBuf = fs.readFileSync(localPath2);
        console.log('Template from local (same dir):', templateBuf.length, 'bytes in', Date.now()-t0, 'ms');
      } else if (fs.existsSync(localPath3)) {
        templateBuf = fs.readFileSync(localPath3);
        console.log('Template from local (cwd):', templateBuf.length, 'bytes in', Date.now()-t0, 'ms');
      } else {
        console.log('Local template not found, trying paths:', localPath, localPath2, localPath3);
        console.log('Falling back to HTTP fetch...');
        const tr = await fetch('https://dentalpracticeassessments.com/Blank_Assessment_Template.xlsx');
        if (!tr.ok) throw new Error('Template HTTP ' + tr.status);
        templateBuf = await tr.buffer();
        console.log('Template fetched via HTTP:', templateBuf.length, 'bytes in', Date.now()-t0, 'ms');
      }
      _cachedTemplateBuf = templateBuf;
    }
  } catch(e) {
    console.error('Template load failed:', e.message);
    throw new Error('Could not load assessment template: ' + e.message);
  }


  /* ═══ PRODUCTION WORKSHEET ═══ */
  sv(wsPW, 'D4', practiceName);
  sv(wsPW, 'D5', prodMonths);
  sv(wsPW, 'G5', totalProd);

  const rightAgg = {};
  const leftAgg = {};
  const srpAgg = {qty: 0, total: 0};
  const usedInPW = new Set();

  for (const c of codes) {
    const bc = baseCode(c.code);
    if (LEFT[bc]) {
      /* Aggregate codes that share the same baseCode (e.g. D1110 + D1110.1) */
      const row = LEFT[bc];
      if (!leftAgg[row]) leftAgg[row] = {qty:0, total:0};
      leftAgg[row].qty += c.qty;
      leftAgg[row].total += c.total;
      usedInPW.add(c.code);
      continue;
    }
    if (SRP_CODES.includes(bc)) {
      srpAgg.qty += c.qty;
      srpAgg.total += c.total;
      usedInPW.add(c.code);
      continue;
    }
    const rRow = RIGHT[bc];
    if (rRow) {
      if (!rightAgg[rRow]) rightAgg[rRow] = {qty:0, total:0};
      rightAgg[rRow].qty += c.qty;
      rightAgg[rRow].total += c.total;
      usedInPW.add(c.code);
    }
  }

  /* Write aggregated LEFT table values with explicit number formats */
  for (const [row, agg] of Object.entries(leftAgg)) {
    sv(wsPW, 'D'+row, agg.qty);
    sv(wsPW, 'F'+row, agg.qty > 0 ? Math.round(agg.total/agg.qty*100)/100 : 0);
  }

  if (srpAgg.qty > 0) {
    sv(wsPW, 'D24', srpAgg.qty);
    sv(wsPW, 'F24', Math.round(srpAgg.total/srpAgg.qty*100)/100);
  }

  /* Row 27: Laser production total — aggregate codes with "laser" in description */
  {
    let laserQty = 0, laserTotal = 0;
    for (const c of codes) {
      if (/laser/i.test(c.desc)) {
        laserQty += c.qty;
        laserTotal += c.total;
      }
    }
    if (laserQty > 0) {
      sv(wsPW, 'D27', laserQty);
      sv(wsPW, 'F27', Math.round(laserTotal / laserQty * 100) / 100);
      sv(wsPW, 'G27', laserTotal);
      console.log('Laser production (row 27): qty=' + laserQty + ' total=$' + laserTotal.toFixed(2));
    }
  }

  /* Row 28: Hygiene Summary total — sum of all hygiene production (rows 21-27) */
  {
    let hygTotal = 0;
    for (let hr = 21; hr <= 27; hr++) {
      if (leftAgg[hr]) hygTotal += leftAgg[hr].total;
    }
    hygTotal += srpAgg.total; /* row 24 SRP */
    /* Add laser total (row 27, not in leftAgg) */
    for (const c of codes) { if (/laser/i.test(c.desc)) hygTotal += c.total; }
    sv(wsPW, 'G28', hygTotal);
    console.log('Hygiene Summary total (G28): $' + hygTotal.toFixed(2));
  }

  for (const [row, agg] of Object.entries(rightAgg)) {
    sv(wsPW, 'L'+row, agg.qty);
    sv(wsPW, 'M'+row, Math.round(agg.total*100)/100);
    sv(wsPW, 'N'+row, agg.qty > 0 ? Math.round(agg.total/agg.qty*100)/100 : 0);
  }

  /* ═══ BATTING AVERAGE BOX (Production Worksheet, G38:G39) ═══ */
  /* Batting Average = monthly visits / monthly crowns prepped
     Visits/mo = comp exams (E12) + focused exams (E11) + adult prophy (E21)
                 + perio maintenance (E23)
     Crowns/mo = E36 (avg number of crowns prepped per month)
     Since E-cells are D/D5, the ratio = (D12+D11+D21+D23)/(D31+D32+D33+D34+D35)
     (months cancel out). */
  {
    const visits = (leftAgg[12]?.qty || 0)   // comprehensive exams
                 + (leftAgg[11]?.qty || 0)   // focused exams
                 + (leftAgg[21]?.qty || 0)   // adult prophy
                 + (leftAgg[23]?.qty || 0);  // perio maintenance

    /* Crowns: replicate template E36 denominator = (D31+D32+D33+D34+D35)/D5
       D31 = porcelain/ceramic (leftAgg row 31)
       D32 = porcelain/high noble (leftAgg row 32)
       D33 = SUM(L3:L8) = right-side rows 3-8 (veneers, inlays, onlays, implant crowns)
       D34 = L18 = SUM(L12:L17) = right-side bridge unit rows 12-17
       D35 = L8 = implant crowns (right-side row 8) */
    const d31 = leftAgg[31]?.qty || 0;
    const d32 = leftAgg[32]?.qty || 0;
    let d33 = 0;
    for (let r = 3; r <= 8; r++) d33 += (rightAgg[r]?.qty || 0);
    let d34 = 0;
    for (let r = 12; r <= 17; r++) d34 += (rightAgg[r]?.qty || 0);
    const d35 = rightAgg[8]?.qty || 0;
    const totalCrowns = d31 + d32 + d33 + d34 + d35;

    let battingAvgText = 'N/A';
    if (totalCrowns > 0) {
      const ratio = Math.round(visits / totalCrowns * 10) / 10;
      battingAvgText = ratio.toFixed(1) + ' to 1';
    }

    _battingAvgText = battingAvgText;
    console.log('Batting average:', battingAvgText, '(visits=' + visits + ', crowns=' + totalCrowns + ')');
  }

  /* Preserve number formatting on Production Worksheet key cells */

  /* Fix formula cells that have numFmt=General — they show raw decimals.
     E column = per-month qty (should be integer), N column = avg fee (should be $) */
  const pwIntCells = ['E10','E11','E12','E13','E16','E17','E18','E21','E22','E23','E24','E25','E26','E30','E31','E32','E34','E35','E36'];
  pwIntCells.forEach(addr => { });
  const pwDollarGeneral = ['N9','N18','N40','N47','N55','N68'];
  pwDollarGeneral.forEach(addr => { });
  /* G6 per-month production */

  /* Production Worksheet row heights */

  /* ═══ ALL CODES - PRODUCTION REPORT ═══ */
  /* Collect header row data */
  const acHeaders = ['Code', 'Description', 'Quantity', 'Total $', 'Avg Fee', '% of Prod'];
  acHeaders.forEach((h, i) => {
    const col = String.fromCharCode(65 + i); // A, B, C, D, E, F
    sv(wsAC, col + '1', h);
  });

  const nonZero = codes.filter(c => c.total > 0);
  const zero = codes.filter(c => c.total === 0);
  const allCodes = [...nonZero, ...zero];

  let directMatchCount = 0;
  const sampleUnmatched = [];

  /* Collect data rows — track which rows need strikethrough.
     Strikethrough = code was imported into the Production Worksheet (exists in usedInPW set).
     Only codes that map to specific PW rows get struck through. */
  _acStrikeRows = [];
  allCodes.forEach((c, i) => {
    const r = i + 2;
    if (usedInPW.has(c.code) && c.total > 0) { directMatchCount++; _acStrikeRows.push(r); }
    else if (sampleUnmatched.length < 5) sampleUnmatched.push(c.code);

    sv(wsAC, 'A'+r, c.code);
    sv(wsAC, 'B'+r, c.desc);
    sv(wsAC, 'C'+r, c.qty);
    sv(wsAC, 'D'+r, Math.round(c.total*100)/100);
    sv(wsAC, 'E'+r, c.qty > 0 ? Math.round(c.total/c.qty*100)/100 : 0);
    sv(wsAC, 'F'+r, totalProd > 0 ? Math.round(c.total/totalProd*10000)/10000 : 0);
  });

  console.log('All Codes: ' + allCodes.length + ' total, ' + directMatchCount + ' matched (' + _acStrikeRows.length + ' strike rows)');

  /* ═══ FINANCIAL OVERVIEW ═══ */
  sv(wsFO, 'D4', practiceName);

  /* Year headers: use the first year in the data range as the primary data year.
     Template layout: C6=year-2, E6=year-1, G6=dataYear (rightmost = most recent).
     Production/collection totals go in the data year columns (G/H). */
  const dataYear = years[0] || new Date().getFullYear();
  sv(wsFO, 'C6', dataYear - 2);
  sv(wsFO, 'E6', dataYear - 1);
  sv(wsFO, 'G6', dataYear);

  /* Production total → G20 (data year column), months → G21 */
  sv(wsFO, 'G20', Math.round(totalProd*100)/100);
  sv(wsFO, 'G21', prodMonths);

  /* Collection total → H20 (data year collection column), months → H21 */
  /* If the collections period is longer than production period, pro-rate to match */
  let collTotal = (collData && collData.payments) ? collData.payments : 0;
  const collMonthsRaw = (collData && collData.months) ? collData.months : prodMonths;
  if (collTotal > 0 && collMonthsRaw > prodMonths && prodMonths > 0) {
    const proRated = Math.round(collTotal / collMonthsRaw * prodMonths * 100) / 100;
    console.log('Collections pro-rated: $' + collTotal + ' over ' + collMonthsRaw + 'mo → $' + proRated + ' over ' + prodMonths + 'mo');
    collTotal = proRated;
  }
  if (collTotal) {
    sv(wsFO, 'H20', Math.round(collTotal*100)/100);
    sv(wsFO, 'H21', prodMonths);
  }

  /* ── Historical estimates: 2024 and 2023 (15% step-down per year) ── */
  /* 2024 = current year * 0.85,  2023 = current year * 0.85^2 */
  if (totalProd > 0) {
    const prod2024 = Math.round(totalProd * 0.85 * 100) / 100;
    const prod2023 = Math.round(totalProd * 0.85 * 0.85 * 100) / 100;
    sv(wsFO, 'E20', prod2024);
    sv(wsFO, 'C20', prod2023);
    sv(wsFO, 'E21', 12);
    sv(wsFO, 'C21', 12);
    console.log('Financial Overview: historical production — 2024=' + prod2024 + ', 2023=' + prod2023);
  }
  if (collTotal > 0) {
    const coll2024 = Math.round(collTotal * 0.85 * 100) / 100;
    const coll2023 = Math.round(collTotal * 0.85 * 0.85 * 100) / 100;
    sv(wsFO, 'F20', coll2024);
    sv(wsFO, 'D20', coll2023);
    sv(wsFO, 'F21', 12);
    sv(wsFO, 'D21', 12);
    console.log('Financial Overview: historical collection — 2024=' + coll2024 + ', 2023=' + coll2023);
  }

  if (plData && plData.totalIncome) {
    sv(wsFO, 'D25', Math.round(plData.totalIncome/12*100)/100);
  }

  /* ── Collections by Payment/Payor Type (row 44) from P&L income items ── */
  if (plData && plData.items) {
    const incItems = plData.items.filter(i => i.section === 'Income');
    let ccTotal = 0, checkTotal = 0, cashTotal = 0, insurTotal = 0, thirdParty = 0;
    for (const it of incItems) {
      const l = it.item.toLowerCase();
      if (/cc\s*payment|credit\s*card/i.test(l)) ccTotal += it.amount;
      else if (/check\s*payment/i.test(l)) checkTotal += it.amount;
      else if (/cash\s*payment/i.test(l)) cashTotal += it.amount;
      else if (/care\s*credit|lending\s*club|3rd\s*party|carecredit/i.test(l)) thirdParty += it.amount;
      else if (/sales|insurance|patient\s*payment|refund/i.test(l)) insurTotal += it.amount;
    }
    /* B44=credit card, C44=patient check, D44=cash, E44=insurance, F44=capitation, G44=3rd party, H44=dentical */
    if (ccTotal) sv(wsFO, 'B44', Math.round(ccTotal*100)/100);
    if (checkTotal) sv(wsFO, 'C44', Math.round(checkTotal*100)/100);
    if (cashTotal) sv(wsFO, 'D44', Math.round(cashTotal*100)/100);
    if (insurTotal) sv(wsFO, 'E44', Math.round(insurTotal*100)/100);
    if (thirdParty) sv(wsFO, 'G44', Math.round(thirdParty*100)/100);
    /* I44=total — use SUM formula, don't hardcode */
    console.log('Financial Overview: payment type data written (CC=' + ccTotal + ' Check=' + checkTotal + ' Cash=' + cashTotal + ' Insur=' + insurTotal + ' 3rdParty=' + thirdParty + ')');
  }
  if (totalProd > 0 && prodMonths > 0) {
    sv(wsFO, 'D27', Math.round(totalProd/prodMonths*100)/100);
  }

  if (arPatient && arPatient.total) {
    sv(wsFO, 'D32', arPatient.total);
    sv(wsFO, 'E32', arPatient.current||0);
    sv(wsFO, 'F32', arPatient.d3160||0);
    sv(wsFO, 'G32', arPatient.d6190||0);
    sv(wsFO, 'H32', arPatient.d90plus||0);
    if (arPatient.insr) sv(wsFO, 'I32', arPatient.insr);
  }
  if (arInsurance && arInsurance.total) {
    sv(wsFO, 'D33', arInsurance.total);
    sv(wsFO, 'E33', arInsurance.current||0);
    sv(wsFO, 'F33', arInsurance.d3160||0);
    sv(wsFO, 'G33', arInsurance.d6190||0);
    sv(wsFO, 'H33', arInsurance.d90plus||0);
  }

  /* NOTE: Financial Overview styling MINIMIZED — using cell.style={...} on cells
     that don't have explicit values was causing corruption. Only format cells
     where we wrote data. Template already has correct styles for most cells. */
  ['D32','D33','E32','F32','G32','H32','E33','F33','G33','H33'].forEach(addr => {
  });

  /* ═══ HYGIENE SCHEDULE ═══ */
  /* 3 weeks recent past (rows 10-12), next 7 days (rows 19-20),
     3 weeks near future (rows 25-27), 2 weeks future future (rows 34-35).
     All data rows get zeros. Dates pre-populated relative to today. */
  {
      const today = new Date();
      const dayOfWeek = today.getDay();
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const thisMonday = new Date(today);
      thisMonday.setDate(today.getDate() + mondayOffset);

      function getMonday(weeksFromNow) {
        const d = new Date(thisMonday);
        d.setDate(thisMonday.getDate() + weeksFromNow * 7);
        return d;
      }
      function fmtWeek(mon) {
        const fri = new Date(mon);
        fri.setDate(mon.getDate() + 4);
        const m1 = mon.getMonth() + 1, d1 = mon.getDate();
        const m2 = fri.getMonth() + 1, d2 = fri.getDate();
        return m1 + '/' + d1 + ' - ' + m2 + '/' + d2;
      }

      /* Recent past: 3 weeks back (rows 10-12). Row 13 left blank (eliminated). */
      for (let i = 0; i < 3; i++) {
        const mon = getMonday(-3 + i);
        sv(wsHS, 'B' + (10 + i), fmtWeek(mon));
      }
      /* Ensure all recent past data rows have zeros (C-N for rows 10-12) */
      const dataCols = ['C','D','E','F','G','H','I','J','K','L','M','N'];
      for (let r = 10; r <= 12; r++) {
        dataCols.forEach(col => { const addr = col+r; if (!(_cellCollector['Hygiene Schedule'] || {})[addr]) sv(wsHS, addr, 0); });
      }

      /* Next 7 days date context */
      sv(wsHS, 'E18', fmtWeek(thisMonday));
      /* Ensure next-7-days rows have zeros (rows 19-20, C-N) */
      for (let r = 19; r <= 20; r++) {
        dataCols.forEach(col => { const addr = col+r; if (!(_cellCollector['Hygiene Schedule'] || {})[addr]) sv(wsHS, addr, 0); });
      }

      /* Near future: 3 weeks forward (rows 25-27). Row 28 left blank (eliminated). */
      for (let i = 0; i < 3; i++) {
        const mon = getMonday(1 + i);
        sv(wsHS, 'B' + (25 + i), fmtWeek(mon));
      }
      for (let r = 25; r <= 27; r++) {
        dataCols.forEach(col => { const addr = col+r; if (!(_cellCollector['Hygiene Schedule'] || {})[addr]) sv(wsHS, addr, 0); });
      }

      /* Future future: 2 weeks after near future (rows 34-35) */
      for (let i = 0; i < 2; i++) {
        const mon = getMonday(4 + i); /* starts week 4 (right after 3 near-future weeks) */
        sv(wsHS, 'B' + (34 + i), fmtWeek(mon));
      }
      for (let r = 34; r <= 35; r++) {
        dataCols.forEach(col => { const addr = col+r; if (!(_cellCollector['Hygiene Schedule'] || {})[addr]) sv(wsHS, addr, 0); });
      }

      /* Populate hygiene schedule form data if provided */
      if (hygieneData) {
        /* Patient estimates */
        if (hygieneData.activePatients) sv(wsHS, 'N39', hygieneData.activePatients);
        if (hygieneData.newPatientsPerMonth) sv(wsHS, 'N40', hygieneData.newPatientsPerMonth);
        if (hygieneData.perioPct) sv(wsHS, 'N41', hygieneData.perioPct);
        if (hygieneData.perioPosPct) sv(wsHS, 'N42', hygieneData.perioPosPct);
        if (hygieneData.ptsPerHygDay) sv(wsHS, 'N51', hygieneData.ptsPerHygDay);
        /* Recent past weekly data (rows 10-12, cols C-N) */
        if (hygieneData.recentPast) {
          hygieneData.recentPast.forEach((week, wi) => {
            if (wi > 2) return;
            const row = 10 + wi;
            (week.data || []).forEach((val, ci) => {
              if (ci < dataCols.length) sv(wsHS, dataCols[ci] + row, val || 0);
            });
          });
        }
        /* Next 7 days (rows 19-20, cols C-N) */
        if (hygieneData.next7Days) {
          hygieneData.next7Days.forEach((rowData, ri) => {
            if (ri > 1) return;
            const row = 19 + ri;
            (rowData.data || []).forEach((val, ci) => {
              if (ci < dataCols.length) sv(wsHS, dataCols[ci] + row, val || 0);
            });
          });
        }
        /* Near future (rows 25-27, cols C-N) */
        if (hygieneData.nearFuture) {
          hygieneData.nearFuture.forEach((week, wi) => {
            if (wi > 2) return;
            const row = 25 + wi;
            (week.data || []).forEach((val, ci) => {
              if (ci < dataCols.length) sv(wsHS, dataCols[ci] + row, val || 0);
            });
          });
        }
        /* Future future (rows 34-35, cols C-N) */
        if (hygieneData.futureFuture) {
          hygieneData.futureFuture.forEach((week, wi) => {
            if (wi > 1) return;
            const row = 34 + wi;
            (week.data || []).forEach((val, ci) => {
              if (ci < dataCols.length) sv(wsHS, dataCols[ci] + row, val || 0);
            });
          });
        }
        /* RDH scheduled per day (row 7: C=Mon, E=Tue, G=Wed, I=Thu, K=Fri, M=Sat) */
        if (hygieneData.rdhPerDay) {
          const rdhCols = ['C','E','G','I','K','M'];
          hygieneData.rdhPerDay.forEach((val, i) => {
            if (i < rdhCols.length) sv(wsHS, rdhCols[i] + '7', val || 0);
          });
        }
        /* Days scheduled (F16) */
        if (hygieneData.daysScheduled) sv(wsHS, 'F16', hygieneData.daysScheduled);
        /* Patient flow from software (H47), % under 19 (H48) */
        if (hygieneData.patientFlow) sv(wsHS, 'H47', hygieneData.patientFlow);
        if (hygieneData.pctUnder19) sv(wsHS, 'H48', hygieneData.pctUnder19);
      }

      /* ── Hygiene Schedule POTENTIAL section: derive from production data ── */
      /* These values feed the formulas in F40-F42, H40-H43, H44, N45-N48 */
      {
        /* Use prefix matching to aggregate sub-codes (D1110 + D1110.1, D4342.1 + D4342.2, etc.) */
        const codeQtyHS = (prefix) => codes.filter(c => c.code === prefix || c.code.startsWith(prefix + '.')).reduce((s,c) => s + c.qty, 0);
        const prophyQtyHS = codeQtyHS('D1110') + codeQtyHS('D1120');
        const perioMaintQtyHS = codeQtyHS('D4910');
        const srpQtyHS = codeQtyHS('D4341') + codeQtyHS('D4342');
        const activePatientEstHS = prodMonths > 0 ? Math.round((prophyQtyHS + perioMaintQtyHS) / (prodMonths / 12)) : 0;
        const compExamsHS = codeQtyHS('D0150');
        const npPerMonthHS = prodMonths > 0 ? Math.round(compExamsHS / prodMonths) : 0;

        /* N39: active patients (only if hub form didn't already provide it) */
        if (!(hygieneData && hygieneData.activePatients) && activePatientEstHS > 0) {
          sv(wsHS, 'N39', activePatientEstHS);
        }
        /* N40: new patients per month from comp exams */
        if (!(hygieneData && hygieneData.newPatientsPerMonth) && npPerMonthHS > 0) {
          sv(wsHS, 'N40', npPerMonthHS);
        }
        /* N41: perio disease % — estimate from SRP ratio vs prophy */
        if (!(hygieneData && hygieneData.perioPct)) {
          const perioRatioHS = prophyQtyHS > 0 ? srpQtyHS / prophyQtyHS : 0.30;
          sv(wsHS, 'N41', Math.round(perioRatioHS * 100) / 100);
        }
        /* N42: perio probing positive % — use industry avg if not provided */
        if (!(hygieneData && hygieneData.perioPosPct)) {
          sv(wsHS, 'N42', 0.30);  /* 30% industry avg */
        }
        /* H47: patient flow — use active patient estimate as proxy */
        if (!(hygieneData && hygieneData.patientFlow) && activePatientEstHS > 0) {
          sv(wsHS, 'H47', activePatientEstHS);
        }
        /* H48: % under 19 — use industry avg if not provided */
        if (!(hygieneData && hygieneData.pctUnder19)) {
          sv(wsHS, 'H48', 0.20);  /* 20% industry avg */
        }
        /* N51: patients scheduled per hygiene day — estimate from production volume */
        if (!(hygieneData && hygieneData.ptsPerHygDay)) {
          /* Typical: 8-10 pts per hygienist per day */
          sv(wsHS, 'N51', 8);
        }
        /* F16: days scheduled (working days in reporting period) — override small form defaults */
        const hasRealDaysScheduled = hygieneData && hygieneData.daysScheduled && hygieneData.daysScheduled > 20;
        if (!hasRealDaysScheduled && prodMonths > 0) {
          sv(wsHS, 'F16', Math.round(prodMonths * 21));  /* ~21 working days/month */
        }

        /* ── Hygiene Schedule GRID: derive recent-past data from production codes ── */
        /* When the hub form didn't provide schedule data, estimate from procedure counts */
        const hsCollector = _cellCollector['Hygiene Schedule'] || {};
        const hygVisitsTotal = prophyQtyHS + perioMaintQtyHS + srpQtyHS;
        const workingDaysTotal = prodMonths > 0 ? Math.round(prodMonths * 21) : 252;
        const hygPtsPerDay = workingDaysTotal > 0 ? Math.round(hygVisitsTotal / workingDaysTotal) : 0;
        /* Estimate hygienists from volume (8 pts/hygienist/day typical) */
        const estRDHCount = Math.max(1, Math.round(hygPtsPerDay / 8));

        /* RDH SCHEDULED per day (row 7): C=Mon, E=Tue, G=Wed, I=Thu, K=Fri
           Overwrite zeros — the zero-filling runs first, so hsCollector already has 0 values */
        const hasRealRDH = hygieneData && Array.isArray(hygieneData.rdhPerDay) && hygieneData.rdhPerDay.some(v => v > 1);
        if (!hasRealRDH && estRDHCount > 0) {
          const rdhDayCols = ['C','E','G','I','K'];
          rdhDayCols.forEach(col => sv(wsHS, col + '7', estRDHCount));
          console.log('Hygiene Schedule: wrote RDH SCHEDULED = ' + estRDHCount + '/day (Mon-Fri)');
        }

        /* Helper: check if a grid section has real (non-zero) data from the form */
        const hasRealGrid = (arr) => Array.isArray(arr) && arr.length > 0 && arr.some(w => w.data && w.data.some(v => v > 0));

        const apptColsHS = ['C','E','G','I','K','M']; /* appt per day Mon-Sat */
        const seenColsHS = ['D','F','H','J','L','N']; /* seen/conf/booked per day Mon-Sat */

        /* Recent past (rows 10-12): fill appt/seen with estimated daily volume */
        const hasRealRecentPast = hasRealGrid(hygieneData && hygieneData.recentPast);
        if (!hasRealRecentPast && hygPtsPerDay > 0) {
          for (let r = 10; r <= 12; r++) {
            for (let d = 0; d < 5; d++) { /* Mon-Fri */
              sv(wsHS, apptColsHS[d] + r, hygPtsPerDay);
              sv(wsHS, seenColsHS[d] + r, Math.round(hygPtsPerDay * 0.85)); /* ~85% show rate */
            }
          }
          console.log('Hygiene Schedule: wrote recent past grid — ' + hygPtsPerDay + ' appt, ' + Math.round(hygPtsPerDay * 0.85) + ' seen per day');
        }

        /* Next 7 days (rows 19-20): fill schd/conf with estimated daily volume */
        const hasRealNext7 = hasRealGrid(hygieneData && hygieneData.next7Days);
        if (!hasRealNext7 && hygPtsPerDay > 0) {
          for (let r = 19; r <= 20; r++) {
            for (let d = 0; d < 5; d++) {
              sv(wsHS, apptColsHS[d] + r, hygPtsPerDay);
              sv(wsHS, seenColsHS[d] + r, Math.round(hygPtsPerDay * 0.90)); /* ~90% confirmed */
            }
          }
          console.log('Hygiene Schedule: wrote next 7 days grid — ' + hygPtsPerDay + ' schd, ' + Math.round(hygPtsPerDay * 0.90) + ' conf per day');
        }

        /* Near future (rows 25-27): fill appt/booked with estimated daily volume */
        const hasRealNearFuture = hasRealGrid(hygieneData && hygieneData.nearFuture);
        if (!hasRealNearFuture && hygPtsPerDay > 0) {
          for (let r = 25; r <= 27; r++) {
            for (let d = 0; d < 5; d++) {
              sv(wsHS, apptColsHS[d] + r, hygPtsPerDay);
              sv(wsHS, seenColsHS[d] + r, Math.round(hygPtsPerDay * 0.75)); /* ~75% booked ahead */
            }
          }
          console.log('Hygiene Schedule: wrote near future grid — ' + hygPtsPerDay + ' appt, ' + Math.round(hygPtsPerDay * 0.75) + ' booked per day');
        }

        /* Far future (rows 34-35): fill appt/booked with estimated daily volume */
        const hasRealFarFuture = hasRealGrid(hygieneData && hygieneData.futureFuture);
        if (!hasRealFarFuture && hygPtsPerDay > 0) {
          for (let r = 34; r <= 35; r++) {
            for (let d = 0; d < 5; d++) {
              sv(wsHS, apptColsHS[d] + r, hygPtsPerDay);
              sv(wsHS, seenColsHS[d] + r, Math.round(hygPtsPerDay * 0.60)); /* ~60% booked far out */
            }
          }
          console.log('Hygiene Schedule: wrote far future grid — ' + hygPtsPerDay + ' appt, ' + Math.round(hygPtsPerDay * 0.60) + ' booked per day');
        }

        /* N51: patients per hygiene day — use calculated value instead of default 8 */
        if (!(hygieneData && hygieneData.ptsPerHygDay) && hygPtsPerDay > 0) {
          sv(wsHS, 'N51', hygPtsPerDay); /* override the default 8 with actual */
        }

        console.log('Hygiene Schedule GRID: ' + hygVisitsTotal + ' total visits, ' +
          hygPtsPerDay + ' pts/day, ' + estRDHCount + ' RDH estimated');

        console.log('Hygiene Schedule POTENTIAL: activePatients=' + activePatientEstHS +
          ' npPerMonth=' + npPerMonthHS + ' prophy=' + prophyQtyHS +
          ' perioMaint=' + perioMaintQtyHS + ' srp=' + srpQtyHS);
      }

      console.log('Hygiene Schedule: populated week dates relative to', thisMonday.toISOString().slice(0,10));
  }

  /* ═══ EMPLOYEE COSTS ═══ */
  /* If no hub form employeeCosts provided, derive estimates from P&L data */
  const hasEmployeeData = employeeCosts && (
    (Array.isArray(employeeCosts.staff) ? employeeCosts.staff.length > 0 : !!employeeCosts.staff) ||
    (Array.isArray(employeeCosts.hygiene) ? employeeCosts.hygiene.length > 0 : !!employeeCosts.hygiene)
  );
  console.log('Employee Costs: hasEmployeeData=' + hasEmployeeData + ' plData=' + !!plData + ' plItems=' + (plData?.items?.length || 0));
  if (!hasEmployeeData && plData && plData.items && plData.items.length > 0) {
    console.log('Employee Costs: deriving from P&L data (' + plData.items.length + ' items)...');
    const collAmt = collData?.payments || plData?.totalIncome || 0;

    /* Extract staff-related P&L line items */
    let totalPayrollWages = 0;
    let totalPayrollTax = 0;
    let totalPayrollFees = 0;
    let totalUniform = 0;
    const staffLineItems = [];

    for (const item of plData.items) {
      if (item.section === 'Income' || item.section === 'COGS') continue;
      const l = item.item.toLowerCase().trim();
      if (/payroll.*(wage|salar)|\bwages?\b|\bsalary\b|\bsalaries\b/i.test(l)) {
        totalPayrollWages += item.amount;
        staffLineItems.push({ name: item.item, amount: item.amount, type: 'wages' });
        console.log('  EC match WAGES: "' + item.item + '" = $' + item.amount);
      } else if (/payroll.*tax/i.test(l)) {
        totalPayrollTax += item.amount;
      } else if (/payroll.*fee/i.test(l)) {
        totalPayrollFees += item.amount;
      } else if (/uniform|laundry/i.test(l)) {
        totalUniform += item.amount;
      }
    }
    console.log('  EC totals: wages=$' + totalPayrollWages + ' tax=$' + totalPayrollTax + ' fees=$' + totalPayrollFees);

    const totalStaffCostEC = totalPayrollWages + totalPayrollTax + totalPayrollFees + totalUniform;

    if (totalPayrollWages > 0) {
      /* Estimate: typically 60% staff / 40% hygiene split on wages */
      const staffWages = Math.round(totalPayrollWages * 0.60);
      const hygWages = Math.round(totalPayrollWages * 0.40);

      /* Estimate typical positions — assume avg $20/hr staff, $50/hr hygienist */
      const avgStaffRate = 20;
      const avgHygRate = 50;
      const hoursPerMonth = 160; /* full time */

      /* Estimate number of staff from wages: monthly wages / (rate * hours) */
      const monthlyStaffWages = prodMonths > 0 ? staffWages / prodMonths : staffWages / 12;
      const monthlyHygWages = prodMonths > 0 ? hygWages / prodMonths : hygWages / 12;
      const estStaffCount = Math.max(1, Math.min(5, Math.round(monthlyStaffWages / (avgStaffRate * hoursPerMonth))));
      const estHygCount = Math.max(1, Math.min(5, Math.round(monthlyHygWages / (avgHygRate * hoursPerMonth))));

      /* Distribute wages across estimated positions */
      const perStaffMonthly = estStaffCount > 0 ? monthlyStaffWages / estStaffCount : 0;
      const perHygMonthly = estHygCount > 0 ? monthlyHygWages / estHygCount : 0;
      const estStaffHourly = Math.round(perStaffMonthly / hoursPerMonth * 100) / 100;
      const estHygHourly = Math.round(perHygMonthly / hoursPerMonth * 100) / 100;

      /* Write Office Manager (row 7) */
      sv(wsEC, 'D7', 'Office Manager');
      sv(wsEC, 'E7', Math.round(estStaffHourly * 1.15 * 100) / 100); /* OM gets ~15% premium */
      sv(wsEC, 'F7', hoursPerMonth);

      /* Write front desk staff (rows 9-13) */
      const frontLabels = ['Front Desk 1', 'Front Desk 2', 'Front Desk 3', 'Front Desk 4', 'Front Desk 5'];
      const staffRows = [9, 10, 11, 12, 13];
      for (let i = 0; i < Math.min(estStaffCount - 1, 5); i++) {
        sv(wsEC, 'D' + staffRows[i], frontLabels[i]);
        sv(wsEC, 'E' + staffRows[i], estStaffHourly);
        sv(wsEC, 'F' + staffRows[i], hoursPerMonth);
      }

      /* Write back office / assistants (rows 16-19) */
      const backLabels = ['Dental Asst 1', 'Dental Asst 2', 'Dental Asst 3', 'Dental Asst 4'];
      const backRows = [16, 17, 18, 19];
      const estBackCount = Math.max(1, Math.min(4, Math.round(estStaffCount * 0.6)));
      for (let i = 0; i < estBackCount; i++) {
        sv(wsEC, 'D' + backRows[i], backLabels[i]);
        sv(wsEC, 'E' + backRows[i], Math.round(estStaffHourly * 1.05 * 100) / 100);
        sv(wsEC, 'F' + backRows[i], hoursPerMonth);
      }

      /* Write hygienists (rows 27-31) */
      const hygLabels = ['Hygienist 1', 'Hygienist 2', 'Hygienist 3', 'Hygienist 4', 'Hygienist 5'];
      const hygRows = [27, 28, 29, 30, 31];
      for (let i = 0; i < Math.min(estHygCount, 5); i++) {
        sv(wsEC, 'D' + hygRows[i], hygLabels[i]);
        sv(wsEC, 'E' + hygRows[i], estHygHourly);
        sv(wsEC, 'F' + hygRows[i], hoursPerMonth);
      }

      /* Employment cost % estimate (payroll tax as % of wages) */
      if (totalPayrollTax > 0 && totalPayrollWages > 0) {
        const empCostPct = Math.round(totalPayrollTax / totalPayrollWages * 100) / 100;
        /* G21 = staff employment cost $, G31 = hyg employment cost $ */
        sv(wsEC, 'G21', Math.round(monthlyStaffWages * empCostPct * 100) / 100);
        sv(wsEC, 'G31', Math.round(monthlyHygWages * empCostPct * 100) / 100);
      }

      console.log('Employee Costs: estimated ' + estStaffCount + ' staff + ' + estBackCount + ' back + ' + estHygCount + ' hygienists from P&L wages=$' + totalPayrollWages);
    }
  }
  if (hasEmployeeData) {
    console.log('Writing Employee Costs data from hub form...');
    /* Staff positions: name→D, rate→E, hours→F (G has formulas for monthly cost) */
    const staffRowMap = { om: 7, f1: 9, f2: 10, f3: 11, f4: 12, f5: 13, b1: 16, b2: 17, b3: 18, b4: 19, b5: 14 };
    /* Relabel row 14 from "front6" to "back 5" */
    sv(wsEC, 'C14', 'back 5');
    if (employeeCosts.staff) {
      employeeCosts.staff.forEach(p => {
        const r = staffRowMap[p.key] || p.row;
        if (r) {
          if (p.name) sv(wsEC, 'D' + r, p.name);
          if (p.rate) sv(wsEC, 'E' + r, p.rate);
          if (p.hours) sv(wsEC, 'F' + r, p.hours);
        }
      });
    }
    /* Staff benefits & employment cost % */
    if (employeeCosts.staffBenefits) sv(wsEC, 'G22', employeeCosts.staffBenefits);

    /* Hygiene positions: name→D, rate→E, hours→F */
    const hygBaseMap = { h1: 27, h2: 28, h3: 29, h4: 30, h5: 31 };
    if (employeeCosts.hygiene) {
      employeeCosts.hygiene.forEach(p => {
        const r = hygBaseMap[p.key] || p.row;
        if (r) {
          if (p.name) sv(wsEC, 'D' + r, p.name);
          if (p.rate) sv(wsEC, 'E' + r, p.rate);
          if (p.hours) sv(wsEC, 'F' + r, p.hours);
        }
      });
    }

    /* Hygiene benefits & employment cost % */
    if (employeeCosts.hygBenefits) sv(wsEC, 'G32', employeeCosts.hygBenefits);

    /* Employment cost % — calculate from wages and write to G21 (staff) and G31 (hygiene) */
    if (employeeCosts.staffEmpCostPct) {
      let totalStaffWages = 0;
      (employeeCosts.staff || []).forEach(p => { totalStaffWages += (p.rate || 0) * (p.hours || 0); });
      sv(wsEC, 'G21', Math.round(totalStaffWages * employeeCosts.staffEmpCostPct * 100) / 100);
    }
    if (employeeCosts.hygEmpCostPct) {
      let totalHygWages = 0;
      (employeeCosts.hygiene || []).forEach(p => { totalHygWages += (p.rate || 0) * (p.hours || 0); });
      sv(wsEC, 'G31', Math.round(totalHygWages * employeeCosts.hygEmpCostPct * 100) / 100);
    }

    /* Benefits policy notes — write to rows 35-42, column D */
    if (employeeCosts.benefits) {
      const b = employeeCosts.benefits;
      if (b.sick) sv(wsEC, 'D35', b.sick);
      if (b.holidays) sv(wsEC, 'D36', b.holidays);
      if (b.vacation) sv(wsEC, 'D37', b.vacation);
      if (b.bonus) sv(wsEC, 'D38', b.bonus);
      if (b.k401) sv(wsEC, 'D39', b.k401);
      if (b.medical) sv(wsEC, 'D40', b.medical);
      if (b.dental) sv(wsEC, 'D41', b.dental);
      if (b.other) sv(wsEC, 'D42', b.other);
    }

    console.log('Employee Costs: done');
  }

  /* ═══ TARGETS & GOAL ═══ */
  /* Template layout: Row 7 headers, Row 8=general dentist, Row 9=associate,
     Row 10=hygiene, Rows 11-16=specialists. Col C=Days Worked. */
  if (practiceProfile) {
    if (practiceProfile.doctorDays) sv(wsTG, 'C8', practiceProfile.doctorDays);
    if (practiceProfile.hasAssociate === true || practiceProfile.hasAssociate === 'yes') {
      if (practiceProfile.associateDays) sv(wsTG, 'C9', practiceProfile.associateDays);
    }
    if (practiceProfile.numHygienists) {
      /* numHygienists from questionnaire = hygiene days per week; multiply by ~4.3 for monthly */
      sv(wsTG, 'C10', practiceProfile.numHygienists);
    }
    console.log('Targets & Goal: populated from practiceProfile (docDays=' + (practiceProfile.doctorDays||0) + ', assocDays=' + (practiceProfile.associateDays||0) + ', hygDays=' + (practiceProfile.numHygienists||0) + ')');
  }

  /* ═══ P&L INPUT ═══ */
  /* Template layout (DO NOT change):
     - Row 2: B2=months, H2=collections from P&L, N2=monthly ave formula(=H2/B2)
     - Row 5: Column headers (From P&L, Associates, Hygienist, Specialists, Lab, ...)
     - Rows 6-47: Data rows (expense items)
     - Row 48: Totals (=SUM formulas already in template)
     - Row 49: Monthly Ave (=col48/B2 formulas already in template)
     - Row 50: Adj. Figure (zeros, consultant fills in)
     - Row 51: P&L $$'s (=col49 formulas already in template)
     - Row 54-56: Spreadsheet Total, Total Cost from P&L, Diff */

  if (plData && plData.items && plData.items.length > 0) {
    sv(wsPI, 'B2', prodMonths || 12);
    if (plData.totalIncome) sv(wsPI, 'H2', plData.totalIncome);
    /* N2 has formula =H2/B2, so it auto-calculates — no need to set it */

    /* ONLY expense items go into the expense grid — exclude Income, COGS, and depreciation */
    let expenseOnly = plData.items.filter(i => i.section !== 'Income' && i.section !== 'COGS');
    expenseOnly = expenseOnly.filter(i => plCategory(i.item) !== null); /* exclude depreciation */
    console.log('P&L Input: ' + expenseOnly.length + ' expense items (filtered from ' + plData.items.length + ' total)');

    /* Template supports max 42 rows (6-47). If more items, combine smallest into "Other Expenses" */
    const MAX_ROWS = 42;
    if (expenseOnly.length > MAX_ROWS) {
      expenseOnly.sort((a, b) => b.amount - a.amount);
      const keep = expenseOnly.slice(0, MAX_ROWS - 1);
      const combine = expenseOnly.slice(MAX_ROWS - 1);
      const combinedAmt = combine.reduce((s, i) => s + i.amount, 0);
      keep.push({ item: 'Other Expenses (combined)', amount: combinedAmt, section: 'Expense' });
      expenseOnly = keep;
      console.log('P&L Input: combined ' + combine.length + ' small items into Other ($' + combinedAmt.toFixed(2) + ')');
    }

    _plInputExpenseNames = new Set();
    let row = 6;
    for (const item of expenseOnly) {
      if (row > 47) break; /* NEVER write past row 47 — row 48+ are summary formulas */
      const col = plCategory(item.item);
      if (col === null) continue;
      sv(wsPI, 'A'+row, item.item);
      sv(wsPI, col+row, item.amount);
      _plInputExpenseNames.add(item.item.toLowerCase().trim());
      row++;
    }
    /* Track last data row for Pass 2 empty-row hiding */
    _plInputLastDataRow = row - 1;  /* row is already 1 past the last written item */

    /* Clear any unused data rows (between last item and row 47) */
    for (let r = row; r <= 47; r++) {
      sv(wsPI, 'A'+r, null);
      ['B','C','D','E','F','G','H','I','J','K','L','M','N','O'].forEach(col => {
        sv(wsPI, col+r, null);
      });
    }

    /* Template already has correct formulas at rows 48-51 and 54-56.
       Just set the Total Cost from P&L value at N55. */
    if (plData.totalExpense) sv(wsPI, 'N55', plData.totalExpense);

    console.log('P&L Input: wrote ' + (row - 6) + ' expense items to rows 6-' + (row-1) + ', template formulas at 48-51 preserved');
  }

  /* ═══ P&L RAW IMPORT, P&L IMAGE & SWOT ANALYSIS (sheets 9-11, ExcelJS-only) ═══ */
  let sheets9to10Buf = null;
  var extraSheetNames = [];
  const swotData = generateSWOT(prodData, collData, plData, hygieneData, employeeCosts, arPatient, arInsurance, practiceName);
  const needsExtraSheets = (plData && plData.items && plData.items.length > 0) || plImageB64 || swotData || practiceProfile;

  if (needsExtraSheets) {
    const wbNewSheets = new ExcelJS.Workbook();

    /* ═══ PRACTICE PROFILE (first extra sheet — becomes first tab via reorder) ═══ */
    if (practiceProfile) {
      try {
      const wsP = wbNewSheets.addWorksheet('Practice Profile');

      /* ── Layout: single wide table B:E, no D gutter ── */
      wsP.getColumn('A').width = 3;
      wsP.getColumn('B').width = 34;
      wsP.getColumn('C').width = 30;
      wsP.getColumn('D').width = 34;
      wsP.getColumn('E').width = 30;
      wsP.getColumn('F').width = 3;

      wsP.views = [{ showGridLines: false }];
      wsP.properties.tabColor = { argb: 'FF2B5797' };

      /* ── Palette ── */
      const _accent  = 'FF2B5797';   /* PerformDDS blue */
      const _accent2 = 'FF3A7BD5';   /* lighter accent */
      const _dark    = 'FF1E293B';
      const _mid     = 'FF64748B';
      const _light   = 'FFF8FAFC';
      const _stripe  = 'FFF1F5F9';
      const _border  = 'FFE2E8F0';
      const _white   = 'FFFFFFFF';

      /* ── Fonts ── */
      const fTitle = { name: 'Candara', size: 18, bold: true, color: { argb: _white } };
      const fSub   = { name: 'Candara', size: 10, color: { argb: 'FFB0C4DE' } };
      const fSect  = { name: 'Candara', size: 11, bold: true, color: { argb: _accent } };
      const fLabel = { name: 'Candara', size: 10, color: { argb: _mid } };
      const fVal   = { name: 'Candara', size: 10, bold: true, color: { argb: _dark } };
      const fCheck = { name: 'Candara', size: 10, color: { argb: _dark } };
      const fNote  = { name: 'Candara', size: 10, italic: true, color: { argb: _mid } };
      const fFoot  = { name: 'Candara', size: 8, italic: true, color: { argb: 'FFA0AEC0' } };

      /* ── Fills ── */
      const fillBanner  = { type: 'pattern', pattern: 'solid', fgColor: { argb: _accent } };
      const fillSection = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F7' } };
      const fillStripe  = { type: 'pattern', pattern: 'solid', fgColor: { argb: _stripe } };
      const fillWhite   = { type: 'pattern', pattern: 'solid', fgColor: { argb: _white } };

      /* ── Borders ── */
      const bdrBot   = { bottom: { style: 'thin', color: { argb: _border } } };
      const bdrAccent = { bottom: { style: 'medium', color: { argb: _accent } } };

      /* ── Helpers ── */
      const allCols = ['A','B','C','D','E','F'];
      const dataCols = ['B','C','D','E'];

      function fillRow(ws, row, fill, border) {
        for (const c of allCols) {
          const cell = ws.getCell(c + row);
          if (fill) cell.fill = fill;
          if (border) cell.border = border;
        }
      }

      function sectionHdr(ws, row, text) {
        fillRow(ws, row, fillSection, bdrAccent);
        const c = ws.getCell('B' + row);
        c.value = text;
        c.font = fSect;
        c.alignment = { vertical: 'middle' };
        ws.getRow(row).height = 28;
      }

      let _parity = 0;
      function dataRow(ws, row, label1, val1, label2, val2) {
        const bg = (_parity % 2 === 0) ? fillWhite : fillStripe;
        fillRow(ws, row, bg, bdrBot);
        ws.getCell('B' + row).value = label1;
        ws.getCell('B' + row).font = fLabel;
        ws.getCell('B' + row).alignment = { vertical: 'middle' };
        ws.getCell('C' + row).value = val1 || '';
        ws.getCell('C' + row).font = fVal;
        ws.getCell('C' + row).alignment = { vertical: 'middle' };
        if (label2) {
          ws.getCell('D' + row).value = label2;
          ws.getCell('D' + row).font = fLabel;
          ws.getCell('D' + row).alignment = { vertical: 'middle' };
          ws.getCell('E' + row).value = val2 || '';
          ws.getCell('E' + row).font = fVal;
          ws.getCell('E' + row).alignment = { vertical: 'middle' };
        }
        ws.getRow(row).height = 24;
        _parity++;
      }

      /* ═══ ROW 1-2: Title banner ═══ */
      fillRow(wsP, 1, fillBanner, null);
      fillRow(wsP, 2, fillBanner, null);
      wsP.mergeCells('B1:E1');
      wsP.getCell('B1').value = practiceName || practiceProfile.website || 'Practice Assessment';
      wsP.getCell('B1').font = fTitle;
      wsP.getCell('B1').alignment = { vertical: 'middle' };
      wsP.getRow(1).height = 44;

      wsP.mergeCells('B2:E2');
      wsP.getCell('B2').value = 'Practice Profile  |  Dental AI Toolkit Assessment';
      wsP.getCell('B2').font = fSub;
      wsP.getCell('B2').alignment = { vertical: 'top' };
      wsP.getRow(2).height = 20;

      /* Row 3: spacer */
      wsP.getRow(3).height = 8;

      let r = 4;

      /* ═══ PRACTICE BASICS ═══ */
      sectionHdr(wsP, r, 'PRACTICE BASICS'); r++;
      _parity = 0;
      dataRow(wsP, r, 'Zip Code', practiceProfile.zipCode || '—', 'Practice Website', practiceProfile.website || '—'); r++;
      dataRow(wsP, r, 'Years Owned', practiceProfile.yearsOwned ? practiceProfile.yearsOwned + ' years' : '—', 'Owner Age', practiceProfile.ownerAge ? practiceProfile.ownerAge + ' years old' : '—'); r++;
      const softwareNames = { dentrix: 'Dentrix', eaglesoft: 'Eaglesoft', opendental: 'Open Dental', other: 'Other' };
      dataRow(wsP, r, 'Practice Management Software', softwareNames[practiceProfile.pmSoftware] || practiceProfile.pmSoftware || '—', null, null); r++;
      r++; /* spacer */

      /* ═══ PAYOR MIX ═══ */
      sectionHdr(wsP, r, 'PAYOR MIX'); r++;
      _parity = 0;
      const mix = practiceProfile.payorMix || {};
      dataRow(wsP, r, 'In-Network PPO', (mix.ppo || 0) + '%', 'HMO', (mix.hmo || 0) + '%'); r++;
      dataRow(wsP, r, 'Medicaid / Government', (mix.gov || 0) + '%', 'Fee-for-Service / OON', (mix.ffs || 0) + '%'); r++;
      r++;

      /* ═══ SCHEDULE & TEAM ═══ */
      sectionHdr(wsP, r, 'SCHEDULE & TEAM'); r++;
      _parity = 0;
      dataRow(wsP, r, 'Doctor Days per Month', practiceProfile.doctorDays ? practiceProfile.doctorDays + ' days' : '—', 'Hygiene Days per Week', practiceProfile.numHygienists ? practiceProfile.numHygienists + ' days' : '—'); r++;
      const assocText = practiceProfile.hasAssociate ? ('Yes  —  ' + (practiceProfile.associateDays || 0) + ' days per month') : 'No';
      dataRow(wsP, r, 'Has Associate Doctor', assocText, 'Operatories Active', (practiceProfile.opsActive || '—') + ' of ' + (practiceProfile.opsTotal || '—') + ' total'); r++;
      r++;

      /* ═══ DAILY PRODUCTION & BENCHMARKS ═══ */
      sectionHdr(wsP, r, 'DAILY PRODUCTION & BENCHMARKS'); r++;
      _parity = 0;
      const docAvg = practiceProfile.docDailyAvg === 'idk' ? "Doesn't know" : (practiceProfile.docDailyAvg ? '$' + Number(practiceProfile.docDailyAvg).toLocaleString() + ' / day' : '—');
      const hygAvg = practiceProfile.hygDailyAvg === 'idk' ? "Doesn't know" : (practiceProfile.hygDailyAvg ? '$' + Number(practiceProfile.hygDailyAvg).toLocaleString() + ' / day' : '—');
      dataRow(wsP, r, 'Doctor Daily Average', docAvg, 'Hygiene Daily Average', hygAvg); r++;
      const crowns = practiceProfile.crownsPerMonth === 'idk' ? "Doesn't know" : (practiceProfile.crownsPerMonth || '—');
      dataRow(wsP, r, 'Crowns per Month', crowns, null, null); r++;
      const goalMap = { yes: 'Yes', no: 'No', sort_of: 'Sort of' };
      const aheadMap = { yes: 'Yes', no: 'No', sometimes: 'Sometimes' };
      dataRow(wsP, r, 'Has Daily Production Goal', goalMap[practiceProfile.hasProductionGoal] || '—', 'Tracks If Ahead/Behind', aheadMap[practiceProfile.knowsIfAhead] || '—'); r++;
      r++;

      /* ═══ GOALS & VISION ═══ */
      sectionHdr(wsP, r, 'GOALS & VISION'); r++;
      _parity = 0;
      const yearsMap = { '1-5': '1 – 5 years', '5-10': '5 – 10 years', '10-15': '10 – 15 years', 'not-on-radar': 'Not on my radar' };
      dataRow(wsP, r, 'Years to Continue Practicing', yearsMap[practiceProfile.yearsToWork] || practiceProfile.yearsToWork || '—', null, null); r++;
      r++;

      /* ═══ TOP CONCERNS ═══ */
      const concerns = practiceProfile.concerns || [];
      if (concerns.length > 0) {
        sectionHdr(wsP, r, 'TOP CONCERNS'); r++;
        const concernLabels = {
          more_profitable: 'Want to be more profitable',
          more_busy: 'Want to be busier',
          pay_staff_more: 'Want to pay staff more',
          owner_bonus: 'Want to take home more',
          more_control: 'Want more control over the practice',
          staff_issues: 'Staff issues',
          overhead_high: 'Overhead is too high',
          insurance_rates: 'Insurance reimbursements too low',
          new_patients: 'Need more new patients',
          exit_plan: 'Considering selling or retiring'
        };
        /* Two-column concern layout */
        for (let ci = 0; ci < concerns.length; ci += 2) {
          const bg = ((ci / 2) % 2 === 0) ? fillWhite : fillStripe;
          fillRow(wsP, r, bg, bdrBot);
          /* Left concern */
          wsP.mergeCells('B' + r + ':C' + r);
          wsP.getCell('B' + r).value = '\u2713  ' + (concernLabels[concerns[ci]] || concerns[ci]);
          wsP.getCell('B' + r).font = fCheck;
          wsP.getCell('B' + r).alignment = { vertical: 'middle' };
          /* Right concern (if exists) */
          if (ci + 1 < concerns.length) {
            wsP.mergeCells('D' + r + ':E' + r);
            wsP.getCell('D' + r).value = '\u2713  ' + (concernLabels[concerns[ci + 1]] || concerns[ci + 1]);
            wsP.getCell('D' + r).font = fCheck;
            wsP.getCell('D' + r).alignment = { vertical: 'middle' };
          }
          wsP.getRow(r).height = 24;
          r++;
        }
        r++;
      }

      /* ═══ ADDITIONAL NOTES ═══ */
      if (practiceProfile.biggestChallenge) {
        sectionHdr(wsP, r, 'ADDITIONAL NOTES'); r++;
        wsP.mergeCells('B' + r + ':E' + r);
        const nc = wsP.getCell('B' + r);
        nc.value = practiceProfile.biggestChallenge;
        nc.font = fNote;
        nc.alignment = { wrapText: true, vertical: 'top' };
        nc.border = bdrBot;
        wsP.getRow(r).height = 50;
        r++;
      }

      /* ═══ Footer ═══ */
      r++;
      fillRow(wsP, r, null, { top: { style: 'thin', color: { argb: _border } } });
      wsP.getCell('B' + r).value = 'Generated by Dental AI Toolkit  \u2022  ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      wsP.getCell('B' + r).font = fFoot;
      wsP.getRow(r).height = 18;

      console.log('Practice Profile sheet: written (v2 redesign)');
      } catch (ppErr) {
        console.error('Practice Profile FAILED:', ppErr.message, ppErr.stack?.slice(0, 300));
      }
    }

    /* P&L Raw Import */
    if (plData && plData.items && plData.items.length > 0) {
      const wsRaw = wbNewSheets.addWorksheet('P&L Raw Import');
      wsRaw.getCell('A1').value = 'P&L Raw Import — ' + (practiceName || 'Practice');
      wsRaw.getCell('A3').value = 'Line Item';
      wsRaw.getCell('B3').value = 'Amount';
      wsRaw.getCell('C3').value = 'Category';
      wsRaw.getCell('D3').value = 'Notes';

      let rr = 5;
      const incomeItems = plData.items.filter(i => i.section === 'Income');
      const cogsItems = plData.items.filter(i => i.section === 'COGS');
      const expenseItems = plData.items.filter(i => i.section !== 'Income' && i.section !== 'COGS');

      if (incomeItems.length > 0) {
        wsRaw.getCell('A'+rr).value = 'INCOME'; rr++;
        for (const item of incomeItems) {
          wsRaw.getCell('A'+rr).value = item.item;
          wsRaw.getCell('B'+rr).value = item.amount;
          wsRaw.getCell('C'+rr).value = 'Income';
          rr++;
        }
        const totalSales = incomeItems.reduce((s,i) => s + i.amount, 0);
        wsRaw.getCell('A'+rr).value = 'Total Sales';
        wsRaw.getCell('B'+rr).value = totalSales;
        wsRaw.getCell('C'+rr).value = 'Income';
        rr++;
      }
      if (plData.totalIncome) {
        wsRaw.getCell('A'+rr).value = 'TOTAL INCOME';
        wsRaw.getCell('B'+rr).value = plData.totalIncome;
        wsRaw.getCell('D'+rr).value = 'Net collections';
        rr++;
      }
      rr++;
      if (cogsItems.length > 0) {
        wsRaw.getCell('A'+rr).value = 'COST OF GOODS SOLD';
        const cogsTotal = cogsItems.reduce((s,i) => s + i.amount, 0);
        wsRaw.getCell('B'+rr).value = cogsTotal;
        wsRaw.getCell('C'+rr).value = 'COGS';
        rr++;
        if (plData.totalIncome) {
          wsRaw.getCell('A'+rr).value = 'GROSS PROFIT';
          wsRaw.getCell('B'+rr).value = plData.totalIncome - cogsTotal;
          rr++;
        }
        rr++;
      }
      wsRaw.getCell('A'+rr).value = 'EXPENSES'; rr++;
      for (const item of expenseItems) {
        const cat = plCategory(item.item);
        wsRaw.getCell('A'+rr).value = item.item;
        wsRaw.getCell('B'+rr).value = item.amount;
        if (cat === null) {
          wsRaw.getCell('C'+rr).value = 'EXCLUDED';
          wsRaw.getCell('D'+rr).value = 'Non-cash — excluded';
        } else if (cat === 'O') {
          wsRaw.getCell('C'+rr).value = 'Add-Back';
          wsRaw.getCell('D'+rr).value = 'Owner — add-back';
        } else {
          const catNames = {F:'Dental Supplies',H:'Staff Costs',J:'Rent & Parking',K:'Marketing',L:'Office Supplies',M:'Other'};
          wsRaw.getCell('C'+rr).value = catNames[cat] || 'Other';
        }
        rr++;
      }
      rr++;
      if (plData.totalExpense) {
        wsRaw.getCell('A'+rr).value = 'TOTAL EXPENSES';
        wsRaw.getCell('B'+rr).value = plData.totalExpense;
        wsRaw.getCell('D'+rr).value = 'Per P&L';
        rr++;
      }
      rr++;
      if (plData.netIncome != null) {
        wsRaw.getCell('A'+rr).value = 'NET INCOME';
        wsRaw.getCell('B'+rr).value = plData.netIncome;
        wsRaw.getCell('D'+rr).value = 'Per P&L';
      }

      wsRaw.getColumn('A').width = 35;
      wsRaw.getColumn('B').width = 15;
      wsRaw.getColumn('C').width = 18;
      wsRaw.getColumn('D').width = 30;
      console.log('P&L Raw Import: written');
    }

    /* P&L Image */
    if (plImageB64) {
      const wsImg = wbNewSheets.addWorksheet('P&L Image');
      try {
        const imgBuf = Buffer.from(plImageB64, 'base64');
        const imageId = wbNewSheets.addImage({ buffer: imgBuf, extension: 'jpeg' });
        wsImg.addImage(imageId, {
          tl: { col: 0, row: 0 },
          br: { col: 10, row: 50 }
        });
        console.log('P&L image embedded, size:', imgBuf.length, 'bytes');
      } catch(imgErr) {
        console.warn('Could not embed P&L image:', imgErr.message);
        wsImg.getCell('A1').value = 'P&L image could not be embedded';
      }
    }

    /* ═══ SWOT ANALYSIS (sheet 11) — 2×2 matrix layout ═══ */
    if (swotData) {
      try {
      const wsSW = wbNewSheets.addWorksheet('SWOT Analysis');

      /* Layout: A=gutter, B-C=left quadrant, D=gutter, E-F=right quadrant, G=gutter */
      wsSW.getColumn('A').width = 2.5;
      wsSW.getColumn('B').width = 3;    /* colour bar */
      wsSW.getColumn('C').width = 58;   /* content */
      wsSW.getColumn('D').width = 2;    /* centre gutter */
      wsSW.getColumn('E').width = 3;    /* colour bar */
      wsSW.getColumn('F').width = 58;   /* content */
      wsSW.getColumn('G').width = 2.5;

      wsSW.views = [{ showGridLines: false }];
      wsSW.properties.tabColor = { argb: 'FF2B5797' };

      const _sw = {
        accent: 'FF2B5797',
        white: 'FFFFFFFF',
        dark: 'FF1E293B',
        mid: 'FF64748B',
        border: 'FFE2E8F0',
        green: 'FF059669', greenLt: 'FFECFDF5', greenBar: 'FF10B981',
        red: 'FFDC2626',   redLt: 'FFFEF2F2',   redBar: 'FFEF4444',
        blue: 'FF2563EB',  blueLt: 'FFEFF6FF',   blueBar: 'FF3B82F6',
        amber: 'FFD97706', amberLt: 'FFFFFBEB',  amberBar: 'FFF59E0B'
      };

      /* ── Title banner ── */
      for (const c of ['A','B','C','D','E','F','G']) {
        wsSW.getCell(c + '1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: _sw.accent } };
        wsSW.getCell(c + '2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: _sw.accent } };
      }
      wsSW.mergeCells('B1:F1');
      wsSW.getCell('B1').value = 'SWOT Analysis  \u2014  ' + (practiceName || 'Practice');
      wsSW.getCell('B1').font = { name: 'Candara', size: 18, bold: true, color: { argb: _sw.white } };
      wsSW.getCell('B1').alignment = { vertical: 'middle' };
      wsSW.getRow(1).height = 44;

      wsSW.mergeCells('B2:F2');
      wsSW.getCell('B2').value = 'Strategic overview generated from practice data';
      wsSW.getCell('B2').font = { name: 'Candara', size: 10, color: { argb: 'FFB0C4DE' } };
      wsSW.getCell('B2').alignment = { vertical: 'top' };
      wsSW.getRow(2).height = 20;

      wsSW.getRow(3).height = 8; /* spacer */

      /* ── Helper: write one SWOT quadrant ── */
      function writeQuadrant(ws, startRow, barCol, contentCol, title, items, barColor, bgColor, titleColor) {
        const hdrFont = { name: 'Candara', size: 11, bold: true, color: { argb: titleColor } };
        const itemFont = { name: 'Candara', size: 10, color: { argb: _sw.dark } };
        const barFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: barColor } };
        const bgFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };

        let r = startRow;

        /* Section header */
        ws.getCell(barCol + r).fill = barFill;
        ws.getCell(contentCol + r).value = title;
        ws.getCell(contentCol + r).font = hdrFont;
        ws.getCell(contentCol + r).fill = bgFill;
        ws.getCell(contentCol + r).alignment = { vertical: 'middle' };
        ws.getCell(contentCol + r).border = { bottom: { style: 'medium', color: { argb: barColor } } };
        ws.getCell(barCol + r).border = { bottom: { style: 'medium', color: { argb: barColor } } };
        ws.getRow(r).height = 28;
        r++;

        /* Items */
        for (let i = 0; i < items.length; i++) {
          ws.getCell(barCol + r).fill = barFill;
          const cell = ws.getCell(contentCol + r);
          cell.value = '\u2022  ' + items[i];
          cell.font = itemFont;
          cell.alignment = { wrapText: true, vertical: 'top' };
          cell.border = { bottom: { style: 'thin', color: { argb: _sw.border } } };
          ws.getRow(r).height = 28;
          r++;
        }

        return r;  /* return next available row */
      }

      /* ── Row 4: Strengths (left) + Weaknesses (right) ── */
      const maxSW = Math.max(swotData.strengths.length, swotData.weaknesses.length);
      const sEnd = writeQuadrant(wsSW, 4, 'B', 'C', 'STRENGTHS', swotData.strengths, _sw.greenBar, _sw.greenLt, _sw.green);
      const wEnd = writeQuadrant(wsSW, 4, 'E', 'F', 'WEAKNESSES', swotData.weaknesses, _sw.redBar, _sw.redLt, _sw.red);

      /* Pad shorter quadrant so they end at the same row */
      const topEnd = Math.max(sEnd, wEnd);

      /* Spacer row */
      const gapRow = topEnd;
      wsSW.getRow(gapRow).height = 12;

      /* ── Opportunities (left) + Threats (right) ── */
      const oStart = gapRow + 1;
      const oEnd = writeQuadrant(wsSW, oStart, 'B', 'C', 'OPPORTUNITIES', swotData.opportunities, _sw.blueBar, _sw.blueLt, _sw.blue);
      const tEnd = writeQuadrant(wsSW, oStart, 'E', 'F', 'THREATS', swotData.threats, _sw.amberBar, _sw.amberLt, _sw.amber);

      const botEnd = Math.max(oEnd, tEnd);

      /* ── Footer ── */
      const fRow = botEnd + 1;
      for (const c of ['A','B','C','D','E','F','G']) {
        wsSW.getCell(c + fRow).border = { top: { style: 'thin', color: { argb: _sw.border } } };
      }
      wsSW.getCell('B' + fRow).value = 'Generated by Dental AI Toolkit  \u2022  ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      wsSW.getCell('B' + fRow).font = { name: 'Candara', size: 8, italic: true, color: { argb: 'FFA0AEC0' } };
      wsSW.getRow(fRow).height = 18;

      console.log('SWOT Analysis: written 2x2 layout (' + swotData.strengths.length + 'S, ' + swotData.weaknesses.length + 'W, ' + swotData.opportunities.length + 'O, ' + swotData.threats.length + 'T)');
      } catch (swotErr) {
        console.error('SWOT Analysis ExcelJS FAILED:', swotErr.message, swotErr.stack?.slice(0, 300));
      }
    }

    /* Collect sheet names in order for dynamic registration */
    extraSheetNames = [];
    wbNewSheets.eachSheet((ws) => { extraSheetNames.push(ws.name); });
    console.log('Extra sheet names:', extraSheetNames);

    /* Set SWOT target sheet number based on its position in the ExcelJS workbook */
    const swotIdx = extraSheetNames.indexOf('SWOT Analysis');
    if (swotIdx >= 0) _swotTargetSheetNum = 9 + swotIdx;

    sheets9to10Buf = await wbNewSheets.xlsx.writeBuffer();
    console.log('Extra sheets ExcelJS buffer written:', sheets9to10Buf.byteLength, 'bytes');
    /* Diagnostic: verify how many sheets are in the ExcelJS buffer */
    try {
      const _diagZip = await JSZip.loadAsync(sheets9to10Buf);
      const _diagSheets = Object.keys(_diagZip.files).filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f));
      console.log('ExcelJS buffer sheet count:', _diagSheets.length, 'files:', _diagSheets.join(', '));
    } catch(e) { console.log('ExcelJS buffer diag failed:', e.message); }
  }

  /* Now inject collected cell values into template, along with sheets 9-10 if present */
  const injStart = Date.now();
  const elapsed = injStart - t0;
  console.log('Time before injection:', elapsed, 'ms');

  const injResult = await injectValuesIntoTemplate(templateBuf, sheetNameMap, sheets9to10Buf, swotData || null, practiceName, extraSheetNames || [], practiceProfile);
  const finalBuf = injResult.buf;
  const _injDiag = injResult._diag;
  const injTime = Date.now() - injStart;
  const totalTime = Date.now() - t0;
  console.log('Injection complete in', injTime, 'ms, total:', totalTime, 'ms, output:', finalBuf.length, 'bytes');
  console.log('Injection diagnostics:', JSON.stringify(_injDiag));

  return {
    xlsxB64: finalBuf.toString('base64'),
    summary: {
      codesFound: codes.length,
      totalProduction: totalProd.toFixed(2),
      months: prodMonths,
      years,
      netCollections: collTotal || plData?.totalIncome || null,
      plParsed: plData !== null && plData.items.length > 0,
      arPatientTotal: arPatient?.total || null,
      arInsuranceTotal: arInsurance?.total || null,
      _version: 'v34-hygiene-grid-fix',
      _debug: { usedInPW: usedInPW.size, directMatch: directMatchCount, unmatchedSample: sampleUnmatched },
      _injDiag,
      _timing: { preInjection: elapsed, injection: injTime, total: totalTime }
    }
  };
}

/* ─── Handler ─── */
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return {statusCode:200, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST,OPTIONS'}, body:''};
  if (event.httpMethod !== 'POST') return {statusCode:405, body:'Method Not Allowed'};

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return {statusCode:400, headers:{'Access-Control-Allow-Origin':'*'}, body:JSON.stringify({error:'Invalid JSON'})}; }

  const { prodText, collText, plText, practiceName='', arPatient={}, arInsurance={}, hygieneData=null, employeeCosts=null, plImageB64=null, practiceProfile=null } = body;
  if (!prodText) return {statusCode:400, headers:{'Access-Control-Allow-Origin':'*'}, body:JSON.stringify({error:'prodText required'})};

  try {
    console.log('Building workbook from pre-parsed data... practiceProfile=' + (practiceProfile ? 'present' : 'NULL'));
    const result = await buildXlsx(prodText, collText, plText, practiceName, arPatient, arInsurance, hygieneData, employeeCosts, plImageB64, practiceProfile);

    return {
      statusCode: 200,
      headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},
      body: JSON.stringify({ success: true, xlsxB64: result.xlsxB64, summary: result.summary })
    };
  } catch(err) {
    console.error('Error:', err.message, err.stack?.slice(0,500));
    return {statusCode:500, headers:{'Access-Control-Allow-Origin':'*'}, body:JSON.stringify({error:err.message})};
  }
};
