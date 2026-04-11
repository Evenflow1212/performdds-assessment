'use strict';
const ExcelJS = require('exceljs');
const fetch   = require('node-fetch');
const JSZip   = require('jszip');
const fs      = require('fs');
const path    = require('path');

/* Module-level template cache — survives across warm invocations */
let _cachedTemplateBuf = null;

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

/* ═══════════════════════════════════════════════════════════════════════════
   POST-PROCESSING: Merge ExcelJS cell values into the original template ZIP.
   ExcelJS corrupts template styles (drops 752→295 cellXfs), causing Excel
   to show a repair dialog. This function surgically injects ExcelJS values
   into the original template while preserving all XML structure and styling.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Extract cell values from ExcelJS output and inject into original template.
 * Preserves template styles, merges, and all formatting.
 */
async function postProcessServerSide(excelJsBuf, templateBuf) {
  const excelJsZip = await JSZip.loadAsync(excelJsBuf);
  const templateZip = await JSZip.loadAsync(templateBuf);

  /* Extract cell values from ExcelJS output sheets (worksheets 1-8) */
  const excelJsCells = {};
  for (let sheetNum = 1; sheetNum <= 8; sheetNum++) {
    const xmlPath = `xl/worksheets/sheet${sheetNum}.xml`;
    const xml = await excelJsZip.file(xmlPath)?.async('string');
    if (!xml) continue;

    excelJsCells[sheetNum] = {};
    /* Parse cells from ExcelJS output */
    const cellPattern = /<c\s+r="([^"]+)"(?:\s+s="(\d+)")?(?:\s+t="([^"]*)")?[^>]*>([^<]*(?:<[^>]*>[^<]*)*)<\/c>/g;
    let match;
    while ((match = cellPattern.exec(xml)) !== null) {
      const cellRef = match[1];
      const styleIdx = match[2];
      const cellType = match[3] || '';
      const cellContent = match[4];

      /* Extract value: look for <v>...</v> or <f>...</f> or <is>...</is> */
      let value = null;
      let isFormula = false;
      let isInlineStr = false;

      if (cellContent.includes('<f>')) {
        const fMatch = cellContent.match(/<f[^>]*>([^<]*)<\/f>/);
        if (fMatch) {
          value = fMatch[1];
          isFormula = true;
        }
      } else if (cellContent.includes('<is>')) {
        const isMatch = cellContent.match(/<is>(?:<t[^>]*>)?([^<]*)/);
        if (isMatch) {
          value = isMatch[1];
          isInlineStr = true;
        }
      } else {
        const vMatch = cellContent.match(/<v>([^<]*)<\/v>/);
        if (vMatch) {
          value = vMatch[1];
        }
      }

      excelJsCells[sheetNum][cellRef] = {
        value,
        isFormula,
        isInlineStr,
        styleIdx
      };
    }
  }

  /* Process template sheets (1-8) and inject values — SINGLE-PASS approach.
     Instead of running one regex per ExcelJS cell (O(n*m) on huge XML), we do
     ONE global regex pass through the template XML, replacing cells in-place. */
  for (let sheetNum = 1; sheetNum <= 8; sheetNum++) {
    const xmlPath = `xl/worksheets/sheet${sheetNum}.xml`;
    let xml = await templateZip.file(xmlPath)?.async('string');
    if (!xml) continue;

    const sheetCells = excelJsCells[sheetNum] || {};
    if (Object.keys(sheetCells).length === 0) continue;

    /* Track which ExcelJS cells were matched (for inserting unmatched ones later) */
    const matched = new Set();

    /* Single-pass: find every <c> tag in the template and replace if we have data */
    xml = xml.replace(/<c\s[^>]*?r="([^"]+)"[^/>]*(?:\/?>(?:[^]*?<\/c>)?)/gs, (fullMatch, cellRef) => {
      const cellData = sheetCells[cellRef];
      if (!cellData || cellData.value === null || cellData.value === undefined) return fullMatch;

      const { value, isFormula, isInlineStr } = cellData;
      const templateHasFormula = fullMatch.includes('<f>') || fullMatch.includes('<f ');

      /* CRITICAL: Never overwrite a template formula with a plain value */
      if (templateHasFormula && !isFormula) return fullMatch;

      /* Skip if template has same inline string label */
      if (fullMatch.includes('<is>') && isInlineStr) {
        const tMatch = fullMatch.match(/<t[^>]*>([^<]*)<\/t>/);
        if (tMatch && tMatch[1] === value) return fullMatch;
      }

      matched.add(cellRef);

      /* Preserve the template's style attribute */
      const styleMatch = fullMatch.match(/\ss="(\d+)"/);
      const styleAttr = styleMatch ? ` s="${styleMatch[1]}"` : '';

      if (isFormula) {
        return `<c r="${cellRef}"${styleAttr}><f>${escapeXml(value)}</f></c>`;
      } else if (typeof value === 'string' || isInlineStr) {
        return `<c r="${cellRef}"${styleAttr} t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
      } else {
        return `<c r="${cellRef}"${styleAttr} t="n"><v>${escapeXml(String(value))}</v></c>`;
      }
    });

    /* Insert cells that weren't in the template (new cells from ExcelJS) */
    const newCellsByRow = {};
    for (const [cellRef, cellData] of Object.entries(sheetCells)) {
      if (matched.has(cellRef)) continue;
      if (cellData.value === null || cellData.value === undefined) continue;

      const { value, isFormula, isInlineStr } = cellData;
      const rowNum = cellRef.match(/\d+$/)[0];

      let cellXml;
      if (isFormula) {
        cellXml = `<c r="${cellRef}" s="0"><f>${escapeXml(value)}</f></c>`;
      } else if (typeof value === 'string' || isInlineStr) {
        cellXml = `<c r="${cellRef}" s="0" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
      } else {
        cellXml = `<c r="${cellRef}" s="0" t="n"><v>${escapeXml(String(value))}</v></c>`;
      }

      if (!newCellsByRow[rowNum]) newCellsByRow[rowNum] = [];
      newCellsByRow[rowNum].push(cellXml);
    }

    /* Batch-insert new cells into their rows (single pass per row group) */
    for (const [rowNum, cells] of Object.entries(newCellsByRow)) {
      const rowPattern = new RegExp(`(<row\\s+r="${rowNum}"[^>]*>)`);
      const rowMatch = xml.match(rowPattern);
      if (rowMatch) {
        xml = xml.replace(rowPattern, rowMatch[1] + cells.join(''));
      } else {
        xml = xml.replace(/<\/sheetData>/, `<row r="${rowNum}">${cells.join('')}</row></sheetData>`);
      }
    }

    console.log(`Sheet ${sheetNum}: ${matched.size} cells replaced, ${Object.keys(newCellsByRow).length} rows with new cells`);
    templateZip.file(xmlPath, xml);
  }

  /* Copy sheets 9 and 10 from ExcelJS (P&L Raw Import and P&L Image) */
  for (let sheetNum = 9; sheetNum <= 10; sheetNum++) {
    const xmlPath = `xl/worksheets/sheet${sheetNum}.xml`;
    const xml = await excelJsZip.file(xmlPath)?.async('string');
    if (xml) {
      templateZip.file(xmlPath, xml);
    }
  }

  /* Check for new sheets from ExcelJS */
  const hasSheet9 = excelJsZip.file('xl/worksheets/sheet9.xml');
  const hasSheet10 = excelJsZip.file('xl/worksheets/sheet10.xml');

  /* Update workbook.xml to reference sheets 9 and 10 if they exist */
  let workbookXml = await templateZip.file('xl/workbook.xml')?.async('string');
  if (workbookXml) {

    if (hasSheet9 || hasSheet10) {
      /* Find the sheets element and its content */
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

        if (hasSheet9) {
          const sheet9Name = 'P&amp;L Raw Import';
          if (!sheetsContent.includes('rId11')) {
            sheetsContent += `<sheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" name="${sheet9Name}" sheetId="${maxId + 1}" state="visible" r:id="rId11"/>`;
          }
        }

        if (hasSheet10) {
          const sheet10Name = 'P&amp;L Image';
          if (!sheetsContent.includes('rId12')) {
            sheetsContent += `<sheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" name="${sheet10Name}" sheetId="${maxId + 2}" state="visible" r:id="rId12"/>`;
          }
        }

        workbookXml = workbookXml.replace(sheetsPattern, `<sheets>${sheetsContent}</sheets>`);
        templateZip.file('xl/workbook.xml', workbookXml);
      }
    }
  }

  /* Update xl/_rels/workbook.xml.rels to add relationship entries for new sheets */
  let wbRelsXml = await templateZip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (wbRelsXml) {
    if (hasSheet9 && !wbRelsXml.includes('sheet9.xml')) {
      wbRelsXml = wbRelsXml.replace(/<\/Relationships>/, '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet9.xml" Id="rId11"/></Relationships>');
    }
    if (hasSheet10 && !wbRelsXml.includes('sheet10.xml')) {
      wbRelsXml = wbRelsXml.replace(/<\/Relationships>/, '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet10.xml" Id="rId12"/></Relationships>');
    }
    templateZip.file('xl/_rels/workbook.xml.rels', wbRelsXml);
  }

  /* Copy any related files for new sheets (images, rels) from ExcelJS output */
  for (const filePath of Object.keys(excelJsZip.files)) {
    /* Copy sheet rels (e.g. xl/worksheets/_rels/sheet9.xml.rels, sheet10.xml.rels) */
    if (filePath.match(/xl\/worksheets\/_rels\/sheet(9|10)\.xml\.rels/)) {
      const content = await excelJsZip.file(filePath)?.async('nodebuffer');
      if (content) templateZip.file(filePath, content);
    }
    /* Copy images from xl/media/ */
    if (filePath.startsWith('xl/media/') && !templateZip.file(filePath)) {
      const content = await excelJsZip.file(filePath)?.async('nodebuffer');
      if (content) templateZip.file(filePath, content);
    }
    /* Copy drawing files referenced by new sheets */
    if (filePath.match(/xl\/drawings\/(drawing|_rels)/) && !templateZip.file(filePath)) {
      const content = await excelJsZip.file(filePath)?.async('nodebuffer');
      if (content) templateZip.file(filePath, content);
    }
  }

  /* Update [Content_Types].xml for new sheets and images */
  let contentTypesXml = await templateZip.file('[Content_Types].xml')?.async('string');
  if (contentTypesXml) {
    if (hasSheet9 && !contentTypesXml.includes('sheet9.xml')) {
      contentTypesXml = contentTypesXml.replace(/<\/Types>/, '<Override PartName="/xl/worksheets/sheet9.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
    }

    if (hasSheet10 && !contentTypesXml.includes('sheet10.xml')) {
      contentTypesXml = contentTypesXml.replace(/<\/Types>/, '<Override PartName="/xl/worksheets/sheet10.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
    }

    /* Add image content type if not already present */
    if (!contentTypesXml.includes('Extension="jpeg"') && !contentTypesXml.includes('Extension="jpg"')) {
      contentTypesXml = contentTypesXml.replace(/<\/Types>/, '<Default Extension="jpeg" ContentType="image/jpeg"/></Types>');
    }
    /* Add drawing Override entries for any drawings we copied */
    for (const filePath of Object.keys(excelJsZip.files)) {
      if (filePath.match(/^xl\/drawings\/drawing\d+\.xml$/) && !contentTypesXml.includes(filePath)) {
        contentTypesXml = contentTypesXml.replace(/<\/Types>/, `<Override PartName="/${filePath}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
      }
    }

    templateZip.file('[Content_Types].xml', contentTypesXml);
  }

  console.log('Post-processing: injected values into template, preserved styles');

  /* Generate final buffer */
  const finalBuf = await templateZip.generateAsync({ type: 'nodebuffer' });
  return finalBuf;
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
async function buildXlsx(prodText, collText, plText, practiceName, arPatient, arInsurance, hygieneData, employeeCosts, plImageB64) {
  /* Parse the Claude output text into structured data */
  const prodData = parseProduction(prodText || '');
  const collData = collText ? parseCollections(collText) : null;
  const plData = plText ? parsePL(plText) : null;

  const { codes, months: prodMonths, years } = prodData;
  const totalProd = codes.reduce((s,c) => s + c.total, 0);

  console.log('Parsed:', codes.length, 'codes,', prodMonths, 'months, years:', years.join(','));
  if (collData) console.log('Collections:', collData.payments, 'over', collData.months, 'months');
  if (plData) console.log('P&L:', plData.items.length, 'items, income:', plData.totalIncome);

  /* Load template — from local bundled file (fast) or module cache (instant on warm) */
  let wb, templateBuf;
  const t0 = Date.now();
  try {
    if (_cachedTemplateBuf) {
      templateBuf = _cachedTemplateBuf;
      console.log('Template from cache:', templateBuf.length, 'bytes in', Date.now()-t0, 'ms');
    } else {
      /* Try local file first (bundled via included_files), then HTTP fallback */
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
      _cachedTemplateBuf = templateBuf;  /* Cache for warm invocations */
    }
    const t1 = Date.now();
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(templateBuf));
    console.log('ExcelJS loaded in', Date.now()-t1, 'ms, sheets:', wb.worksheets.map(s=>s.name).join(', '));
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

  /* Fix formula cells that have numFmt=General — they show raw decimals.
     E column = per-month qty (should be integer), N column = avg fee (should be $) */
  const pwIntCells = ['E10','E11','E12','E13','E16','E17','E18','E21','E22','E23','E24','E25','E26','E30','E31','E32','E34','E35','E36'];
  pwIntCells.forEach(addr => { try { wsPW.getCell(addr).numFmt = '#,##0'; } catch(e) {} });
  const pwDollarGeneral = ['N9','N18','N40','N47','N55','N68'];
  pwDollarGeneral.forEach(addr => { try { wsPW.getCell(addr).numFmt = '$#,##0.00'; } catch(e) {} });
  /* G6 per-month production */
  try { wsPW.getCell('G6').numFmt = '$#,##0'; } catch(e) {}

  /* Production Worksheet row heights */
  try { wsPW.getRow(4).height = 30; } catch(e) {}

  /* ═══ ALL CODES - PRODUCTION REPORT ═══ */
  /* Wipe the existing sheet IN PLACE (preserves tab order) then write fresh.
     Use cell.style = {...} to completely replace all formatting. */
  for (let r = 1; r <= 250; r++) {
    ['A','B','C','D','E','F'].forEach(col => {
      try {
        const cell = wsAC.getCell(col + r);
        cell.value = null;
        cell.style = {};
      } catch(e) {}
    });
    try { const row = wsAC.getRow(r); row.style = {}; row.font = undefined; } catch(e) {}
  }
  ['A','B','C','D','E','F'].forEach(col => {
    try { wsAC.getColumn(col).style = {}; } catch(e) {}
  });

  /* Header row */
  const acHeaders = ['Code', 'Description', 'Quantity', 'Total $', 'Avg Fee', '% of Prod'];
  acHeaders.forEach((h, i) => {
    const cell = wsAC.getCell(1, i + 1);
    cell.value = h;
    cell.style = {
      font: { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } },
      alignment: { horizontal: 'center', vertical: 'center' }
    };
  });
  wsAC.getColumn('A').width = 12;
  wsAC.getColumn('B').width = 44;
  wsAC.getColumn('C').width = 10;
  wsAC.getColumn('D').width = 14;
  wsAC.getColumn('E').width = 12;
  wsAC.getColumn('F').width = 16;
  /* Header row height */
  try { wsAC.getRow(1).height = 19.5; } catch(e) {}

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

    const usedStyle = {
      font: { name: 'Verdana', size: 10, strike: true },
      alignment: { vertical: 'center' }
    };
    const cleanStyle = {
      font: { name: 'Verdana', size: 10, strike: false },
      alignment: { vertical: 'center' }
    };
    const baseStyle = isUsed ? usedStyle : cleanStyle;

    wsAC.getCell('A'+r).value = c.code;
    wsAC.getCell('A'+r).style = baseStyle;
    wsAC.getCell('B'+r).value = c.desc;
    wsAC.getCell('B'+r).style = baseStyle;
    wsAC.getCell('C'+r).value = c.qty;
    wsAC.getCell('C'+r).style = { ...baseStyle, numFmt: '#,##0', alignment: { horizontal: 'right', vertical: 'center' } };
    wsAC.getCell('D'+r).value = Math.round(c.total*100)/100;
    wsAC.getCell('D'+r).style = { ...baseStyle, numFmt: '$#,##0.00', alignment: { horizontal: 'right', vertical: 'center' } };
    wsAC.getCell('E'+r).value = c.qty > 0 ? Math.round(c.total/c.qty*100)/100 : 0;
    wsAC.getCell('E'+r).style = { ...baseStyle, numFmt: '$#,##0.00', alignment: { horizontal: 'right', vertical: 'center' } };
    wsAC.getCell('F'+r).value = totalProd > 0 ? Math.round(c.total/totalProd*10000)/10000 : 0;
    wsAC.getCell('F'+r).style = { ...baseStyle, numFmt: '0.00%', alignment: { horizontal: 'right', vertical: 'center' } };
  });

  /* Set data row heights for All Codes (master template uses 15.0) — only data rows */
  for (let r = 2; r <= allCodes.length + 1; r++) {
    try { wsAC.getRow(r).height = 15.0; } catch(e) {}
  }
  /* Reset trailing blank rows to default (12.75) */
  for (let r = allCodes.length + 2; r <= 200; r++) {
    try { wsAC.getRow(r).height = 12.75; } catch(e) {}
  }

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

  /* NOTE: Financial Overview styling MINIMIZED — using cell.style={...} on cells
     that don't have explicit values was causing corruption. Only format cells
     where we wrote data. Template already has correct styles for most cells. */
  ['D32','D33','E32','F32','G32','H32','E33','F33','G33','H33'].forEach(addr => {
    try { wsFO.getCell(addr).numFmt = '$#,##0.00'; } catch(e) {}
  });

  /* ═══ HYGIENE SCHEDULE ═══ */
  /* 3 weeks recent past (rows 10-12), next 7 days (rows 19-20),
     3 weeks near future (rows 25-27), 2 weeks future future (rows 34-35).
     All data rows get zeros. Dates pre-populated relative to today. */
  {
    const wsHS = wb.getWorksheet('Hygiene Schedule');
    if (wsHS) {
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
        dataCols.forEach(col => { if (!wsHS.getCell(col+r).value) sv(wsHS, col+r, 0); });
      }

      /* Next 7 days date context */
      sv(wsHS, 'E18', fmtWeek(thisMonday));
      /* Ensure next-7-days rows have zeros (rows 19-20, C-N) */
      for (let r = 19; r <= 20; r++) {
        dataCols.forEach(col => { if (!wsHS.getCell(col+r).value) sv(wsHS, col+r, 0); });
      }

      /* Near future: 3 weeks forward (rows 25-27). Row 28 left blank (eliminated). */
      for (let i = 0; i < 3; i++) {
        const mon = getMonday(1 + i);
        sv(wsHS, 'B' + (25 + i), fmtWeek(mon));
      }
      for (let r = 25; r <= 27; r++) {
        dataCols.forEach(col => { if (!wsHS.getCell(col+r).value) sv(wsHS, col+r, 0); });
      }

      /* Future future: 2 weeks after near future (rows 34-35) */
      for (let i = 0; i < 2; i++) {
        const mon = getMonday(4 + i); /* starts week 4 (right after 3 near-future weeks) */
        sv(wsHS, 'B' + (34 + i), fmtWeek(mon));
      }
      for (let r = 34; r <= 35; r++) {
        dataCols.forEach(col => { if (!wsHS.getCell(col+r).value) sv(wsHS, col+r, 0); });
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
        /* RDH scheduled per day (row 7: C, E, G, I) */
        if (hygieneData.rdhPerDay) {
          const rdhCols = ['C','E','G','I'];
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

      console.log('Hygiene Schedule: populated week dates relative to', thisMonday.toISOString().slice(0,10));
    }
  }

  /* ═══ EMPLOYEE COSTS ═══ */
  if (employeeCosts) {
    const wsEC = wb.getWorksheet('Employee Costs');
    if (wsEC) {
      console.log('Writing Employee Costs data...');
      /* Staff positions: name→D, rate→E, hours→F (G has formulas for monthly cost) */
      const staffRowMap = { om: 7, f1: 9, f2: 10, f3: 11, f4: 12, f5: 13, b1: 16, b2: 17, b3: 18, b4: 19, b5: 14 };
      /* Relabel row 14 from "front6" to "back 5" */
      sv(wsEC, 'C14', 'back 5');
      if (employeeCosts.staff) {
        employeeCosts.staff.forEach(p => {
          const r = staffRowMap[p.key] || p.row;
          if (r) {
            if (p.name) sv(wsEC, 'D' + r, p.name);
            if (p.rate) { sv(wsEC, 'E' + r, p.rate); try { wsEC.getCell('E' + r).numFmt = '#,##0.00'; } catch(e) {} }
            if (p.hours) { sv(wsEC, 'F' + r, p.hours); try { wsEC.getCell('F' + r).numFmt = '#,##0'; } catch(e) {} }
            /* Ensure monthly cost formula exists */
            try { wsEC.getCell('G' + r).value = { formula: 'E' + r + '*F' + r }; wsEC.getCell('G' + r).numFmt = '#,##0.00'; } catch(e) {}
          }
        });
      }
      /* Staff benefits & employment cost % */
      if (employeeCosts.staffBenefits) sv(wsEC, 'G22', employeeCosts.staffBenefits);
      if (employeeCosts.staffEmpCostPct && employeeCosts.staffEmpCostPct !== 0.10) {
        /* Update formula with custom % instead of default 10% */
        try { wsEC.getCell('G21').value = { formula: 'G20*' + employeeCosts.staffEmpCostPct }; } catch(e) {}
      }

      /* Hygiene positions: name→D, rate→E, hours→F
         Template has RDH 1-3 at rows 27-29. If h4/h5 have data,
         insert rows after 29 and adjust summary formulas. */
      const extraHyg = (employeeCosts.hygiene || []).filter(p => p.key === 'h4' || p.key === 'h5');
      const extraCount = extraHyg.length;
      if (extraCount > 0) {
        /* Insert rows after row 29 for extra RDH positions */
        try { wsEC.spliceRows(30, 0, ...Array(extraCount).fill([])); } catch(e) {
          console.warn('spliceRows failed, inserting manually');
          for (let i = 0; i < extraCount; i++) {
            try { wsEC.insertRow(30 + i, []); } catch(e2) {}
          }
        }
        /* Write extra RDH labels and formulas */
        extraHyg.forEach((p, i) => {
          const r = 30 + i;
          sv(wsEC, 'C' + r, p.label || ('rdh ' + (4 + i)));
          try { wsEC.getCell('G' + r).value = { formula: 'E' + r + '*F' + r }; } catch(e) {}
        });
        /* Fix summary formulas shifted down by extraCount */
        const wRow = 30 + extraCount;      // wages row
        const eRow = wRow + 1;              // employment costs row
        const bRow = wRow + 2;              // benefits row
        const tRow = wRow + 3;              // hygiene total row
        try { wsEC.getCell('G' + wRow).value = { formula: 'SUM(G27:G' + (29 + extraCount) + ')' }; } catch(e) {}
        try { wsEC.getCell('G' + eRow).value = { formula: 'G' + wRow + '*0.1' }; } catch(e) {}
        /* benefits value at bRow, total at tRow */
        try { wsEC.getCell('G' + tRow).value = { formula: 'G' + wRow + '+G' + eRow + '+G' + bRow }; } catch(e) {}
      }

      /* Write all hygiene position data (h1-h5) */
      const hygBaseMap = { h1: 27, h2: 28, h3: 29, h4: 30, h5: 31 };
      if (employeeCosts.hygiene) {
        employeeCosts.hygiene.forEach(p => {
          const r = hygBaseMap[p.key] || p.row;
          if (r) {
            if (p.name) sv(wsEC, 'D' + r, p.name);
            if (p.rate) { sv(wsEC, 'E' + r, p.rate); try { wsEC.getCell('E' + r).numFmt = '#,##0.00'; } catch(e) {} }
            if (p.hours) { sv(wsEC, 'F' + r, p.hours); try { wsEC.getCell('F' + r).numFmt = '#,##0'; } catch(e) {} }
            try { wsEC.getCell('G' + r).value = { formula: 'E' + r + '*F' + r }; wsEC.getCell('G' + r).numFmt = '#,##0.00'; } catch(e) {}
          }
        });
      }

      /* Hygiene benefits & employment cost % (row shifts if extra RDH added) */
      const hygBenRow = 32 + extraCount;
      const hygEmpRow = 31 + extraCount;
      if (employeeCosts.hygBenefits) sv(wsEC, 'G' + hygBenRow, employeeCosts.hygBenefits);
      if (employeeCosts.hygEmpCostPct && employeeCosts.hygEmpCostPct !== 0.10) {
        try { wsEC.getCell('G' + hygEmpRow).value = { formula: 'G' + (30 + extraCount) + '*' + employeeCosts.hygEmpCostPct }; } catch(e) {}
      }

      /* Benefits policy notes (rows shift if extra RDH added) */
      const benOffset = extraCount;
      if (employeeCosts.benefits) {
        const benMap = { sick: 35 + benOffset, holidays: 36 + benOffset, vacation: 37 + benOffset, bonus: 38 + benOffset, k401: 39 + benOffset, medical: 40 + benOffset, dental: 41 + benOffset, other: 42 + benOffset };
        Object.entries(employeeCosts.benefits).forEach(([key, val]) => {
          if (val && benMap[key]) sv(wsEC, 'D' + benMap[key], val);
        });
      }

      console.log('Employee Costs: done');
    }
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

    let row = 6;
    for (const item of expenseOnly) {
      if (row > 47) break; /* NEVER write past row 47 — row 48+ are summary formulas */
      const col = plCategory(item.item);
      if (col === null) continue;
      sv(wsPI, 'A'+row, item.item);
      sv(wsPI, col+row, item.amount);
      row++;
    }
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
      } else if (cat === 'O') {
        sv(wsRaw, 'C'+rr, 'Add-Back');
        sv(wsRaw, 'D'+rr, 'Owner — add-back');
      } else {
        const catNames = {F:'Dental Supplies',H:'Staff Costs',J:'Rent & Parking',K:'Marketing',L:'Office Supplies',M:'Other'};
        sv(wsRaw, 'C'+rr, catNames[cat] || 'Other');
      }
      /* Strikethrough ALL expense items — MUST use cell.style to override template styles */
      ['A','B','C','D'].forEach(col => {
        try {
          const c = wsRaw.getCell(col+rr);
          c.style = { font: { name: 'Verdana', size: 10, strike: true, color: { argb: 'FF888888' } } };
        } catch(e) {}
      });
      rr++;
    }
    rr++;
    if (plData.totalExpense) { sv(wsRaw, 'A'+rr, 'TOTAL EXPENSES'); sv(wsRaw, 'B'+rr, plData.totalExpense); sv(wsRaw, 'D'+rr, 'Per P&L'); rr++; }
    rr++;
    if (plData.netIncome != null) { sv(wsRaw, 'A'+rr, 'NET INCOME'); sv(wsRaw, 'B'+rr, plData.netIncome); sv(wsRaw, 'D'+rr, 'Per P&L'); }

    /* Set column widths to match master template */
    wsRaw.getColumn('A').width = 35;
    wsRaw.getColumn('B').width = 15;
    wsRaw.getColumn('C').width = 18;
    wsRaw.getColumn('D').width = 30;

    /* Bold header cells (this is a new sheet, so no template corruption risk) */
    ['A1','A3','B3','C3','D3'].forEach(addr => {
      try { wsRaw.getCell(addr).font = { name: 'Verdana', size: 10, bold: true }; } catch(e) {}
    });
  }

  /* ═══ P&L IMAGE — embed using ExcelJS native image support ═══ */
  {
    let wsImg = wb.getWorksheet('P&L Image');
    if (!wsImg) wsImg = wb.addWorksheet('P&L Image');
    if (plImageB64) {
      try {
        const imgBuf = Buffer.from(plImageB64, 'base64');
        const imageId = wb.addImage({ buffer: imgBuf, extension: 'jpeg' });
        wsImg.addImage(imageId, {
          tl: { col: 0, row: 0 },
          br: { col: 10, row: 50 }
        });
        console.log('P&L image embedded server-side, size:', imgBuf.length, 'bytes');
      } catch(imgErr) {
        console.warn('Could not embed P&L image:', imgErr.message);
        sv(wsImg, 'A1', 'P&L image could not be embedded');
      }
    } else {
      sv(wsImg, 'A1', '');
    }
  }

  /* NOTE: Per-sheet theme color fixes REMOVED — iterating over empty styled cells
     (PW col H, FO col J, TG col F, BP col K) was causing ExcelJS to instantiate
     those cells and corrupt their values during serialization. Some yellow fills
     may appear in notes columns, but this is cosmetic — data integrity is preserved.
     If yellow fills are unacceptable, fix them ONLY on cells that have actual values. */

  /* NOTE: Global yellow-to-white sweep REMOVED — it was causing ExcelJS to
     instantiate empty styled cells and corrupt their values (style indices
     appearing as cell values, e.g. $612-$623 in Financial Overview).
     Per-sheet targeted fixes above handle the known problem cells. */

  /* NOTE: Global font fix REMOVED — iterating every cell in every sheet (including
     empty styled cells) was causing ExcelJS to instantiate cells and corrupt them
     during serialization. Style indices were being written as cell values (e.g.
     $612-$623 in Financial Overview column C, "745"/"746" in P&L Input).
     Font corrections are now applied ONLY to cells where we explicitly set values. */

  /* ═══ FIX TAB ORDER ═══ */
  /* ExcelJS may reorder sheets. Force the correct order by rebuilding _worksheets.
     The _worksheets array is 1-based (index 0 = undefined). */
  const desiredOrder = [
    'Production Worksheet',
    'All Codes - Production Report',
    'Hygiene Schedule',
    'Financial Overview',
    'Targets & Goal',
    'Employee Costs',
    'Budgetary P&L',
    'P&L Input',
    'P&L Raw Import',
    'P&L Image'
  ];
  const ordered = [];
  for (const name of desiredOrder) {
    const ws = wb.getWorksheet(name);
    if (ws) ordered.push(ws);
  }
  /* Include any extra sheets not in the desired list */
  for (const ws of wb.worksheets) {
    if (!ordered.includes(ws)) ordered.push(ws);
  }
  /* Rebuild the internal array and reassign IDs */
  wb._worksheets = [undefined];
  ordered.forEach((ws, i) => {
    ws.id = i + 1;
    ws.orderNo = i;
    wb._worksheets.push(ws);
  });
  console.log('Tab order fixed:', wb.worksheets.map(s=>s.name).join(', '));

  const excelJsBuf = await wb.xlsx.writeBuffer();
  console.log('ExcelJS buffer written:', excelJsBuf.byteLength, 'bytes');

  /* Post-process: surgically inject ExcelJS values into original template to preserve styles.
     Skip if template is not available (e.g. fetch failed) or if env var disables it. */
  let finalBuf;
  const ppStart = Date.now();
  const elapsed = ppStart - t0;
  console.log('Time before post-processing:', elapsed, 'ms');

  /* If we've used more than 18s already, skip post-processing to avoid timeout */
  if (elapsed > 18000) {
    console.warn('Skipping post-processing — already at', elapsed, 'ms');
    finalBuf = Buffer.from(excelJsBuf);
  } else {
    try {
      finalBuf = await postProcessServerSide(Buffer.from(excelJsBuf), templateBuf);
      console.log('Post-processing complete in', Date.now()-ppStart, 'ms,', finalBuf.length, 'bytes');
    } catch (ppErr) {
      console.error('Post-processing failed, using ExcelJS output:', ppErr.message);
      finalBuf = Buffer.from(excelJsBuf);
    }
  }

  return {
    xlsxB64: finalBuf.toString('base64'),
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

  const { prodText, collText, plText, practiceName='', arPatient={}, arInsurance={}, hygieneData=null, employeeCosts=null, plImageB64=null } = body;
  if (!prodText) return {statusCode:400, headers:{'Access-Control-Allow-Origin':'*'}, body:JSON.stringify({error:'prodText required'})};

  try {
    console.log('Building workbook from pre-parsed data...');
    const result = await buildXlsx(prodText, collText, plText, practiceName, arPatient, arInsurance, hygieneData, employeeCosts, plImageB64);

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
