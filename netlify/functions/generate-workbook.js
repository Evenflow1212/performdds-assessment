'use strict';
const ExcelJS = require('exceljs');
const fetch   = require('node-fetch');

/* Helper: set cell value safely */
function sv(ws, addr, val) { try { ws.getCell(addr).value = val; } catch(e) {} }

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
  if (/payroll.*(wage|salar)|^wages?\b/i.test(l)) return 'H';
  if (/payroll.*tax/i.test(l)) return 'H';
  if (/payroll.*fee/i.test(l)) return 'H';
  if (/uniform|laundry/i.test(l)) return 'H';
  if (/dental.*suppl|job.*suppl/i.test(l)) return 'F';
  if (/advertis|marketing/i.test(l)) return 'K';
  if (/^rent|lease/i.test(l)) return 'J';
  if (/repair|maintenance/i.test(l)) return 'J';
  if (/office.*suppl|software/i.test(l)) return 'L';
  if (/car.*truck/i.test(l)) return 'O';
  if (/meal|entertainment|dining/i.test(l)) return 'O';
  if (/travel\b/i.test(l)) return 'O';
  if (/401k|retirement/i.test(l)) return 'O';
  if (/depreciat|amortiz/i.test(l)) return null; // EXCLUDED
  return 'M';
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

/* ─── Build the workbook from pre-parsed text ─── */
async function buildXlsx(prodText, collText, plText, practiceName, arPatient, arInsurance, plImageB64) {
  /* Parse the Claude output text into structured data */
  const prodData = parseProduction(prodText || '');
  const collData = collText ? parseCollections(collText) : null;
  const plData = plText ? parsePL(plText) : null;

  const { codes, months: prodMonths, years } = prodData;
  const totalProd = codes.reduce((s,c) => s + c.total, 0);

  console.log('Parsed:', codes.length, 'codes,', prodMonths, 'months, years:', years.join(','));
  if (collData) console.log('Collections:', collData.payments, 'over', collData.months, 'months');
  if (plData) console.log('P&L:', plData.items.length, 'items, income:', plData.totalIncome);

  /* Load template */
  let wb;
  try {
    const tr = await fetch('https://dentalpracticeassessments.com/Blank_Assessment_Template.xlsx');
    if (!tr.ok) throw new Error('Template HTTP ' + tr.status);
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await tr.buffer());
    console.log('Template loaded, sheets:', wb.worksheets.map(s=>s.name).join(', '));
  } catch(e) {
    console.error('Template load failed:', e.message);
    throw new Error('Could not load assessment template: ' + e.message);
  }

  const wsPW = wb.getWorksheet('Production Worksheet');
  const wsAC = wb.getWorksheet('All Codes - Production Report');
  const wsFO = wb.getWorksheet('Financial Overview');
  const wsPI = wb.getWorksheet('P&L Input');

  if (!wsPW || !wsAC || !wsFO || !wsPI) {
    throw new Error('Template missing required sheets. Found: ' + wb.worksheets.map(s=>s.name).join(', '));
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
    try { wsPW.getCell('D'+row).numFmt = '#,##0'; } catch(e) {}
    try { wsPW.getCell('F'+row).numFmt = '$#,##0.00'; } catch(e) {}
  }

  if (srpAgg.qty > 0) {
    sv(wsPW, 'D24', srpAgg.qty);
    sv(wsPW, 'F24', Math.round(srpAgg.total/srpAgg.qty*100)/100);
    try { wsPW.getCell('D24').numFmt = '#,##0'; } catch(e) {}
    try { wsPW.getCell('F24').numFmt = '$#,##0.00'; } catch(e) {}
  }

  for (const [row, agg] of Object.entries(rightAgg)) {
    sv(wsPW, 'L'+row, agg.qty);
    sv(wsPW, 'M'+row, Math.round(agg.total*100)/100);
    sv(wsPW, 'N'+row, agg.qty > 0 ? Math.round(agg.total/agg.qty*100)/100 : 0);
    try { wsPW.getCell('L'+row).numFmt = '#,##0'; } catch(e) {}
    try { wsPW.getCell('M'+row).numFmt = '$#,##0.00'; } catch(e) {}
    try { wsPW.getCell('N'+row).numFmt = '$#,##0.00'; } catch(e) {}
  }

  /* Preserve number formatting on Production Worksheet key cells */
  try { wsPW.getCell('G5').numFmt = '$#,##0.00'; } catch(e) {}
  try { wsPW.getCell('D5').numFmt = '#,##0'; } catch(e) {}

  /* ═══ ALL CODES - PRODUCTION REPORT ═══ */
  /* NUCLEAR OPTION: Delete the template sheet and rebuild from scratch.
     This eliminates ALL inherited formatting (row styles, column styles,
     conditional formatting, themes) that might force strikethrough. */
  const acIndex = wb.worksheets.findIndex(s => s.name === 'All Codes - Production Report');
  if (acIndex >= 0) wb.removeWorksheet(wsAC.id);
  const wsAC2 = wb.addWorksheet('All Codes - Production Report');
  /* Move it to the original position */
  try { wb.moveWorksheet(wsAC2.id, acIndex); } catch(e) {}

  /* Header row */
  const acHeaders = ['Code', 'Description', 'Quantity', 'Total $', 'Avg Fee', '% of Prod'];
  acHeaders.forEach((h, i) => {
    const cell = wsAC2.getCell(1, i + 1);
    cell.value = h;
    cell.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2B4A' } };
    cell.alignment = { horizontal: i >= 2 ? 'right' : 'left' };
  });
  wsAC2.getColumn('A').width = 12;
  wsAC2.getColumn('B').width = 35;
  wsAC2.getColumn('C').width = 12;
  wsAC2.getColumn('D').width = 14;
  wsAC2.getColumn('E').width = 12;
  wsAC2.getColumn('F').width = 12;

  const nonZero = codes.filter(c => c.total > 0);
  const zero = codes.filter(c => c.total === 0);
  const allCodes = [...nonZero, ...zero];

  let directMatchCount = 0;
  const sampleUnmatched = [];

  allCodes.forEach((c, i) => {
    const r = i + 2;
    const bc = baseCode(c.code);
    const isUsed = LEFT.hasOwnProperty(bc) || SRP_CODES.includes(bc) || RIGHT.hasOwnProperty(bc);
    if (isUsed) directMatchCount++;
    else if (sampleUnmatched.length < 5) sampleUnmatched.push(c.code);

    const font = isUsed
      ? { name: 'Verdana', size: 10, strike: true,  color: { argb: 'FF999999' } }
      : { name: 'Verdana', size: 10, strike: false, color: { argb: 'FF000000' } };

    wsAC2.getCell('A'+r).value = c.code;
    wsAC2.getCell('B'+r).value = c.desc;
    wsAC2.getCell('C'+r).value = c.qty;
    wsAC2.getCell('D'+r).value = Math.round(c.total*100)/100;
    wsAC2.getCell('E'+r).value = c.qty > 0 ? Math.round(c.total/c.qty*100)/100 : 0;
    wsAC2.getCell('F'+r).value = totalProd > 0 ? Math.round(c.total/totalProd*10000)/10000 : 0;

    ['A','B','C','D','E','F'].forEach(col => { wsAC2.getCell(col+r).font = font; });
    wsAC2.getCell('C'+r).numFmt = '#,##0';
    wsAC2.getCell('D'+r).numFmt = '$#,##0.00';
    wsAC2.getCell('E'+r).numFmt = '$#,##0.00';
    wsAC2.getCell('F'+r).numFmt = '0.00%';
    wsAC2.getCell('C'+r).alignment = { horizontal: 'right' };
    wsAC2.getCell('D'+r).alignment = { horizontal: 'right' };
    wsAC2.getCell('E'+r).alignment = { horizontal: 'right' };
    wsAC2.getCell('F'+r).alignment = { horizontal: 'right' };
  });

  console.log('All Codes: ' + allCodes.length + ' total, ' + directMatchCount + ' matched, ' + sampleUnmatched.length + ' unmatched sample: ' + sampleUnmatched.join(','));

  /* ═══ FINANCIAL OVERVIEW ═══ */
  sv(wsFO, 'D4', practiceName);
  const primaryYear = years.length >= 2 ? years[1] : years[0] || new Date().getFullYear();
  sv(wsFO, 'E6', primaryYear);
  sv(wsFO, 'E20', Math.round(totalProd*100)/100);
  try { wsFO.getCell('E20').numFmt = '$#,##0'; } catch(e) {}
  sv(wsFO, 'E21', prodMonths);

  if (collData && collData.payments) {
    sv(wsFO, 'F20', Math.round(collData.payments*100)/100);
    try { wsFO.getCell('F20').numFmt = '$#,##0'; } catch(e) {}
    sv(wsFO, 'F21', collData.months || prodMonths);
  }

  if (plData && plData.totalIncome) {
    sv(wsFO, 'D25', Math.round(plData.totalIncome/12*100)/100);
    try { wsFO.getCell('D25').numFmt = '$#,##0'; } catch(e) {}
  }
  if (totalProd > 0 && prodMonths > 0) {
    sv(wsFO, 'D27', Math.round(totalProd/prodMonths*100)/100);
    try { wsFO.getCell('D27').numFmt = '$#,##0'; } catch(e) {}
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

  /* ═══ P&L INPUT ═══ */
  if (plData && plData.items && plData.items.length > 0) {
    sv(wsPI, 'B2', 12);
    if (plData.totalIncome) sv(wsPI, 'H2', plData.totalIncome);

    /* ONLY expense items go into the expense grid — exclude Income and COGS */
    const expenseOnly = plData.items.filter(i => i.section !== 'Income' && i.section !== 'COGS');
    console.log('P&L Input: ' + expenseOnly.length + ' expense items (filtered from ' + plData.items.length + ' total)');

    let row = 6;
    for (const item of expenseOnly) {
      if (row > 46) break;
      const col = plCategory(item.item);
      if (col === null) continue;
      sv(wsPI, 'A'+row, item.item);
      /* Fix font — template has Rockwell 23pt which causes overlap */
      try { wsPI.getCell('A'+row).font = { name: 'Verdana', size: 9 }; } catch(e) {}
      sv(wsPI, col+row, item.amount);
      try { wsPI.getCell(col+row).font = { name: 'Verdana', size: 9 }; } catch(e) {}
      try { wsPI.getCell(col+row).numFmt = '$#,##0.00'; } catch(e) {}
      row++;
    }

    if (plData.totalExpense) sv(wsPI, 'N55', plData.totalExpense);

    /* Fix column M ("Other") width — template has it too narrow */
    try { wsPI.getColumn('M').width = 18; } catch(e) {}
  }

  /* ═══ P&L RAW IMPORT (new sheet) ═══ */
  if (plData && plData.items && plData.items.length > 0) {
    let wsRaw = wb.getWorksheet('P&L Raw Import');
    if (!wsRaw) wsRaw = wb.addWorksheet('P&L Raw Import');
    sv(wsRaw, 'A1', 'P&L Raw Import — ' + (practiceName || 'Practice'));
    sv(wsRaw, 'A3', 'Line Item'); sv(wsRaw, 'B3', 'Amount'); sv(wsRaw, 'C3', 'Category'); sv(wsRaw, 'D3', 'Notes');

    let rr = 5;
    /* Income items first */
    const incomeItems = plData.items.filter(i => i.section === 'Income');
    const cogsItems = plData.items.filter(i => i.section === 'COGS');
    const expenseItems = plData.items.filter(i => i.section !== 'Income' && i.section !== 'COGS');

    if (incomeItems.length > 0) {
      sv(wsRaw, 'A'+rr, 'INCOME'); rr++;
      for (const item of incomeItems) {
        sv(wsRaw, 'A'+rr, item.item); sv(wsRaw, 'B'+rr, item.amount); sv(wsRaw, 'C'+rr, 'Income'); rr++;
      }
      const totalSales = incomeItems.reduce((s,i) => s + i.amount, 0);
      sv(wsRaw, 'A'+rr, 'Total Sales'); sv(wsRaw, 'B'+rr, totalSales); sv(wsRaw, 'C'+rr, 'Income'); rr++;
    }
    if (plData.totalIncome) { sv(wsRaw, 'A'+rr, 'TOTAL INCOME'); sv(wsRaw, 'B'+rr, plData.totalIncome); sv(wsRaw, 'D'+rr, 'Net collections'); rr++; }
    rr++;
    if (cogsItems.length > 0) {
      sv(wsRaw, 'A'+rr, 'COST OF GOODS SOLD');
      const cogsTotal = cogsItems.reduce((s,i) => s + i.amount, 0);
      sv(wsRaw, 'B'+rr, cogsTotal); sv(wsRaw, 'C'+rr, 'COGS'); rr++;
      if (plData.totalIncome) { sv(wsRaw, 'A'+rr, 'GROSS PROFIT'); sv(wsRaw, 'B'+rr, plData.totalIncome - cogsTotal); rr++; }
      rr++;
    }
    sv(wsRaw, 'A'+rr, 'EXPENSES'); rr++;
    for (const item of expenseItems) {
      const cat = plCategory(item.item);
      sv(wsRaw, 'A'+rr, item.item);
      sv(wsRaw, 'B'+rr, item.amount);
      if (cat === null) {
        sv(wsRaw, 'C'+rr, 'EXCLUDED');
        sv(wsRaw, 'D'+rr, 'Non-cash — excluded');
        ['A','B','C','D'].forEach(col => {
          try { wsRaw.getCell(col+rr).font = { ...(wsRaw.getCell(col+rr).font||{}), strike: true }; } catch(e) {}
        });
      } else if (cat === 'O') {
        sv(wsRaw, 'C'+rr, 'Add-Back');
        sv(wsRaw, 'D'+rr, 'Owner — add-back');
      } else {
        const catNames = {F:'Dental Supplies',H:'Staff Costs',J:'Rent & Parking',K:'Marketing',L:'Office Supplies',M:'Other'};
        sv(wsRaw, 'C'+rr, catNames[cat] || 'Other');
      }
      rr++;
    }
    rr++;
    if (plData.totalExpense) { sv(wsRaw, 'A'+rr, 'TOTAL EXPENSES'); sv(wsRaw, 'B'+rr, plData.totalExpense); sv(wsRaw, 'D'+rr, 'Per P&L'); rr++; }
    rr++;
    if (plData.netIncome != null) { sv(wsRaw, 'A'+rr, 'NET INCOME'); sv(wsRaw, 'B'+rr, plData.netIncome); sv(wsRaw, 'D'+rr, 'Per P&L'); }

    /* Set column widths to prevent #### display */
    wsRaw.getColumn('A').width = 35;
    wsRaw.getColumn('B').width = 18;
    wsRaw.getColumn('C').width = 18;
    wsRaw.getColumn('D').width = 22;
  }

  /* ═══ P&L IMAGE ═══ */
  {
    let wsImg = wb.getWorksheet('P&L Image');
    if (!wsImg) wsImg = wb.addWorksheet('P&L Image');
    if (plImageB64) {
      try {
        /* Detect if JPEG (starts with /9j/) or PNG */
        const imgExt = plImageB64.startsWith('/9j/') ? 'jpeg' : 'png';
        const imageId = wb.addImage({
          base64: plImageB64,
          extension: imgExt,
        });
        /* Place image starting at A1, sized to roughly fill the visible area */
        wsImg.addImage(imageId, {
          tl: { col: 0, row: 0 },
          ext: { width: 750, height: 970 }
        });
        sv(wsImg, 'A1', '');  /* Clear any placeholder text */
        console.log('P&L image embedded successfully');
      } catch(imgErr) {
        console.warn('Could not embed P&L image:', imgErr.message);
        sv(wsImg, 'A1', 'P&L Image — could not embed (error: ' + imgErr.message + ')');
      }
    } else {
      sv(wsImg, 'A1', 'P&L Image — no image data provided');
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return {
    xlsxB64: Buffer.from(buf).toString('base64'),
    summary: {
      codesFound: codes.length,
      totalProduction: totalProd.toFixed(2),
      months: prodMonths,
      years,
      netCollections: collData?.payments || plData?.totalIncome || null,
      plParsed: plData !== null && plData.items.length > 0,
      arPatientTotal: arPatient?.total || null,
      arInsuranceTotal: arInsurance?.total || null,
      _debug: { usedInPW: usedInPW.size, directMatch: directMatchCount, unmatchedSample: sampleUnmatched }
    }
  };
}

/* ─── Handler ─── */
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return {statusCode:200, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST,OPTIONS'}, body:''};
  if (event.httpMethod !== 'POST') return {statusCode:405, body:'Method Not Allowed'};

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return {statusCode:400, headers:{'Access-Control-Allow-Origin':'*'}, body:JSON.stringify({error:'Invalid JSON'})}; }

  const { prodText, collText, plText, practiceName='', arPatient={}, arInsurance={}, plImageB64=null } = body;
  if (!prodText) return {statusCode:400, headers:{'Access-Control-Allow-Origin':'*'}, body:JSON.stringify({error:'prodText required'})};

  try {
    console.log('Building workbook from pre-parsed data...');
    const result = await buildXlsx(prodText, collText, plText, practiceName, arPatient, arInsurance, plImageB64);

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
