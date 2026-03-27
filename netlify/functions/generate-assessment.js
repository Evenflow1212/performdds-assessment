const ExcelJS = require('exceljs');

exports.handler = async function(event) {
  if(event.httpMethod==='OPTIONS') return {statusCode:200,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type'}};
  if(event.httpMethod!=='POST') return {statusCode:405,body:'Method Not Allowed'};
  let body; try{body=JSON.parse(event.body);}catch{return{statusCode:400,body:'Bad JSON'};}
  const {practiceName='Practice',months=12,totalProduction=0,collections=0,codes={},plItems=[],hygiene={}}=body;
  const wb=new ExcelJS.Workbook(); wb.creator='Perform DDS'; wb.created=new Date();
  const q=(c)=>(codes[c]||{}).qty||0;
  const t=(c)=>(codes[c]||{}).total||0;
  const a=(c)=>(codes[c]||{}).avg||0;
  const pm=(n)=>months>0?Math.round(n/months*10)/10:0;
  const pct=(n,d)=>d>0?Math.round(n/d*1000)/10:0;
  function fill(argb){return{type:'pattern',pattern:'solid',fgColor:{argb}};}
  function sc(ws,r,c,v,o={}){const cell=ws.getCell(r,c);if(v!==undefined&&v!==null)cell.value=v;if(o.bg)cell.fill=fill(o.bg);if(o.bold||o.color||o.size)cell.font={bold:!!o.bold,color:{argb:o.color||'FF000000'},size:o.size||11,name:'Calibri'};if(o.halign)cell.alignment={horizontal:o.halign,vertical:'middle'};if(o.numFmt)cell.numFmt=o.numFmt;return cell;}
  const NAVY='FF1F3864',NAVY2='FF2E4B7A',GRAY='FF7F7F7F',BL='FFD9E1F2',BM='FFEEF3FA',YEL='FFFFF3CD',WHT='FFFFFFFF',RED='FFFFE0E0';
  const PCT='0.0"%"';
  const sumcat=(cat)=>plItems.filter(i=>i.category===cat).reduce((s,i)=>s+Math.abs(i.amount),0);
  const associates=sumcat('Associates'),hygPay=sumcat('Hygienist'),specialists=sumcat('Specialists');
  const lab=sumcat('Lab'),dentalSup=sumcat('Dental Supplies'),specSup=sumcat('Specialist Supplies');
  const staffWages=sumcat('Staff Costs'),staffBonus=sumcat('Staff Bonus'),rent=sumcat('Rent & Parking');
  const marketing=sumcat('Marketing'),officeSupp=sumcat('Office Supplies'),misc=sumcat('Other');
  const hygTotal=(()=>{const hc=['D1110','D1120','D4910','D4341','D4342','D4381','D4346'];return hc.reduce((s,c)=>s+t(c),0);})();

  // TAB 1: PRODUCTION WORKSHEET
  const ws1=wb.addWorksheet('Production Worksheet');
  ws1.getColumn(2).width=30;ws1.getColumn(4).width=9;ws1.getColumn(5).width=11;ws1.getColumn(6).width=12;ws1.getColumn(7).width=14;
  [10,11,12,13,14].forEach(c=>ws1.getColumn(c).width=14);
  ws1.mergeCells(1,2,1,8);sc(ws1,1,2,'PRODUCTION WORKSHEET',{bg:NAVY,bold:true,color:WHT,size:14});ws1.getRow(1).height=28;
  ws1.mergeCells(2,2,2,8);sc(ws1,2,2,'PRODUCTION OVERVIEW',{bg:GRAY,bold:true,color:WHT});
  sc(ws1,4,2,'practice');sc(ws1,4,4,practiceName,{bold:true});
  sc(ws1,5,2,'number of months reviewed');sc(ws1,5,4,months);sc(ws1,5,5,'total production');sc(ws1,5,7,totalProduction,{numFmt:'$#,##0'});
  sc(ws1,6,7,months>0?Math.round(totalProduction/months):0,{numFmt:'$#,##0'});
  sc(ws1,8,2,'EXAMS',{bold:true});sc(ws1,8,5,'per month');
  [[10,'periodic exam (0120)','D0120'],[11,'focused exam (0140)','D0140'],[12,'comprehensive exam (0150)','D0150'],[13,'perio exam (0180)','D0180']].forEach(([r,lbl,c])=>{sc(ws1,r,2,lbl);sc(ws1,r,4,q(c),{numFmt:'#,##0'});sc(ws1,r,5,pm(q(c)),{numFmt:'#,##0.0'});sc(ws1,r,6,a(c),{numFmt:'$#,##0.00'});});
  sc(ws1,15,2,'IMAGING',{bold:true});sc(ws1,15,5,'per month');
  [[16,'full mouth x-rays (0210)','D0210'],[17,'4 bite wings (0274)','D0274'],[18,'panorex (0330)','D0330']].forEach(([r,lbl,c])=>{sc(ws1,r,2,lbl);sc(ws1,r,4,q(c),{numFmt:'#,##0'});sc(ws1,r,5,pm(q(c)),{numFmt:'#,##0.0'});sc(ws1,r,6,a(c),{numFmt:'$#,##0.00'});});
  sc(ws1,20,2,'HYGIENE',{bold:true});sc(ws1,20,5,'per month');sc(ws1,20,7,'total $$s');
  [[21,'adult prophy (1110)','D1110'],[22,'child prophy (1120)','D1120'],[23,'perio maintenance (4910)','D4910'],[24,'SRP (4341/2)',null],[25,'arestin or similar (4381)','D4381'],[26,'irrigation','D4346']].forEach(([r,lbl,c])=>{const qty=c?q(c):q('D4341')+q('D4342');const tot=c?t(c):t('D4341')+t('D4342');const avg=c?a(c):Math.round(tot/(qty||1)*100)/100;sc(ws1,r,2,lbl);sc(ws1,r,4,qty,{numFmt:'#,##0'});sc(ws1,r,5,pm(qty),{numFmt:'#,##0.0'});sc(ws1,r,6,avg,{numFmt:'$#,##0.00'});sc(ws1,r,7,tot,{numFmt:'$#,##0'});});
  sc(ws1,27,2,'HYGIENE SUMMARY',{bold:true});sc(ws1,27,6,pct(hygTotal,totalProduction),{numFmt:PCT});sc(ws1,27,7,hygTotal,{numFmt:'$#,##0',bold:true});
  sc(ws1,30,2,'CROWN & BRIDGE',{bold:true});
  [[31,'porcelain/ceramic (2740)','D2740'],[32,'porcelain/high noble (2750)','D2750'],[33,'inlays & onlays; veneers & other',null]].forEach(([r,lbl,c])=>{const qty=c?q(c):q('D2962')+q('D2780')+q('D2790');const tot=c?t(c):t('D2962')+t('D2780')+t('D2790');const avg=c?a(c):Math.round(tot/(qty||1)*100)/100;sc(ws1,r,2,lbl);sc(ws1,r,4,qty,{numFmt:'#,##0'});sc(ws1,r,5,pm(qty),{numFmt:'#,##0.0'});sc(ws1,r,6,avg,{numFmt:'$#,##0.00'});sc(ws1,r,7,tot,{numFmt:'$#,##0'});});
  sc(ws1,38,2,'SPECIALTY',{bold:true});sc(ws1,38,5,'% of production');
  const specItems=[[39,'perio',t('D4341')+t('D4342')+t('D4249')+t('D4211')],[40,'oral surgery',t('D7140')+t('D7210')+t('D7953')+t('D7922')],[41,'ortho',t('D8090')+t('D8040')],[42,'endo',t('D3310')+t('D3320')+t('D3330')+t('D3332')],[43,'dentures',t('D5110')+t('D5120')+t('D5213')+t('D5214')+t('D5225')]];
  specItems.forEach(([r,lbl,tot])=>{sc(ws1,r,3,lbl);sc(ws1,r,4,tot,{numFmt:'$#,##0'});sc(ws1,r,5,pct(tot,totalProduction),{numFmt:PCT});});
  const specTotal=specItems.reduce((s,[,,tot])=>s+tot,0);
  sc(ws1,44,2,'SPECIALTY TOTAL',{bold:true});sc(ws1,44,4,specTotal,{numFmt:'$#,##0',bold:true});sc(ws1,44,5,pct(specTotal,totalProduction),{numFmt:PCT});
  const ohdr=(r,title)=>{sc(ws1,r,10,title,{bg:NAVY,bold:true,color:WHT});['CODE','#','TOTAL $','AVG $'].forEach((h,i)=>sc(ws1,r,11+i,h,{bg:NAVY2,bold:true,color:WHT,halign:'center'}));};
  const orow=(r,lbl,code,qty,tot,avg)=>{sc(ws1,r,10,lbl,{bg:BM});sc(ws1,r,11,code,{bg:BM});sc(ws1,r,12,qty,{bg:BM,numFmt:'#,##0'});sc(ws1,r,13,tot,{bg:BM,numFmt:'$#,##0'});sc(ws1,r,14,avg||Math.round(tot/(qty||1)),{bg:BM,numFmt:'$#,##0.00'});};
  const yrow=(r,n12,n13)=>{[12,13,14].forEach(c=>ws1.getCell(r,c).fill=fill(YEL));if(n12!==undefined)sc(ws1,r,12,n12,{bg:YEL,numFmt:'#,##0'});if(n13!==undefined)sc(ws1,r,13,n13,{bg:YEL,numFmt:'$#,##0'});};
  ohdr(2,'OTHER CROWNS');orow(3,'Veneers','2962',q('D2962'),t('D2962'),a('D2962'));orow(4,'Cast Metal/Gold','2780-2790',q('D2780')+q('D2790'),t('D2780')+t('D2790'),0);orow(5,'Implant Crowns','6058-6065',q('D6058')+q('D6065'),t('D6058')+t('D6065'),0);
  yrow(9,q('D2962')+q('D2780')+q('D2790')+q('D6058')+q('D6065'),t('D2962')+t('D2780')+t('D2790')+t('D6058')+t('D6065'));
  ohdr(11,'BRIDGE UNITS');orow(12,'Pontic/Abutment','6245,6740',q('D6245')+q('D6740'),t('D6245')+t('D6740'),0);yrow(18,q('D6245')+q('D6740'),t('D6245')+t('D6740'));
  ohdr(42,'ENDO');[['ROOT CANAL, ANTERIOR','3310','D3310'],['ROOT CANAL, BICUSPID','3320','D3320'],['ROOT CANAL, MOLAR','3330','D3330']].forEach(([lbl,code,c],i)=>orow(43+i,lbl,code,q(c),t(c),a(c)));yrow(47,q('D3310')+q('D3320')+q('D3330'),t('D3310')+t('D3320')+t('D3330'));
  ohdr(57,'ORAL SURGERY');[['Simple Extraction','7140','D7140'],['Bone Graft','7953','D7953'],['Implant Placement','6010','D6010']].forEach(([lbl,code,c],i)=>orow(58+i,lbl,code,q(c),t(c),a(c)));yrow(68,q('D7140')+q('D7953')+q('D6010'),t('D7140')+t('D7953')+t('D6010'));
  ws1.views=[{showGridLines:false}];

  // TAB 2: ALL CODES
  const ws2=wb.addWorksheet('All Codes - Production Report');
  [10,35,12,14,12,12].forEach((w,i)=>ws2.getColumn(i+1).width=w);
  ['Code','Description','Quantity','Total $','Average $','% of Prod'].forEach((h,i)=>sc(ws2,1,i+1,h,{bg:'FF1F4E79',bold:true,color:WHT,halign:'center'}));
  const descs={'D0120':'Periodic Oral Evaluation','D0140':'Limited Oral Evaluation','D0150':'Comprehensive Oral Evaluation','D0210':'Complete Series Radiographs','D0274':'Bitewings - Four Images','D0330':'Panoramic Image','D1110':'Adult Prophylaxis','D1120':'Child Prophylaxis','D2740':'Crown - Porcelain/Ceramic','D2750':'Crown - Porcelain/High Noble','D2950':'Core Buildup','D3310':'Root Canal - Anterior','D3320':'Root Canal - Bicuspid','D3330':'Root Canal - Molar','D4341':'SRP - Per Quad','D4342':'SRP - 1-3 Teeth','D4346':'Scaling - Generalized','D4910':'Periodontal Maintenance','D6010':'Surgical Implant Placement','D7140':'Extraction - Erupted','D7953':'Bone Graft - Ridge Preservation','D8090':'Orthodontics - Comprehensive'};
  Object.entries(codes).sort((a,b)=>(b[1].total||0)-(a[1].total||0)).forEach(([code,data],i)=>{const r=i+2;const bg=i%2===0?'FFF2F2F2':WHT;sc(ws2,r,1,code,{bg});sc(ws2,r,2,descs[code]||'',{bg});sc(ws2,r,3,data.qty||0,{bg,numFmt:'#,##0',halign:'right'});sc(ws2,r,4,Math.round(data.total||0),{bg,numFmt:'$#,##0',halign:'right'});sc(ws2,r,5,data.avg||0,{bg,numFmt:'$#,##0.00',halign:'right'});sc(ws2,r,6,pct(data.total||0,totalProduction),{bg,numFmt:PCT,halign:'right'});});
  ws2.views=[{showGridLines:false}];

  // TAB 3: HYGIENE SCHEDULE
  const ws3=wb.addWorksheet('Hygiene Schedule');
  ws3.mergeCells(2,2,2,8);sc(ws3,2,2,'HYGIENE SCHEDULE',{bg:GRAY,bold:true,color:WHT});
  sc(ws3,4,2,'practice');sc(ws3,4,5,practiceName);
  const dkeys=['mon','tue','wed','thu','fri','sat'];
  sc(ws3,6,2,'HOURS',{bold:true});dkeys.forEach((k,i)=>sc(ws3,6,3+i,(hygiene.hours||{})[k]||''));
  sc(ws3,7,2,'RDH SCHEDULED',{bold:true});dkeys.forEach((k,i)=>sc(ws3,7,3+i,parseInt((hygiene.rdh||{})[k])||0,{numFmt:'#,##0'}));
  sc(ws3,8,2,'RECENT PAST',{bold:true});
  ['appt','seen'].forEach((h,si)=>dkeys.forEach((_,di)=>sc(ws3,9,3+di*2+si,h,{halign:'center'})));
  (hygiene.recentPast||[]).forEach((wk,wi)=>{const r=10+wi;sc(ws3,r,2,wk.date||'');(wk.days||[]).forEach((d,di)=>{sc(ws3,r,3+di*2,d.appt||0,{numFmt:'#,##0'});sc(ws3,r,4+di*2,d.seen||0,{numFmt:'#,##0'});});});
  const rpA=(hygiene.recentPast||[]).flatMap(w=>w.days||[]).reduce((s,d)=>s+(d.appt||0),0);
  const rpS=(hygiene.recentPast||[]).flatMap(w=>w.days||[]).reduce((s,d)=>s+(d.seen||0),0);
  sc(ws3,15,5,'totals:',{bold:true});sc(ws3,15,6,rpA,{numFmt:'#,##0'});sc(ws3,15,8,rpS,{numFmt:'#,##0'});sc(ws3,15,14,pct(rpS,rpA),{numFmt:PCT});
  sc(ws3,18,2,'NEXT 7 DAYS',{bold:true});
  sc(ws3,19,2,'Scheduled',{bold:true});(hygiene.next7||{scheduled:[]}).scheduled.forEach((v,i)=>sc(ws3,19,3+i,v,{numFmt:'#,##0'}));
  sc(ws3,20,2,'Confirmed',{bold:true});(hygiene.next7||{confirmed:[]}).confirmed.forEach((v,i)=>sc(ws3,20,3+i,v,{numFmt:'#,##0'}));
  const n7s=(hygiene.next7||{scheduled:[],confirmed:[]});
  const n7tot=n7s.scheduled.reduce((s,v)=>s+v,0),n7con=n7s.confirmed.reduce((s,v)=>s+v,0);
  sc(ws3,21,5,'totals:',{bold:true});sc(ws3,21,6,n7tot,{numFmt:'#,##0'});sc(ws3,21,8,n7con,{numFmt:'#,##0'});sc(ws3,21,14,pct(n7con,n7tot),{numFmt:PCT});
  sc(ws3,24,2,'NEAR FUTURE',{bold:true});
  (hygiene.nearFuture||[]).forEach((wk,wi)=>{const r=25+wi;sc(ws3,r,2,wk.date||'');(wk.days||[]).forEach((d,di)=>{sc(ws3,r,3+di*2,d.appt||0,{numFmt:'#,##0'});sc(ws3,r,4+di*2,d.booked||0,{numFmt:'#,##0'});});});
  const nfA=(hygiene.nearFuture||[]).flatMap(w=>w.days||[]).reduce((s,d)=>s+(d.appt||0),0);
  const nfB=(hygiene.nearFuture||[]).flatMap(w=>w.days||[]).reduce((s,d)=>s+(d.booked||0),0);
  sc(ws3,30,5,'totals:',{bold:true});sc(ws3,30,6,nfA,{numFmt:'#,##0'});sc(ws3,30,8,nfB,{numFmt:'#,##0'});sc(ws3,30,14,pct(nfB,nfA),{numFmt:PCT});
  ws3.views=[{showGridLines:false}];

  // TAB 4: FINANCIAL OVERVIEW
  const ws4=wb.addWorksheet('Financial Overview');
  ws4.mergeCells(2,2,2,8);sc(ws4,2,2,'FINANCIAL PERFORMANCE',{bg:GRAY,bold:true,color:WHT});
  sc(ws4,4,2,'practice');sc(ws4,4,4,practiceName);
  sc(ws4,20,5,totalProduction,{numFmt:'$#,##0'});sc(ws4,20,6,collections,{numFmt:'$#,##0'});sc(ws4,21,5,months);
  sc(ws4,22,5,months>0?Math.round(totalProduction/months):0,{numFmt:'$#,##0'});sc(ws4,22,6,months>0?Math.round(collections/months):0,{numFmt:'$#,##0'});
  sc(ws4,25,4,months>0?Math.round(collections/months):0,{numFmt:'$#,##0'});sc(ws4,25,6,'(From P&L)');
  sc(ws4,27,4,months>0?Math.round(totalProduction/months):0,{numFmt:'$#,##0'});sc(ws4,27,6,'(From production report)');
  sc(ws4,28,3,'collection %');sc(ws4,28,4,pct(collections,totalProduction),{numFmt:PCT});
  sc(ws4,30,2,'ACCOUNTS RECEIVABLE',{bold:true});['total','current','30-60','60-90','90+'].forEach((h,i)=>sc(ws4,31,4+i,h,{bold:true,halign:'center'}));
  sc(ws4,32,3,'patient');sc(ws4,33,3,'insurance');sc(ws4,34,3,'total');
  sc(ws4,40,2,'COLLECTIONS BY PAYMENT/PAYOR TYPE',{bold:true});
  ws4.views=[{showGridLines:false}];

  // TAB 5: TARGETS & GOAL
  const ws5=wb.addWorksheet('Targets & Goal');
  ws5.mergeCells(2,2,2,5);sc(ws5,2,2,'TARGETS & GOAL',{bg:GRAY,bold:true,color:WHT});
  sc(ws5,4,2,'practice');sc(ws5,4,3,practiceName);
  sc(ws5,6,2,'INITIAL MONTHLY TARGET',{bold:true});
  ['Days Worked','Daily Target','Monthly'].forEach((h,i)=>sc(ws5,7,3+i,h,{bold:true,halign:'center'}));
  [['general dentist',0,3500],['associate general dentist',0,3000],['hygiene',0,1000],['perio surgery',0,8000],['endo',0,5000],['oral surgery',0,8000],['ortho',0,5000]].forEach(([lbl,d,daily],i)=>{const r=8+i;sc(ws5,r,2,lbl);sc(ws5,r,3,d);sc(ws5,r,4,daily,{numFmt:'$#,##0'});sc(ws5,r,5,d*daily,{numFmt:'$#,##0'});});
  ws5.views=[{showGridLines:false}];

  // TAB 6: EMPLOYEE COSTS
  const ws6=wb.addWorksheet('Employee Costs');
  ws6.mergeCells(2,2,2,8);sc(ws6,2,2,'EMPLOYEE COSTS',{bg:GRAY,bold:true,color:WHT});
  sc(ws6,4,3,'practice');sc(ws6,4,4,practiceName);sc(ws6,6,2,'STAFF',{bold:true});
  ['position','time (yrs)','hourly rate','hrs/mo','monthly cost'].forEach((h,i)=>sc(ws6,6,3+i,h,{bold:true}));
  ['office manager','front 1','front 2','front 3','front 4'].forEach((r,i)=>sc(ws6,7+i,3,r));
  sc(ws6,26,2,'HYGIENE',{bold:true});['rdh 1','rdh 2','rdh 3'].forEach((r,i)=>sc(ws6,27+i,3,r));
  sc(ws6,45,2,'STAFF BUDGET VS BENCHMARKS',{bold:true});
  ['collections','min 16%','max 20%','budget 18%'].forEach((h,i)=>sc(ws6,45,4+i,h,{bold:true,halign:'center'}));
  sc(ws6,46,3,'actual');sc(ws6,46,4,collections,{numFmt:'$#,##0'});sc(ws6,46,5,Math.round(collections*.16),{numFmt:'$#,##0'});sc(ws6,46,6,Math.round(collections*.20),{numFmt:'$#,##0'});sc(ws6,46,7,Math.round(collections*.18),{numFmt:'$#,##0'});
  sc(ws6,47,3,'actual staff cost');sc(ws6,47,4,staffWages+staffBonus,{numFmt:'$#,##0'});sc(ws6,47,5,pct(staffWages+staffBonus,collections),{numFmt:PCT});
  ws6.views=[{showGridLines:false}];

  // TAB 7: BUDGETARY P&L
  const ws7=wb.addWorksheet('Budgetary P&L');
  ws7.mergeCells(2,2,2,10);sc(ws7,2,2,'BUDGETARY P&L',{bg:GRAY,bold:true,color:WHT});
  sc(ws7,4,2,'practice');sc(ws7,4,4,practiceName);
  sc(ws7,7,2,'COLLECTION',{bold:true});sc(ws7,7,3,collections,{bg:'FFD8D8D8',numFmt:'$#,##0'});
  const brows=[['associates',associates],['hygienists',hygPay],['specialists',specialists],[''],['lab',lab],['supplies',dentalSup],['specialist supplies',specSup],[''],['VARIABLE COSTS',associates+hygPay+specialists+lab+dentalSup+specSup,true],[''],['staff wages',staffWages],['staff bonus',staffBonus],['rent & parking',rent],['office supplies',officeSupp],['misc',misc],[''],['marketing',marketing],[''],['FIXED COSTS',staffWages+staffBonus+rent+officeSupp+misc+marketing,true],[''],['FINANCING',0],[''],['net',collections-associates-hygPay-specialists-lab-dentalSup-specSup-staffWages-staffBonus-rent-officeSupp-misc-marketing,true]];
  let br=8;brows.forEach(([lbl,val,bold])=>{if(!lbl){br++;return;}sc(ws7,br,2,lbl,{bold:!!bold});if(val!==undefined){sc(ws7,br,3,val,{bg:'FFD8D8D8',numFmt:'$#,##0'});sc(ws7,br,4,pct(val,collections),{bg:'FFD8D8D8',numFmt:PCT});}br++;});
  ws7.views=[{showGridLines:false}];

  // TAB 8: P&L INPUT
  const ws8=wb.addWorksheet('P&L Input');
  sc(ws8,2,1,'months reviewed');sc(ws8,2,2,months,{bg:BL});sc(ws8,2,5,'collections from P&L');sc(ws8,2,8,collections,{bg:BL,numFmt:'$#,##0'});sc(ws8,2,12,'monthly ave.');sc(ws8,2,14,months>0?Math.round(collections/months):0,{bg:BL,numFmt:'$#,##0'});
  ['From P&L:','Associates','Hygienist','Specialists','Lab','Dental Supplies','Spec Supplies','Staff Costs','Staff Bonus','Rent & Parking','Marketing','Office Supplies','Other','Owner Draw','Add-Back','Row Total'].forEach((h,i)=>sc(ws8,5,i+1,h,{bg:NAVY2,bold:true,color:WHT,size:10}));
  const catCol={'Associates':2,'Hygienist':3,'Specialists':4,'Lab':5,'Dental Supplies':6,'Specialist Supplies':7,'Staff Costs':8,'Staff Bonus':9,'Rent & Parking':10,'Marketing':11,'Office Supplies':12,'Other':13,'Owner Draw':14,'Add-Back':15};
  plItems.filter(i=>i.category!=='Income').forEach((item,i)=>{const r=6+i;const bg=i%2===0?'FFF2F2F2':WHT;sc(ws8,r,1,item.label,{bg});const col=catCol[item.category]||13;sc(ws8,r,col,Math.abs(item.amount),{numFmt:'$#,##0'});let rt=0;for(let c=2;c<=15;c++){const v=ws8.getCell(r,c).value;if(typeof v==='number')rt+=v;}sc(ws8,r,16,rt,{numFmt:'$#,##0'});});
  const totR=6+plItems.filter(i=>i.category!=='Income').length+2;sc(ws8,totR,1,'Totals',{bg:NAVY2,bold:true,color:WHT});
  for(let c=2;c<=16;c++){let sum=0;for(let r=6;r<totR;r++){const v=ws8.getCell(r,c).value;if(typeof v==='number')sum+=v;}if(sum)sc(ws8,totR,c,sum,{bg:NAVY2,numFmt:'$#,##0'});}
  const mR=totR+1;sc(ws8,mR,1,'Monthly Ave',{bg:BL});for(let c=2;c<=15;c++){const v=ws8.getCell(totR,c).value;if(typeof v==='number'&&v>0)sc(ws8,mR,c,months>0?Math.round(v/months):0,{bg:BL,numFmt:'$#,##0'});}
  ws8.views=[{showGridLines:false}];

  // TAB 9: P&L RAW IMPORT
  const ws9=wb.addWorksheet('P&L Raw Import');
  ws9.getColumn(1).width=35;ws9.getColumn(2).width=16;ws9.getColumn(3).width=22;ws9.getColumn(4).width=30;
  sc(ws9,1,1,'P&L Raw Import -- '+practiceName,{bg:NAVY,bold:true,color:WHT});[1,2,3,4].forEach(c=>ws9.getCell(1,c).fill=fill(NAVY));
  sc(ws9,2,1,'January 1 - December 31 | Cash Basis');
  ['Line Item','Amount','Category','Notes'].forEach((h,i)=>sc(ws9,3,i+1,h,{bg:NAVY2,bold:true,color:WHT}));
  sc(ws9,4,1,'INCOME',{bg:NAVY2,bold:true,color:WHT});[1,2,3,4].forEach(c=>ws9.getCell(4,c).fill=fill(NAVY2));
  sc(ws9,5,1,'Services');sc(ws9,5,2,collections,{numFmt:'$#,##0.00'});sc(ws9,5,3,'Income');
  sc(ws9,6,1,'TOTAL INCOME',{bg:BL,bold:true});sc(ws9,6,2,collections,{bg:BL,numFmt:'$#,##0.00',bold:true});sc(ws9,6,4,'Net collections',{bg:BL});
  sc(ws9,8,1,'EXPENSES',{bg:NAVY2,bold:true,color:WHT});[1,2,3,4].forEach(c=>ws9.getCell(8,c).fill=fill(NAVY2));
  const catColors={'Add-Back':'FFFFF0CC','Owner Draw':'FFFFF0CC'};
  [...plItems].filter(i=>i.category!=='Income').sort((a,b)=>a.label.localeCompare(b.label)).forEach((item,i)=>{const r=9+i;const bg=catColors[item.category]||(i%2===0?'FFF2F2F2':WHT);sc(ws9,r,1,item.label,{bg});sc(ws9,r,2,Math.abs(item.amount),{bg,numFmt:'$#,##0.00'});sc(ws9,r,3,item.category||'',{bg});for(let c=1;c<=3;c++){const cell=ws9.getCell(r,c);cell.font={...(cell.font||{}),strike:true,color:{argb:'FF595959'}};}});
  const expTot=plItems.filter(i=>i.category!=='Income').reduce((s,i)=>s+Math.abs(i.amount),0);
  const lastR=9+plItems.filter(i=>i.category!=='Income').length;
  sc(ws9,lastR,1,'TOTAL EXPENSES',{bg:BL,bold:true});sc(ws9,lastR,2,expTot,{bg:BL,numFmt:'$#,##0.00',bold:true});
  ws9.views=[{showGridLines:false}];

  const buffer=await wb.xlsx.writeBuffer();
  const b64=Buffer.from(buffer).toString('base64');
  return {statusCode:200,headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="'+practiceName.replace(/[^a-z0-9]/gi,'_')+'_Assessment.xlsx"','Access-Control-Allow-Origin':'*'},body:b64,isBase64Encoded:true};
};
