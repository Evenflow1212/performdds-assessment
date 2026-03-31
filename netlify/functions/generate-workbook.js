'use strict';
const ExcelJS = require('exceljs');

const CODE_MAP={D0120:'exam_periodic',D0140:'exam_focused',D0150:'exam_comprehensive',D0170:'exam_other',D0180:'exam_perio',D0210:'imaging_fmx',D0220:'imaging_other',D0230:'imaging_other',D0270:'imaging_other',D0272:'imaging_other',D0273:'imaging_other',D0274:'imaging_bw4',D0330:'imaging_pano',D0340:'imaging_other',D1110:'hyg_adult_prophy',D1120:'hyg_child_prophy',D4341:'hyg_srp',D4342:'hyg_srp',D4346:'hyg_irrigation',D4381:'hyg_arestin',D4910:'hyg_perio_maint',D2740:'cb_2740',D2750:'cb_2750',D2962:'oc_veneers',D6057:'oc_implant_crown',D6058:'oc_implant_crown',D6059:'oc_implant_crown',D6060:'oc_implant_crown',D6061:'oc_implant_crown',D6062:'oc_implant_crown',D6063:'oc_implant_crown',D6064:'oc_implant_crown',D6065:'oc_implant_crown',D6245:'bridge_pontic',D6740:'bridge_pontic',D2510:'cb_inlay_onlay',D2520:'cb_inlay_onlay',D2530:'cb_inlay_onlay',D2542:'cb_inlay_onlay',D2543:'cb_inlay_onlay',D2544:'cb_inlay_onlay',D8090:'ortho_comp_adult',D8040:'ortho_limited',D8681:'ortho_retention',D5110:'den_complete',D5120:'den_complete',D5213:'den_partial_cast',D5214:'den_partial_cast',D5820:'den_interim',D5821:'den_interim',D3310:'endo_anterior',D3320:'endo_bicuspid',D3330:'endo_molar',D3332:'endo_retreat',D3346:'endo_retreat',D3347:'endo_retreat',D3348:'endo_retreat',D4249:'perio_crown_length',D4211:'perio_gingivectomy',D7140:'os_ext_simple',D7210:'os_ext_surgical',D6010:'os_implant_surgical',D7953:'os_bone_graft'};

function norm(r){let s=String(r).trim().toUpperCase();if(!s.startsWith('D'))s='D'+s;const d=s.slice(1);if(d.length===5&&d[0]==='0')return'D'+d.slice(1);return s;}
function g(gr,k,f='qty'){return(gr[k]||{})[f]||0;}
function agg(raw){const gr={};for(const[code,d]of Object.entries(raw)){const g=CODE_MAP[norm(code)];if(!g)continue;if(!gr[g])gr[g]={qty:0,total:0};gr[g].qty+=d.qty;gr[g].total+=d.total;}for(const d of Object.values(gr))d.avg=d.qty>0?Math.round(d.total/d.qty*100)/100:0;return gr;}

function parseProdMeta(text){
  const m=text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-](\d{4}))\s*[-–]\s*(\d{1,2}[\/\-]\d{1,2}[\/\-](\d{4}))/);
  if(!m){console.log('No date range found, defaulting 12 months');return{months:12,years:[new Date().getFullYear()]};}
  const parse=(s)=>{const p=s.split(/[\/\-]/);return new Date(parseInt(p[2]),parseInt(p[0])-1,parseInt(p[1]));};
  const startDate=parse(m[1]);const endDate=parse(m[3]);
  const startYear=parseInt(m[2]);const endYear=parseInt(m[4]);
  const months=Math.round((endDate.getFullYear()-startDate.getFullYear())*12+(endDate.getMonth()-startDate.getMonth())+(endDate.getDate()-startDate.getDate())/31);
  const roundedMonths=Math.max(1,months);
  const years=[];
  for(let y=startYear;y<=endYear;y++){
    const mStart=(y===startYear)?startDate.getMonth():0;
    const mEnd=(y===endYear)?endDate.getMonth():11;
    const monthsInYear=mEnd-mStart+1;
    if(monthsInYear>=3)years.push(y);
  }
  if(years.length===0)years.push(endYear);
  console.log('Date range: '+m[1]+' to '+m[3]+' = '+roundedMonths+' months, years:'+years.join(','));
  return{months:roundedMonths,years};
}

function parseProd(text){
  const raw={};
  const pipeLines=text.split('\n').filter(l=>l.includes('|'));
  if(pipeLines.length>5){
    for(const line of pipeLines){
      const parts=line.trim().split('|');
      if(parts.length<3)continue;
      const code=norm(parts[0].trim());
      const qty=parseInt(parts[1],10);
      const total=parseFloat(parts[2].replace(/[,$]/g,''));
      if(!code||isNaN(qty)||isNaN(total)||qty<=0)continue;
      if(!raw[code])raw[code]={qty:0,total:0};
      raw[code].qty+=qty;raw[code].total+=total;
    }
  }
  const blocks=text.split(/\n(?=[A-Z])/);
  for(const block of blocks){
    const codeM=block.match(/^([A-Za-z]\d{4,6}[a-z]?)\s+-/);
    const qtyM=block.match(/Quantity:\s*([\d,]+)/);
    const totM=block.match(/Total:\s*([\d,]+\.\d{2})/);
    if(codeM&&qtyM&&totM){
      const code=norm(codeM[1]);
      const qty=parseInt(qtyM[1].replace(/,/g,''),10);
      const total=parseFloat(totM[1].replace(/,/g,''));
      if(qty>0&&total>0){
        if(!raw[code])raw[code]={qty:0,total:0};
        raw[code].qty+=qty;raw[code].total+=total;
      }
    }
  }
  for(const d of Object.values(raw)){d.total=Math.round(d.total*100)/100;d.avg=d.qty>0?Math.round(d.total/d.qty*100)/100:0;}
  return raw;
}

// FIXED parsePL: robust matching for QuickBooks P&L format variations
function parsePL(text){
  const lines = text.split('\n').map(l => l.trimEnd());

  function parseAmt(s) {
    if (!s) return null;
    s = s.trim().replace(/\$/g, '').replace(/,/g, '').trim();
    const neg = s.startsWith('(') && s.endsWith(')');
    const val = parseFloat(s.replace(/[()]/g, ''));
    if (isNaN(val)) return null;
    return neg ? -val : val;
  }

  function findAmount(pattern) {
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!pattern.test(trimmed)) continue;
      for (let j = i; j <= Math.min(i+2, lines.length-1); j++) {
        const amtMatch = lines[j].match(/([\-\(]?\$?\s*[\d,]+(?:\.\d{1,2})?\)?)\s*$/);
        if (amtMatch) { return parseAmt(amtMatch[1]); }
      }
    }
    return null;
  }

  const tiPatterns = [/^total\s+income\b/i,/^total\s+revenue\b/i,/^gross\s+profit\b/i,/^total\s+collections\b/i];
  const tePatterns = [/^total\s+expense[s]?\b/i,/^total\s+operating\s+expense[s]?\b/i,/^total\s+cost[s]?\b/i];
  const niPatterns = [/^net\s+(?:ordinary\s+)?income\b/i,/^net\s+(?:income|profit|loss)\b/i,/^net\s+earnings\b/i];

  let ti = null, te = null, ni = null;
  for (const p of tiPatterns) { ti = findAmount(p); if (ti !== null) break; }
  for (const p of tePatterns) { te = findAmount(p); if (te !== null) break; }
  for (const p of niPatterns) { ni = findAmount(p); if (ni !== null) break; }

  if (ti === null) { console.error('P&L: Total Income not found. Sample:', lines.slice(0,30).join(' | ')); throw new Error('P&L: Total Income not found'); }
  if (te === null) { console.error('P&L: Total Expense not found. Sample:', lines.slice(0,30).join(' | ')); throw new Error('P&L: Total Expense not found'); }
  if (ni === null) { ni = Math.round((ti - te) * 100) / 100; console.warn('P&L: Net Income derived:', ni); }

  const derived = Math.round((ti - te) * 100) / 100;
  const diff = Math.abs(derived - ni);
  const tolerance = Math.abs(ti) * 0.01 + 1;
  if (diff > tolerance) { console.warn('P&L loose validation: ti='+ti+' te='+te+' ni='+ni+' diff='+diff); ni = derived; }

  const lineItems = [];
  for (const line of lines) {
    const tr = line.trim();
    if (!tr) continue;
    const m = tr.match(/^(.+?)\s{2,}([\d,]+\.\d{2})\s*$/);
    if (m && parseFloat(m[2].replace(/,/g,'')) > 0 && m[1].trim().length > 1)
      lineItems.push({label: m[1].trim(), amount: parseFloat(m[2].replace(/,/g,''))});
  }
  console.log('P&L parsed: ti='+ti+' te='+te+' ni='+ni+' lines='+lineItems.length);
  return {totalIncome: ti, totalExpense: te, netIncome: ni, netCollections: ti, lines: lineItems};
}

async function callClaude(base64,prompt,key){
  const resp=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:4096,messages:[{role:'user',content:[{type:'document',source:{type:'base64',media_type:'application/pdf',data:base64}},{type:'text',text:prompt}]}]})});
  const d=await resp.json();if(d.error)throw new Error(d.error.message);return d.content?.[0]?.text||'';
}

function addPLRawImport(wb,pl,name){
  let ws = wb.getWorksheet('P&L Raw Import');
  if (!ws) ws = wb.addWorksheet('P&L Raw Import');
  ws.spliceRows(1, ws.rowCount);
  const NAVY='1F3864',WHITE='FFFFFF',LGRAY='F2F2F2';
  const fill=(c)=>({type:'pattern',pattern:'solid',fgColor:{argb:c}});
  ws.columns=[{key:'A',width:45},{key:'B',width:16},{key:'C',width:22}];
  const h1=ws.addRow(['P&L RAW IMPORT — '+name,'','']);h1.height=24;
  ['A','B','C'].forEach(c=>{ws.getCell(c+'1').fill=fill(NAVY);ws.getCell(c+'1').font={bold:true,color:{argb:WHITE},size:c==='A'?12:10,name:'Arial'};});
  ws.getCell('A1').alignment={horizontal:'left',vertical:'middle'};
  const h2=ws.addRow(['Line Item','Amount','→ P&L Input Cell']);h2.height=18;
  ['A','B','C'].forEach(c=>{ws.getCell(c+'2').fill=fill(NAVY);ws.getCell(c+'2').font={bold:true,color:{argb:WHITE},size:10,name:'Arial'};ws.getCell(c+'2').alignment={horizontal:c==='B'?'right':'left',vertical:'middle'};});
  if(pl&&pl.lines&&pl.lines.length>0){pl.lines.forEach((item,i)=>{const bg=i%2===0?LGRAY:WHITE;const row=ws.addRow([item.label,item.amount,'']);row.height=16;['A','B','C'].forEach(c=>{const cell=ws.getCell(c+row.number);cell.fill=fill(bg);cell.font={size:10,name:'Arial'};cell.border={bottom:{style:'thin',color:{argb:'CCCCCC'}}};});ws.getCell('A'+row.number).alignment={horizontal:'left',vertical:'middle'};ws.getCell('B'+row.number).alignment={horizontal:'right',vertical:'middle'};ws.getCell('B'+row.number).numFmt='$#,##0.00';});}
  ws.addRow([]);
  if(pl){['TOTAL EXPENSE','NET INCOME'].forEach((lbl,i)=>{const val=i===0?pl.totalExpense:pl.netIncome;const row=ws.addRow([lbl,val,'']);row.height=18;['A','B','C'].forEach(c=>{ws.getCell(c+row.number).fill=fill('E8EEF7');ws.getCell(c+row.number).font={bold:true,size:10,name:'Arial',color:{argb:'1F3864'}};});ws.getCell('B'+row.number).numFmt='$#,##0.00';ws.getCell('B'+row.number).alignment={horizontal:'right'};});}
  ws.views=[{state:'frozen',ySplit:2}];
}

// FIXED: always load Blank_Assessment_Template.xlsx first
async function buildXlsx(raw,groups,pl,prodMeta,name,extra={}){
  const {months,years} = prodMeta;
  const {arPatient={}, arInsurance={}, netCollectionsFromReport=null} = extra;
  const wb = new ExcelJS.Workbook();
  const TEMPLATE_URL = 'https://raw.githubusercontent.com/Evenflow1212/performdds-assessment/main/Blank_Assessment_Template.xlsx';
  try {
    const resp = await fetch(TEMPLATE_URL);
    if (!resp.ok) throw new Error('Template fetch status: ' + resp.status);
    await wb.xlsx.load(Buffer.from(await resp.arrayBuffer()));
    console.log('Template loaded OK');
  } catch (e) {
    console.error('Template load failed:', e.message);
    ['Production Worksheet','HYG Prod','Hygiene Schedule','dr prod','Financial Overview','Targets & Goal','Employee Costs','Budgetary P&L','P&L Input','All Codes'].forEach(n => { if (!wb.getWorksheet(n)) wb.addWorksheet(n); });
  }
  const wsPW = wb.getWorksheet('Production Worksheet');
  const wsFO = wb.getWorksheet('Financial Overview');
  const wsPL = wb.getWorksheet('P&L Input');
  if (!wsPW) throw new Error('Production Worksheet tab not found in template');
  if (!wsFO) throw new Error('Financial Overview tab not found in template');
  if (!wsPL) throw new Error('P&L Input tab not found in template');

  const tot = Object.values(raw).reduce((s,v) => s+v.total, 0);
  const sv = (ws,c,v) => { try { ws.getCell(c).value = v; } catch(e) {} };
  const fv = (ws,c,fo) => { try { ws.getCell(c).value = {formula: fo}; } catch(e) {} };

  sv(wsPW,'D4',name); sv(wsPW,'D5',months); sv(wsPW,'G5',Math.round(tot*100)/100); fv(wsPW,'G6','=G5/D5');
  sv(wsPW,'D9',raw.D0120?.qty||0);  fv(wsPW,'E9','=D9/D5');   sv(wsPW,'F9',raw.D0120?.avg||0);
  sv(wsPW,'D10',raw.D0140?.qty||0); fv(wsPW,'E10','=D10/D5'); sv(wsPW,'F10',raw.D0140?.avg||0);
  sv(wsPW,'D11',raw.D0150?.qty||0); fv(wsPW,'E11','=D11/D5'); sv(wsPW,'F11',raw.D0150?.avg||0);
  sv(wsPW,'D12',raw.D0180?.qty||0); fv(wsPW,'E12','=D12/D5');
  sv(wsPW,'D15',g(groups,'imaging_fmx'));  fv(wsPW,'E15','=D15/D5'); sv(wsPW,'F15',raw.D0210?.avg||0);
  sv(wsPW,'D16',g(groups,'imaging_bw4'));  fv(wsPW,'E16','=D16/D5'); sv(wsPW,'F16',raw.D0274?.avg||0);
  sv(wsPW,'D17',g(groups,'imaging_pano')); fv(wsPW,'E17','=D17/D5'); sv(wsPW,'F17',raw.D0330?.avg||0);
  sv(wsPW,'D20',g(groups,'hyg_adult_prophy')); fv(wsPW,'E20','=D20/D5'); sv(wsPW,'F20',raw.D1110?.avg||0); fv(wsPW,'G20','=D20*F20');
  sv(wsPW,'D21',g(groups,'hyg_child_prophy')); fv(wsPW,'E21','=D21/D5'); sv(wsPW,'F21',raw.D1120?.avg||0); fv(wsPW,'G21','=D21*F21');
  sv(wsPW,'D22',g(groups,'hyg_perio_maint')); fv(wsPW,'E22','=D22/D5'); sv(wsPW,'F22',raw.D4910?.avg||0); fv(wsPW,'G22','=D22*F22');
  const sqQ=g(groups,'hyg_srp'),sqT=g(groups,'hyg_srp','total');
  sv(wsPW,'D23',sqQ); fv(wsPW,'E23','=D23/D5'); sv(wsPW,'F23',sqQ>0?Math.round(sqT/sqQ*100)/100:0); fv(wsPW,'G23','=D23*F23');
  sv(wsPW,'D24',g(groups,'hyg_arestin')); fv(wsPW,'E24','=D24/D5'); sv(wsPW,'F24',raw.D4381?.avg||0); fv(wsPW,'G24','=D24*F24');
  sv(wsPW,'D25',g(groups,'hyg_irrigation')); fv(wsPW,'E25','=D25/D5'); fv(wsPW,'G25','=D25*F25');
  fv(wsPW,'G27','=SUM(G20:G26)'); fv(wsPW,'F27','=IFERROR(G27/G5,0)');
  sv(wsPW,'D30',g(groups,'cb_2740')); fv(wsPW,'E30','=D30/D5'); sv(wsPW,'F30',raw.D2740?.avg||0); fv(wsPW,'G30','=F30*D30');
  sv(wsPW,'D31',g(groups,'cb_2750')); fv(wsPW,'E31','=D31/D5'); sv(wsPW,'F31',raw.D2750?.avg||0); fv(wsPW,'G31','=F31*D31');
  const ioQ=g(groups,'cb_inlay_onlay'),ioT=g(groups,'cb_inlay_onlay','total');
  sv(wsPW,'D32',ioQ); fv(wsPW,'E32','=D32/D5'); sv(wsPW,'G32',ioT);
  const brQ=g(groups,'bridge_pontic'),brT=g(groups,'bridge_pontic','total');
  sv(wsPW,'D33',brQ); fv(wsPW,'E33','=D33/D5'); sv(wsPW,'G33',brT);
  const icQ=g(groups,'oc_implant_crown'),icT=g(groups,'oc_implant_crown','total');
  sv(wsPW,'D34',icQ); fv(wsPW,'E34','=D34/D5'); sv(wsPW,'G34',icT);
  fv(wsPW,'E35','=IFERROR((D30+D31+D32+D33+D34)/D5,0)');
  const peT=Object.keys(groups).filter(k=>k.startsWith('perio_')).reduce((a,k)=>a+g(groups,k,'total'),0);
  const osT=Object.keys(groups).filter(k=>k.startsWith('os_')).reduce((a,k)=>a+g(groups,k,'total'),0);
  const orT=Object.keys(groups).filter(k=>k.startsWith('ortho_')).reduce((a,k)=>a+g(groups,k,'total'),0);
  const enT=Object.keys(groups).filter(k=>k.startsWith('endo_')).reduce((a,k)=>a+g(groups,k,'total'),0);
  const deT=Object.keys(groups).filter(k=>k.startsWith('den_')).reduce((a,k)=>a+g(groups,k,'total'),0);
  sv(wsPW,'D38',Math.round(peT*100)/100); fv(wsPW,'E38','=IFERROR(D38/G5,0)'); fv(wsPW,'F38','=IFERROR(D38/D5,0)');
  sv(wsPW,'D39',Math.round(osT*100)/100); fv(wsPW,'E39','=IFERROR(D39/G5,0)'); fv(wsPW,'F39','=IFERROR(D39/D5,0)');
  sv(wsPW,'D40',Math.round(orT*100)/100); fv(wsPW,'E40','=IFERROR(D40/G5,0)'); fv(wsPW,'F40','=IFERROR(D40/D5,0)');
  sv(wsPW,'D41',Math.round(enT*100)/100); fv(wsPW,'E41','=IFERROR(D41/G5,0)'); fv(wsPW,'F41','=IFERROR(D41/D5,0)');
  sv(wsPW,'D42',Math.round(deT*100)/100); fv(wsPW,'E42','=IFERROR(D42/G5,0)'); fv(wsPW,'F42','=IFERROR(D42/D5,0)');
  fv(wsPW,'D43','=SUM(D38:D42)'); fv(wsPW,'E43','=IFERROR(D43/G5,0)');

  // FINANCIAL OVERVIEW — year columns parsed from report, NEVER hardcoded
  sv(wsFO,'D4',name);
  const yearCols = ['C','E','G'];
  const prodPerYear = Math.round(tot/years.length*100)/100;
  years.forEach((yr,i) => {
    const col = yearCols[i]; if (!col) return;
    sv(wsFO,col+'6',yr);
    sv(wsFO,'B20','TOTAL'); sv(wsFO,col+'20',prodPerYear);
    sv(wsFO,'B21','months'); sv(wsFO,col+'21',12);
    sv(wsFO,'B22','AVERAGE'); fv(wsFO,col+'22','=IFERROR('+col+'20/'+col+'21,0)');
    if (pl && i === years.length-1) {
      const cc = String.fromCharCode(col.charCodeAt(0)+1);
      sv(wsFO,cc+'20',Math.round(pl.netCollections*100)/100);
      sv(wsFO,cc+'21',12);
      fv(wsFO,cc+'22','=IFERROR('+cc+'20/'+cc+'21,0)');
    }
  });
  if (pl) fv(wsFO,'D25',"='P&L Input'!N2");
  const mrc = String.fromCharCode(yearCols[years.length-1].charCodeAt(0)+1);
  fv(wsFO,'D26','=IFERROR('+mrc+'22,0)');
  sv(wsFO,'D27',Math.round(tot/months*100)/100);
  fv(wsFO,'D28','=IFERROR(D25/D27,0)');


  // AR AGING rows 32-33 in Financial Overview
  if (arPatient && arPatient.total) {
    sv(wsFO,'C32','Patient AR');
    sv(wsFO,'D32',arPatient.total||0);
    sv(wsFO,'E32',arPatient.current||0);
    sv(wsFO,'F32',arPatient.d3160||0);
    sv(wsFO,'G32',arPatient.d6190||0);
    sv(wsFO,'H32',arPatient.d90plus||0);
    sv(wsFO,'I32',arPatient.insr||0);
  }
  if (arInsurance && arInsurance.total) {
    sv(wsFO,'C33','Insurance AR');
    sv(wsFO,'D33',arInsurance.total||0);
    sv(wsFO,'E33',arInsurance.current||0);
    sv(wsFO,'F33',arInsurance.d3160||0);
    sv(wsFO,'G33',arInsurance.d6190||0);
    sv(wsFO,'H33',arInsurance.d90plus||0);
  }
  // Override collections col with Analysis Summary total if available
  if (netCollectionsFromReport && years.length > 0) {
    const lastCol = yearCols[years.length-1];
    const collCol = String.fromCharCode(lastCol.charCodeAt(0)+1);
    sv(wsFO,collCol+'20',Math.round(netCollectionsFromReport*100)/100);
    fv(wsFO,collCol+'22','=IFERROR('+collCol+'20/'+collCol+'21,0)');
    if (pl) { sv(wsFO,'D26',Math.round(netCollectionsFromReport/months*100)/100); }
    console.log('Collections from report written: '+netCollectionsFromReport);
  }
  // P&L INPUT — only touch specific data cells
  sv(wsPL,'B2',12); fv(wsPL,'N2','=IFERROR(H2/B2,0)');
  if (pl) {
    sv(wsPL,'H2',pl.netCollections);
    sv(wsPL,'N54',pl.totalExpense);
    console.log('P&L written: netCollections='+pl.netCollections+' totalExpense='+pl.totalExpense);
  }
  if (pl) addPLRawImport(wb, pl, name);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

exports.handler = async function(event) {
  if (event.httpMethod==='OPTIONS') return {statusCode:200,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST,OPTIONS'},body:''};
  if (event.httpMethod!=='POST') return {statusCode:405,body:'Method Not Allowed'};
  const KEY = process.env.ANTHROPIC_KEY;
  if (!KEY) return {statusCode:500,body:JSON.stringify({error:'ANTHROPIC_KEY not set'})};
  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return {statusCode:400,body:JSON.stringify({error:'Invalid JSON'})}; }
  const {productionBase64, collectionsBase64, plBase64, practiceName='', software='dentrix', arPatient={}, arInsurance={}} = body;
  if (!productionBase64) return {statusCode:400,body:JSON.stringify({error:'productionBase64 required'})};
  try {
    const PROD_PROMPT = 'Dental practice production by procedure code report. Extract every ADA code with quantity and total. Return ONLY lines: CODE|QTY|TOTAL (e.g. D0120|2916|139832.00). Also include date range line verbatim from header.';
    const COLL_PROMPT = 'This is a Dentrix Analysis Summary (Provider) report. Find the TOTAL row at the bottom. Extract Charges and Payments totals. Return ONLY two lines:\nCHARGES|[amount]\nPAYMENTS|[amount]';
    const PL_PROMPT = 'QuickBooks P&L report. Extract full text verbatim preserving all labels and dollar amounts. Total Income, Total Expense, and Net Income must appear clearly. Output raw text only.';
    const [prodText, collText, plText] = await Promise.all([
      callClaude(productionBase64, PROD_PROMPT, KEY),
      collectionsBase64 ? callClaude(collectionsBase64, COLL_PROMPT, KEY) : Promise.resolve(''),
      plBase64 ? callClaude(plBase64, PL_PROMPT, KEY) : Promise.resolve('')
    ]);
    console.log('prodText length:', prodText.length);
    if (collectionsBase64) console.log('collText:', collText.slice(0,200));
    if (plBase64) console.log('plText length:', plText.length);
    const prodMeta = parseProdMeta(prodText);
    const raw = parseProd(prodText);
    const groups = agg(raw);
    let netCollectionsFromReport = null;
    if (collText) {
      const paymentsM = collText.match(/PAYMENTS\|([\d,]+\.?\d*)/i);
      if (paymentsM) { netCollectionsFromReport = parseFloat(paymentsM[1].replace(/,/g,'')); console.log('Collections parsed: '+netCollectionsFromReport); }
    }
    let pl = null;
    if (plBase64 && plText) {
      try { pl = parsePL(plText); console.log('P&L OK: netCollections='+pl.netCollections); }
      catch(e) { console.error('PL parse failed:', e.message); }
    }
    const xlsxB64 = await buildXlsx(raw, groups, pl, prodMeta, practiceName, {arPatient, arInsurance, netCollectionsFromReport});
    const totalProd = Object.values(raw).reduce((s,v) => s+v.total, 0);
    return {
      statusCode:200,
      headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},
      body:JSON.stringify({success:true,xlsxB64,summary:{
        codesFound:Object.keys(raw).length,
        totalProduction:totalProd.toFixed(2),
        months:prodMeta.months,
        years:prodMeta.years,
        netCollections:netCollectionsFromReport||pl?.netCollections||null,
        totalExpense:pl?.totalExpense||null,
        netIncome:pl?.netIncome||null,
        plParsed:pl!==null,
        arPatientTotal:arPatient?.total||null,
        arInsuranceTotal:arInsurance?.total||null
      }})
    };
  } catch(err) {
    return {statusCode:500,headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({error:err.message,stack:err.stack?.slice(0,500)})};
  }
};
