const ExcelJS = require('exceljs');

exports.handler = async function(event) {
  if(event.httpMethod === 'OPTIONS') return {statusCode:200,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type'}};
  if(event.httpMethod !== 'POST') return {statusCode:405,body:'Method Not Allowed'};
  let body; try{body=JSON.parse(event.body);}catch{return{statusCode:400,body:'Bad JSON'};}
  const {practiceName='Practice',months=12,totalProduction=0,collections=0,codes={},plItems=[],hygiene={}}=body;
  const wb=new ExcelJS.Workbook(); wb.creator='Perform DDS';
  const q=(c)=>(codes[c]||codes['D'+c.replace(/^D/,'')]||{qty:0,total:0,avg:0}).qty||0;
  const t=(c)=>(codes[c]||codes['D'+c.replace(/^D/,'')]||{qty:0,total:0,avg:0}).total||0;
  const a=(c)=>(codes[c]||codes['D'+c.replace(/^D/,'')]||{qty:0,total:0,avg:0}).avg||0;
  function fill(argb){return{type:'pattern',pattern:'solid',fgColor:{argb}};}
  function sc(ws,r,c,v,o={}){const cell=ws.getCell(r,c);if(v!==undefined)cell.value=v;if(o.bg)cell.fill=fill(o.bg);if(o.bold||o.color)cell.font={bold:!!o.bold,color:{argb:o.color||'FF000000'},size:o.size||11,name:'Calibri'};if(o.halign)cell.alignment={horizontal:o.halign,vertical:'middle'};if(o.numFmt)cell.numFmt=o.numFmt;return cell;}
  const NAVY='FF1F3864',NAVY2='FF2E4B7A',GRAY='FF7F7F7F',BL='FFD9E1F2',BM='FFEEF3FA',YEL='FFFFF3CD',WHITE='FFFFFFFF',RED='FFFFE0E0';
  const pm=(n)=>months>0?Math.round(n/months*10)/10:0;
  const hygTotal=t('D1110')+t('D1120')+t('D4910')+t('D4341')+t('D4342')+t('D4381')+t('D4346');
  const getpl=(...keys)=>{for(const k of keys){const f=plItems.find(i=>i.label===k||i.category===k);if(f)return Math.abs(f.amount);}return 0;};
  const staffWages=plItems.filter(i=>i.category==='Staff Costs').reduce((s,i)=>s+Math.abs(i.amount),0);
  const lab=getpl('Lab Fees','Lab');const dentalSup=getpl('Dental Supplies');const rent=getpl('Rent & Parking','Rent');
  const marketing=getpl('Marketing','Advertising');const staffBonus=getpl('Staff Bonus','Employees Bonus');
  const associates=getpl('Associates','Associates Salary');const misc=plItems.filter(i=>i.category==='Other').reduce((s,i)=>s+Math.abs(i.amount),0);

  // TAB 1: PRODUCTION WORKSHEET
  const ws1=wb.addWorksheet('Production Worksheet');
  ws1.getColumn(2).width=28;ws1.getColumn(4).width=10;ws1.getColumn(5).width=12;ws1.getColumn(6).width=12;ws1.getColumn(7).width=14;
  [10,11,12,13,14].forEach(c=>ws1.getColumn(c).width=13);
  ws1.mergeCells(1,2,1,8);sc(ws1,1,2,'PRODUCTION WORKSHEET',{bg:NAVY,bold:true,color:WHITE,size:14});ws1.getRow(1).height=28;
  ws1.mergeCells(2,2,2,8);sc(ws1,2,2,'PRODUCTION OVERVIEW',{bg:GRAY,bold:true,color:WHITE});
  sc(ws1,4,2,'practice');sc(ws1,4,4,practiceName,{bold:true});
  sc(ws1,5,2,'number of months reviewed');sc(ws1,5,4,months);sc(ws1,5,5,'total production');sc(ws1,5,7,totalProduction,{numFmt:'$#,##0'});
  ws1.getCell(6,7).value={formula:'IFERROR(G5/D5,0)'};ws1.getCell(6,7).numFmt='$#,##0';
  sc(ws1,8,2,'EXAMS',{bold:true});sc(ws1,8,5,'per month',{halign:'center'});
  [[10,'periodic exam (0120)','D0120'],[11,'focused exam (0140)','D0140'],[12,'comprehensive exam (0150)','D0150'],[13,'perio exam (0180)','D0180']].forEach(([r,lbl,c])=>{sc(ws1,r,2,lbl);sc(ws1,r,4,q(c),{numFmt:'#,##0'});ws1.getCell(r,5).value={formula:'IFERROR(D'+r+'/D5,0)'};ws1.getCell(r,5).numFmt='#,##0.0';sc(ws1,r,6,a(c),{numFmt:'$#,##0.00'});});
  sc(ws1,15,2,'IMAGING',{bold:true});
  [[16,'full mouth x-rays (0210)','D0210'],[17,'4 bite wings (0274)','D0274'],[18,'panorex (0330)','D0330']].forEach(([r,lbl,c])=>{sc(ws1,r,2,lbl);sc(ws1,r,4,q(c),{numFmt:'#,##0'});ws1.getCell(r,5).value={formula:'IFERROR(D'+r+'/D5,0)'};ws1.getCell(r,5).numFmt='#,##0.0';sc(ws1,r,6,a(c),{numFmt:'$#,##0.00'});});
  sc(ws1,20,2,'HYGIENE',{bold:true});sc(ws1,20,7,'total $$s');
  [[21,'adult prophy (1110)','D1110'],[22,'child prophy (1120)','D1120'],[23,'perio maintenance (4910)','D4910'],[24,'SRP (4341/2)',null],[25,'arestin or similar (4381)','D4381'],[26,'irrigation','D4346']].forEach(([r,lbl,c])=>{sc(ws1,r,2,lbl);const qty=c?q(c):q('D4341')+q('D4342');const tot=c?t(c):t('D4341')+t('D4342');const avg=c?a(c):Math.round(tot/(qty||1)*100)/100;sc(ws1,r,4,qty,{numFmt:'#,##0'});ws1.getCell(r,5).value={formula:'IFERROR(D'+r+'/D5,0)'};ws1.getCell(r,5).numFmt='#,##0.0';sc(ws1,r,6,avg,{numFmt:'$#,##0.00'});sc(ws1,r,7,tot,{numFmt:'$#,##0'});});
  sc(ws1,27,2,'HYGIENE SUMMARY',{bold:true});sc(ws1,27,7,hygTotal,{numFmt:'$#,##0',bold:true});ws1.getCell(27,6).value={formula:'IFERROR(G27/G5,0)'};ws1.getCell(27,6).numFmt='0.0%';
  sc(ws1,30,2,'CROWN & BRIDGE',{bold:true});
  [[31,'porcelain/ceramic (2740)','D2740'],[32,'porcelain/high noble (2750)','D2750'],[33,'inlays & onlays; veneers & other',null]].forEach(([r,lbl,c])=>{sc(ws1,r,2,lbl);const qty=c?q(c):q('D2962')+q('D2780')+q('D2790');const tot=c?t(c):t('D2962')+t('D2780')+t('D2790');sc(ws1,r,4,qty,{numFmt:'#,##0'});ws1.getCell(r,5).value={formula:'IFERROR(D'+r+'/D5,0)'};sc(ws1,r,6,Math.round(tot/(qty||1)*100)/100,{numFmt:'$#,##0.00'});sc(ws1,r,7,tot,{numFmt:'$#,##0'});});
  sc(ws1,38,2,'SPECIALTY',{bold:true});sc(ws1,38,5,'% of production');
  [[39,'perio',t('D4341')+t('D4342')+t('D4249')],[40,'oral surgery',t('D7140')+t('D7210')+t('D7953')],[41,'ortho',t('D8090')+t('D8040')],[42,'endo',t('D3310')+t('D3320')+t('D3330')],[43,'dentures',t('D5110')+t('D5120')+t('D5213')+t('D5214')]].forEach(([r,lbl,tot])=>{sc(ws1,r,3,lbl);sc(ws1,r,4,tot,{numFmt:'$#,##0'});ws1.getCell(r,5).value={formula:'IFERROR(D'+r+'/G5,0)'};ws1.getCell(r,5).numFmt='0.0%';});
  const specTotal=t('D4341')+t('D4342')+t('D4249')+t('D7140')+t('D7210')+t('D7953')+t('D8090')+t('D8040')+t('D3310')+t('D3320')+t('D3330')+t('D5110')+t('D5120')+t('D5213')+t('D5214');
  sc(ws1,44,2,'SPECIALTY TOTAL',{bold:true});sc(ws1,44,4,specTotal,{numFmt:'$#,##0',bold:true});ws1.getCell(44,5).value={formula:'IFERROR(D44/G5,0)'};ws1.getCell(44,5).numFmt='0.0%';
  // Right side orange tables
  const setOrangeHdr=(r,title)=>{sc(ws1,r,10,title,{bg:NAVY,bold:true,color:WHITE});['CODE','#','TOTAL $','AVG $'].forEach((h,i)=>sc(ws1,r,11+i,h,{bg:NAVY2,bold:true,color:WHITE,halign:'center'}));};
  setOrangeHdr(2,'OTHER CROWNS');
  [['Veneers','2962',q('D2962'),t('D2962'),a('D2962')],['Cast Metal/Gold','2780-2790',q('D2780')+q('D2790'),t('D2780')+t('D2790'),0],['Implant Crowns','6058-6065',q('D6058')+q('D6065'),t('D6058')+t('D6065'),0]].forEach(([lbl,code,qty,tot,avg],i)=>{const r=3+i;sc(ws1,r,10,lbl,{bg:BM});sc(ws1,r,11,code,{bg:BM});sc(ws1,r,12,qty,{bg:BM,numFmt:'#,##0'});sc(ws1,r,13,tot,{bg:BM,numFmt:'$#,##0'});sc(ws1,r,14,avg||Math.round(tot/(qty||1)),{bg:BM,numFmt:'$#,##0.00'});});
  sc(ws1,9,12,{formula:'SUM(L3:L8)'},{...{bg:YEL},numFmt:'#,##0'});sc(ws1,9,13,{formula:'SUM(M3:M8)'},{...{bg:YEL},numFmt:'$#,##0'});
  setOrangeHdr(11,'BRIDGE UNITS');
  sc(ws1,12,10,'Pontic/Abutment',{bg:BM});sc(ws1,12,11,'6245,6740',{bg:BM});sc(ws1,12,12,q('D6245')+q('D6740'),{bg:BM,numFmt:'#,##0'});sc(ws1,12,13,t('D6245')+t('D6740'),{bg:BM,numFmt:'$#,##0'});
  sc(ws1,18,12,{formula:'SUM(L12:L17)'},{...{bg:YEL},numFmt:'#,##0'});sc(ws1,18,13,{formula:'SUM(M12:M17)'},{...{bg:YEL},numFmt:'$#,##0'});
  setOrangeHdr(42,'ENDO');
  [['ROOT CANAL, ANTERIOR','3310',q('D3310'),t('D3310'),a('D3310')],['ROOT CANAL, BICUSPID','3320',q('D3320'),t('D3320'),a('D3320')],['ROOT CANAL, MOLAR','3330',q('D3330'),t('D3330'),a('D3330')]].forEach(([lbl,code,qty,tot,avg],i)=>{const r=43+i;sc(ws1,r,10,lbl,{bg:BM});sc(ws1,r,11,code,{bg:BM});sc(ws1,r,12,qty,{bg:BM,numFmt:'#,##0'});sc(ws1,r,13,tot,{bg:BM,numFmt:'$#,##0'});sc(ws1,r,14,avg,{bg:BM,numFmt:'$#,##0.00'});});
  sc(ws1,47,12,{formula:'SUM(L43:L46)'},{...{bg:YEL},numFmt:'#,##0'});sc(ws1,47,13,{formula:'SUM(M43:M46)'},{...{bg:YEL},numFmt:'$#,##0'});
  setOrangeHdr(57,'ORAL SURGERY');
  [['Simple Extraction','7140',q('D7140'),t('D7140'),a('D7140')],['Bone Graft','7953',q('D7953'),t('D7953'),a('D7953')],['Implant Placement','6010',q('D6010'),t('D6010'),a('D6010')]].forEach(([lbl,code,qty,tot,avg],i)=>{const r=58+i;sc(ws1,r,10,lbl,{bg:BM});sc(ws1,r,11,code,{bg:BM});sc(ws1,r,12,qty,{bg:BM,numFmt:'#,##0'});sc(ws1,r,13,tot,{bg:BM,numFmt:'$#,##0'});sc(ws1,r,14,avg,{bg:BM,numFmt:'$#,##0.00'});});
  sc(ws1,68,12,{formula:'SUM(L58:L67)'},{...{bg:YEL},numFmt:'#,##0'});sc(ws1,68,13,{formula:'SUM(M58:M67)'},{...{bg:YEL},numFmt:'$#,##0'});
  ws1.views=[{showGridLines:false}];

  // TAB 2: ALL CODES
  const ws2=wb.addWorksheet('All Codes - Production Report');
  [10,35,12,14,12,16].forEach((w,i)=>ws2.getColumn(i+1).width=w);
  ['Code','Description','Quantity','Total $','Average $','% of Production'].forEach((h,i)=>sc(ws2,1,i+1,h,{bg:'FF1F4E79',bold:true,color:WHITE,halign:'center'}));
  const descs={'D0120':'Periodic Oral Evaluation','D0140':'Limited Oral Evaluation','D0150':'Comprehensive Oral Evaluation','D0210':'Complete Series Radiographs','D0274':'Bitewings - Four Images','D0330':'Panoramic Image','D1110':'Adult Prophylaxis','D1120':'Child Prophylaxis','D2740':'Crown - Porcelain/Ceramic','D2750':'Crown - Porcelain/High Noble','D3310':'Root Canal - Anterior','D3320':'Root Canal - Bicuspid','D3330':'Root Canal - Molar','D4341':'SRP - Per Quad','D4342':'SRP - 1-3 Teeth','D4910':'Periodontal Maintenance','D6010':'Surgical Implant Placement','D7140':'Extraction - Erupted','D7953':'Bone Graft - Ridge Preservation'};
  Object.entries(codes).sort((a,b)=>(b[1].total||0)-(a[1].total||0)).forEach(([code,data],i)=>{const r=i+2;const bg=i%2===0?'FFF2F2F2':WHITE;sc(ws2,r,1,code,{bg});sc(ws2,r,2,descs[code]||'',{bg});sc(ws2,r,3,data.qty||0,{bg,numFmt:'#,##0',halign:'right'});sc(ws2,r,4,data.total||0,{bg,numFmt:'$#,##0.00',halign:'right'});sc(ws2,r,5,data.avg||0,{bg,numFmt:'$#,##0.00',halign:'right'});sc(ws2,r,6,totalProduction>0?(data.total||0)/totalProduction:0,{bg,numFmt:'0.0000',halign:'right'});});
  ws2.views=[{showGridLines:false}];

  // TAB 3: HYGIENE SCHEDULE (simplified)
  const ws3=wb.addWorksheet('Hygiene Schedule');
  ws3.mergeCells(2,2,2,8);sc(ws3,2,2,'HYGIENE SCHEDULE',{bg:GRAY,bold:true,color:WHITE});
  sc(ws3,4,2,'practice');sc(ws3,4,5,practiceName);
  const days=['Mon','Tue','Wed','Thu','Fri','Sat'];const dkeys=['mon','tue','wed','thu','fri','sat'];
  sc(ws3,6,2,'HOURS',{bold:true});dkeys.forEach((k,i)=>sc(ws3,6,3+i,(hygiene.hours||{})[k]||''));
  sc(ws3,7,2,'RDH SCHEDULED',{bold:true});dkeys.forEach((k,i)=>sc(ws3,7,3+i,parseInt((hygiene.rdh||{})[k])||0,{numFmt:'#,##0'}));
  sc(ws3,8,2,'RECENT PAST',{bold:true});
  ['appt','seen'].forEach((h,i)=>days.forEach((d,di)=>sc(ws3,9,3+di*2+i,h,{halign:'center'})));
  (hygiene.recentPast||[]).forEach((wk,wi)=>{const r=10+wi;sc(ws3,r,2,wk.date||'');(wk.days||[]).forEach((d,di)=>{sc(ws3,r,3+di*2,d.appt||0,{numFmt:'#,##0'});sc(ws3,r,4+di*2,d.seen||0,{numFmt:'#,##0'});});});
  sc(ws3,18,2,'NEXT 7 DAYS',{bold:true});
  sc(ws3,19,2,'Scheduled',{bold:true});(hygiene.next7||{scheduled:[]}).scheduled.forEach((v,i)=>sc(ws3,19,3+i,v,{numFmt:'#,##0'}));
  sc(ws3,20,2,'Confirmed',{bold:true});(hygiene.next7||{confirmed:[]}).confirmed.forEach((v,i)=>sc(ws3,20,3+i,v,{numFmt:'#,##0'}));
  sc(ws3,24,2,'NEAR FUTURE',{bold:true});
  (hygiene.nearFuture||[]).forEach((wk,wi)=>{const r=25+wi;sc(ws3,r,2,wk.date||'');(wk.days||[]).forEach((d,di)=>{sc(ws3,r,3+di*2,d.appt||0,{numFmt:'#,##0'});sc(ws3,r,4+di*2,d.booked||0,{numFmt:'#,##0'});});});
  ws3.views=[{showGridLines:false}];

  // TAB 4: FINANCIAL OVERVIEW
  const ws4=wb.addWorksheet('Financial Overview');
  ws4.mergeCells(2,2,2,8);sc(ws4,2,2,'FINANCIAL PERFORMANCE',{bg:GRAY,bold:true,color:WHITE});
  sc(ws4,4,2,'practice');sc(ws4,4,4,practiceName);
  sc(ws4,20,5,totalProduction,{numFmt:'$#,##0'});sc(ws4,20,6,collections,{numFmt:'$#,##0'});
  sc(ws4,21,5,months);sc(ws4,25,4,collections>0?collections/months:0,{numFmt:'$#,##0'});
  sc(ws4,27,4,totalProduction>0?totalProduction/months:0,{numFmt:'$#,##0'});
  sc(ws4,28,3,'collection %');sc(ws4,28,4,totalProduction>0?collections/totalProduction:0,{numFmt:'0.0%'});
  sc(ws4,30,2,'ACCOUNTS RECEIVABLE',{bold:true});['total','current','30-60','60-90','90+'].forEach((h,i)=>sc(ws4,31,4+i,h,{bold:true,halign:'center'}));
  sc(ws4,32,3,'patient');sc(ws4,33,3,'insurance');sc(ws4,34,3,'total');
  ws4.getCell(34,4).value={formula:'SUM(D32:D33)'};ws4.getCell(34,4).numFmt='$#,##0';
  ws4.views=[{showGridLines:false}];

  // TAB 5: TARGETS & GOAL
  const ws5=wb.addWorksheet('Targets & Goal');
  ws5.mergeCells(2,2,2,5);sc(ws5,2,2,'TARGETS & GOAL',{bg:GRAY,bold:true,color:WHITE});
  sc(ws5,4,2,'practice');sc(ws5,4,3,practiceName);
  sc(ws5,6,2,'INITIAL MONTHLY TARGET',{bold:true});
  ['Days Worked','Daily Target','Monthly'].forEach((h,i)=>sc(ws5,7,3+i,h,{bold:true,halign:'center'}));
  [['general dentist',0,3500],['associate general dentist',0,3000],['hygiene',0,1000],['perio surgery',0,8000],['endo',0,5000],['oral surgery',0,8000],['ortho',0,5000]].forEach(([lbl,d,daily],i)=>{const r=8+i;sc(ws5,r,2,lbl);sc(ws5,r,3,d);sc(ws5,r,4,daily,{numFmt:'$#,##0'});ws5.getCell(r,5).value={formula:'C'+r+'*D'+r};ws5.getCell(r,5).numFmt='$#,##0';});
  ws5.getCell(17,5).value={formula:'SUM(E8:E16)'};ws5.getCell(17,5).numFmt='$#,##0';
  sc(ws5,18,3,'annual');ws5.getCell(18,5).value={formula:'E17*12'};ws5.getCell(18,5).numFmt='$#,##0';
  ws5.views=[{showGridLines:false}];

  // TAB 6: EMPLOYEE COSTS
  const ws6=wb.addWorksheet('Employee Costs');
  ws6.mergeCells(2,2,2,8);sc(ws6,2,2,'EMPLOYEE COSTS',{bg:GRAY,bold:true,color:WHITE});
  sc(ws6,4,3,'practice');sc(ws6,4,4,practiceName);
  sc(ws6,6,2,'STAFF',{bold:true});['','time with practice (yrs)','hourly rate','hours','monthly cost'].forEach((h,i)=>{if(h)sc(ws6,6,3+i,h,{bold:true});});
  ['office manager','front 1','front2','front3','front4'].forEach((r,i)=>{sc(ws6,7+i,3,r);sc(ws6,7+i,7,0,{numFmt:'$#,##0'});});
  ws6.getCell(20,7).value={formula:'SUM(G7:G19)'};ws6.getCell(20,7).numFmt='$#,##0';
  ws6.getCell(21,7).value={formula:'G20*0.1'};ws6.getCell(21,7).numFmt='$#,##0';
  ws6.getCell(23,7).value={formula:'G20+G21+G22'};ws6.getCell(23,7).numFmt='$#,##0';
  sc(ws6,26,2,'HYGIENE',{bold:true});['rdh 1','rdh 2','rdh 3'].forEach((r,i)=>{sc(ws6,27+i,3,r);sc(ws6,27+i,7,0,{numFmt:'$#,##0'});});
  sc(ws6,45,2,'STAFF BUDGET',{bold:true});sc(ws6,46,3,'actual');sc(ws6,46,4,collections,{numFmt:'$#,##0'});
  ws6.getCell(46,5).value={formula:'D46*0.16'};ws6.getCell(46,5).numFmt='$#,##0';
  ws6.getCell(46,6).value={formula:'D46*0.2'};ws6.getCell(46,6).numFmt='$#,##0';
  ws6.getCell(46,7).value={formula:'D46*0.18'};ws6.getCell(46,7).numFmt='$#,##0';
  ws6.views=[{showGridLines:false}];

  // TAB 7: BUDGETARY P&L
  const ws7=wb.addWorksheet('Budgetary P&L');
  ws7.mergeCells(2,2,2,10);sc(ws7,2,2,'BUDGETARY P&L',{bg:GRAY,bold:true,color:WHITE});
  sc(ws7,4,2,'practice');sc(ws7,4,4,practiceName);
  sc(ws7,7,2,'COLLECTION',{bold:true});sc(ws7,7,3,collections,{bg:'FFD8D8D8',numFmt:'$#,##0'});
  const brows=[['associates',associates],['hygienists',0],['specialists',0],['',''],['lab',lab],['supplies',dentalSup],['specialist supplies',0],['',''],['VARIABLE COSTS',associates+lab+dentalSup,true],['',''],['staff wages',staffWages],['staff bonus',staffBonus],['rent & parking',rent],['office supplies',0],['misc',misc],['',''],['marketing',marketing],['',''],['FIXED COSTS',staffWages+staffBonus+rent+misc+marketing,true],['',''],['FINANCING',0],['',''],['net',collections-associates-lab-dentalSup-staffWages-staffBonus-rent-misc-marketing,true]];
  let br=8;brows.forEach(([lbl,val,bold])=>{if(!lbl){br++;return;}sc(ws7,br,2,lbl,{bold:!!bold});if(val!==undefined){sc(ws7,br,3,val,{bg:'FFD8D8D8',numFmt:'$#,##0'});sc(ws7,br,4,collections>0?val/collections:0,{bg:'FFD8D8D8',numFmt:'0.0%'});}br++;});
  ws7.views=[{showGridLines:false}];

  // TAB 8: P&L INPUT
  const ws8=wb.addWorksheet('P&L Input');
  sc(ws8,2,1,'months reviewed');sc(ws8,2,2,months,{bg:BL});
  sc(ws8,2,5,'collections from P&L');sc(ws8,2,8,collections,{bg:BL,numFmt:'$#,##0'});
  sc(ws8,2,12,'monthly ave.');ws8.getCell(2,14).value={formula:'H2/B2'};ws8.getCell(2,14).numFmt='$#,##0';
  ['From P&L:','Associates','Hygienist','Specialists','Lab','Dental Supplies','Spec Supplies','Staff Costs','Staff Bonus','Rent & Parking','Marketing','Office Supplies','Other','Salary','Other','Row Total'].forEach((h,i)=>sc(ws8,5,i+1,h,{bg:NAVY2,bold:true,color:WHITE,size:10}));
  const cm={B:2,C:3,D:4,E:5,F:6,G:7,H:8,I:9,J:10,K:11,L:12,M:13,N:14,O:15};
  const catm={'Marketing':'K','Lab':'E','Dental Supplies':'F','Staff Costs':'H','Staff Bonus':'I','Associates':'B','Hygienist':'C','Specialists':'D','Specialist Supplies':'G','Rent & Parking':'J','Office Supplies':'L','Other':'M','Add-Back':'O','Owner Draw':'N'};
  plItems.forEach((item,i)=>{const r=6+i;const colK=catm[item.category]||'M';sc(ws8,r,1,item.label,{bg:i%2===0?'FFF2F2F2':WHITE});sc(ws8,r,cm[colK],Math.abs(item.amount),{numFmt:'$#,##0'});ws8.getCell(r,16).value={formula:'SUM(B'+r+':O'+r+')'}});
  const tr=6+plItems.length+2;sc(ws8,tr,1,'Totals',{bg:NAVY2,bold:true,color:WHITE});
  for(let c=2;c<=16;c++){const col=ws8.getColumn(c).letter;ws8.getCell(tr,c).value={formula:'SUM('+col+'5:'+col+(tr-1)+')'};ws8.getCell(tr,c).fill=fill(NAVY2);ws8.getCell(tr,c).font={color:{argb:WHITE},bold:true};}
  const mr=tr+1;sc(ws8,mr,1,'Monthly Ave',{bg:BL});
  for(let c=2;c<=15;c++){const col=ws8.getColumn(c).letter;ws8.getCell(mr,c).value={formula:col+tr+'/B2'};ws8.getCell(mr,c).fill=fill(BL);ws8.getCell(mr,c).numFmt='$#,##0';}
  const ar=mr+1;sc(ws8,ar,1,'Adj. Figure',{bg:BL});for(let c=2;c<=15;c++){ws8.getCell(ar,c).value=0;ws8.getCell(ar,c).fill=fill(BL);}
  const pr=ar+1;sc(ws8,pr,1,"P&L $$'s",{bg:NAVY2,bold:true,color:WHITE});
  for(let c=2;c<=15;c++){const col=ws8.getColumn(c).letter;ws8.getCell(pr,c).value={formula:col+mr};ws8.getCell(pr,c).fill=fill(NAVY2);ws8.getCell(pr,c).font={color:{argb:WHITE},bold:true};ws8.getCell(pr,c).numFmt='$#,##0';}
  ws8.views=[{showGridLines:false}];

  // TAB 9: P&L RAW IMPORT
  const ws9=wb.addWorksheet('P&L Raw Import');
  ws9.getColumn(1).width=35;ws9.getColumn(2).width=16;ws9.getColumn(3).width=20;ws9.getColumn(4).width=28;
  sc(ws9,1,1,'P&L Raw Import — '+practiceName,{bg:NAVY,bold:true,color:WHITE});[1,2,3,4].forEach(c=>ws9.getCell(1,c).fill=fill(NAVY));
  sc(ws9,2,1,'January 1 – December 31 | Cash Basis');
  ['Line Item','Amount','Category','Notes'].forEach((h,i)=>sc(ws9,3,i+1,h,{bg:NAVY2,bold:true,color:WHITE}));
  sc(ws9,4,1,'INCOME',{bg:NAVY2,bold:true,color:WHITE});[1,2,3,4].forEach(c=>ws9.getCell(4,c).fill=fill(NAVY2));
  sc(ws9,5,1,'Services');sc(ws9,5,2,collections,{numFmt:'$#,##0.00'});sc(ws9,5,3,'Income');
  sc(ws9,6,1,'TOTAL INCOME',{bg:BL,bold:true});sc(ws9,6,2,collections,{bg:BL,numFmt:'$#,##0.00',bold:true});sc(ws9,6,4,'Net collections',{bg:BL});
  sc(ws9,8,1,'EXPENSES',{bg:NAVY2,bold:true,color:WHITE});[1,2,3,4].forEach(c=>ws9.getCell(8,c).fill=fill(NAVY2));
  const catColors={'EXCLUDED':RED,'Add-Back':'FFFFF0CC','Owner Draw':'FFFFF0CC'};
  const sortedPL=[...plItems].sort((a,b)=>a.label.localeCompare(b.label));
  sortedPL.forEach((item,i)=>{const r=9+i;const bg=catColors[item.category]||(i%2===0?'FFF2F2F2':WHITE);sc(ws9,r,1,item.label,{bg});sc(ws9,r,2,Math.abs(item.amount),{bg,numFmt:'$#,##0.00'});sc(ws9,r,3,item.category||'',{bg});if(item.notes)sc(ws9,r,4,item.notes,{bg});for(let c=1;c<=4;c++){const cell=ws9.getCell(r,c);cell.font={...(cell.font||{}),strike:true,color:{argb:'FF595959'}};}});
  const expTotal=plItems.reduce((s,i)=>s+Math.abs(i.amount),0);
  const lastR=9+sortedPL.length;sc(ws9,lastR,1,'TOTAL EXPENSES',{bg:BL,bold:true});sc(ws9,lastR,2,expTotal,{bg:BL,numFmt:'$#,##0.00',bold:true});sc(ws9,lastR,4,'Per P&L',{bg:BL});
  ws9.views=[{showGridLines:false}];

  const buffer=await wb.xlsx.writeBuffer();
  const base64=Buffer.from(buffer).toString('base64');
  return {statusCode:200,headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="'+practiceName.replace(/[^a-z0-9]/gi,'_')+'_Assessment.xlsx"','Access-Control-Allow-Origin':'*'},body:base64,isBase64Encoded:true};
};
