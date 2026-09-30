'use strict';
const NWImport=(()=>{
  const MAX=8*1024*1024,EXPANDED=80*1024*1024,PART=12*1024*1024;
  const fail=m=>{throw new Error(m);};
  const compact=t=>String(t||'').replace(/\s+/g,' ').trim();
  const tags=(node,name)=>Array.from(node.getElementsByTagNameNS('*',name));
  const children=(node,name)=>Array.from(node.children).filter(x=>x.localName===name);
  function decode(bytes,legacy=false){
    if(bytes[0]===255&&bytes[1]===254)return new TextDecoder('utf-16le',{fatal:true}).decode(bytes);
    if(bytes[0]===254&&bytes[1]===255)return new TextDecoder('utf-16be',{fatal:true}).decode(bytes);
    try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{if(legacy)return new TextDecoder('shift_jis',{fatal:true}).decode(bytes);throw new Error('UTF-8またはBOM付きUTF-16に変換してください。');}
  }
  function xml(s){if(/<!DOCTYPE|<!ENTITY/i.test(s))fail('DTD・外部実体を含むXMLは取り込めません。');const d=new DOMParser().parseFromString(s,'application/xml');if(tags(d,'parsererror').length||d.documentElement.localName==='parsererror')fail('XMLを読み取れません。');return d;}
  function zipCheck(bytes){
    if(bytes.byteLength>MAX)fail('1ファイル8MB以内にしてください。');
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let end=-1;
    for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(v.getUint32(i,true)===0x06054b50 && i+22+v.getUint16(i+20,true)===bytes.length){end=i;break;}
    if(end<0)fail('OfficeファイルのZIP構造が不正です。');
    const count=v.getUint16(end+10,true),size=v.getUint32(end+12,true),offset=v.getUint32(end+16,true);
    if(v.getUint16(end+4,true)||v.getUint16(end+6,true)||v.getUint16(end+8,true)!==count||count>4000||count===65535||offset+size!==end)fail('分割ZIP・ZIP64・過大なZIPには対応していません。');
    let cursor=offset,total=0;const names=new Set();
    for(let i=0;i<count;i++){
      if(cursor+46>end||v.getUint32(cursor,true)!==0x02014b50)fail('ZIPディレクトリが不正です。');
      const flags=v.getUint16(cursor+8,true),method=v.getUint16(cursor+10,true),compressed=v.getUint32(cursor+20,true),length=v.getUint32(cursor+24,true),n=v.getUint16(cursor+28,true),extra=v.getUint16(cursor+30,true),comment=v.getUint16(cursor+32,true),start=v.getUint32(cursor+42,true);
      if(cursor+46+n+extra+comment>end||start+30>offset||flags&1||![0,8].includes(method)||length>PART||(total+=length)>EXPANDED)fail('暗号化・巨大な展開サイズ・未対応のZIPです。');
      const name=decode(bytes.subarray(cursor+46,cursor+46+n));
      if(name.startsWith('/')||name.includes('\\')||name.split('/').includes('..')||/[\x00-\x1f]/.test(name)||names.has(name))fail('ZIP内部のファイル名が不正または重複しています。');names.add(name);
      if(v.getUint32(start,true)!==0x04034b50||start+30+v.getUint16(start+26,true)+v.getUint16(start+28,true)+compressed>offset)fail('ZIPのデータ位置が不正です。');
      cursor+=46+n+extra+comment;
    }
    if(cursor!==end)fail('ZIPディレクトリの長さが不正です。');
  }
  function bytesOf(entry){return new Promise((resolve,reject)=>{
    const stream=entry.internalStream('uint8array');let size=0,stopped=false;const parts=[];
    stream.on('data',chunk=>{if(stopped)return;size+=chunk.length;if(size>PART){stopped=true;stream.pause();reject(new Error('展開サイズが上限を超えました。'));return;}parts.push(chunk);});
    stream.on('error',reject);stream.on('end',()=>{if(stopped)return;const data=new Uint8Array(size);let p=0;for(const chunk of parts){data.set(chunk,p);p+=chunk.length;}resolve(data);});stream.resume();
  });}
  async function part(z,name){const file=z.file(name);if(!file)fail(`必要な内部ファイルがありません：${name}`);return xml(decode(await bytesOf(file)));}
  function resolve(owner,target){
    if(/^[a-z][a-z0-9+.-]*:|^\/\/|[?#\\]/i.test(target))fail('外部参照・不正な内部参照は使用できません。');
    const path=target.startsWith('/')?[]:owner.split('/').slice(0,-1);
    for(const p of target.split('/')){if(!p||p==='.')continue;if(p==='..'){if(!path.length)fail('パッケージ外の参照です。');path.pop();}else path.push(p);}return path.join('/');
  }
  async function rels(z,owner){
    const p=owner.split('/'),file=p.pop(),rel=[...p,'_rels',file+'.rels'].join('/');if(!z.file(rel))return new Map();const map=new Map();
    for(const r of tags(await part(z,rel),'Relationship')){if(r.getAttribute('TargetMode')==='External')continue;map.set(r.getAttribute('Id'),{target:resolve(owner,r.getAttribute('Target')),kind:r.getAttribute('Type').split('/').pop()});}return map;
  }
  const rid=n=>Array.from(n.attributes).find(a=>a.localName==='id'&&a.namespaceURI)?.value;
  function paragraphs(node){return tags(node,'p').map(p=>compact(tags(p,'t').map(t=>t.textContent).join(''))).filter(Boolean);}
  function visio(doc,prefix,add){
    for(const s of tags(doc,'Shape')){const id=s.getAttribute('ID'),text=children(s,'Text').map(t=>compact(t.textContent)).filter(Boolean).join(' / ');if(text)add(`${prefix} 図形${id}`,text);
      for(const sec of children(s,'Section').filter(n=>n.getAttribute('N')==='Property'))for(const row of children(sec,'Row')){const cells=children(row,'Cell');const value=cells.find(c=>c.getAttribute('N')==='Value');const label=cells.find(c=>c.getAttribute('N')==='Label');if(value)add(`${prefix} 図形${id} 属性${label?.getAttribute('V')||row.getAttribute('N')}`,value.getAttribute('V'));}
      for(const p of children(s,'Prop')){const label=children(p,'Label')[0]?.textContent||p.getAttribute('NameU'),value=children(p,'Value')[0]?.textContent;if(value)add(`${prefix} 図形${id} 属性${label}`,value);}
      if(s.hasAttribute('Master'))add(`${prefix} 図形${id} 継承参照`,`Master=${s.getAttribute('Master')}（継承文字・属性は未展開）`);
    }
    tags(doc,'Connect').forEach((c,i)=>add(`${prefix} 接続${i+1}`,`${c.getAttribute('FromSheet')}.${c.getAttribute('FromCell')} → ${c.getAttribute('ToSheet')}.${c.getAttribute('ToCell')}（登録情報）`));
  }
  async function extract(name,input){
    const bytes=input instanceof Uint8Array?input:new Uint8Array(input);if(bytes.length>MAX)fail('1ファイル8MB以内にしてください。');const ext=name.split('.').pop().toLowerCase(),lines=[];let chars=0;
    function add(location,text){const body=compact(text);if(!body)return;const line=location+': '+body;chars+=line.length+1;if(chars>160000)fail('抽出本文が16万字を超えます。対象範囲を絞ってください。');lines.push(line);}
    const old={doc:'docx',xls:'xlsx',ppt:'pptx',vsd:'vsdx'};if(old[ext])fail(`旧形式 .${ext} は .${old[ext]} へ「名前を付けて保存」してください。拡張子の変更だけでは変換できません。`);
    if(['txt','md','csv','cfg','log'].includes(ext)){const content=decode(bytes,true);if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content))fail('テキストに未対応の制御文字が含まれています。');content.split(/\r?\n/).forEach((s,i)=>add(`L${i+1}`,s));}
    else if(ext==='vdx'){const doc=xml(decode(bytes));const pages=tags(doc,'Page');if(pages.length>300)fail('Visioは300ページ以内にしてください。');pages.forEach((p,i)=>visio(p,`ページ${i+1}`,add));}
    else if(['docx','xlsx','pptx','vsdx'].includes(ext)){
      zipCheck(bytes);const z=await JSZip.loadAsync(bytes);
      if(ext==='docx'){const doc=await part(z,'word/document.xml');paragraphs(doc).forEach((s,i)=>add(`本文${i+1}`,s));}
      if(ext==='pptx'){
        const doc=await part(z,'ppt/presentation.xml'),refs=await rels(z,'ppt/presentation.xml'),slides=tags(doc,'sldId');if(slides.length>300)fail('PPTXは300スライド以内にしてください。');
        for(let i=0;i<slides.length;i++){
          const ref=refs.get(rid(slides[i]));if(!ref||ref.kind!=='slide')fail('スライド参照が不正です。');const slide=await part(z,ref.target),prefix=`スライド${i+1}${slide.documentElement.getAttribute('show')==='0'?'（非表示）':''}`;
          tags(slide,'sp').forEach((shape,j)=>paragraphs(shape).forEach(t=>add(`${prefix} 図形${j+1}`,t)));
          tags(slide,'tbl').forEach((table,j)=>children(table,'tr').forEach((row,k)=>add(`${prefix} 表${j+1} 行${k+1}`,children(row,'tc').map(c=>paragraphs(c).join(' / ')).join(' | '))));
          for(const ref2 of (await rels(z,ref.target)).values())if(ref2.kind==='notesSlide'){
            const notes=await part(z,ref2.target);for(const s of tags(notes,'sp')){const ph=tags(s,'ph')[0];if(['sldImg','sldNum','dt','hdr','ftr'].includes(ph?.getAttribute('type')))continue;paragraphs(s).forEach(t=>add(`${prefix} ノート`,t));}
          }
        }
      }
      if(ext==='xlsx'){
        const book=await part(z,'xl/workbook.xml'),refs=await rels(z,'xl/workbook.xml');const strings=z.file('xl/sharedStrings.xml')?tags(await part(z,'xl/sharedStrings.xml'),'si').map(s=>tags(s,'t').map(t=>t.textContent).join('')):[];
        const sheets=tags(book,'sheet');if(sheets.length>100)fail('Excelは100シート以内にしてください。');let cells=0;
        for(const sheet of sheets){const ref=refs.get(rid(sheet));if(!ref||ref.kind!=='worksheet')fail('ワークシート以外のシートは未対応です。');const doc=await part(z,ref.target),prefix=sheet.getAttribute('name')+(sheet.getAttribute('state')&&sheet.getAttribute('state')!=='visible'?'（非表示）':'');
          for(const row of tags(doc,'row')){const values=[];for(const c of children(row,'c')){if(++cells>400000)fail('Excelは40万セル以内にしてください。');const address=c.getAttribute('r'),type=c.getAttribute('t'),raw=children(c,'v')[0]?.textContent;let value=type==='s'?strings[Number(raw)]:type==='inlineStr'?tags(c,'t').map(t=>t.textContent).join(''):raw;
            if(type==='s'&&(raw===undefined||value===undefined))fail('Excel共有文字列の参照が不正です。');const f=children(c,'f')[0];if(f)value=`=${f.textContent||'共有数式'} [${raw===undefined?'保存済み値なし／未再計算':'保存済み値='+raw}]`;if(value!==undefined&&value!=='')values.push(address+'='+value);
          }if(values.length)add(prefix,values.join(' | '));}
        }
      }
      if(ext==='vsdx'){
        const owner='visio/pages/pages.xml',doc=await part(z,owner),refs=await rels(z,owner),pages=tags(doc,'Page');if(pages.length>300)fail('Visioは300ページ以内にしてください。');
        for(let i=0;i<pages.length;i++){const relation=children(pages[i],'Rel')[0],ref=relation&&refs.get(rid(relation));if(!ref||ref.kind!=='page')fail('Visioページ参照が不正です。');visio(await part(z,ref.target),`ページ${i+1}（${pages[i].getAttribute('Name')||pages[i].getAttribute('NameU')||''}）`,add);}
      }
    }else fail('ブラウザー版の対応形式はDOCX / XLSX / PPTX / VSDX / VDX / TXT / MD / CSV / CFG / LOGです。PDF・画像OCR・旧形式には対応していません。');
    if(!lines.length)fail('文字を抽出できませんでした。画像だけの資料はテキスト化してください。');return lines.join('\n');
  }
  return {extract,zipCheck,xml,decode};
})();
if(typeof module!=='undefined')module.exports=NWImport;
