'use strict';
const ExcelJS = require('exceljs');
const fetch = require('node-fetch');

async function callClaude(pdfBase64, prompt, key) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1024,
      messages: [{role:'user',content:[
        {type:'document',source:{type:'base64',media_type:'application/pdf',data:pdfBase64}},
        {type:'text',text:prompt}
      ]}]
    })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error('Claude API error: ' + JSON.stringify(data).slice(0,300));
  return data.content?.[0]?.text || '';
}

function parseProdMeta(text) {
  let months = 24, years = [];
  for (const line of text.split('\n')) {
    const m = line.match(/(\d{2}\/\d{2}\/\d{4})\s*[-\u2013]\s*(\d{2}\/\d{2}\/\d{4})/);
    if (m) {
      const from = new Date(m[1]), to = new Date(m[2]);
      months = Math.round((to - from) / (1000*60*60*24*30.44));
      for (let y = from.getFullYear(); y <= to.getFullYear(); y++) years.push(y);
      break;
    }
  }
  if (!years.length) { const now = new Date(); years = [now.getFullYear()-1, now.getFullYear()]; }
  return { months, years };
}

function parseProd(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9\.\-]{1,10})\|(\d+)\|([0-9,.]+)/i);
    if (m) {
      const code = m[1].toUpperCase(), qty = parseInt(m[2]), total = parseFloat(m[3].replace(/,/g,''));
      if (!isNaN(total) && !isNaN(qty)) result[code] = { qty, total };
    }
  }
  return result;
}

function agg(raw) {
  const g = {diagnostic:0,preventive:0,restorative:0,endodontics:0,periodontics:0,prosthodontics:0,implants:0,oralSurgery:0,orthodontics:0,adjunctive:0,other:0};
  for (const [code, v] of Object.entries(raw)) {
    if (/^D0[123]/.test(code)) g.diagnostic += v.total;
    else if (/^D1/.test(code)) g.preventive += v.total;
    else if (/^D2/.test(code)) g.restorative += v.total;
    else if (/^D3/.test(code)) g.endodontics += v.total;
    else if (/^D4/.test(code)) g.periodontics += v.total;
    else if (/^D5/.test(code)) g.prosthodontics += v.total;
    else if (/^D6/.test(code)) g.implants += v.total;
    else if (/^D7/.test(code)) g.oralSurgery += v.total;
    else if (/^D8/.test(code)) g.orthodontics += v.total;
    else if (/^D9/.test(code)) g.adjunctive += v.total;
    else g.other += v.total;
  }
  return g;
}

function parsePL(text) {
  let netCollections = null, totalExpense = null, netIncome = null, totalIncome = null;
  function getAmt(str) {
    const cleaned = str.replace(/\(/g,'-').replace(/\)/g,'');
    const m = cleaned.match(/-?\$?([\d,]+\.?\d*)/);
    if (!m) return null;
    const val = parseFloat(m[1].replace(/,/g,''));
    return cleaned.trim().startsWith('-') ? -val : val;
  }
  for (const line of text.split('\n')) {
    const l = line.toLowerCase(), amt = getAmt(line);
    if (amt === null) continue;
    if (l.includes('total income') || l.includes('total revenue')) totalIncome = amt;
    if (l.includes('total expense')) totalExpense = amt;
    if (l.includes('net income') || l.includes('net operating income')) netIncome = amt;
    if (l.includes('net collections')) netCollections = amt;
  }
  if (!netCollections && totalIncome) netCollections = totalIncome;
  return { netCollections, totalExpense, netIncome, totalIncome };
}

function sv(ws, addr, val) { try { ws.getCell(addr).value = val; } catch(e) {} }

async function buildXlsx(raw, groups, pl, prodMeta, practiceName, arPatient, arInsurance, netCollectionsFromReport) {
  const { months, years } = prodMeta;
  let wb;
  try {
    const tr = await fetch('https://dentalpracticeassessments.com/Blank_Assessment_Template.xlsx');
    if (!tr.ok) throw new Error('Template ' + tr.status);
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await tr.buffer());
    console.log('Template loaded OK');
  } catch(e) {
    console.error('Template error:', e.message);
    wb = new ExcelJS.Workbook();
    wb.addWorksheet('Financial Overview');
    wb.addWorksheet('All Codes');
    wb.addWorksheet('Production by Category');
  }
  const wsFO = wb.getWorksheet('Financial Overview') || wb.worksheets[0];
  const wsAC = wb.getWorksheet('All Codes') || wb.worksheets[1];
  const wsPBC = wb.getWorksheet('Production by Category') || wb.worksheets[2];
  if (practiceName) sv(wsFO,'B2',practiceName);
  const yearCols = ['D','E','F'];
  years.slice(0,3).forEach((yr,i) => { if (yearCols[i]) sv(wsFO,yearCols[i]+'4',yr); });
  const col = yearCols[Math.min(years.length-1,2)] || 'E';
  const totalProd = Object.values(raw).reduce((s,v)=>s+v.total,0);
  sv(wsFO,col+'7',Math.round(totalProd*100)/100);
  const catRows = {diagnostic:8,preventive:9,restorative:10,endodontics:11,periodontics:12,prosthodontics:13,implants:14,oralSurgery:15,orthodontics:16,adjunctive:17,other:18};
  Object.entries(catRows).forEach(([cat,row]) => { if (groups[cat]) sv(wsFO,col+row,Math.round(groups[cat]*100)/100); });
  const collections = netCollectionsFromReport || pl?.netCollections || null;
  if (collections) sv(wsFO,col+'20',Math.round(Math.abs(collections)*100)/100);
  if (collections && totalProd>0) sv(wsFO,col+'22',Math.round(Math.abs(collections)/totalProd*10000)/10000);
  if (months>0) sv(wsFO,col+'26',Math.round(totalProd/months*100)/100);
  if (pl) {
    if (pl.totalExpense) sv(wsFO,col+'35',Math.round(Math.abs(pl.totalExpense)*100)/100);
    if (pl.netIncome != null) sv(wsFO,col+'36',Math.round(pl.netIncome*100)/100);
  }
  if (arPatient && arPatient.total) {
    sv(wsFO,'C32','Patient AR'); sv(wsFO,'D32',arPatient.total);
    sv(wsFO,'E32',arPatient.current||0); sv(wsFO,'F32',arPatient.d3160||0);
    sv(wsFO,'G32',arPatient.d6190||0); sv(wsFO,'H32',arPatient.d90plus||0); sv(wsFO,'I32',arPatient.insr||0);
  }
  if (arInsurance && arInsurance.total) {
    sv(wsFO,'C33','Insurance AR'); sv(wsFO,'D33',arInsurance.total);
    sv(wsFO,'E33',arInsurance.current||0); sv(wsFO,'F33',arInsurance.d3160||0);
    sv(wsFO,'G33',arInsurance.d6190||0); sv(wsFO,'H33',arInsurance.d90plus||0);
  }
  if (wsAC) {
    Object.entries(raw).filter(([,v])=>v.total>0).sort((a,b)=>b[1].total-a[1].total).forEach(([code,v],i) => {
      const r=i+2; sv(wsAC,'A'+r,code); sv(wsAC,'C'+r,v.qty); sv(wsAC,'D'+r,Math.round(v.total*100)/100);
      if (v.qty>0) sv(wsAC,'E'+r,Math.round(v.total/v.qty*100)/100);
    });
  }
  if (wsPBC) {
    const cats = ['diagnostic','preventive','restorative','endodontics','periodontics','prosthodontics','implants','oralSurgery','orthodontics','adjunctive','other'];
    const labels = ['Diagnostic','Preventive','Restorative','Endodontics','Periodontics','Prosthodontics','Implants','Oral Surgery','Orthodontics','Adjunctive','Other'];
    cats.forEach((cat,i) => {
      sv(wsPBC,'A'+(i+2),labels[i]); sv(wsPBC,'B'+(i+2),Math.round((groups[cat]||0)*100)/100);
      if (totalProd>0) sv(wsPBC,'C'+(i+2),Math.round((groups[cat]||0)/totalProd*10000)/10000);
    });
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf).toString('base64');
}

exports.handler = async function(event) {
  if (event.httpMethod==='OPTIONS') return {statusCode:200,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST,OPTIONS'},body:''};
  if (event.httpMethod!=='POST') return {statusCode:405,body:'Method Not Allowed'};
  const KEY = process.env.ANTHROPIC_KEY;
  if (!KEY) return {statusCode:500,body:JSON.stringify({error:'ANTHROPIC_KEY not set'})};
  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return {statusCode:400,body:JSON.stringify({error:'Invalid JSON'})}; }

  // arPatient and arInsurance come as pre-parsed objects from the hub
  const {productionBase64,collectionsBase64,plBase64,practiceName='',arPatient={},arInsurance={}} = body;
  if (!productionBase64) return {statusCode:400,body:JSON.stringify({error:'productionBase64 required'})};

  try {
    const PROD_PROMPT = 'Dental practice production by procedure code report. Extract every procedure code with quantity and dollar total. Return ONLY one line per code: CODE|QTY|TOTAL (example: D0120|910|62016.00). Include the date range from the header on the first line verbatim.';
    const COLL_PROMPT = 'Dentrix Analysis Summary Provider report. Find the TOTAL row at the bottom of page 2. The payments number will appear as negative. Return ONLY:\nCHARGES|[total charges as positive number]\nPAYMENTS|[total payments as positive number, remove any minus sign]';
    const PL_PROMPT = 'QuickBooks Profit and Loss. Extract full text with all labels and dollar amounts. Include Total Income, Total Expenses, Net Income clearly.';

    console.log('Starting Claude calls: prod + coll + pl...');
    const [prodText, collText, plText] = await Promise.all([
      callClaude(productionBase64, PROD_PROMPT, KEY),
      collectionsBase64 ? callClaude(collectionsBase64, COLL_PROMPT, KEY) : Promise.resolve(''),
      plBase64 ? callClaude(plBase64, PL_PROMPT, KEY) : Promise.resolve('')
    ]);
    console.log('Done. prod:', prodText.length, 'coll:', collText.slice(0,120));

    const prodMeta = parseProdMeta(prodText);
    const raw = parseProd(prodText);
    const groups = agg(raw);

    let netCollectionsFromReport = null;
    if (collText) {
      const m = collText.match(/PAYMENTS\|([\d,]+\.?\d*)/i);
      if (m) { netCollectionsFromReport = Math.abs(parseFloat(m[1].replace(/,/g,''))); console.log('Collections:', netCollectionsFromReport); }
    }

    let pl = null;
    if (plBase64 && plText) {
      try { pl = parsePL(plText); console.log('P&L OK:', pl.totalExpense, pl.netIncome); }
      catch(e) { console.error('P&L error:', e.message); }
    }

    console.log('AR Patient:', JSON.stringify(arPatient), '| AR Insurance:', JSON.stringify(arInsurance));
    const xlsxB64 = await buildXlsx(raw, groups, pl, prodMeta, practiceName, arPatient, arInsurance, netCollectionsFromReport);
    const totalProd = Object.values(raw).reduce((s,v)=>s+v.total,0);

    return {
      statusCode:200,
      headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},
      body:JSON.stringify({success:true,xlsxB64,summary:{
        codesFound:Object.keys(raw).length,
        totalProduction:totalProd.toFixed(2),
        months:prodMeta.months,
        years:prodMeta.years,
        netCollections:netCollectionsFromReport||pl?.netCollections||null,
        plParsed:pl!==null,
        arPatientTotal:arPatient?.total||null,
        arInsuranceTotal:arInsurance?.total||null
      }})
    };
  } catch(err) {
    console.error('Handler error:', err.message);
    return {statusCode:500,headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({error:err.message,stack:err.stack?.slice(0,500)})};
  }
};
