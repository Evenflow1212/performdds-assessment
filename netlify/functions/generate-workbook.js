'use strict';
const ExcelJS = require('exceljs');
const fetch   = require('node-fetch');

async function callClaude(pdfBase64, prompt, key) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
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
  if (!years.length) {
    const now = new Date();
    years = [now.getFullYear()-1, now.getFullYear()];
  }
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
    if      (/^D0[123]/.test(code)) g.diagnostic    += v.total;
    else if (/^D1/.test(code))      g.preventive    += v.total;
    else if (/^D2/.test(code))      g.restorative   += v.total;
    else if (/^D3/.test(code))      g.endodontics   += v.total;
    else if (/^D4/.test(code))      g.periodontics  += v.total;
    else if (/^D5/.test(code))      g.prosthodontics+= v.total;
    else if (/^D6/.test(code))      g.implants      += v.total;
    else if (/^D7/.test(code))      g.oralSurgery   += v.total;
    else if (/^D8/.test(code))      g.orthodontics  += v.total;
    else if (/^D9/.test(code))      g.adjunctive    += v.total;
    else                            g.other         += v.total;
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
    if (l.includes('total income') || l.includes('total revenue'))   totalIncome    = amt;
    if (l.includes('total expense'))                                  totalExpense   = amt;
    if (l.includes('net income') || l.includes('net operating income')) netIncome    = amt;
    if (l.includes('net collections'))                                netCollections = amt;
  }
  if (!netCollections && totalIncome) netCollections = totalIncome;
  return { netCollections, totalExpense, netIncome, totalIncome };
}

/* ── ADA CDT code descriptions ── */
const ADA_DESCRIPTIONS = {
  'D0120':'Periodic oral evaluation','D0140':'Limited oral evaluation','D0150':'Comprehensive oral evaluation','D0160':'Detailed/extensive oral evaluation','D0170':'Re-evaluation, limited','D0180':'Comprehensive periodontal evaluation',
  'D0210':'Intraoral complete series','D0220':'Intraoral periapical first film','D0230':'Intraoral periapical each additional','D0240':'Intraoral occlusal radiograph','D0250':'Extra-oral 2D projection','D0270':'Bitewing single radiograph','D0272':'Bitewings two radiographs','D0274':'Bitewings four radiographs','D0277':'Vertical bitewings 7-8 radiographs','D0330':'Panoramic radiograph','D0340':'2D cephalometric radiograph','D0350':'2D oral/facial photographic image','D0364':'Cone beam CT limited','D0367':'Cone beam CT both jaws','D0460':'Pulp vitality tests','D0470':'Diagnostic casts',
  'D1110':'Prophylaxis adult','D1120':'Prophylaxis child','D1206':'Topical fluoride varnish','D1208':'Topical fluoride','D1310':'Nutritional counseling','D1320':'Tobacco counseling','D1330':'Oral hygiene instructions','D1351':'Sealant per tooth','D1352':'Preventive resin restoration','D1353':'Sealant repair per tooth','D1510':'Space maintainer fixed unilateral','D1516':'Space maintainer fixed bilateral maxillary','D1517':'Space maintainer fixed bilateral mandibular','D1520':'Space maintainer removable unilateral','D1526':'Space maintainer removable bilateral maxillary','D1527':'Space maintainer removable bilateral mandibular','D1550':'Re-cement space maintainer','D1556':'Remove fixed space maintainer',
  'D2140':'Amalgam one surface primary','D2150':'Amalgam two surfaces primary','D2160':'Amalgam three surfaces primary','D2161':'Amalgam four+ surfaces primary','D2330':'Resin composite one surface anterior','D2331':'Resin composite two surfaces anterior','D2332':'Resin composite three surfaces anterior','D2335':'Resin composite four+ surfaces/incisal anterior','D2390':'Resin composite crown anterior','D2391':'Resin composite one surface posterior','D2392':'Resin composite two surfaces posterior','D2393':'Resin composite three surfaces posterior','D2394':'Resin composite four+ surfaces posterior','D2510':'Inlay metallic one surface','D2520':'Inlay metallic two surfaces','D2530':'Inlay metallic three+ surfaces','D2542':'Onlay metallic two surfaces','D2543':'Onlay metallic three surfaces','D2544':'Onlay metallic four+ surfaces','D2610':'Inlay porcelain/ceramic one surface','D2620':'Inlay porcelain/ceramic two surfaces','D2630':'Inlay porcelain/ceramic three+ surfaces','D2642':'Onlay porcelain/ceramic two surfaces','D2643':'Onlay porcelain/ceramic three surfaces','D2644':'Onlay porcelain/ceramic four+ surfaces','D2650':'Inlay resin one surface','D2651':'Inlay resin two surfaces','D2652':'Inlay resin three+ surfaces','D2662':'Onlay resin two surfaces','D2663':'Onlay resin three surfaces','D2664':'Onlay resin four+ surfaces','D2710':'Crown resin (indirect)','D2712':'Crown 3/4 resin','D2720':'Crown resin with high noble metal','D2721':'Crown resin with predominantly base metal','D2722':'Crown resin with noble metal','D2740':'Crown porcelain/ceramic','D2750':'Crown porcelain fused to high noble metal','D2751':'Crown porcelain fused to predominantly base metal','D2752':'Crown porcelain fused to noble metal','D2780':'Crown 3/4 cast high noble metal','D2781':'Crown 3/4 cast predominantly base metal','D2782':'Crown 3/4 cast noble metal','D2783':'Crown 3/4 porcelain/ceramic','D2790':'Crown full cast high noble metal','D2791':'Crown full cast predominantly base metal','D2792':'Crown full cast noble metal','D2794':'Crown titanium','D2799':'Provisional crown','D2910':'Re-cement/re-bond inlay/onlay/veneer/partial coverage','D2915':'Re-cement cast or prefab post and core','D2920':'Re-cement/re-bond crown','D2921':'Reattach tooth fragment','D2929':'Prefabricated porcelain/ceramic crown','D2930':'Prefabricated stainless steel crown primary','D2931':'Prefabricated stainless steel crown permanent','D2932':'Prefabricated resin crown','D2940':'Protective restoration','D2941':'Interim therapeutic restoration','D2949':'Restorative foundation for crown','D2950':'Core buildup including pins','D2951':'Pin retention per tooth','D2952':'Post and core cast','D2953':'Each additional cast post','D2954':'Prefabricated post and core','D2955':'Post removal','D2957':'Each additional prefab post','D2960':'Labial veneer resin laminate','D2961':'Labial veneer porcelain laminate','D2962':'Labial veneer porcelain laminate (chair-side)','D2971':'Additional procedures to construct new crown under existing partial denture framework','D2980':'Crown repair','D2981':'Inlay repair','D2982':'Onlay repair','D2983':'Veneer repair','D2990':'Resin infiltration',
  'D3110':'Pulp cap direct (excluding final restoration)','D3120':'Pulp cap indirect (excluding final restoration)','D3220':'Therapeutic pulpotomy','D3221':'Pulpal debridement primary/permanent','D3230':'Pulpal therapy anterior primary','D3240':'Pulpal therapy posterior primary','D3310':'Endodontic therapy anterior','D3320':'Endodontic therapy premolar','D3330':'Endodontic therapy molar','D3331':'Treatment of root canal obstruction','D3332':'Incomplete endodontic therapy','D3333':'Internal root repair','D3346':'Retreatment anterior','D3347':'Retreatment premolar','D3348':'Retreatment molar','D3351':'Apexification/recalcification initial visit','D3352':'Apexification/recalcification interim medication replacement','D3353':'Apexification/recalcification final visit','D3410':'Apicoectomy anterior','D3421':'Apicoectomy premolar first root','D3425':'Apicoectomy molar first root','D3426':'Apicoectomy each additional root','D3427':'Periradicular surgery without apicoectomy','D3430':'Retrograde filling per root','D3450':'Root amputation per root','D3460':'Endodontic implant','D3470':'Intentional reimplantation','D3501':'Surgical exposure to facilitate eruption','D3910':'Surgical procedure for isolation of tooth',
  'D4210':'Gingivectomy/gingivoplasty 4+ teeth per quadrant','D4211':'Gingivectomy/gingivoplasty 1-3 teeth per quadrant','D4240':'Gingival flap including root planing 4+ teeth per quadrant','D4241':'Gingival flap including root planing 1-3 teeth per quadrant','D4245':'Apically positioned flap','D4249':'Clinical crown lengthening','D4260':'Osseous surgery 4+ teeth per quadrant','D4261':'Osseous surgery 1-3 teeth per quadrant','D4263':'Bone replacement graft first site in quadrant','D4264':'Bone replacement graft each additional site in quadrant','D4266':'Guided tissue regeneration resorbable barrier per site','D4267':'Guided tissue regeneration nonresorbable barrier per site','D4270':'Pedicle soft tissue graft','D4271':'Free soft tissue graft','D4273':'Autogenous connective tissue graft','D4274':'Mesial/distal wedge procedure','D4275':'Non-autogenous connective tissue graft','D4276':'Combined connective tissue and double pedicle graft','D4277':'Free soft tissue graft each additional tooth','D4278':'Free soft tissue graft each additional contiguous tooth','D4283':'Autogenous connective tissue graft each additional tooth','D4285':'Non-autogenous connective tissue graft each additional tooth','D4320':'Provisional splinting intracoronal','D4321':'Provisional splinting extracoronal','D4341':'Periodontal scaling and root planing 4+ teeth per quadrant','D4342':'Periodontal scaling and root planing 1-3 teeth per quadrant','D4346':'Scaling in presence of generalized moderate or severe gingival inflammation','D4355':'Full mouth debridement','D4381':'Localized delivery of antimicrobial agents per tooth','D4910':'Periodontal maintenance','D4920':'Unscheduled dressing change',
  'D5110':'Complete denture maxillary','D5120':'Complete denture mandibular','D5130':'Immediate denture maxillary','D5140':'Immediate denture mandibular','D5211':'Maxillary partial denture resin base','D5212':'Mandibular partial denture resin base','D5213':'Maxillary partial denture cast metal framework','D5214':'Mandibular partial denture cast metal framework','D5221':'Immediate maxillary partial denture resin base','D5222':'Immediate mandibular partial denture resin base','D5223':'Immediate maxillary partial denture cast metal','D5224':'Immediate mandibular partial denture cast metal','D5225':'Maxillary partial denture flexible base','D5226':'Mandibular partial denture flexible base','D5282':'Removable unilateral partial denture one piece cast','D5283':'Removable unilateral partial denture one piece flexible','D5284':'Removable unilateral partial denture one piece cast metal','D5410':'Adjust complete denture maxillary','D5411':'Adjust complete denture mandibular','D5421':'Adjust partial denture maxillary','D5422':'Adjust partial denture mandibular','D5511':'Repair broken complete denture base mandibular','D5512':'Repair broken complete denture base maxillary','D5520':'Replace missing/broken teeth complete denture','D5611':'Repair resin partial denture base mandibular','D5612':'Repair resin partial denture base maxillary','D5621':'Repair cast partial framework mandibular','D5622':'Repair cast partial framework maxillary','D5630':'Repair or replace broken clasp per tooth','D5640':'Replace broken teeth per tooth','D5650':'Add tooth to existing partial denture','D5660':'Add clasp to existing partial denture','D5670':'Replace all teeth and acrylic on cast framework maxillary','D5671':'Replace all teeth and acrylic on cast framework mandibular','D5710':'Rebase complete maxillary denture','D5711':'Rebase complete mandibular denture','D5720':'Rebase maxillary partial denture','D5721':'Rebase mandibular partial denture','D5730':'Reline complete maxillary denture chairside','D5731':'Reline complete mandibular denture chairside','D5740':'Reline maxillary partial denture chairside','D5741':'Reline mandibular partial denture chairside','D5750':'Reline complete maxillary denture lab','D5751':'Reline complete mandibular denture lab','D5760':'Reline maxillary partial denture lab','D5761':'Reline mandibular partial denture lab','D5810':'Interim complete denture maxillary','D5811':'Interim complete denture mandibular','D5820':'Interim partial denture maxillary','D5821':'Interim partial denture mandibular','D5850':'Tissue conditioning maxillary','D5851':'Tissue conditioning mandibular','D5862':'Precision attachment','D5863':'Overdenture complete maxillary','D5864':'Overdenture partial maxillary','D5865':'Overdenture complete mandibular','D5866':'Overdenture partial mandibular','D5867':'Replacement of replaceable part of attachment',
  'D6010':'Surgical placement endosteal implant','D6011':'Second stage implant surgery','D6012':'Surgical placement interim implant','D6013':'Surgical placement mini implant','D6040':'Eposteal implant','D6050':'Custom fabricated abutment','D6051':'Interim abutment','D6052':'Semi-precision attachment abutment','D6055':'Connecting bar implant supported/retained','D6056':'Prefabricated abutment','D6057':'Custom fabricated abutment','D6058':'Abutment supported porcelain/ceramic crown','D6059':'Abutment supported porcelain fused to metal crown','D6060':'Abutment supported metallic crown','D6061':'Abutment supported porcelain/ceramic crown high noble','D6062':'Abutment supported cast metal crown high noble','D6063':'Abutment supported porcelain fused to metal crown base','D6064':'Abutment supported metallic crown base','D6065':'Implant supported porcelain/ceramic crown','D6066':'Implant supported porcelain fused to metal crown','D6067':'Implant supported metallic crown','D6068':'Abutment supported retainer porcelain/ceramic FPD','D6069':'Abutment supported retainer PFM FPD','D6070':'Abutment supported retainer cast metal FPD','D6071':'Abutment supported retainer metallic FPD','D6072':'Abutment supported retainer PFM FPD base','D6073':'Abutment supported retainer metallic FPD base','D6074':'Abutment supported retainer PFM FPD noble','D6075':'Implant supported retainer ceramic FPD','D6076':'Implant supported retainer PFM FPD','D6077':'Implant supported retainer metallic FPD','D6080':'Implant maintenance procedures','D6081':'Scaling and debridement around implant','D6082':'Implant supported removable denture maxillary','D6083':'Implant supported removable denture mandibular','D6084':'Implant supported fixed denture maxillary','D6085':'Implant supported fixed denture mandibular','D6086':'Implant supported fixed denture edentulous maxillary','D6087':'Implant supported fixed denture edentulous mandibular','D6090':'Repair implant supported prosthesis','D6091':'Replacement of semi-precision/precision attachment','D6092':'Re-cement/re-bond implant/abutment supported crown','D6093':'Re-cement/re-bond implant/abutment supported FPD','D6094':'Abutment supported crown titanium','D6095':'Repair implant abutment','D6096':'Remove broken implant retaining screw','D6097':'Abutment supported crown porcelain fused to titanium','D6098':'Implant supported crown porcelain fused to titanium','D6099':'Implant supported retainer porcelain fused to titanium',
  'D6100':'Implant removal by report','D6190':'Radiographic/surgical implant index','D6199':'Unspecified implant procedure',
  'D6210':'Pontic cast high noble metal','D6211':'Pontic cast predominantly base metal','D6212':'Pontic cast noble metal','D6214':'Pontic titanium','D6240':'Pontic porcelain fused to high noble metal','D6241':'Pontic porcelain fused to predominantly base metal','D6242':'Pontic porcelain fused to noble metal','D6243':'Pontic porcelain fused to titanium','D6245':'Pontic porcelain/ceramic','D6250':'Pontic resin with high noble metal','D6251':'Pontic resin with predominantly base metal','D6252':'Pontic resin with noble metal','D6253':'Provisional pontic','D6545':'Retainer cast metal for resin bonded FPD','D6548':'Retainer porcelain/ceramic for resin bonded FPD','D6549':'Resin retainer','D6600':'Retainer inlay porcelain/ceramic two surfaces','D6601':'Retainer inlay porcelain/ceramic three+ surfaces','D6602':'Retainer inlay cast high noble two surfaces','D6603':'Retainer inlay cast high noble three+ surfaces','D6604':'Retainer inlay cast predominantly base two surfaces','D6605':'Retainer inlay cast predominantly base three+ surfaces','D6606':'Retainer inlay cast noble two surfaces','D6607':'Retainer inlay cast noble three+ surfaces','D6608':'Retainer onlay porcelain/ceramic two surfaces','D6609':'Retainer onlay porcelain/ceramic three+ surfaces','D6610':'Retainer onlay cast high noble metal two surfaces','D6611':'Retainer onlay cast high noble metal three+ surfaces','D6612':'Retainer onlay cast predominantly base metal two surfaces','D6613':'Retainer onlay cast predominantly base metal three+ surfaces','D6614':'Retainer onlay cast noble metal two surfaces','D6615':'Retainer onlay cast noble metal three+ surfaces','D6624':'Retainer inlay titanium','D6634':'Retainer onlay titanium','D6710':'Retainer crown indirect resin based composite','D6720':'Retainer crown resin with high noble metal','D6721':'Retainer crown resin with predominantly base metal','D6722':'Retainer crown resin with noble metal','D6740':'Retainer crown porcelain/ceramic','D6750':'Retainer crown porcelain fused to high noble metal','D6751':'Retainer crown porcelain fused to predominantly base metal','D6752':'Retainer crown porcelain fused to noble metal','D6753':'Retainer crown porcelain fused to titanium','D6780':'Retainer crown 3/4 cast high noble metal','D6781':'Retainer crown 3/4 cast predominantly base metal','D6782':'Retainer crown 3/4 cast noble metal','D6783':'Retainer crown 3/4 porcelain/ceramic','D6784':'Retainer crown 3/4 titanium','D6790':'Retainer crown full cast high noble metal','D6791':'Retainer crown full cast predominantly base metal','D6792':'Retainer crown full cast noble metal','D6793':'Provisional retainer crown','D6794':'Retainer crown titanium',
  'D7111':'Extraction coronal remnants deciduous tooth','D7140':'Extraction erupted tooth or exposed root','D7210':'Extraction erupted tooth requiring removal of bone and/or sectioning','D7220':'Removal of impacted tooth soft tissue','D7230':'Removal of impacted tooth partially bony','D7240':'Removal of impacted tooth completely bony','D7241':'Removal of impacted tooth completely bony with complications','D7250':'Removal of residual tooth roots','D7251':'Coronectomy intentional partial tooth removal','D7260':'Oroantral fistula closure','D7261':'Primary closure of sinus perforation','D7270':'Tooth reimplantation/stabilization','D7272':'Tooth transplantation','D7280':'Exposure of unerupted tooth','D7282':'Mobilization of erupted/malpositioned tooth','D7283':'Placement of device to facilitate eruption','D7285':'Incisional biopsy of oral tissue hard','D7286':'Incisional biopsy of oral tissue soft','D7287':'Exfoliative cytological sample collection','D7288':'Brush biopsy','D7290':'Surgical repositioning of teeth','D7291':'Transseptal fiberotomy','D7292':'Placement of temporary anchorage device','D7293':'Placement of temporary anchorage device requiring flap','D7294':'Placement of temporary anchorage device requiring bone',
  'D7310':'Alveoloplasty in conjunction with extractions 4+ teeth per quadrant','D7311':'Alveoloplasty in conjunction with extractions 1-3 teeth per quadrant','D7320':'Alveoloplasty not in conjunction with extractions 4+ teeth per quadrant','D7321':'Alveoloplasty not in conjunction with extractions 1-3 teeth per quadrant','D7340':'Vestibuloplasty ridge extension','D7350':'Vestibuloplasty ridge extension including soft tissue grafts',
  'D7410':'Excision of benign lesion up to 1.25cm','D7411':'Excision of benign lesion greater than 1.25cm','D7412':'Excision of benign lesion complicated','D7413':'Excision of malignant lesion up to 1.25cm','D7414':'Excision of malignant lesion greater than 1.25cm','D7415':'Excision of malignant lesion complicated','D7440':'Excision of malignant tumor','D7441':'Excision of malignant tumor without closure','D7450':'Removal of benign odontogenic cyst/tumor','D7451':'Removal of benign nonodontogenic cyst/tumor','D7460':'Removal of benign neoplasm','D7461':'Removal of benign nonodontogenic neoplasm','D7465':'Destruction of lesion(s) by physical or chemical method','D7471':'Removal of lateral exostosis','D7472':'Removal of torus palatinus','D7473':'Removal of torus mandibularis','D7485':'Surgical reduction of osseous tuberosity','D7490':'Radical resection of mandible/maxilla',
  'D7510':'Incision and drainage of abscess intraoral soft tissue','D7511':'Incision and drainage of abscess intraoral soft tissue complicated','D7520':'Incision and drainage of abscess extraoral soft tissue','D7521':'Incision and drainage of abscess extraoral soft tissue complicated','D7530':'Removal of foreign body from mucosa/skin/subcutaneous tissue','D7540':'Removal of reaction-producing foreign bodies musculoskeletal system','D7550':'Partial ostectomy/sequestrectomy','D7560':'Maxillary sinusotomy for removal of tooth fragment or foreign body',
  'D7610':'Maxilla open reduction','D7620':'Maxilla closed reduction','D7630':'Mandible open reduction','D7640':'Mandible closed reduction','D7650':'Malar/zygomatic arch open reduction','D7660':'Malar/zygomatic arch closed reduction','D7670':'Alveolus closed reduction','D7671':'Alveolus open reduction','D7680':'Facial bones complicated reduction',
  'D7710':'Maxilla open reduction with fixation','D7720':'Maxilla closed reduction with fixation','D7730':'Mandible open reduction with fixation','D7740':'Mandible closed reduction with fixation','D7750':'Malar/zygomatic arch open reduction with fixation','D7760':'Malar/zygomatic arch closed reduction with fixation','D7770':'Alveolus open reduction with stabilization','D7771':'Alveolus closed reduction with stabilization','D7780':'Facial bones complicated reduction with fixation',
  'D7810':'Open reduction of dislocation','D7820':'Closed reduction of dislocation','D7830':'Manipulation under anesthesia','D7840':'Condylectomy','D7850':'Surgical discectomy','D7852':'Disc repair','D7854':'Synovectomy','D7856':'Myotomy','D7858':'Joint reconstruction','D7860':'Arthrotomy','D7865':'Arthroplasty','D7870':'Arthrocentesis','D7871':'Non-arthroscopic lysis and lavage','D7872':'Arthroscopy diagnosis','D7873':'Arthroscopy diagnosis with treatment','D7874':'Arthroscopy surgery lavage and lysis','D7875':'Arthroscopy surgery disc repositioning','D7876':'Arthroscopy surgery discectomy','D7877':'Arthroscopy surgery debridement','D7880':'Occlusal orthotic device','D7881':'Occlusal orthotic device adjustment',
  'D7910':'Suture of recent small wounds up to 5cm','D7911':'Complicated suture up to 5cm','D7912':'Complicated suture greater than 5cm','D7920':'Skin graft','D7921':'Collection/application of autologous blood concentrate','D7922':'Placement of intra-socket biological dressing','D7940':'Osteoplasty','D7941':'Osteotomy mandibular rami','D7943':'Osteotomy mandibular rami with bone graft','D7944':'Osteotomy segmented','D7945':'Osteotomy body of mandible','D7946':'LeFort I (maxilla total)','D7947':'LeFort I (maxilla segmented)','D7948':'LeFort II/III','D7949':'LeFort II or III','D7950':'Osseous/osteoperioteal/cartilage graft of mandible/maxilla autogenous','D7951':'Sinus augmentation with bone/bone substitutes via lateral open approach','D7952':'Sinus augmentation via vertical approach','D7953':'Bone replacement graft for ridge preservation per site','D7955':'Repair of maxillofacial soft/hard tissue defects','D7960':'Frenulectomy/frenuloplasty','D7961':'Buccal/labial frenectomy','D7962':'Lingual frenectomy','D7963':'Frenuloplasty','D7970':'Excision of hyperplastic tissue per arch','D7971':'Excision of pericoronal gingiva','D7972':'Surgical reduction of fibrous tuberosity','D7979':'Non-surgical sialolithotomy','D7980':'Surgical sialolithotomy','D7981':'Excision of salivary gland','D7982':'Sialodochoplasty','D7983':'Closure of salivary fistula','D7990':'Emergency tracheotomy','D7991':'Coronoidectomy','D7995':'Synthetic graft',
  'D8010':'Limited orthodontic treatment of the primary dentition','D8020':'Limited orthodontic treatment of the transitional dentition','D8030':'Limited orthodontic treatment of the adolescent dentition','D8040':'Limited orthodontic treatment of the adult dentition','D8050':'Interceptive orthodontic treatment of the primary dentition','D8060':'Interceptive orthodontic treatment of the transitional dentition','D8070':'Comprehensive orthodontic treatment of the transitional dentition','D8080':'Comprehensive orthodontic treatment of the adolescent dentition','D8090':'Comprehensive orthodontic treatment of the adult dentition','D8210':'Removable appliance therapy','D8220':'Fixed appliance therapy','D8660':'Pre-orthodontic treatment examination','D8670':'Periodic orthodontic treatment visit','D8680':'Orthodontic retention','D8681':'Removable orthodontic retainer adjustment','D8695':'Removal of fixed orthodontic appliances','D8696':'Repair of orthodontic appliance','D8697':'Repair/reattach orthodontic appliance','D8698':'Re-cement/re-bond fixed retainer','D8699':'Re-cement/re-bond fixed retainer',
  'D9110':'Palliative treatment of dental pain','D9120':'Fixed partial denture sectioning','D9210':'Local anesthesia not in conjunction with operative/surgical procedures','D9211':'Regional block anesthesia','D9212':'Trigeminal division block anesthesia','D9215':'Local anesthesia in conjunction with operative/surgical procedures','D9219':'Evaluation for deep sedation or general anesthesia','D9222':'Deep sedation/general anesthesia first 15 minutes','D9223':'Deep sedation/general anesthesia each subsequent 15 minutes','D9230':'Inhalation of nitrous oxide/analgesia','D9239':'Intravenous moderate (conscious) sedation first 15 minutes','D9243':'Intravenous moderate sedation each subsequent 15 minutes','D9248':'Non-intravenous conscious sedation','D9310':'Consultation','D9311':'Consultation with medical health care professional','D9420':'Hospital or ambulatory surgical center','D9430':'Office visit for observation','D9440':'Office visit after regularly scheduled hours','D9450':'Case presentation','D9610':'Therapeutic parenteral drug single administration','D9612':'Therapeutic parenteral drug two or more administrations','D9630':'Drugs or medicaments dispensed in office','D9910':'Application of desensitizing medicament','D9911':'Application of desensitizing resin','D9920':'Behavior management','D9930':'Treatment of complications post-surgical','D9932':'Cleaning and inspection of removable appliance','D9933':'Cleaning and inspection of fixed appliance','D9935':'Device repair','D9940':'Occlusal guard','D9941':'Fabrication of athletic mouthguard','D9942':'Repair/reline of occlusal guard','D9943':'Occlusal guard adjustment','D9944':'Occlusal guard hard appliance full arch','D9945':'Occlusal guard soft appliance full arch','D9946':'Occlusal guard hard appliance partial arch','D9950':'Occlusion analysis mounted case','D9951':'Occlusal adjustment limited','D9952':'Occlusal adjustment complete','D9970':'Enamel microabrasion','D9971':'Odontoplasty 1-2 teeth','D9972':'External bleaching per arch','D9973':'External bleaching per tooth','D9974':'Internal bleaching per tooth','D9975':'External bleaching for home application per arch','D9985':'Sales tax','D9986':'Missed appointment','D9987':'Cancelled appointment','D9990':'Certified translation/sign-language services','D9991':'Dental case management','D9992':'Dental case management motivational interviewing','D9993':'Dental case management patient education','D9994':'Dental case management coordination of care','D9995':'Teledentistry synchronous','D9996':'Teledentistry asynchronous','D9997':'Dental case management'
};

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

  const wsFO  = wb.getWorksheet('Financial Overview')    || wb.worksheets[0];
  const wsAC  = wb.getWorksheet('All Codes')             || wb.worksheets[1];
  const wsPBC = wb.getWorksheet('Production by Category') || wb.worksheets[2];

  /* ── Financial Overview ── */
  if (practiceName) sv(wsFO,'B2',practiceName);
  const yearCols = ['D','E','F'];
  years.slice(0,3).forEach((yr,i) => { if (yearCols[i]) sv(wsFO,yearCols[i]+'4',yr); });
  const col = yearCols[Math.min(years.length-1,2)] || 'E';

  const totalProd = Object.values(raw).reduce((s,v)=>s+v.total,0);
  sv(wsFO,col+'7',Math.round(totalProd*100)/100);

  const catRows = {diagnostic:8,preventive:9,restorative:10,endodontics:11,periodontics:12,prosthodontics:13,implants:14,oralSurgery:15,orthodontics:16,adjunctive:17,other:18};
  Object.entries(catRows).forEach(([cat,row]) => {
    if (groups[cat]) sv(wsFO,col+row,Math.round(groups[cat]*100)/100);
  });

  const collections = netCollectionsFromReport || pl?.netCollections || null;
  if (collections) sv(wsFO,col+'20',Math.round(Math.abs(collections)*100)/100);
  if (collections && totalProd>0) sv(wsFO,col+'22',Math.round(Math.abs(collections)/totalProd*10000)/10000);
  if (months>0) sv(wsFO,col+'26',Math.round(totalProd/months*100)/100);

  if (pl) {
    if (pl.totalExpense) sv(wsFO,col+'35',Math.round(Math.abs(pl.totalExpense)*100)/100);
    if (pl.netIncome != null) sv(wsFO,col+'36',Math.round(pl.netIncome*100)/100);
  }

  /* ── AR data ── */
  if (arPatient && arPatient.total) {
    sv(wsFO,'C32','Patient AR');
    sv(wsFO,'D32',arPatient.total);
    sv(wsFO,'E32',arPatient.current||0);
    sv(wsFO,'F32',arPatient.d3160||0);
    sv(wsFO,'G32',arPatient.d6190||0);
    sv(wsFO,'H32',arPatient.d90plus||0);
    sv(wsFO,'I32',arPatient.insr||0);
  }
  if (arInsurance && arInsurance.total) {
    sv(wsFO,'C33','Insurance AR');
    sv(wsFO,'D33',arInsurance.total);
    sv(wsFO,'E33',arInsurance.current||0);
    sv(wsFO,'F33',arInsurance.d3160||0);
    sv(wsFO,'G33',arInsurance.d6190||0);
    sv(wsFO,'H33',arInsurance.d90plus||0);
  }

  /* ── P&L Summary ── */
  if (pl) {
    if (pl.totalIncome != null) sv(wsFO,col+'35', Math.round(Math.abs(pl.totalExpense)*100)/100);
    if (pl.netIncome != null)   sv(wsFO,col+'36', Math.round(pl.netIncome*100)/100);
  }

  /* ── All Codes tab ── */
  if (wsAC) {
    // Sort all codes: non-zero first (by total desc), then zero-dollar codes
    const nonZero = Object.entries(raw).filter(([,v])=>v.total>0).sort((a,b)=>b[1].total-a[1].total);
    const zeroDollar = Object.entries(raw).filter(([,v])=>v.total===0).sort((a,b)=>a[0].localeCompare(b[0]));
    const allCodes = [...nonZero, ...zeroDollar];

    allCodes.forEach(([code,v],i) => {
      const r = i + 2;
      sv(wsAC,'A'+r, code);
      // Column B: ADA code description
      sv(wsAC,'B'+r, ADA_DESCRIPTIONS[code] || '');
      sv(wsAC,'C'+r, v.qty);
      sv(wsAC,'D'+r, Math.round(v.total*100)/100);
      if (v.qty>0) sv(wsAC,'E'+r, Math.round(v.total/v.qty*100)/100);

      // Apply strikethrough to zero-dollar codes
      if (v.total === 0) {
        ['A','B','C','D','E'].forEach(c => {
          try {
            const cell = wsAC.getCell(c+r);
            cell.font = { ...(cell.font || {}), strike: true, color: { argb: 'FF999999' } };
          } catch(e) {}
        });
      }
    });
  }

  /* ── Production by Category ── */
  if (wsPBC) {
    const cats   = ['diagnostic','preventive','restorative','endodontics','periodontics','prosthodontics','implants','oralSurgery','orthodontics','adjunctive','other'];
    const labels = ['Diagnostic','Preventive','Restorative','Endodontics','Periodontics','Prosthodontics','Implants','Oral Surgery','Orthodontics','Adjunctive','Other'];
    cats.forEach((cat,i) => {
      sv(wsPBC,'A'+(i+2),labels[i]);
      sv(wsPBC,'B'+(i+2),Math.round((groups[cat]||0)*100)/100);
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
  try { body = JSON.parse(event.body); } catch(e) { return {statusCode:400,body:JSON.stringify({error:'Invalid JSON'})}; }

  const {productionBase64,collectionsBase64,plBase64,practiceName='',arPatient={},arInsurance={}} = body;
  if (!productionBase64) return {statusCode:400,body:JSON.stringify({error:'productionBase64 required'})};

  try {
    const PROD_PROMPT = 'Dental practice production by procedure code report. Extract every procedure code with quantity and dollar total. Return ONLY one line per code: CODE|QTY|TOTAL (example: D0120|910|62016.00). Include the date range from the header on the first line verbatim.';
    const COLL_PROMPT = 'Dentrix Analysis Summary Provider report. Find the TOTAL row at the bottom of page 2. The payments number will appear as negative. Return ONLY:\nCHARGES|[total charges as positive number]\nPAYMENTS|[total payments as positive number, remove any minus sign]';
    const PL_PROMPT   = 'QuickBooks Profit and Loss. Extract full text with all labels and dollar amounts. Include Total Income, Total Expenses, Net Income clearly.';

    console.log('Starting Claude calls: prod + coll + pl...');
    const [prodText, collText, plText] = await Promise.all([
      callClaude(productionBase64, PROD_PROMPT, KEY),
      collectionsBase64 ? callClaude(collectionsBase64, COLL_PROMPT, KEY) : Promise.resolve(''),
      plBase64          ? callClaude(plBase64,          PL_PROMPT,   KEY) : Promise.resolve('')
    ]);
    console.log('Done. prod:', prodText.length, 'coll:', collText.slice(0,120));

    const prodMeta = parseProdMeta(prodText);
    const raw      = parseProd(prodText);
    const groups   = agg(raw);

    let netCollectionsFromReport = null;
    if (collText) {
      const m = collText.match(/PAYMENTS\|([\d,]+\.?\d*)/i);
      if (m) {
        netCollectionsFromReport = Math.abs(parseFloat(m[1].replace(/,/g,'')));
        console.log('Collections:', netCollectionsFromReport);
      }
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
