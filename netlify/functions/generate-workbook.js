'use strict';
const ExcelJS = require('exceljs');

const CODE_MAP={D0120:'exam_periodic',D0140:'exam_focused',D0150:'exam_comprehensive',D0170:'exam_other',D0180:'exam_perio',D0210:'imaging_fmx',D0220:'imaging_other',D0230:'imaging_other',D0270:'imaging_other',D0272:'imaging_other',D0273:'imaging_other',D0274:'imaging_bw4',D0330:'imaging_pano',D0340:'imaging_other',D1110:'hyg_adult_prophy',D1120:'hyg_child_prophy',D4341:'hyg_srp',D4342:'hyg_srp',D4346:'hyg_irrigation',D4381:'hyg_arestin',D4910:'hyg_perio_maint',D2740:'cb_2740',D2750:'cb_2750',D2962:'oc_veneers',D6057:'oc_implant_crown',D6058:'oc_implant_crown',D6059:'oc_implant_crown',D6060:'oc_implant_crown',D6061:'oc_implant_crown',D6062:'oc_implant_crown',D6063:'oc_implant_crown',D6064:'oc_implant_crown',D6065:'oc_implant_crown',D6245:'bridge_pontic',D6740:'bridge_pontic',D2510:'cb_inlay_onlay',D2520:'cb_inlay_onlay',D2530:'cb_inlay_onlay',D2542:'cb_inlay_onlay',D2543:'cb_inlay_onlay',D2544:'cb_inlay_onlay',D8090:'ortho_comp_adult',D8040:'ortho_limited',D8681:'ortho_retention',D5110:'den_complete',D5120:'den_complete',D5213:'den_partial_cast',D5214:'den_partial_cast',D5820:'den_interim',D5821:'den_interim',D3310:'endo_anterior',D3320:'endo_bicuspid',D3330:'endo_molar',D3332:'endo_retreat',D3346:'endo_retreat',D3347:'endo_retreat',D3348:'endo_retreat',D4249:'perio_crown_length',D4211:'perio_gingivectomy',D7140:'os_ext_simple',D7210:'os_ext_surgical',D6010:'os_implant_surgical',D7953:'os_bone_graft'};

function norm(r){let s=String(r).trim().toUpperCase();if(!s.startsWith('D'))s='D'+s;const d=s.slice(1);if(d.length===5&&d[0]==='0')return'D'+d.slice(1);return s;}
function g(gr,k,f='qty'){return(gr[k]||{})[f]||0;}
function agg(raw){const gr={};for(const[code,d]of Object.entries(raw)){const g=CODE_MAP[norm(code)];if(!g)continue;if(!gr[g])gr[g]={qty:0,total:0};gr[g].qty+=d.qty;gr[g].total+=d.total;}for(const d of Object.values(gr))d.avg=d.qty>0?Math.round(d.total/d.qty*100)/100:0;return gr;}

// Parse date range and month count from production report text
function parseProdMeta(text){
  // Match date range like "12/01/2021 - 12/20/2023" anywhere in the text
  const m=text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-](\d{4}))\s*[-–]\s*(\d{1,2}[\/\-]\d{1,2}[\/\-](\d{4}))/);
  if(!m){console.log('No date range found, defaulting 12 months');return{months:12,years:[new Date().getFullYear()]};}
  const parse=(s)=>{const p=s.split(/[\/\-]/);return new Date(parseInt(p[2]),parseInt(p[0])-1,parseInt(p[1]));};
  const startDate=parse(m[1]);const endDate=parse(m[3]);
  const startYear=parseInt(m[2]);const endYear=parseInt(m[4]);
  // Months = difference in months rounded to nearest whole month
  const months=Math.round((endDate.getFullYear()-startDate.getFullYear())*12+(endDate.getMonth()-startDate.getMonth())+(endDate.getDate()-startDate.getDate())/31);
  const roundedMonths=Math.max(1,months);
  // Only include years that have meaningful data (at least 3 months)
  // If start month > 9 (Oct/Nov/Dec), don't count start year as a full year
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
  // Try CODE|QTY|TOTAL pipe format first (AI extraction)
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
  // Also try native Dentrix/Eaglesoft format: "Quantity: N Total: N,NNN.NN"
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

function parsePL(text){
  const RI=/^\s*Total\s+Income\s+([\d,]+\.\d{2})\s*$/im,RE=/^\s*Total\s+Expense\s+([\d,]+\.\d{2})\s*$/im,RN=/^\s*Net\s+(?:Ordinary\s+)?Income\s+([\-\(]?[\d,]+\.\d{2}\)?)\s*$/im;
  function amt(s){s=s.trim().replace(/,/g,'');const neg=s.startsWith('(')&&s.endsWith(')');return neg?-parseFloat(s.replace(/[()]/g,'')):parseFloat(s);}
  const mi=RI.exec(text),me=RE.exec(text),mn=RN.exec(text);
  if(!mi)throw new Error('P&L: Total Income not found');
  if(!me)throw new Error('P&L: Total Expense not found');
  if(!mn)throw new Error('P&L: Net Income not found');
  const ti=amt(mi[1]),te=amt(me[1]),ni=amt(mn[1]);
  if(Math.abs(Math.round((ti-te)*100)/100-ni)>0.03)throw new Error('P&L validation failed');
  const lines=[];
  for(const line of text.split('\n')){const tr=line.trim();if(!tr)continue;const m=tr.match(/^(.+?)\s+([\d,]+\.\d{2})\s*$/);if(m&&parseFloat(m[2].replace(/,/g,''))>0&&m[1].trim().length>1)lines.push({label:m[1].trim(),amount:parseFloat(m[2].replace(/,/g,''))});}
  return{totalIncome:ti,totalExpense:te,netIncome:ni,netCollections:ti,lines};
}

async function callClaude(base64,prompt,key){
  const resp=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:4096,messages:[{role:'user',content:[{type:'document',source:{type:'base64',media_type:'application/pdf',data:base64}},{type:'text',text:prompt}]}]})});
  const d=await resp.json();if(d.error)throw new Error(d.error.message);return d.content?.[0]?.text||'';
}

function addPLRawImport(wb,pl,name){
  const ws=wb.addWorksheet('P&L Raw Import');
  const NAVY='1F3864',WHITE='FFFFFF',LGRAY='F2F2F2';
  const fill=(c)=>({type:'pattern',pattern:'solid',fgColor:{argb:c}});
  ws.columns=[{key:'A',width:45},{key:'B',width:16},{key:'C',width:22}];
  const h1=ws.addRow(['P&L RAW IMPORT — '+name,'','']);h1.height=24;
  ['A','B','C'].forEach(c=>{ws.getCell(c+'1').fill=fill(NAVY);ws.getCell(c+'1').font={bold:true,color:{argb:WHITE},size:c==='A'?12:10,name:'Arial'};});
  ws.getCell('A1').alignment={horizontal:'left',vertical:'middle'};
  const h2=ws.addRow(['Line Item','Amount','\u2192 P&L Input Cell']);h2.height=18;
  ['A','B','C'].forEach(c=>{ws.getCell(c+'2').fill=fill(NAVY);ws.getCell(c+'2').font={bold:true,color:{argb:WHITE},size:10,name:'Arial'};ws.getCell(c+'2').alignment={horizontal:c==='B'?'right':'left',vertical:'middle'};});
  if(pl&&pl.lines&&pl.lines.length>0){pl.lines.forEach((item,i)=>{const bg=i%2===0?LGRAY:WHITE;const row=ws.addRow([item.label,item.amount,'']);row.height=16;['A','B','C'].forEach(c=>{const cell=ws.getCell(c+row.number);cell.fill=fill(bg);cell.font={size:10,name:'Arial'};cell.border={bottom:{style:'thin',color:{argb:'CCCCCC'}}};});ws.getCell('A'+row.number).alignment={horizontal:'left',vertical:'middle'};ws.getCell('B'+row.number).alignment={horizontal:'right',vertical:'middle'};ws.getCell('B'+row.number).numFmt='$#,##0.00';});}
  ws.addRow([]);
  if(pl){['TOTAL EXPENSE','NET INCOME'].forEach((lbl,i)=>{const val=i===0?pl.totalExpense:pl.netIncome;const row=ws.addRow([lbl,val,'']);row.height=18;['A','B','C'].forEach(c=>{ws.getCell(c+row.number).fill=fill('E8EEF7');ws.getCell(c+row.number).font={bold:true,size:10,name:'Arial',color:{argb:'1F3864'}};});ws.getCell('B'+row.number).numFmt='$#,##0.00';ws.getCell('B'+row.number).alignment={horizontal:'right'};});}
  ws.views=[{state:'frozen',ySplit:2}];
}

async function buildXlsx(raw,groups,pl,prodMeta,name){
  const{months,years}=prodMeta;
  const wb=new ExcelJS.Workbook();
  const wsPW=wb.addWorksheet('Production Worksheet');
  wb.addWorksheet('HYG Prod');wb.addWorksheet('Hygiene Schedule');wb.addWorksheet('dr prod');
  const wsFO=wb.addWorksheet('Financial Overview');
  wb.addWorksheet('Targets & Goal');wb.addWorksheet('Employee Costs');wb.addWorksheet('Budgetary P&L');
  const wsPL=wb.addWorksheet('P&L Input');
  if(pl)addPLRawImport(wb,pl,name);
  const tot=Object.values(raw).reduce((s,v)=>s+v.total,0);
  const sv=(ws,c,v)=>{try{ws.getCell(c).value=v;}catch(e){}};
  const fv=(ws,c,fo)=>{try{ws.getCell(c).value={formula:fo};}catch(e){}};

  // PRODUCTION WORKSHEET
  sv(wsPW,'B2','PRODUCTION OVERVIEW');sv(wsPW,'B4','practice');sv(wsPW,'D4',name);
  sv(wsPW,'B5','number of months reviewed');sv(wsPW,'D5',months);sv(wsPW,'E5','total production');sv(wsPW,'G5',Math.round(tot*100)/100);fv(wsPW,'G6','=G5/D5');
  sv(wsPW,'B8','EXAMS');sv(wsPW,'D8','qty');sv(wsPW,'E8','per month');sv(wsPW,'F8','ave. fee');
  sv(wsPW,'B9','periodic exam (0120)');sv(wsPW,'D9',raw.D0120?.qty||0);fv(wsPW,'E9','=D9/D5');sv(wsPW,'F9',raw.D0120?.avg||0);
  sv(wsPW,'B10','focused exam (0140)');sv(wsPW,'D10',raw.D0140?.qty||0);fv(wsPW,'E10','=D10/D5');sv(wsPW,'F10',raw.D0140?.avg||0);
  sv(wsPW,'B11','comprehensive exam (0150)');sv(wsPW,'D11',raw.D0150?.qty||0);fv(wsPW,'E11','=D11/D5');sv(wsPW,'F11',raw.D0150?.avg||0);
  sv(wsPW,'B12','perio exam (0180)');sv(wsPW,'D12',raw.D0180?.qty||0);fv(wsPW,'E12','=D12/D5');
  sv(wsPW,'B14','IMAGING');sv(wsPW,'D14','qty');sv(wsPW,'E14','per month');sv(wsPW,'F14','ave. fee');
  sv(wsPW,'B15','full mouth x-rays (0210)');sv(wsPW,'D15',g(groups,'imaging_fmx'));fv(wsPW,'E15','=D15/D5');sv(wsPW,'F15',raw.D0210?.avg||0);
  sv(wsPW,'B16','4 bite wings (0274)');sv(wsPW,'D16',g(groups,'imaging_bw4'));fv(wsPW,'E16','=D16/D5');sv(wsPW,'F16',raw.D0274?.avg||0);
  sv(wsPW,'B17','panorex (0330)');sv(wsPW,'D17',g(groups,'imaging_pano'));fv(wsPW,'E17','=D17/D5');sv(wsPW,'F17',raw.D0330?.avg||0);
  sv(wsPW,'B19','HYGIENE');sv(wsPW,'D19','qty');sv(wsPW,'E19','per month');sv(wsPW,'F19','ave. fee');sv(wsPW,'G19','total $$s');
  sv(wsPW,'B20','adult prophy (1110)');sv(wsPW,'D20',g(groups,'hyg_adult_prophy'));fv(wsPW,'E20','=D20/D5');sv(wsPW,'F20',raw.D1110?.avg||0);fv(wsPW,'G20','=D20*F20');
  sv(wsPW,'B21','child prophy (1120)');sv(wsPW,'D21',g(groups,'hyg_child_prophy'));fv(wsPW,'E21','=D21/D5');sv(wsPW,'F21',raw.D1120?.avg||0);fv(wsPW,'G21','=D21*F21');
  sv(wsPW,'B22','perio maintenance (4910)');sv(wsPW,'D22',g(groups,'hyg_perio_maint'));fv(wsPW,'E22','=D22/D5');sv(wsPW,'F22',raw.D4910?.avg||0);fv(wsPW,'G22','=D22*F22');
  const sqQ=g(groups,'hyg_srp'),sqT=g(groups,'hyg_srp','total');sv(wsPW,'B23','SRP (4341/2)');sv(wsPW,'D23',sqQ);fv(wsPW,'E23','=D23/D5');sv(wsPW,'F23',sqQ>0?Math.round(sqT/sqQ*100)/100:0);fv(wsPW,'G23','=D23*F23');
  sv(wsPW,'B24','arestin or similar (4381)');sv(wsPW,'D24',g(groups,'hyg_arestin'));fv(wsPW,'E24','=D24/D5');sv(wsPW,'F24',raw.D4381?.avg||0);fv(wsPW,'G24','=D24*F24');
  sv(wsPW,'B25','irrigation');sv(wsPW,'D25',g(groups,'hyg_irrigation'));fv(wsPW,'E25','=D25/D5');sv(wsPW,'F25',0);fv(wsPW,'G25','=D25*F25');
  fv(wsPW,'G27','=SUM(G20:G26)');fv(wsPW,'F27','=IFERROR(G27/G5,0)');
  sv(wsPW,'B29','CROWN & BRIDGE');sv(wsPW,'D29','qty');sv(wsPW,'E29','per month');sv(wsPW,'F29','ave. fee');sv(wsPW,'G29','total $$s');
  sv(wsPW,'B30','porcelain/ceramic (2740)');sv(wsPW,'D30',g(groups,'cb_2740'));fv(wsPW,'E30','=D30/D5');sv(wsPW,'F30',raw.D2740?.avg||0);fv(wsPW,'G30','=F30*D30');
  sv(wsPW,'B31','porcelain/high noble (2750)');sv(wsPW,'D31',g(groups,'cb_2750'));fv(wsPW,'E31','=D31/D5');sv(wsPW,'F31',raw.D2750?.avg||0);fv(wsPW,'G31','=F31*D31');
  const ioQ=g(groups,'cb_inlay_onlay'),ioT=g(groups,'cb_inlay_onlay','total');sv(wsPW,'B32','inlays & onlays; veneers & other');sv(wsPW,'D32',ioQ);fv(wsPW,'E32','=D32/D5');sv(wsPW,'G32',ioT);
  const brQ=g(groups,'bridge_pontic'),brT=g(groups,'bridge_pontic','total');sv(wsPW,'B33','bridge units');sv(wsPW,'D33',brQ);fv(wsPW,'E33','=D33/D5');sv(wsPW,'G33',brT);
  const icQ=g(groups,'oc_implant_crown'),icT=g(groups,'oc_implant_crown','total');sv(wsPW,'B34','implant crowns');sv(wsPW,'D34',icQ);fv(wsPW,'E34','=D34/D5');sv(wsPW,'G34',icT);
  fv(wsPW,'E35','=IFERROR((D30+D31+D32+D33+D34)/D5,0)');
  sv(wsPW,'B37','SPECIALTY');sv(wsPW,'D37','$$s');sv(wsPW,'E37','% of production');sv(wsPW,'F37','Prod Per Month');
  const peT=Object.keys(groups).filter(k=>k.startsWith('perio_')).reduce((a,k)=>a+g(groups,k,'total'),0);
  const osT=Object.keys(groups).filter(k=>k.startsWith('os_')).reduce((a,k)=>a+g(groups,k,'total'),0);
  const orT=Object.keys(groups).filter(k=>k.startsWith('ortho_')).reduce((a,k)=>a+g(groups,k,'total'),0);
  const enT=Object.keys(groups).filter(k=>k.startsWith('endo_')).reduce((a,k)=>a+g(groups,k,'total'),0);
  const deT=Object.keys(groups).filter(k=>k.startsWith('den_')).reduce((a,k)=>a+g(groups,k,'total'),0);
  sv(wsPW,'C38','perio');sv(wsPW,'D38',Math.round(peT*100)/100);fv(wsPW,'E38','=IFERROR(D38/G5,0)');fv(wsPW,'F38','=IFERROR(D38/D5,0)');
  sv(wsPW,'C39','oral surgery');sv(wsPW,'D39',Math.round(osT*100)/100);fv(wsPW,'E39','=IFERROR(D39/G5,0)');fv(wsPW,'F39','=IFERROR(D39/D5,0)');
  sv(wsPW,'C40','ortho');sv(wsPW,'D40',Math.round(orT*100)/100);fv(wsPW,'E40','=IFERROR(D40/G5,0)');fv(wsPW,'F40','=IFERROR(D40/D5,0)');
  sv(wsPW,'C41','endo');sv(wsPW,'D41',Math.round(enT*100)/100);fv(wsPW,'E41','=IFERROR(D41/G5,0)');fv(wsPW,'F41','=IFERROR(D41/D5,0)');
  sv(wsPW,'C42','dentures');sv(wsPW,'D42',Math.round(deT*100)/100);fv(wsPW,'E42','=IFERROR(D42/G5,0)');fv(wsPW,'F42','=IFERROR(D42/D5,0)');
  sv(wsPW,'B43','SPECIALTY TOTAL');fv(wsPW,'D43','=SUM(D38:D42)');fv(wsPW,'E43','=IFERROR(D43/G5,0)');

  // FINANCIAL OVERVIEW
  sv(wsFO,'B4','practice');sv(wsFO,'D4',name);
  sv(wsFO,'B5','HISTORICAL PRODUCTION & COLLECTION');
  sv(wsFO,'C7','production');sv(wsFO,'D7','collection');

  // Year columns — parsed from report, NOT hardcoded
  // Col C = first/only year, Col E = second year (if 2-year report)
  const prodPerYear=Math.round(tot/years.length*100)/100;
  const yearCols=['C','E','G']; // up to 3 years
  years.forEach((yr,i)=>{
    const col=yearCols[i];
    if(!col)return;
    sv(wsFO,col+'6',yr);
    sv(wsFO,col+'7','production');
    sv(wsFO,(String.fromCharCode(col.charCodeAt(0)+1))+'7','collection');
    // Monthly rows 8-19: BLANK (no month-by-month data from production-by-code report)
    // Only populate TOTAL row (row 20) and AVERAGE row (row 22)
    sv(wsFO,'B20','TOTAL');
    sv(wsFO,col+'20',prodPerYear);  // production total for this year
    sv(wsFO,'B21','months');
    sv(wsFO,col+'21',12);
    sv(wsFO,'B22','AVERAGE');
    fv(wsFO,col+'22','=IFERROR('+col+'20/'+col+'21,0)');
    // Collection data (from P&L if available)
    if(pl&&i===years.length-1){
      // Put collection total in most recent year column
      const collCol=String.fromCharCode(col.charCodeAt(0)+1);
      sv(wsFO,collCol+'20',Math.round(pl.netCollections*100)/100);
      sv(wsFO,collCol+'21',12);
      fv(wsFO,collCol+'22','=IFERROR('+collCol+'20/'+collCol+'21,0)');
    }
  });

  // P&L vs Practice comparison rows
  sv(wsFO,'B25','ave. monthly collection');
  if(pl)fv(wsFO,'D25',"='P&L Input'!N2");
  sv(wsFO,'F25','(From p&l)');
  sv(wsFO,'B26','ave. monthly collection');
  // D26 = ave monthly collection from practice reports (most recent year collection col avg)
  const mostRecentCollCol=String.fromCharCode(yearCols[years.length-1].charCodeAt(0)+1);
  fv(wsFO,'D26','=IFERROR('+mostRecentCollCol+'22,0)');
  sv(wsFO,'F26','(From practice reports)');
  sv(wsFO,'B27','ave. monthly production');
  // D27 = total production / total months (across all years)
  sv(wsFO,'D27',Math.round(tot/months*100)/100);
  sv(wsFO,'F27','(From production report — '+months+' months)');
  sv(wsFO,'C28','collection %');
  fv(wsFO,'D28','=IFERROR(D25/D27,0)');

  // P&L INPUT
  sv(wsPL,'A2','months reviewed');sv(wsPL,'B2',12);sv(wsPL,'E2','collections from P&L');sv(wsPL,'L2','monthly ave.');fv(wsPL,'N2','=IFERROR(H2/B2,0)');
  sv(wsPL,'B4','Variable Costs');sv(wsPL,'H4','Fixed Costs');sv(wsPL,'N4','Owner');
  sv(wsPL,'A5','From P & L:');sv(wsPL,'B5','Associates');sv(wsPL,'C5','Hygienist');sv(wsPL,'D5','Specialists');sv(wsPL,'E5','Lab');sv(wsPL,'F5','Dental Supplies');sv(wsPL,'G5','Specialist Supplies');sv(wsPL,'H5','Staff Costs');sv(wsPL,'I5','Staff Bonus');sv(wsPL,'J5','Rent & Parking');sv(wsPL,'K5','Marketing');sv(wsPL,'L5','Office Supplies');sv(wsPL,'M5','Other');sv(wsPL,'N5','Salary');sv(wsPL,'O5','Other');
  ['Advertising','Amortization','Bank Charges','Credit Card Fees','Continuing Education','Contributions','De Minimis Expenditures','Dental Supplies','Depreciation','Dues & Subscriptions','Employee Relations','Insurance','Lab Fees','Laundry & Cleaning','Licenses & Fees','Meals & Entertainment','Office Supplies','associates salary','Employees Bonus','Employees Wages',"Officer's Salary",'Pension Expense','Postage','Professional Services','Rent','Repairs & Maintenance','Security','SW support/electronic services','B&O','Payroll','Property','Telephone','Travel','Uncategorized Expense','Uniforms','Utilities'].forEach((lbl,i)=>{sv(wsPL,'A'+(6+i),lbl);fv(wsPL,'P'+(6+i),'=SUM(B'+(6+i)+':O'+(6+i)+')');});
  fv(wsPL,'P47','=SUM(P6:P46)');sv(wsPL,'K53','Spreadsheet Total');fv(wsPL,'N53','=SUM(B47:O47)');sv(wsPL,'K54','Total Cost from P&L');sv(wsPL,'K55','Diff');fv(wsPL,'N55','=IFERROR(N54-N53,0)');
  if(pl){sv(wsPL,'H2',pl.netCollections);sv(wsPL,'N54',pl.totalExpense);}

  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

exports.handler=async function(event){
  if(event.httpMethod==='OPTIONS')return{statusCode:200,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST,OPTIONS'},body:''};
  if(event.httpMethod!=='POST')return{statusCode:405,body:'Method Not Allowed'};
  const KEY=process.env.ANTHROPIC_KEY;
  if(!KEY)return{statusCode:500,body:JSON.stringify({error:'ANTHROPIC_KEY not set'})};
  let body;try{body=JSON.parse(event.body);}catch(e){return{statusCode:400,body:JSON.stringify({error:'Invalid JSON'})};}
  const{productionBase64,plBase64,practiceName=''}=body;
  if(!productionBase64)return{statusCode:400,body:JSON.stringify({error:'productionBase64 required'})};
  try{
    const PROD_PROMPT='This is a dental practice production by procedure code report. Extract every ADA procedure code with its quantity and total production dollar amount. Return ONLY data lines in this exact format: CODE|QTY|TOTAL (e.g. D0120|2916|139832.00). One line per code. Include every code that has a quantity > 0. No headers, no explanations, no other text. Also include the date range line verbatim from the report header (e.g. "12/01/2021 - 12/20/2023").';
    const PL_PROMPT='QuickBooks Profit & Loss PDF. Extract raw text verbatim preserving all indentation and dollar amounts so Total Income, Total Expense, and Net Income summary lines are clearly identifiable.';
    const[prodText,plText='']=await Promise.all([callClaude(productionBase64,PROD_PROMPT,KEY),plBase64?callClaude(plBase64,PL_PROMPT,KEY):Promise.resolve('')]);
    const prodMeta=parseProdMeta(prodText);
    const raw=parseProd(prodText);
    const groups=agg(raw);
    let pl=null;
    if(plBase64&&plText){try{pl=parsePL(plText);}catch(e){console.error('PL parse:',e.message);}}
    const xlsxB64=await buildXlsx(raw,groups,pl,prodMeta,practiceName);
    const totalProd=Object.values(raw).reduce((s,v)=>s+v.total,0);
    return{statusCode:200,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},body:JSON.stringify({success:true,xlsxB64,summary:{codesFound:Object.keys(raw).length,totalProduction:totalProd.toFixed(2),months:prodMeta.months,years:prodMeta.years,netCollections:pl?.netCollections||null,totalExpense:pl?.totalExpense||null,netIncome:pl?.netIncome||null}})};
  }catch(err){return{statusCode:500,headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({error:err.message,stack:err.stack?.slice(0,500)})};}
};
