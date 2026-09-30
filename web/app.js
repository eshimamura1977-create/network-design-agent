'use strict';
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = {projects:[], current:null, sources:[], jobs:[], tab:'requirements', dirty:false, findings:null, health:null, busy:false};
state.provider=localStorage.getItem('nw-ai-provider') || 'm365';
if(!['m365','ai'].includes(state.provider))state.provider='m365';
let pollTimer;
const labels = {candidate:'候補',confirmed:'確認済み',unresolved:'未決',completed:'完了',failed:'失敗',running:'処理中',queued:'待機中'};

async function api(path, body) {
  const response = await fetch(path, {method:body === undefined ? 'GET':'POST',headers:body === undefined ? {}:{'Content-Type':'application/json','X-Workbench-Request':'1'},body:body === undefined ? undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const value = await response.json();
  if (!response.ok) throw new Error([value.error,...(value.details || [])].join('\n'));
  return value;
}
function message(text, error=false) {const el=$('#message');el.textContent=text;el.className=error?'error':'';el.hidden=!text;}
async function execute(fn) {try {await fn();} catch(error) {message(error.message || '処理に失敗しました',true);}}
function dirty() {state.dirty=true;state.findings=null;renderHeader();}
function projectPath(suffix='') {return `/api/projects/${state.current.id}${suffix}`;}
function badge(status) {return `<span class="badge ${esc(status)}">${esc(labels[status] || status)}</span>`;}
function button(label,action,extra='') {return `<button class="button" data-action="${action}" ${extra}>${label}</button>`;}
function heading(num,title,description,action='') {return `<div class="page-heading"><div><div class="eyebrow">STEP ${num} / NETWORK DESIGN</div><h1>${title}</h1><p>${description}</p></div>${action}</div>`;}
function empty(title,description) {return `<div class="empty"><div class="empty-symbol">◇</div><h2>${title}</h2><p>${description}</p></div>`;}
function field(label,path,value,type='text') {return `<div class="field"><label class="label" for="f-${path}">${label}</label><input id="f-${path}" data-path="${path}" type="${type}" value="${esc(value)}"></div>`;}
function cell(path,value,wide=false,type='text') {return `<input aria-label="${esc(path)}" class="${wide?'wide-input':''}" data-path="${path}" type="${type}" value="${esc(value)}">`;}
function select(path,value,options) {return `<select aria-label="${esc(path)}" data-path="${path}">${options.map(([v,l])=>`<option value="${esc(v)}" ${value===v?'selected':''}>${esc(l)}</option>`).join('')}</select>`;}
function metrics() {
  const p=state.current.project;
  const data=[['▤',p.requirements.length,'要件候補・確定','根拠と状態を管理'],['✓',p.requirements.filter(r=>r.status==='confirmed').length,'確認済み要件','レビューで確定'],['▦',p.design.devices.length,'登録機器','ホスト単位で管理'],['⌁',p.design.vlans.length,'VLAN','共通のアドレス台帳']];
  return `<div class="metrics">${data.map(([icon,n,l,s])=>`<div class="metric"><div class="metric-icon">${icon}</div><div><div class="metric-label">${l}</div><div class="metric-number">${n}</div><div class="metric-sub">${s}</div></div></div>`).join('')}</div>`;
}
function renderHeader() {
  $('#project-select').innerHTML = state.projects.length ? state.projects.map(p=>`<option value="${p.id}" ${state.current?.id===p.id?'selected':''}>${esc(p.name)}</option>`).join(''):'<option value="">案件を作成してください</option>';
  $('#revision').textContent = state.current ? `v${state.current.revision}${state.dirty?' *':''}`:'';
  $('#save-project').disabled=!state.dirty;
  $('#save-project').textContent=state.dirty?'変更を保存':'保存済み';
  $('#req-count').textContent=state.current?.project.requirements.length || 0;
  $('#device-count').textContent=state.current?.project.design.devices.length || 0;
  document.querySelectorAll('[data-tab]').forEach(el=>el.classList.toggle('active',el.dataset.tab===state.tab));
}
function render() {
  renderHeader();
  if(!state.current) {
    $('#content').innerHTML=`<section class="welcome"><div class="empty"><div class="empty-symbol">⌁</div><div class="eyebrow">NETWORK DESIGN WORKBENCH</div><h1>最初の設計案件を開く</h1><p>要件の根拠、機器の設定値、成果物をひとつの案件に。<br>まずは架空のオフィスLANで、設計から出力まで試せます。</p><div class="actions"><button class="button primary" data-action="sample">サンプル案件で試す →</button><button class="button" data-action="new">新しい案件を作成</button></div><p>資料・設計データは、このPCに保存されます。</p></div></section>`;
    return;
  }
  $('#content').innerHTML=({requirements:requirementsView,design:designView,validation:validationView,outputs:outputsView})[state.tab]();
  if(state.tab==='outputs')$('#content').insertAdjacentHTML('afterbegin',designDocumentView());
  if(['requirements','outputs'].includes(state.tab))$('#content').insertAdjacentHTML('afterbegin',pipelineView());
  refreshAiControls();
}
function requirementsView() {
  const p=state.current.project;
  return heading('01','資料から、要件を明確に。','原文を取り込み、抽出した候補を確認して設計の前提を揃えます。')+metrics()+designDocumentView()+`<div class="grid-two"><div><section class="card"><div class="card-head"><h2>入力資料</h2><span>${state.sources.length} 件</span></div><div class="card-body"><label class="upload-area"><input id="upload" type="file" accept=".txt,.md,.csv,.cfg,.log,.docx,.xlsx,.pptx,.vsdx,.vdx,.pdf" multiple><span class="upload-symbol">↑</span><strong>ファイルを選択して取り込む</strong><small>Word · Excel · PowerPoint · Visio · PDF · テキスト / 各8MBまで</small></label><div class="divider-label">またはテキストを貼り付け</div><div class="field"><label class="label" for="source-name">資料名</label><input id="source-name" value="ヒアリングメモ.txt" maxlength="150"></div><div class="field"><label class="label" for="source-text">要件・現行情報</label><textarea id="source-text" rows="5" placeholder="例：業務端末とゲスト端末を分離する。&#10;管理通信にはVLAN 99を使用する。"></textarea></div><button class="button full-button" data-action="add-source">資料を登録</button>${state.sources.map(s=>`<div class="source-item"><details class="source-row"><summary><span>▤ ${esc(s.name)}</span><small>${s.body.length.toLocaleString()} 文字</small></summary><pre>${esc(s.body)}</pre></details><button class="button small danger" data-action="delete-source" data-source="${esc(s.id)}" aria-label="${esc(s.name)}を入力資料から削除">削除</button></div>`).join('')}<div class="notice">対応：.docx / .xlsx / .pptx / .vsdx / .vdx / .txt 等。PPTXは文字・表・ノート、Visioは図形文字・属性・登録済み接続情報を抽出します。<details><summary>取込範囲と旧形式について</summary>画像のOCR、SmartArt・グラフ・埋込ファイルの読解、線の見た目による接続推定、Visioマスターの継承文字・属性、Wordヘッダー・脚注・テキストボックスは未対応です。Excelはセルと数式・保存済み値を取り込み、再計算は行いません。非表示のスライド・シートとノートも取込対象です。旧形式 .doc / .xls / .ppt / .vsd は元のアプリで現行形式へ保存し直してください。各8MB・抽出16万字まで。</details></div></div><div class="section-actions"><button class="button" data-action="analyze-local" ${!state.sources.length?'disabled':''}>ローカルで候補抽出</button><button class="button primary" data-action="analyze-ai" ${!state.health?.ai.configured || !state.sources.length?'disabled':''}>AIで要件を整理</button></div></section>${analysisJobsView()}</div><section class="card"><div class="card-head"><h2>要件一覧</h2><button class="text-button" data-action="add-requirement">＋ 手入力で追加</button></div>${p.requirements.length?p.requirements.map((r,i)=>`<article class="requirement"><div class="requirement-top"><span class="req-id">${esc(r.id)} <span class="subtext">${esc(r.category)}</span></span><div class="actions">${select(`requirements.${i}.status`,r.status,[['candidate','候補'],['confirmed','確認済み'],['unresolved','未決']])}<button class="text-button" data-action="remove-requirement" data-index="${i}" aria-label="${esc(r.id)}を削除">×</button></div></div><textarea aria-label="${esc(r.id)} 要件" data-path="requirements.${i}.text" rows="2">${esc(r.text)}</textarea><details><summary>根拠：${esc(r.source)}</summary><div class="quote">${esc(r.quote || '手入力のため引用未登録')}</div></details></article>`).join(''):empty('要件はまだありません','資料を登録して候補を抽出するか、要件を手入力してください。')}<div class="section-actions"><span class="subtext">候補は原文と照合し、各行を「確認済み」に変更します。</span></div></section></div>`;
}

function pipelineView() {
  const jobs=state.jobs.filter(j=>j.kind==='pipeline');
  const pending=jobs.some(j=>['queued','running'].includes(j.status));
  const ready=state.provider==='m365'?state.health?.m365?.authenticated:state.health?.ai?.configured;
  return `<section class="card"><div class="card-head"><h2>AIで全工程のドラフトを一括生成</h2><span>Word・Excel・Visio・Config案</span></div><div class="card-body"><p>共通の設計データから、要件・基本／詳細設計・パラメータ・構成図・Config案・試験・移行・工事・運用引継ぎをZIPで作成します。</p><p class="subtext">設計 → 文書化 → 下流工程 → AIレビューの4段階。生成完了後も未承認です。機種・OSが未決の機器はConfig作成待ちとして出力します。既存の設計データへは自動反映されません。</p><button class="button primary" data-action="pipeline" ${!ready || !state.current.project.requirements.length || pending?'disabled':''}>AIで全工程を生成</button><p class="subtext">${!ready?'AI未接続です。「接続設定と対応範囲」で登録・サインインを行ってください。':'案件名・要件・資料本文・中間の設計案を、選択中のAIへ4回に分けて送信します。数分以上かかる場合があります。'} 要件一覧の登録が必要です。入力本文は合計5万字まで。</p></div>${jobs.map(j=>{
    const r=j.result;
    const old=r.revision!==state.current.revision || JSON.stringify((r.sources||[]).map(s=>s.id).sort())!==JSON.stringify(state.sources.map(s=>s.id).sort());
    return `<div class="job"><div class="job-header"><strong>全工程ドラフト ${r.revision?`v${r.revision}`:''}</strong>${badge(j.status)}</div>${j.status==='completed'?`<p>要レビュー · 機器 ${r.nodes}台 · 試験 ${r.tests}項目 · 未決・指摘 ${r.open_items}件 · 重大指摘 ${r.blocking}件</p><p class="subtext">Config案 ${r.config_drafts}件／作成待ち ${r.config_deferred}件${old?' · 過去の入力から生成':''}</p><a class="button primary" href="${esc(r.download_url)}" download>全工程ドラフトをダウンロード ↓</a><p class="subtext">最初に「12_要件対応とレビュー.xlsx」の未決事項・AIレビューを確認してください。</p>`:j.status==='failed'?`<p class="notice warning">${esc(r.error)}</p>`:`<p>${esc(r.stage||'処理を開始しています')}</p>`}</div>`;
  }).join('')}</section>`;
}
function designDocumentView() {
  const hasInput=state.sources.length || state.current.project.requirements.length;
  const aiReady=state.provider==='m365'?state.health?.m365?.authenticated:state.health?.ai?.configured;
  const pending=state.jobs.some(j=>j.kind==='design-document' && ['queued','running'].includes(j.status));
  const jobs=state.jobs.filter(j=>j.kind==='design-document');
  return `<section class="card"><div class="card-head"><h2>要件からネットワーク設計書を作成</h2><span>Word</span></div><div class="card-body"><p>機器・VLANの手入力を先に行わず、取り込んだ資料と要件一覧から基本設計書のドラフトを作成できます。</p><p class="subtext">ローカル：要件の章別整理と標準的な設計方針案。AI：資料に基づく個別の設計提案。いずれも未承認で、候補・未決を含みます。設定値やConfigへは自動反映しません。</p><div class="actions"><button class="button primary" data-action="design-document-local" ${!hasInput || pending?'disabled':''}>Word設計書のドラフトを作成</button><button class="button" data-action="design-document-ai" ${!hasInput || !aiReady || pending?'disabled':''}>${state.provider==='m365'?'M365 Copilot':'AI'}で設計案を生成</button></div>${!aiReady?'<p class="subtext">AI未接続のため、現在はローカルのドラフト作成を利用できます。</p>':''}<p class="subtext">対象：WAN・LAN・無線・クラウド・認証・通信制御・可用性・運用・移行の10章。資料本文と要件本文の合計5万字まで。</p></div>${jobs.map(j=>{
    const old=j.result.revision!==state.current.revision || JSON.stringify((j.result.sources || []).map(s=>s.id).sort())!==JSON.stringify(state.sources.map(s=>s.id).sort());
    return `<div class="job"><div class="job-header"><strong>ネットワーク基本設計書 ${j.result.revision?`v${j.result.revision}`:''}</strong>${badge(j.status)}</div><small>${esc(new Date(j.created).toLocaleString('ja-JP'))}</small>${j.status==='completed'?`<p class="subtext">${j.result.mode==='local'?'ローカル整理と標準的な設計方針案':'AIによる設計方針案'} · 未承認 · ${j.result.chapters}章 · 未分類要件 ${j.result.unmapped}件${old?' · 過去の入力から作成（必要に応じて再生成）':''}</p><a class="button primary" href="${esc(j.result.download_url)}" download>Word設計書をダウンロード ↓</a>`:j.status==='failed'?`<p class="notice warning">${esc(j.result.error)}</p>`:'<p class="subtext">設計書を作成しています。完了するとWordをダウンロードできます。</p>'}</div>`;
  }).join('')}</section>`;
}
function analysisJobsView() {
  const jobs=state.jobs.filter(j=>j.kind==='analysis').slice(0,3);
  if(!jobs.length)return '';
  return `<section class="card"><div class="card-head"><h2>解析結果</h2><span>直近3件</span></div>${jobs.map(j=>`<div class="job"><div class="job-header"><strong>${j.result.mode==='ai'?'AI整理':'要件候補の抽出'}</strong>${badge(j.status)}</div><small>${esc(new Date(j.created).toLocaleString('ja-JP'))}</small>${j.status==='completed'?`<p class="subtext">${j.result.requirements.length} 件の候補 · 元の設計版 v${j.result.base_revision}</p><p class="advice">${esc(j.result.advice)}</p><details><summary class="subtext">候補の内容を確認</summary><div class="job-req">${j.result.requirements.map(r=>`<p>${esc(r.text)}<br><small>${esc(r.source)}</small></p>`).join('')}</div></details><div class="actions"><button class="button primary" data-action="apply-analysis" data-job="${j.id}" ${j.result.base_revision!==state.current.revision?'disabled':''}>候補を要件一覧に追加</button></div>${j.result.base_revision!==state.current.revision?'<p class="subtext">反映済み、または設計版が更新されています。</p>':''}`:j.status==='failed'?`<p class="notice warning">${esc(j.result.error)}</p>`:'<div class="loading-line"></div><p class="subtext">資料を処理しています。この画面で結果を確認できます。</p>'}</div>`).join('')}</section>`;
}
function designView() {
  const d=state.current.project.design;
  return heading('02','設計データを、一元管理。','各成果物の元になる値を編集します。自動で推測した設定値は挿入しません。')+`<section class="card"><div class="card-head"><h2>接続構成</h2><span>保存済みデータから表示</span></div>${d.devices.length?`<img class="topology" src="${projectPath('/topology')}?v=${state.current.revision}" alt="保存済みのネットワーク接続構成図">`:empty('機器を追加してください','機器とポート、接続を登録すると構成図が表示されます。')}</section><section class="card"><div class="card-head"><h2>設計方針・未決事項</h2></div><div class="card-body"><textarea aria-label="設計方針・未決事項" data-path="design.notes" rows="3" placeholder="採用方式、対象外、未確定の情報を記録">${esc(d.notes)}</textarea></div></section><section class="card"><div class="card-head"><h2>VLAN・サブネット</h2><button class="text-button" data-action="add-vlan">＋ VLAN追加</button></div><div class="table-scroll"><table><thead><tr><th>VLAN ID</th><th>名称</th><th>サブネット</th><th>VRF</th><th>用途</th><th></th></tr></thead><tbody>${d.vlans.map((v,i)=>`<tr><td>${cell(`design.vlans.${i}.id`,v.id,false,'number')}</td><td>${cell(`design.vlans.${i}.name`,v.name)}</td><td>${cell(`design.vlans.${i}.subnet`,v.subnet,true)}</td><td>${cell(`design.vlans.${i}.vrf`,v.vrf)}</td><td>${cell(`design.vlans.${i}.purpose`,v.purpose)}</td><td><button class="text-button" data-action="remove-vlan" data-index="${i}" aria-label="VLAN ${v.id}を削除">×</button></td></tr>`).join('')}</tbody></table></div></section><div class="page-heading"><div><h2>機器・インターフェース</h2><p>管理IPはCIDR形式。ConfigはC9200LのL2設定に対応。</p></div><button class="button" data-action="add-device">＋ 機器を追加</button></div>${d.devices.map((dev,i)=>deviceCard(dev,i)).join('')}<section class="card"><div class="card-head"><h2>物理接続</h2><button class="text-button" data-action="add-link">＋ 接続を追加</button></div><div class="table-scroll"><table><thead><tr><th>接続元ホスト</th><th>接続元ポート</th><th>接続先ホスト</th><th>接続先ポート</th><th></th></tr></thead><tbody>${d.links.map((l,i)=>`<tr>${['a_device','a_port','b_device','b_port'].map(k=>`<td>${cell(`design.links.${i}.${k}`,l[k],true)}</td>`).join('')}<td><button class="text-button" data-action="remove-link" data-index="${i}" aria-label="接続${i+1}を削除">×</button></td></tr>`).join('')}</tbody></table></div></section>`;
}
function deviceCard(d,i) {
  const prefix=`design.devices.${i}`;
  return `<section class="card"><div class="device-header"><h3>▦ ${esc(d.hostname)}</h3><button class="text-button" data-action="remove-device" data-index="${i}">機器を削除</button></div><div class="device-fields">${[['ホスト名','hostname'],['機種','model'],['OS版','os_version'],['役割','role'],['管理IP / prefix','management_ip'],['管理VLAN','management_vlan','number'],['ゲートウェイ','gateway'],['VRF','vrf']].map(([label,key,type])=>field(label,`${prefix}.${key}`,d[key],type || 'text')).join('')}</div><div class="table-scroll"><table><thead><tr><th>インターフェース</th><th>モード</th><th>VLAN（カンマ区切り）</th><th>Native VLAN</th><th>説明</th><th></th></tr></thead><tbody>${d.ports.map((p,j)=>`<tr><td>${cell(`${prefix}.ports.${j}.name`,p.name,true)}</td><td>${select(`${prefix}.ports.${j}.mode`,p.mode,[['access','access'],['trunk','trunk']])}</td><td>${cell(`${prefix}.ports.${j}.vlans`,p.vlans.join(','))}</td><td>${cell(`${prefix}.ports.${j}.native_vlan`,p.native_vlan,false,'number')}</td><td>${cell(`${prefix}.ports.${j}.description`,p.description)}</td><td><button class="text-button" data-action="remove-port" data-index="${i}" data-port="${j}" aria-label="${esc(p.name)}を削除">×</button></td></tr>`).join('')}</tbody></table></div><div class="port-actions"><button class="text-button" data-action="add-port" data-index="${i}">＋ ポートを追加</button></div></section>`;
}
function validationView() {
  const findings=state.findings;
  const approved=state.current.approved_revision===state.current.revision&&!state.dirty;
  const errors=findings?.filter(f=>f.level==='error').length || 0;
  const warnings=findings?.filter(f=>f.level==='warning').length || 0;
  return heading('03','整合性を確かめて、承認。','IP・VLAN・接続の静的検査と、担当者による設計レビューを行います。',`<button class="button primary" data-action="validate">検証を実行</button>`)+`<section class="card"><div class="card-head"><h2>検証結果</h2><span>${findings?`v${state.current.revision} / ${errors} エラー・${warnings} 警告`:'未実施'}</span></div>${findings?`<div class="check-summary"><div class="check-icon">${errors||warnings?'!':'✓'}</div><div><h2>${errors?'設定の修正が必要です':warnings?'確認が必要な項目があります':'実装済みの静的検査を通過しました'}</h2><p>この結果は設計の完全性や実機動作を保証するものではありません。</p></div></div><div class="findings">${findings.map(f=>`<div class="finding"><span class="badge ${esc(f.level)}">${{error:'エラー',warning:'警告',info:'確認事項'}[f.level]}</span><div><strong>${esc(f.target)}</strong><p>${esc(f.message)}</p><code>${esc(f.code)}</code></div></div>`).join('')}</div>`:empty('検証を実行してください','IP重複、サブネット重複、管理IP、VLAN参照、ポート重複、物理接続の両端を照合します。')}</section><section class="card"><div class="card-head"><h2>設計レビュー</h2>${approved?badge('confirmed'):'<span>未承認</span>'}</div><div class="card-body"><p>要件と設定値を確認し、この版を成果物の生成元として承認します。承認後に値を変更すると、再承認が必要です。</p><div class="notice warning">Configは承認済みかつエラー・警告がない版だけ出力します。AAA・SSH・監視・NTP・STP方針等は別途設計が必要です。試作Configをそのまま本番に投入しないでください。</div><button class="button teal" data-action="approve" ${approved?'disabled':''}>${approved?`v${state.current.revision} 承認済み`:'この版の設計を承認する'}</button></div></section>`;
}
function outputsView() {
  const outputs=[['DOCX','要件定義書・設計書','要件の根拠と共通の設計値'],['XLSX','パラメータシート','ホスト別・機種別・アドレス台帳'],['VSDX','構成図・試験構成図','試作VSDX + SVG / 表示未検証'],['CFG','機器別Config','承認・静的検査通過時のみ'],['DOCX','試験設計書・移行設計書','試験方針と移行計画の下書き'],['XLSX','試験項目表・工事資料','期待値・結果・作業手順の下書き'],['DOCX','運用引継ぎ資料','管理情報・運用上の未決事項'],['JSON','設計データ・検証結果','版番号と出力ファイルのSHA-256']];
  const jobs=state.jobs.filter(j=>j.kind==='export');
  return heading('04','同じ設計から、成果物へ。','設計版を固定して一括生成します。長い処理はバックグラウンドで実行します。',`<button class="button primary" data-action="generate">成果物を一括生成 ↓</button>`)+`<div class="output-grid">${outputs.map(([type,title,text])=>`<div class="output-card"><div class="file-type ${type.toLowerCase()}">${type}</div><div><h3>${title}</h3><p>${text}</p></div></div>`).join('')}</div><div class="notice">生成物はレビュー用の下書きです。試験の具体化、移行・工事・引継ぎは未決事項を含みます。出力したOfficeファイルの編集内容は、設計データへ自動反映されません。</div><section class="card"><div class="card-head"><h2>生成履歴</h2><span>版ごとに保存</span></div>${jobs.length?jobs.map(j=>`<div class="job"><div class="job-header"><h3>成果物パッケージ ${j.result.revision?`v${j.result.revision}`:''}</h3>${badge(j.status)}</div><small>${esc(new Date(j.created).toLocaleString('ja-JP'))}</small>${j.status==='completed'?`<p class="subtext">${j.result.files.length} ファイル · Config ${j.result.config_included?'含む':'未出力（承認と検証を確認）'} ${j.result.revision!==state.current.revision?' · 過去の設計版':''}</p><div class="actions"><a class="button primary" href="${esc(j.result.download_url)}" download>ZIPをダウンロード ↓</a><span class="badge">v${j.result.revision}</span></div><details class="negative-space"><summary class="subtext">生成ファイルを確認</summary><div class="job-req">${j.result.files.map(f=>`<p>${esc(f.name)} <small>${Math.ceil(f.size/1024)} KB</small></p>`).join('')}</div></details>`:j.status==='failed'?`<p class="notice warning">${esc(j.result.error)}</p>`:'<div class="loading-line"></div><p class="subtext">Word・Excel・構成図などを生成しています。</p>'}</div>`).join(''):empty('まだ成果物を生成していません','登録済みの設計データをもとに、Word・Excel・構成図などをまとめて生成します。')}</section>`;
}
async function refreshProjects(){state.projects=await api('/api/projects');renderHeader();}
async function loadProject(id) {
  clearTimeout(pollTimer);
  const [current,sources,jobs]=await Promise.all([api(`/api/projects/${id}`),api(`/api/projects/${id}/sources`),api(`/api/projects/${id}/jobs`)]);
  state.current=current;state.sources=sources;state.jobs=jobs;state.dirty=false;state.findings=null;
  localStorage.setItem('nw-current-project',id);render();schedulePoll();
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if(state.jobs.some(j=>['queued','running'].includes(j.status))){
    const projectId=state.current.id;
    pollTimer=setTimeout(()=>execute(async()=>{
      const jobs=await api(`/api/projects/${projectId}/jobs`);
      if(state.current.id!==projectId)return;
      state.jobs=jobs;
      // Do not replace an editor while the user is typing.
      if(['requirements','outputs'].includes(state.tab) && !$('#content').contains(document.activeElement)) render();
      if(jobs.some(j=>['queued','running'].includes(j.status)))schedulePoll();
      else {message('処理が完了しました。解析結果または生成履歴を確認してください。'); if(['requirements','outputs'].includes(state.tab) && !state.dirty)render();}
    }),1200);
  }
}
async function save() {
  if(!state.dirty)return;
  state.current=await api(projectPath(),{revision:state.current.revision,project:state.current.project});state.dirty=false;state.findings=null;
  await refreshProjects();render();message('設計データを保存しました。変更前の版も保持しています。');
}
async function create(sample=false,name='') {
  if(state.dirty&&!confirm('未保存の変更があります。保存せずに別の案件を開きますか？'))return;
  const created=await api('/api/projects',sample?{sample:true}:{name});
  await refreshProjects();await loadProject(created.id);message(sample?'架空のサンプル案件を開きました。設定値を変更して検証・生成を試せます。':'新しい案件を作成しました。');
}
function addDevice() {
  const devices=state.current.project.design.devices;let n=devices.length+1;
  while(devices.some(d=>d.hostname===`SW-${String(n).padStart(2,'0')}`))n++;
  devices.push({hostname:`SW-${String(n).padStart(2,'0')}`,model:'C9200L',os_version:'IOS XE 17.x',adapter:'cisco_ios_l2',role:'アクセス',management_ip:'',management_vlan:99,gateway:'',vrf:'default',ports:[]});dirty();render();
}
async function action(name,el) {
  if(name==='sample')return create(true);
  if(name==='new')return $('#new-dialog').showModal();
  const p=state.current?.project,d=p?.design,i=Number(el.dataset.index);
  if(name==='add-source'){
    const text=$('#source-text').value;if(!text.trim())throw new Error('資料のテキストを入力してください');
    await api(projectPath('/sources'),{name:$('#source-name').value,text});state.sources=await api(projectPath('/sources'));render();message('資料を登録しました。要件の候補を抽出できます。');
  }else if(name==='delete-source'){
    const source=state.sources.find(s=>s.id===el.dataset.source);
    if(!source)return;
    const count=p.requirements.filter(r=>r.source_id?r.source_id===source.id:r.source===source.name||r.source.startsWith(source.name+' / ')).length;
    if(!confirm(`「${source.name}」を入力資料から削除しますか？\n\nPC上の元ファイルは削除しません。既存の要件・引用・履歴・成果物は残ります。\n関連する要件${count}件を「未決」に戻し、設計の承認を解除します。削除前の解析結果は反映できなくなります。${state.dirty?'\n未保存の設計編集は先に保存します。':''}`))return;
    const projectId=state.current.id;
    await save();
    if(state.current.id!==projectId)throw new Error('案件が切り替わりました。対象の案件で削除してください。');
    const result=await api(projectPath(`/sources/${source.id}/delete`),{revision:state.current.revision});
    await refreshProjects();
    if(state.current.id!==projectId)return;
    await loadProject(projectId);
    message(`「${source.name}」を入力資料から削除しました。関連要件${result.affected_requirements}件は未決です。必要な資料で再解析してください。`);
  }else if(name==='add-requirement'){
    let n=1;while(p.requirements.some(r=>r.id===`REQ-${String(n).padStart(3,'0')}`))n++;
    p.requirements.push({id:`REQ-${String(n).padStart(3,'0')}`,text:'要件を入力してください',source:'手入力',quote:'',status:'candidate',category:'機能'});dirty();render();
  }else if(name==='remove-requirement'){p.requirements.splice(i,1);dirty();render();
  }else if(name.startsWith('analyze-')){
    await save();const mode=name==='analyze-ai'?state.provider:'local';await api(projectPath('/analyze'),{mode});state.jobs=await api(projectPath('/jobs'));render();schedulePoll();message(mode==='local'?'ローカルで要件候補を抽出しています。':`${mode==='m365'?'M365 Copilot':'設定したAI'}へ解析を依頼しました。`);
  }else if(name==='apply-analysis'){
    if(state.dirty)throw new Error('未保存の編集があります。保存してから最新の版で再解析してください。');
    const current=await api(`/api/jobs/${el.dataset.job}/apply`,{});await refreshProjects();await loadProject(current.id);message('要件候補を追加しました。原文を確認し、各行の状態を更新してください。');
  }else if(name==='add-device'){addDevice();
  }else if(name==='remove-device'){d.devices.splice(i,1);dirty();render();
  }else if(name==='add-vlan'){let id=10;while(d.vlans.some(v=>v.id===id))id++;d.vlans.push({id,name:`VLAN${id}`,subnet:'',vrf:'default',purpose:''});dirty();render();
  }else if(name==='remove-vlan'){d.vlans.splice(i,1);dirty();render();
  }else if(name==='add-port'){const ports=d.devices[i].ports;let n=1;while(ports.some(p=>p.name===`GigabitEthernet1/0/${n}`))n++;ports.push({name:`GigabitEthernet1/0/${n}`,mode:'access',vlans:[],native_vlan:1,description:''});dirty();render();
  }else if(name==='remove-port'){d.devices[i].ports.splice(Number(el.dataset.port),1);dirty();render();
  }else if(name==='add-link'){d.links.push({a_device:'',a_port:'',b_device:'',b_port:''});dirty();render();
  }else if(name==='remove-link'){d.links.splice(i,1);dirty();render();
  }else if(name==='validate'){await save();state.findings=(await api(projectPath('/validate'),{})).findings;render();message('登録された設計データの静的検査が完了しました。');
  }else if(name==='approve'){await save();state.current=await api(projectPath('/approve'),{revision:state.current.revision});render();message(`v${state.current.revision}を承認しました。成果物からConfigの下書きを生成できます。`);
  }else if(name==='pipeline'){
    const projectId=state.current.id;
    await save();
    if(state.current.id!==projectId)throw new Error('案件が切り替わりました。対象の案件で再実行してください。');
    await api(projectPath('/pipeline'),{revision:state.current.revision,mode:state.provider});
    state.jobs=await api(projectPath('/jobs'));render();schedulePoll();
    message('全工程のドラフト作成を開始しました。進捗とレビュー結果をこの欄に表示します。');
  }else if(name.startsWith('design-document-')){
    const projectId=state.current.id;
    await save();
    if(state.current.id!==projectId)throw new Error('案件が切り替わりました。対象の案件で再実行してください。');
    const mode=name==='design-document-local'?'local':state.provider;
    await api(projectPath('/design-document'),{revision:state.current.revision,mode});
    state.jobs=await api(projectPath('/jobs'));render();schedulePoll();
    message('ネットワーク基本設計書の作成を開始しました。この欄にWordのダウンロードボタンが表示されます。');
  }else if(name==='generate'){await save();await api(projectPath('/generate'),{revision:state.current.revision});state.jobs=await api(projectPath('/jobs'));render();schedulePoll();message('成果物の生成を開始しました。完了するとZIPを取得できます。');}
}
document.addEventListener('click',event=>{
  const tab=event.target.closest('[data-tab]');if(tab){state.tab=tab.dataset.tab;message('');render();return;}
  const target=event.target.closest('[data-action]');
  if(target)execute(async()=>{target.disabled=true;try{await action(target.dataset.action,target);}finally{target.disabled=false;}});
});
$('#content').addEventListener('input',event=>{
  const path=event.target.dataset.path;if(!path)return;
  const keys=path.split('.');let owner=state.current.project;for(const key of keys.slice(0,-1))owner=owner[key];
  const key=keys.at(-1);let value=event.target.value;
  if(key==='vlans')value=value.trim()?value.split(',').map(x=>Number(x.trim())):[];
  else if(event.target.type==='number')value=value===''?null:Number(value);
  owner[key]=value;dirty();
});
$('#content').addEventListener('change',event=>{
  if(event.target.id==='upload')execute(async()=>{
    const projectId=state.current.id;
    let imported=0;const errors=[];
    for(const file of Array.from(event.target.files)){
      try{
        if(file.size>8*1024*1024)throw new Error('8MBを超えています');
        message(`${file.name} を取り込んでいます…`);
        const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(new Error('ファイルを読み込めませんでした'));reader.readAsDataURL(file);});
        await api(`/api/projects/${projectId}/sources`,{name:file.name,base64});imported++;
      }catch(error){errors.push(`${file.name}: ${error.message}`);}
    }
    if(state.current.id!==projectId)return;
    state.sources=await api(projectPath('/sources'));render();
    message(errors.length?`${imported}件取込済み／${errors.length}件失敗。${errors.slice(0,3).join(' ／ ')}`:`${imported}件の資料を取り込みました。抽出内容を確認して要件の候補を抽出してください。`,errors.length>0);
  });
});
$('#project-select').addEventListener('change',event=>execute(async()=>{if(state.dirty&&!confirm('未保存の変更を破棄して案件を切り替えますか？')){renderHeader();return;}await loadProject(event.target.value);message('');}));
$('#save-project').addEventListener('click',()=>execute(save));
$('#sample-project').addEventListener('click',()=>execute(()=>create(true)));
$('#new-project').addEventListener('click',()=>$('#new-dialog').showModal());
$('#cancel-new').addEventListener('click',()=>$('#new-dialog').close());
$('#new-form').addEventListener('submit',event=>{event.preventDefault();execute(async()=>{await create(false,$('#new-name').value);$('#new-dialog').close();});});
function refreshAiControls(){
  const m=state.health?.m365;
  const pipelineButton=$('[data-action="pipeline"]');
  if(pipelineButton)pipelineButton.disabled=!state.current?.project.requirements.length || !(state.provider==='m365'?m?.authenticated:state.health?.ai?.configured) || state.jobs.some(j=>j.kind==='pipeline' && ['queued','running'].includes(j.status));
  $('#ai-badge').textContent=state.provider==='m365'?(m?.authenticated?'M365 サインイン済み':m?.configured?'M365 要サインイン':'M365 未設定'):(state.health?.ai.configured?'AI 設定済み':'AI 未接続');
  const button=$('[data-action="analyze-ai"]');
  if(button){button.textContent=state.provider==='m365'?'M365 Copilotで要件を整理':'AIで要件を整理';button.disabled=!state.sources.length || !(state.provider==='m365'?m?.authenticated:state.health?.ai.configured);}
  const draftButton=$('[data-action="design-document-ai"]');
  if(draftButton){draftButton.textContent=state.provider==='m365'?'M365 Copilotで設計案を生成':'AIで設計案を生成';draftButton.disabled=!(state.sources.length || state.current?.project.requirements.length) || !(state.provider==='m365'?m?.authenticated:state.health?.ai?.configured) || state.jobs.some(j=>j.kind==='design-document' && ['queued','running'].includes(j.status));}
}
function connectionMessage(text,error=false){const el=$('#connection-message');el.textContent=text;el.hidden=!text;el.className=error?'notice warning':'notice';}
async function connectionAction(fn){try{await fn();}catch(error){connectionMessage(error.message,true);}}
function renderConnection(){
  const m=state.health?.m365,ai=state.health?.ai;
  $('#ai-provider').value=state.provider;
  $('#m365-settings').hidden=state.provider!=='m365';$('#compatible-settings').hidden=state.provider!=='ai';
  const mstatus=!m?.configured?'アプリ登録情報が未設定です':m.authenticated?`${m.account} / ${m.chat_verified?'Chat API応答確認済み':'サインイン済み・Chat API疎通未確認'}`:m.expired?'認証期限切れ。再サインインしてください':'設定済み。職場アカウントでサインインしてください';
  $('#connection-info').innerHTML=`<div class="notice">${state.provider==='m365'?esc(mstatus):ai?.configured?`設定済み（疎通未確認） / ${esc(ai.model)}`:'互換APIは未接続です'}</div>`;
  $('#m365-tenant').value=m?.tenant_id || '';$('#m365-client').value=m?.client_id || '';$('#m365-redirect').value=m?.redirect_uri || '';
  $('#m365-login').disabled=!m?.configured || !m.sdk_available;$('#m365-test').disabled=!m?.authenticated;$('#m365-logout').disabled=!m?.authenticated;
  refreshAiControls();
}
async function refreshConnection(){state.health=await api('/api/health');renderConnection();}
function showConnection(){connectionMessage('');renderConnection();$('#connection-dialog').showModal();connectionAction(refreshConnection);}
$('#connection-button').addEventListener('click',showConnection);$('#ai-badge').addEventListener('click',showConnection);$('#close-connection').addEventListener('click',()=>$('#connection-dialog').close());
$('#ai-provider').addEventListener('change',()=>{state.provider=$('#ai-provider').value;localStorage.setItem('nw-ai-provider',state.provider);renderConnection();});
$('#m365-config-form').addEventListener('submit',event=>{event.preventDefault();connectionAction(async()=>{await api('/api/m365/config',{tenant_id:$('#m365-tenant').value,client_id:$('#m365-client').value});await refreshConnection();connectionMessage('登録情報を保存しました。Microsoftにサインインしてください。');});});
async function signIn(){
  await save();
  if(location.hostname!=='localhost'){location.assign(`http://localhost:${location.port}/?m365=connect`);return;}
  connectionMessage('Microsoftのサインイン画面を準備しています…');
  const result=await api('/api/m365/start',{});
  const target=new URL(result.authorization_url);
  if(target.origin!=='https://login.microsoftonline.com')throw new Error('認証先がMicrosoftではないため停止しました');
  location.assign(target.href);
}
$('#m365-login').addEventListener('click',()=>connectionAction(signIn));
$('#m365-logout').addEventListener('click',()=>connectionAction(async()=>{await api('/api/m365/logout',{});await refreshConnection();connectionMessage('このアプリの認証情報を破棄しました。');}));
$('#m365-test').addEventListener('click',()=>connectionAction(async()=>{
  $('#m365-test').disabled=true;connectionMessage('Copilotへテスト文字列を送信しています。案件資料は送信しません。');
  try{
    const started=await api('/api/m365/test',{});
    const poll=async()=>{try{const job=await api(`/api/jobs/${started.job_id}`);if(['running','queued'].includes(job.status)){setTimeout(poll,1500);return;}await refreshConnection();connectionMessage(job.status==='completed'?job.result.message:job.result.error,job.status==='failed');}catch(error){connectionMessage(error.message,true);$('#m365-test').disabled=false;}};
    setTimeout(poll,1000);
  }catch(error){$('#m365-test').disabled=false;throw error;}
}));
window.addEventListener('beforeunload',event=>{if(state.dirty){event.preventDefault();event.returnValue='';}});
execute(async()=>{
  if(location.protocol==='file:'){
    $('#ai-badge').textContent='HTTP接続が必要です';
    message('HTMLファイルの直接表示では操作できません。start.ps1で起動し、下のリンクからHTTP画面を開いてください。',true);
    $('#content').innerHTML='<section class="welcome"><div class="empty"><h1>HTTPの画面を開いてください</h1><p>このアプリはAPIサーバーと接続して動作します。HTMLファイル単体ではデータを保存・生成できません。</p><a class="button primary" href="http://127.0.0.1:8080">設計支援画面を開く →</a></div></section>';
    $('#sample-project').disabled=true;$('#new-project').disabled=true;
    return;
  }
  state.health=await api('/api/health');refreshAiControls();
  await refreshProjects();const last=localStorage.getItem('nw-current-project');
  const id=state.projects.find(p=>p.id===last)?.id || state.projects[0]?.id;
  if(id)await loadProject(id);else render();
  const authResult=new URLSearchParams(location.search).get('m365');
  if(authResult){history.replaceState(null,'','/');state.provider='m365';localStorage.setItem('nw-ai-provider','m365');showConnection();if(authResult==='connect')await signIn();else if(authResult==='signed-in')connectionMessage('職場アカウントでサインインしました。「接続テスト」でAPIの利用可否を確認できます。');}
});
