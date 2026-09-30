'use strict';
// Fixed fictional example for UI/export tests. This is not an AI-generated design.
function NWDemo(){
  const body='センターと3事業所のネットワーク機器を更改する。\n閉域網上のIPsec接続を維持し、一部情報系システムとRADIUS認証をAWSへ移行する。\n各拠点はWANルータ、PoEスイッチ、無線LANで構成する。\n機種、OS、アドレス、回線帯域、停止可能時間は別途決定する。';
  const project={name:'架空企業ネットワーク更改・操作確認サンプル',revision:1,sources:[{id:'SRC1',name:'サンプル要件.txt',body}],requirements:body.split('\n').map((text,i)=>({id:'REQ-'+(i+1),text,status:'confirmed',source_id:'SRC1',source:'サンプル要件.txt',quote:text}))};
  const tr={requirement_ids:['REQ-1','REQ-2','REQ-3'],evidence:[],state:'proposal',rationale:'操作確認用の仮置き。実案件では要件に基づいて再設計する。'};
  const a={overview:'4拠点＋AWSの操作確認用モデル。接続は論理モデルで、冗長装置や通信制御の詳細は未確定。',sites:[],networks:[],nodes:[],parameters:[],connections:[],questions:['回線・機器・OS・冗長構成・RADIUS断時の認証方針を決定する。','記載IPは例示値。実際のアドレス体系を確認する。']};
  for(let i=0;i<4;i++){
    const site='S'+i;a.sites.push({...tr,id:site,name:i?'事業所'+i:'センター',kind:i?'branch':'center'});
    a.networks.push({...tr,id:'NET'+i,site_id:site,name:'管理LAN（例）',vrf:'default',vlan:99,cidr:`10.${i}.99.0/24`,gateway:`10.${i}.99.1`});
    for(const [index,kind,role] of [[0,'RT','WANルータ'],[1,'SW','PoEスイッチ'],[2,'AP','無線LAN AP']])a.nodes.push({...tr,id:kind+i,hostname:(i?'BR'+i:'CTR')+'-'+kind+'01',site_id:site,role,model:null,os_version:null,network_id:'NET'+i,management_ip:`10.${i}.99.${11+index}`});
    a.connections.push({...tr,id:'LAN'+i,a:'RT'+i,b:'SW'+i,a_port:null,b_port:null,kind:'physical',purpose:'LAN接続（ポート未定）'},{...tr,id:'WLAN'+i,a:'SW'+i,b:'AP'+i,a_port:null,b_port:null,kind:'physical',purpose:'AP給電・通信（ポート未定）'});
    if(i)a.connections.push({...tr,id:'WAN'+i,a:'RT0',b:'RT'+i,a_port:null,b_port:null,kind:'logical',purpose:'閉域網上IPsec・冗長系は要設計'});
  }
  a.sites.push({...tr,id:'AWS',name:'AWS',kind:'cloud'});a.nodes.push({...tr,id:'RADIUS',hostname:'AWS-RADIUS01',site_id:'AWS',role:'認証サーバ（冗長系未定）',model:null,os_version:null,network_id:null,management_ip:null});
  a.connections.push({...tr,id:'CLOUD',a:'RT0',b:'RADIUS',a_port:null,b_port:null,kind:'logical',purpose:'AWS認証への到達性・方式未定'});
  a.parameters.push({...tr,id:'P1',node_id:'SW0',name:'PoE電力予算',value:'AP機種と台数の確定後に最大消費電力・余裕率を算定'});
  const design={overview:a.overview,sections:NWCore.defs.chapters.map(c=>({key:c.key,proposal:`${c.title}：この本文は操作確認用サンプルです。要件と共通設計の確認後、Copilotへ依頼して具体化してください。`,rationale:'サンプルの値は設計判断の根拠として使用しない。',questions:['実案件の要件・制約に合わせた詳細化が必要。'],requirement_ids:['REQ-1'],evidence:[]}))};
  const step={id:'STEP1',targets:['RT0','SW0'],requirement_ids:['REQ-1'],action:'現行設定と接続表のバックアップを取得し、作業対象・ポートを二名で照合する。',expected:'バックアップを読み戻せること、現地ラベルと台帳が一致すること。',rollback:'差異があれば作業を中止し、台帳を修正して再承認する。',owner:'NW担当・作業責任者'};
  const delivery={test_policy:'操作確認用。試験環境で検証する。停止・合否閾値と認証断時の要件が未確定のため、本番受入には使用しない。',tests:[{id:'T1',requirement_ids:['REQ-1','REQ-2','REQ-3'],targets:['RT0','SW0','RADIUS'],kind:'normal',preconditions:'検証用端末・試験用アカウント・ログ採取設定を用意する。',procedure:'試験端末を無線LANへ接続し、RADIUS認証ログと認証後の通信を確認する。',expected:'許可ユーザーが認証成功し、許可されたセグメントへ接続できる。応答時間閾値は未定。',evidence_to_collect:'認証ログ、端末のアドレス、疎通ログ、実施時刻'}],test_nodes:[],test_connections:[],migration:[{...step}],construction:[{...step}],operations:[{...step,id:'OPS1',action:'RADIUSの認証失敗ログとWANトンネル状態を確認する。',expected:'異常があれば運用窓口へ連絡する。閾値と連絡先は要確定。'}],configs:a.nodes.map(n=>({node_id:n.id,status:'deferred',text:'',reason:'機種とOSが未確定のためコマンドを生成していません。'})),coverage:project.requirements.map(r=>({requirement_id:r.id,disposition:'needs_information',design_ids:[],test_ids:r.id==='REQ-4'?[]:['T1'],reason:'サンプル段階。機種・冗長構成・認証障害時の動作・各試験閾値を確定する。'}))};
  return {project,workflow:{request_id:'sample-browser-1',revision:1,sample:true,stages:{architecture:a,design,delivery,review:{summary:'操作確認用サンプルです。実案件の設計完成を示すものではありません。',issues:[{severity:'blocking',target:'機種・OS・冗長構成',finding:'機器・バージョン・冗長構成が未定でConfigを作成できない。',required_action:'要件と現行資料で選定条件を確認し、採用機種とOSを確定する。'},{severity:'warning',target:'認証・試験・図面',finding:'認証断時の動作、負荷条件、障害復旧試験、接続ポートの詳細が未確定。',required_action:'設計担当が不足を解消し、レビューと実機検証を実施する。'}]}}}};
}
if(typeof module!=='undefined')module.exports=NWDemo;
