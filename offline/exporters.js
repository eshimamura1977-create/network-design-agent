'use strict';
const NWExport=(()=>{
  const esc=v=>String(v??'未定').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const xml=s=>'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+s;
  const relns='http://schemas.openxmlformats.org/package/2006/relationships';
  const officens='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const relations=rows=>xml(`<Relationships xmlns="${relns}">${rows.map((r,i)=>`<Relationship Id="rId${i+1}" Type="${r[0]}" Target="${esc(r[1])}"/>`).join('')}</Relationships>`);
  const types=rows=>xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'+rows.map(r=>`<Override PartName="/${r[0]}" ContentType="${r[1]}"/>`).join('')+'</Types>');
  const compress=z=>z.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:6}});
  const join=v=>Array.isArray(v)?v.join(', '):v??'未定';
  function p(text,style='Normal'){return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r>${String(text??'未定').split('\n').map((s,i)=>(i?'<w:br/>':'')+`<w:t xml:space="preserve">${esc(s)}</w:t>`).join('')}</w:r></w:p>`;}
  async function docx(title,project,sections,sample=false){
    const z=new JSZip();
    z.file('[Content_Types].xml',types([['word/document.xml','application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],['word/styles.xml','application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml']]));
    z.file('_rels/.rels',relations([[officens+'/officeDocument','word/document.xml']]));
    z.file('word/_rels/document.xml.rels',relations([[officens+'/styles','styles.xml']]));
    z.file('word/styles.xml',xml('<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Yu Gothic" w:eastAsia="游ゴシック"/><w:sz w:val="20"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:color w:val="163C55"/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="260" w:after="140"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="163C55"/><w:sz w:val="28"/></w:rPr></w:style></w:styles>'));
    const body=p(title,'Title')+p(project.name)+p(`改訂 ${project.revision} ／ 要レビュー・未承認${sample?' ／ 操作確認用サンプル（AI生成ではありません）':''}`)+sections.map(s=>p(s.title,'Heading1')+s.lines.map(t=>p(t)).join('')).join('');
    z.file('word/document.xml',xml('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+body+'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>'));
    return compress(z);
  }
  const col=n=>{let s='';for(n++;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
  async function xlsx(sheets){
    const z=new JSZip(),names=new Set();
    const safe=sheets.map((s,i)=>{let name=s.name.replace(/[\\/*?:\[\]]/g,'_').slice(0,31);if(names.has(name.toLowerCase()))name=name.slice(0,25)+'_'+i;names.add(name.toLowerCase());return {...s,name};});
    z.file('[Content_Types].xml',types([['xl/workbook.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],['xl/styles.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'],...safe.map((s,i)=>[`xl/worksheets/sheet${i+1}.xml`,'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'])]));
    z.file('_rels/.rels',relations([[officens+'/officeDocument','xl/workbook.xml']]));
    z.file('xl/workbook.xml',xml(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${officens}"><sheets>${safe.map((s,i)=>`<sheet name="${esc(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`));
    z.file('xl/_rels/workbook.xml.rels',relations([...safe.map((s,i)=>[officens+'/worksheet',`worksheets/sheet${i+1}.xml`]),[officens+'/styles','styles.xml']]));
    z.file('xl/styles.xml',xml('<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Yu Gothic"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Yu Gothic"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF163C55"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'));
    safe.forEach((s,i)=>{
      const rows=[s.headers,...s.rows],last=col(s.headers.length-1)+rows.length;
      const data=rows.map((row,r)=>`<row r="${r+1}">${row.map((v,c)=>{const t=String(join(v));if(t.length>32767)throw Error('Excelセルが32767文字を超えています。');return `<c r="${col(c)}${r+1}" s="${r===0?1:0}" t="inlineStr"><is><t xml:space="preserve">${esc(t)}</t></is></c>`;}).join('')}</row>`).join('');
      z.file(`xl/worksheets/sheet${i+1}.xml`,xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${s.headers.map((h,c)=>`<col min="${c+1}" max="${c+1}" width="${s.widths?.[c]||28}" customWidth="1"/>`).join('')}</cols><sheetData>${data}</sheetData><autoFilter ref="A1:${last}"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup paperSize="8" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`));
    });return compress(z);
  }
  function layout(nodes){return new Map(nodes.map((n,i)=>[n.id,{x:190+(i%3)*360,y:120+Math.floor(i/3)*190}]));}
  function svg(a,d,test=false){
    const nodes=[...a.nodes,...(test?d.test_nodes:[])],links=[...a.connections,...(test?d.test_connections:[])],pos=layout(nodes),height=Math.max(360,Math.ceil(nodes.length/3)*190+100);
    let body=`<rect width="100%" height="100%" fill="#f4f7fb"/><text x="24" y="32" font-size="20">${test?'試験構成図':'ネットワーク構成図'} — 要レビュー</text>`;
    for(const l of links){const a=pos.get(l.a),b=pos.get(l.b);body+=`<path d="M ${a.x} ${a.y+46} L ${b.x} ${b.y-46}" stroke="#64748b" stroke-width="2" ${l.kind==='logical'?'stroke-dasharray="7 4"':''} fill="none"/><text x="${(a.x+b.x)/2}" y="${(a.y+b.y)/2}" font-size="11">${esc(l.id)}</text>`;}
    for(const n of nodes){const t=pos.get(n.id);body+=`<g><title>${esc([n.hostname,n.role,n.model,n.management_ip].join(' / '))}</title><rect x="${t.x-150}" y="${t.y-46}" width="300" height="100" rx="8" fill="white" stroke="#7194aa"/>`+[n.hostname.slice(0,32),n.hostname.length>32?n.hostname.slice(32):n.role.slice(0,25),(a.sites.find(s=>s.id===n.site_id)?.name||'')+' / '+(n.management_ip||'IP未定')].map((s,i)=>`<text x="${t.x}" y="${t.y-16+i*25}" text-anchor="middle" font-size="${i?12:15}">${esc(s)}</text>`).join('')+'</g>';}
    body+=`<text x="24" y="${height-20}" font-size="12">実線：物理 / 破線：論理。線のID・ポート・用途はパラメータシートの接続台帳を参照。</text>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="${height}" viewBox="0 0 1100 ${height}" font-family="Yu Gothic,sans-serif" fill="#163c55">${body}</svg>`;
  }
  async function vsdx(a,d,test=false){
    const z=new JSZip(),ns='http://schemas.microsoft.com/office/visio/2012/main',rbase='http://schemas.microsoft.com/visio/2010/relationships/';
    const nodes=[...a.nodes,...(test?d.test_nodes:[])],links=[...a.connections,...(test?d.test_connections:[])],pos=layout(nodes),height=Math.max(4,Math.ceil(nodes.length/3)*1.9+1),ids=new Map(nodes.map((n,i)=>[n.id,i+1]));
    const cells=o=>Object.entries(o).map(([k,v])=>`<Cell N="${k}" V="${esc(v)}"/>`).join('');
    const geometry=points=>'<Section N="Geometry" IX="0">'+points.map(([x,y],i)=>`<Row T="${i?'LineTo':'MoveTo'}" IX="${i+1}">${cells({X:x,Y:y})}</Row>`).join('')+'</Section>';
    let shapes=nodes.map((n,i)=>{const p=pos.get(n.id);return `<Shape ID="${i+1}" NameU="Device.${i+1}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">${cells({PinX:p.x/100,PinY:height-p.y/100,Width:3,Height:1,LocPinX:1.5,LocPinY:.5,LineColor:'#7194AA',LinePattern:1,FillForegnd:'#FFFFFF',FillPattern:1})}${geometry([[0,0],[3,0],[3,1],[0,1],[0,0]])}<Text>${esc(n.hostname+'\n'+n.role+'\n'+(n.management_ip||'IP未定'))}</Text></Shape>`;}).join('');
    let connects='';links.forEach((l,i)=>{const a=pos.get(l.a),b=pos.get(l.b),id=nodes.length+i+1,x1=a.x/100,y1=height-a.y/100-.5,x2=b.x/100,y2=height-b.y/100+.5,dx=x2-x1,dy=y2-y1,len=Math.hypot(dx,dy);
      shapes+=`<Shape ID="${id}" NameU="Link.${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">${cells({BeginX:x1,BeginY:y1,EndX:x2,EndY:y2,PinX:(x1+x2)/2,PinY:(y1+y2)/2,Width:len,Height:0,LocPinX:len/2,LocPinY:0,Angle:Math.atan2(dy,dx),OneD:1,LinePattern:l.kind==='logical'?2:1,LineColor:'#64748B',FillPattern:0})}${geometry([[0,0],[len,0]])}<Text>${esc(l.id+' / '+(l.a_port||'?')+' - '+(l.b_port||'?'))}</Text></Shape>`;
      connects+=`<Connect FromSheet="${id}" FromCell="BeginX" FromPart="9" ToSheet="${ids.get(l.a)}" ToCell="PinX" ToPart="3"/><Connect FromSheet="${id}" FromCell="EndX" FromPart="12" ToSheet="${ids.get(l.b)}" ToCell="PinX" ToPart="3"/>`;
    });
    z.file('[Content_Types].xml',types([['visio/document.xml','application/vnd.ms-visio.drawing.main+xml'],['visio/pages/pages.xml','application/vnd.ms-visio.pages+xml'],['visio/pages/page1.xml','application/vnd.ms-visio.page+xml']]));
    z.file('_rels/.rels',relations([[rbase+'document','visio/document.xml']]));z.file('visio/_rels/document.xml.rels',relations([[rbase+'pages','pages/pages.xml']]));z.file('visio/pages/_rels/pages.xml.rels',relations([[rbase+'page','page1.xml']]));
    z.file('visio/document.xml',xml(`<VisioDocument xmlns="${ns}"><StyleSheets><StyleSheet ID="0" NameU="No Style">${cells({LinePattern:1,FillPattern:1,FillForegnd:'#FFFFFF'})}</StyleSheet></StyleSheets></VisioDocument>`));
    z.file('visio/pages/pages.xml',xml(`<Pages xmlns="${ns}" xmlns:r="${officens}"><Page ID="0" Name="${test?'試験構成図':'構成図'}（要レビュー）" NameU="Topology draft"><PageSheet>${cells({PageWidth:11,PageHeight:height})}</PageSheet><Rel r:id="rId1"/></Page></Pages>`));
    z.file('visio/pages/page1.xml',xml(`<PageContents xmlns="${ns}"><Shapes>${shapes}</Shapes><Connects>${connects}</Connects></PageContents>`));return compress(z);
  }
  const sheet=(name,headers,rows,widths)=>({name,headers,rows,widths});
  const traceLines=x=>[`状態：${x.state} / 根拠：${x.rationale}`,`要件：${join(x.requirement_ids)}`,...x.evidence.map(e=>`引用 [${e.source_id}] ${e.quote}`)];
  async function bundle(project,workflow,progress=()=>{}){
    NWCore.project(project);if(!workflow||workflow.revision!==project.revision||NWCore.steps.some(k=>!workflow.stages[k]))throw Error('4段階の回答を取り込んでから出力してください。');NWCore.validateStages(workflow.stages,project);
    const {architecture:a,design:b,delivery:d,review:r}=workflow.stages,z=new JSZip(),status=workflow.sample?'操作確認用サンプル／AI生成ではありません':'AI回答から作成／要レビュー・未承認';
    const put=(name,data)=>z.file(name,data),word=async(name,title,sections)=>put(name,await docx(title,project,sections,workflow.sample));
    progress('Word文書を作成中');
    await word('01_要件定義書.docx','要件定義書',project.requirements.map(q=>({title:q.id+' / '+q.status,lines:[q.text,'出典：'+q.source]})));
    await word('02_基本設計書.docx','ネットワーク基本設計書',[{title:'概要',lines:[b.overview]},...b.sections.map(s=>({title:NWCore.defs.chapters.find(c=>c.key===s.key).title,lines:[s.proposal,'判断理由：'+s.rationale,'要件：'+join(s.requirement_ids),...s.evidence.map(e=>'引用 ['+e.source_id+'] '+e.quote),...s.questions.map(q=>'確認事項：'+q)]}))]);
    await word('02b_詳細設計書.docx','ネットワーク詳細設計書',[{title:'共通設計',lines:[a.overview,...a.questions.map(q=>'確認事項：'+q)]},...a.nodes.map(n=>({title:n.hostname,lines:[`拠点：${n.site_id} / 役割：${n.role}`,`機種：${n.model??'未定'} / OS：${n.os_version??'未定'}`,`管理IP：${n.management_ip??'未定'} / ネットワーク：${n.network_id??'未定'}`,...traceLines(n),...a.parameters.filter(p=>p.node_id===n.id).flatMap(p=>[p.name+'：'+p.value,...traceLines(p)])]}))]);
    await word('06_試験設計書.docx','試験設計書',[{title:'試験方針',lines:[d.test_policy,'結果は全件未実施。実機・検証環境で別途実施してください。']},...d.tests.map(t=>({title:t.id+' / '+t.kind,lines:[`対象：${join(t.targets)} / 要件：${join(t.requirement_ids)}`,'前提：'+t.preconditions,'操作：'+t.procedure,'期待結果：'+t.expected,'証跡：'+t.evidence_to_collect]}))]);
    const stepSections=rows=>rows.map(s=>({title:s.id+' / '+s.owner,lines:['対象：'+join(s.targets),'要件：'+join(s.requirement_ids),'操作：'+s.action,'確認：'+s.expected,'切戻し・復旧：'+s.rollback]}));
    await word('09_移行設計書.docx','移行設計書',stepSections(d.migration));await word('11_運用引継ぎ資料.docx','運用引継ぎ資料',stepSections(d.operations));
    progress('Excel台帳を作成中');
    const deviceHeaders=['ID','ホスト名','拠点','役割','機種','管理IP','OS','管理ネットワーク','状態','根拠','要件ID'];
    const deviceRows=ns=>ns.map(n=>[n.id,n.hostname,n.site_id,n.role,n.model,n.management_ip,n.os_version,n.network_id,n.state,n.rationale,n.requirement_ids]);
    const parSheet=(name,rows)=>sheet(name,['ID','機器ID','項目','値','状態','根拠','要件ID'],rows.map(p=>[p.id,p.node_id,p.name,p.value,p.state,p.rationale,p.requirement_ids]));
    const sheets=[sheet('概要',['項目','内容'],[['案件',project.name],['状態',status],['改訂',project.revision],['確認事項',a.questions.join('\n')]]),sheet('機器台帳',deviceHeaders,deviceRows(a.nodes)),sheet('アドレス台帳',['ID','拠点','名称','VRF','VLAN','CIDR','Gateway','状態','根拠','要件ID'],a.networks.map(n=>[n.id,n.site_id,n.name,n.vrf,n.vlan,n.cidr,n.gateway,n.state,n.rationale,n.requirement_ids])),sheet('接続台帳',['ID','A機器','Aポート','B機器','Bポート','種別','用途','状態','要件ID'],[...a.connections,...d.test_connections].map(l=>[l.id,l.a,l.a_port,l.b,l.b_port,l.kind,l.purpose,l.state,l.requirement_ids])),parSheet('全パラメータ',a.parameters),sheet('試験装置',deviceHeaders,deviceRows(d.test_nodes))];
    a.nodes.forEach((n,i)=>sheets.push(sheet(`H${i+1}_${n.hostname}`,['項目','値','状態'],[['機器ID',n.id,n.state],['機種',n.model,n.state],['OS',n.os_version,n.state],['管理IP',n.management_ip,n.state],...a.parameters.filter(p=>p.node_id===n.id).map(p=>[p.name,p.value,p.state])])));
    [...new Set(a.nodes.map(n=>n.model||'機種未定'))].forEach((m,i)=>sheets.push(sheet(`M${i+1}_${m}`,deviceHeaders,deviceRows(a.nodes.filter(n=>(n.model||'機種未定')===m)))));
    put('03_パラメータシート.xlsx',await xlsx(sheets));
    put('08_試験項目表.xlsx',await xlsx([sheet('試験項目',['ID','要件ID','対象','種別','前提','操作','期待結果','採取証跡','結果'],d.tests.map(t=>[t.id,t.requirement_ids,t.targets,t.kind,t.preconditions,t.procedure,t.expected,t.evidence_to_collect,'未実施']))]));
    put('10_工事資料.xlsx',await xlsx([sheet('工事手順',['順番','ID','対象','要件ID','作業','確認','切戻し','担当','結果'],d.construction.map((s,i)=>[i+1,s.id,s.targets,s.requirement_ids,s.action,s.expected,s.rollback,s.owner,'未実施']))]));
    put('12_要件対応・レビュー.xlsx',await xlsx([sheet('要件対応',['要件ID','判定','設計ID','試験ID','理由'],d.coverage.map(c=>[c.requirement_id,c.disposition,c.design_ids,c.test_ids,c.reason])),sheet('レビュー',['重大度','対象','指摘','必要な対応'],r.issues.map(i=>[i.severity,i.target,i.finding,i.required_action])),sheet('概要',['項目','内容'],[['状態',status],['レビュー要約',r.summary]])]));
    progress('構成図・Config案を作成中');
    for(const [test,name] of [[false,'04_構成図'],[true,'07_試験構成図']]){put(name+'.svg',svg(a,d,test));put(name+'.vsdx',await vsdx(a,d,test));}
    for(const c of d.configs){const n=a.nodes.find(n=>n.id===c.node_id);put('05_Config/'+n.hostname+'.review.txt',`${status}\nホスト：${n.hostname}\n機種：${n.model??'未定'} / OS：${n.os_version??'未定'}\n状態：${c.status}\n理由：${c.reason}\n実機投入前に構文・依存関係・差分・切戻しを確認してください。\n\n${c.text}`);}
    put('設計データ.json',JSON.stringify({project,workflow},null,2));
    put('はじめに.txt',`${status}\n案件：${project.name}\n${r.summary}\nこのZIPは承認済み成果物ではありません。Configはレビュー用テキストです。試験は未実施です。\nWordの印刷レイアウトとVisioデスクトップでの表示は利用環境で確認してください。SVGはブラウザーで閲覧できます。\n設計データ.jsonには入力資料の抽出テキストも含まれます。\n`);
    put('manifest.json',JSON.stringify({version:'browser-1',status:'review_required',sample:workflow.sample,revision:project.revision,blocking:r.issues.filter(i=>i.severity==='blocking').length,config_deferred:d.configs.filter(c=>c.status==='deferred').length,files:Object.keys(z.files).filter(k=>!z.files[k].dir)},null,2));
    progress('ZIPを作成中');return compress(z);
  }
  return {docx,xlsx,svg,vsdx,bundle};
})();
if(typeof module!=='undefined')module.exports=NWExport;
