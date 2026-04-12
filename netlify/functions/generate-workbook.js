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
let _plInputExpenseNames = new Set();  // P&L expenses written to P&L Input sheet

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
   INJECT VALUES INTO TEMPLATE: Use JSZip to directly modify template XML.
   For sheets 1-8: Use regex to find and replace existing cells.
   For sheets 9-10: Convert ExcelJS shared strings to inline strings.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Inject collected cell values into template XML.
 * For sheets 1-8: direct regex injection preserving styles.
 * For sheets 9-10: resolve shared strings to inline strings.
 */
async function injectValuesIntoTemplate(templateBuf, sheetNameMap, sheets9to10Buf) {
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
    if (Object.keys(sheetCells).length === 0) {
      console.log(`Sheet ${sheetNum}: no collected data, skipping`);
      continue;
    }

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

      /* CRITICAL: Never overwrite template formulas */
      const templateHasFormula = fullMatch.includes('<f>') || fullMatch.includes('<f ');
      if (templateHasFormula) {
        _formulaSkip++;
        return fullMatch;
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
        styleId = '385'; /* P&L Input data style */
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
      /* G7, G9, G16-G18 are hardcoded 0 instead of formulas — add =E*F formulas */
      [7, 9, 16, 17, 18].forEach(r => {
        xml = xml.replace(
          new RegExp(`<c r="G${r}" s="642" t="n"><v>0</v></c>`),
          `<c r="G${r}" s="642"><f>E${r}*F${r}</f><v></v></c>`
        );
      });
      /* Remove benefits section (rows 34-42) — clear all cell content but keep rows for structure */
      for (let r = 34; r <= 42; r++) {
        /* Replace any cell with content in these rows with empty cell preserving style */
        xml = xml.replace(
          new RegExp(`<c\\s([^>]*?)r="([A-Z]+${r})"([^>]*)>.*?</c>`, 'gs'),
          (full, pre, ref, post) => {
            const styleMatch = full.match(/\ss="(\d+)"/);
            const styleAttr = styleMatch ? ` s="${styleMatch[1]}"` : '';
            return `<c r="${ref}"${styleAttr}/>`;
          }
        );
      }
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
      console.log('Budgetary P&L: fixed IFERROR and column widths');
    }

    /* ── P&L Input (sheet 8): ensure data rows are visible ── */
    if (sheetNum === 8) {
      /* Template has customHeight="1" which forces 12.75pt even if content overflows.
         Remove customHeight on data rows (6-50) so Excel auto-sizes, and set minimum 15pt. */
      xml = xml.replace(/<row\s+r="(\d+)"([^>]*)>/g, (full, rNum, attrs) => {
        const r = parseInt(rNum);
        if (r >= 6 && r <= 50) {
          /* Remove customHeight and ensure reasonable height */
          let newAttrs = attrs.replace(/\s*customHeight="1"/g, '');
          newAttrs = newAttrs.replace(/ht="[^"]*"/, 'ht="15"');
          return `<row r="${rNum}"${newAttrs}>`;
        }
        return full;
      });
      /* Widen column A for expense names */
      xml = xml.replace(/<col[^>]*min="1" max="1"[^>]*\/>/,
        '<col min="1" max="1" width="35" customWidth="1" style="385"/>');
      console.log('P&L Input: fixed row heights and column A width');
    }

    console.log(`Sheet ${sheetNum}: matched=${_regexMatches} hits=${_dataHits} replaced=${matched.size} formulaSkip=${_formulaSkip} newCells=${Object.values(newCellsByRow).flat().length}`);
    templateZip.file(xmlPath, xml);
  }

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

    /* Map ExcelJS sheets → template sheet9, sheet10 */
    const targetSheetNums = [9, 10];
    let hasSheet9 = false, hasSheet10 = false;
    for (let idx = 0; idx < excelSheetFiles.length && idx < 2; idx++) {
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
        /* ── P&L Raw Import (sheet 9): strikethrough expenses used in P&L Input ── */
        if (targetNum === 9 && _plInputExpenseNames.size > 0) {
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
        console.log(`ExcelJS ${srcPath} → ${targetPath}: converted shared strings to inline`);
      }
    }

    /* Copy rels for ExcelJS sheets, remapping to sheet9/10 */
    for (let idx = 0; idx < excelSheetFiles.length && idx < 2; idx++) {
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

    let workbookXml = await templateZip.file('xl/workbook.xml')?.async('string');
    if (workbookXml && (hasSheet9 || hasSheet10)) {
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

        if (hasSheet9 && !sheetsContent.includes('rId11')) {
          sheetsContent += `<sheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" name="P&amp;L Raw Import" sheetId="${maxId + 1}" state="visible" r:id="rId11"/>`;
        }
        if (hasSheet10 && !sheetsContent.includes('rId12')) {
          sheetsContent += `<sheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" name="P&amp;L Image" sheetId="${maxId + 2}" state="visible" r:id="rId12"/>`;
        }

        workbookXml = workbookXml.replace(sheetsPattern, `<sheets>${sheetsContent}</sheets>`);
        templateZip.file('xl/workbook.xml', workbookXml);
      }
    }

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

    /* Content_Types handled in post-processing from preserved original */
  }

  console.log('Template injection complete');

  /* ═══ PASS 1: Generate the xlsx from templateZip ═══ */
  const pass1Buf = await templateZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  console.log('Pass 1 output:', pass1Buf.length, 'bytes');

  /* ═══ PASS 2: Post-process — restore template styles, remove contamination ═══ */
  /* JSZip/ExcelJS contamination replaces the template's styles.xml (752 cellXfs)
     with a smaller ExcelJS version (~350 cellXfs) and injects sharedStrings.xml.
     This second pass loads the pass-1 output as a fresh zip and forcibly replaces
     the corrupted files with the originals saved at the start. */
  const fixZip = await JSZip.loadAsync(pass1Buf);

  /* Restore original template styles.xml — fix only the grey placeholder font */
  if (_originalStylesXml) {
    let stylesXml = _originalStylesXml;
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

    /* === Change yellow fill (FFFFFF00) to blue on Financial Overview payment category cells === */
    /* Fill 11 uses FFFFFF00 (yellow) — change to blue FF4472C4 */
    stylesXml = stylesXml.replace(
      /(<fill>[\s\S]*?<fgColor rgb=")FFFFFF00("[\s\S]*?<\/fill>)/g,
      (full, pre, post) => pre + 'FF4472C4' + post
    );
    console.log('Pass 2: changed yellow fills (FFFFFF00) to blue (FF4472C4)');

    fixZip.file('xl/styles.xml', stylesXml);
    console.log('Pass 2: restored styles.xml:', stylesXml.length, 'chars');
  }

  /* Restore template Content_Types and append additions for sheets 9-10 */
  if (_originalContentTypes) {
    let ct = _originalContentTypes;
    if (!ct.includes('sheet9.xml')) {
      ct = ct.replace(/<\/Types>/, '<Override PartName="/xl/worksheets/sheet9.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
    }
    if (!ct.includes('sheet10.xml')) {
      ct = ct.replace(/<\/Types>/, '<Override PartName="/xl/worksheets/sheet10.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
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
    console.log('Pass 2: restored Content_Types');
  }

  /* ═══ PASS 2 sheet-level fixes: column widths, IFERROR ═══ */
  /* These must happen in Pass 2 because ExcelJS contamination rewrites sheet XML
     during Pass 1, changing style="383" to style="1" and potentially resetting column widths. */
  const sheetFixes = {
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
      /* IFERROR on row 45 */
      ['B','C','D','E','F','G','H'].forEach(c => {
        xml = xml.replace(new RegExp(`<f>${c}44/I44</f>`), `<f>IFERROR(${c}44/I44,0)</f>`);
      });
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
      /* P&L Input: fix row heights and column A width */
      xml = xml.replace(/<row\s+r="(\d+)"([^>]*)>/g, (full, rNum, attrs) => {
        const r = parseInt(rNum);
        if (r >= 6 && r <= 50) {
          let a = attrs.replace(/\s*customHeight="1"/g, '');
          a = a.replace(/ht="[^"]*"/, 'ht="15"');
          return `<row r="${rNum}"${a}>`;
        }
        return full;
      });
      return xml;
    }
  };

  for (const [path, fixFn] of Object.entries(sheetFixes)) {
    let xml = await fixZip.file(path)?.async('string');
    if (xml) {
      xml = fixFn(xml);
      fixZip.file(path, xml);
      console.log('Pass 2: applied fixes to', path);
    }
  }

  /* Remove sharedStrings.xml (template has none — ExcelJS injects one) */
  if (fixZip.file('xl/sharedStrings.xml')) {
    fixZip.remove('xl/sharedStrings.xml');
    console.log('Pass 2: removed sharedStrings.xml');
  }

  /* Remove sharedStrings reference from workbook.xml.rels */
  let wbRels = await fixZip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (wbRels && wbRels.includes('sharedStrings')) {
    wbRels = wbRels.replace(/<Relationship[^>]*sharedStrings[^>]*\/>/g, '');
    fixZip.file('xl/_rels/workbook.xml.rels', wbRels);
    console.log('Pass 2: removed sharedStrings ref from workbook.xml.rels');
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

  const finalBuf = await fixZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  console.log('Pass 2 final output:', finalBuf.length, 'bytes');

  /* Double-verify the final buffer */
  const finalZip = await JSZip.loadAsync(finalBuf);
  const finalStyles = await finalZip.file('xl/styles.xml')?.async('string');
  if (finalStyles) {
    const fXfs = finalStyles.match(/cellXfs count="(\d+)"/);
    console.log('FINAL VERIFY: cellXfs=' + (fXfs?fXfs[1]:'?') + ' len=' + finalStyles.length);
  }

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
  /* Reset collectors for this invocation */
  _cellCollector = {};
  _acStrikeRows = [];
  _plInputExpenseNames = new Set();

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

  for (const [row, agg] of Object.entries(rightAgg)) {
    sv(wsPW, 'L'+row, agg.qty);
    sv(wsPW, 'M'+row, Math.round(agg.total*100)/100);
    sv(wsPW, 'N'+row, agg.qty > 0 ? Math.round(agg.total/agg.qty*100)/100 : 0);
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
    if (usedInPW.has(c.code)) { directMatchCount++; _acStrikeRows.push(r); }
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
  const primaryYear = years.length >= 2 ? years[1] : years[0] || new Date().getFullYear();
  sv(wsFO, 'E6', primaryYear);
  sv(wsFO, 'E20', Math.round(totalProd*100)/100);
  sv(wsFO, 'E21', prodMonths);

  if (collData && collData.payments) {
    sv(wsFO, 'F20', Math.round(collData.payments*100)/100);
    sv(wsFO, 'F21', collData.months || prodMonths);
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

  /* ═══ EMPLOYEE COSTS ═══ */
  if (employeeCosts) {
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

    /* Benefits section removed per client request — clear rows 34-42 */
    /* (template rows with sick pay, holidays, vacation, bonus, 401K, medical, dental, other) */

    console.log('Employee Costs: done');
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

  /* ═══ P&L RAW IMPORT & P&L IMAGE (sheets 9-10, ExcelJS-only) ═══ */
  let sheets9to10Buf = null;
  let needsSheets9to10 = (plData && plData.items && plData.items.length > 0) || plImageB64;

  if (needsSheets9to10) {
    const wbNewSheets = new ExcelJS.Workbook();

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

    sheets9to10Buf = await wbNewSheets.xlsx.writeBuffer();
    console.log('Sheets 9-10 ExcelJS buffer written:', sheets9to10Buf.byteLength, 'bytes');
  }

  /* Now inject collected cell values into template, along with sheets 9-10 if present */
  const injStart = Date.now();
  const elapsed = injStart - t0;
  console.log('Time before injection:', elapsed, 'ms');

  const finalBuf = await injectValuesIntoTemplate(templateBuf, sheetNameMap, sheets9to10Buf);
  const injTime = Date.now() - injStart;
  const totalTime = Date.now() - t0;
  console.log('Injection complete in', injTime, 'ms, total:', totalTime, 'ms, output:', finalBuf.length, 'bytes');

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
      _version: 'v8-pass2-sheet-fixes',
      _debug: { usedInPW: usedInPW.size, directMatch: directMatchCount, unmatchedSample: sampleUnmatched },
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
