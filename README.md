# network-design-agent — Network Design Workbench

ネットワーク設計支援エージェントのローカル試作です。入力資料の根拠、要件の確認状態、共通の設計データ、版、静的検査結果、成果物を一つの案件として管理します。

**v0.4.0：要件からWord基本設計書を生成できます。** 「01 資料と要件」の作成ボタンから実行してください。AI未接続時は章別整理と標準的な方針案、AI接続時は個別の設計提案に対応します。[操作と制限](DESIGN_WORD.md)

**v0.3.1：PowerPoint・Visioの資料取込と、取り込んだ資料の削除に対応しています。** [入力形式と制限](IMPORT_FORMATS.md)を確認してください。

**作成済みの専用エージェントとの連携は未実装です。** 現在のM365連携は汎用のCopilot Chat APIを使用します。M365 CopilotのAgent BuilderからCopilot Studioへコピーした専用エージェントの呼び出し、SharePoint上のYML・MD・雛形の取得と適用は今後の拡張です。

**v0.2：M365 Copilot接続を追加しました。** [M365接続手順](M365_SETUP.md)に沿って会社のテナントIDとアプリのクライアントIDを登録し、職場アカウントでサインインします。実環境への接続はアプリ登録・管理者同意後に確認してください。Chat APIはプレビューです。

## 起動

Python 3.11以降とGitを用意し、この非公開リポジトリへのアクセス権があるGitHubアカウントで取得します。PowerShellで任意の作業フォルダから実行してください。

```powershell
git clone https://github.com/eshimamura1977-create/network-design-agent.git
cd network-design-agent
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\start.ps1
```

ブラウザで **http://127.0.0.1:8080** を開きます。終了は実行したターミナルで Ctrl+C。

ターミナルを開いたままにせず起動する場合は `launch.ps1` を実行します。この方法で起動したアプリは `stop.ps1` で停止できます。**web/index.htmlを直接開いてもAPIと接続できません。必ずHTTPのURLを使用してください。**

Gitを使わない場合は、GitHubの「Code → Download ZIP」で取得・展開し、そのフォルダで以下を実行できます。初回の依存ライブラリ導入には、PyPIまたは会社指定のパッケージ配布先への接続が必要です。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\start.ps1
```

ポートが使用中なら `.env.example` を `.env` にコピーし、`GUI_PORT` と `API_PORT` を変更します。既存のサービスは停止しません。

## 最初に試す操作

1. 「サンプルを開く」で架空の3台のLANを作成します。文書用IPv4アドレスを使用しています。
2. 「設計データ」で機器、VLAN、ポート、接続、方針を確認します。
3. 「検証と承認」→「検証を実行」で静的検査を行います。
4. 設計値を確認して「この版の設計を承認する」を押します。
5. 「成果物」→「成果物を一括生成」からZIPを取得します。
6. 管理IPを他の機器と同じ値に変更・保存し、IP重複が検出されることを試せます。変更で承認は解除されます。

新規案件では資料を登録し、「ローカルで候補抽出」またはAI接続後の「AIで要件を整理」を実行します。解析結果を確認して「候補を要件一覧に追加」を押し、各行を確認します。解析が設計パラメータを勝手に変更することはありません。

## 推奨構成と今回の実装

```text
Browser (HTTP)
  -> local reverse proxy 127.0.0.1:8080
  -> Python API 127.0.0.1:8765
       -> SQLite: 案件 / 版 / 根拠資料 / 非同期ジョブ
       -> 要件整理: ローカル行抽出 or Chat Completions互換AI
       -> 共通設計モデル + 静的検証
       -> Word / Excel / SVG / 試作VSDX / Config / ZIP
```

- Python標準HTTPサーバーとジョブ実行器を使った**単一PC・単一利用者向けPoC**です。
- GUIとAPIの両方を127.0.0.1へ限定します。外部公開、ユーザー認証、社内SSO、TLS終端は実装していません。
- 不明なHost、別Originからのリクエスト、操作用ヘッダーがないPOSTを拒否します。プロキシの転送先は固定です。
- 資料はローカル保存。AIボタンを押したときだけ、設定先へ資料を送信します。
- 現在のM365 Chat API接続はユーザー委任認証。シークレット不要、認証情報はメモリ内のみ。専用のCopilot Studioエージェントとの接続は未実装です。
- JSONは内部で生成・管理します。通常の入力操作ではJSONやMDの準備は不要です。
- 生成物には版番号とSHA-256付きmanifestを保存します。変更履歴はSQLiteに保持します。版の復元UIは未実装です。
- 長時間処理はジョブとして実行。再起動で中断したジョブは失敗として表示し、手動で再実行できます。処理途中からの再開は未実装です。

## AIモデルへのlocal proxy接続

M365 Copilotを使う場合、この.env設定は不要です。[M365接続手順](M365_SETUP.md)を使用してください。以下はChat Completions互換APIを選んだ場合の設定です。

`.env.example` を `.env` にコピーします。例：

```dotenv
LLM_BASE_URL=http://127.0.0.1:1234/v1
LLM_MODEL=your-model-name
LLM_API_KEY=
ALLOW_REMOTE_LLM=false
```

`POST {LLM_BASE_URL}/chat/completions` を使用します。ローカルLLMサーバーまたはその形式に対応したAPIプロキシを別途起動してください。設定後はアプリを再起動します。「AI設定済み」は設定の存在を表し、疎通成功の意味ではありません。

外部の承認済みHTTPS APIへ接続する場合に限り `ALLOW_REMOTE_LLM=true` を設定します。会社・顧客データを扱う場合は組織で承認された処理先だけを設定してください。キーはブラウザへ返しません。HTTP_PROXY等の環境変数による転送や、APIのリダイレクトは使用しません。

AIの出力は要件候補と確認事項に限定しています。原文引用が実在しない場合は反映せず失敗とします。引用が存在しても解釈の正しさは保証できないため、利用者が確認して確定します。AIへの入力は合計5万字まで。超過時は切り捨てずエラーにします。AI未設定時にAI風の応答を生成することはありません。

## 成果物と対応範囲

| 成果物 | 実装内容 |
|---|---|
| 要件定義書 DOCX | 要件、確認状態、資料名、根拠引用 |
| ネットワーク設計書 DOCX | 設計方針、機器、VLAN、ポート、検査結果 |
| パラメータシート XLSX | 概要、アドレス台帳、VLAN、接続、ホスト別、機種別 |
| 構成図 SVG / VSDX | 登録機器・物理接続から生成。VSDXは基本図形の試作 |
| Config CFG | C9200L / IOS XE 17系のVLAN・管理SVI・access/trunk設定のみ |
| 試験設計書 DOCX / 項目表 XLSX | 設定値に基づく確認項目、要件ごとの受入観点。詳細手順・閾値は要具体化 |
| 試験構成図 SVG / VSDX | 設計構成を転記した下書き。測定端末・障害注入点は未定義 |
| 移行設計書 DOCX / 工事資料 XLSX | 未決事項を明示したひな型 |
| 運用引継ぎ DOCX | 管理情報と運用上の未決事項を記載したひな型 |
| JSON / manifest | 設計スナップショット・検査結果・版・ファイルハッシュ |

**制限**

- Configは担当者承認済みで、エラー・警告がない場合のみ出力します。すべて下書きです。
- 機種SKUごとのポート数・速度・対応機能、OSごとのコマンド可否は未検証です。実機投入機能はありません。
- L3ルーティング、BGP/OSPF、ACL、FW、VPN、無線、冗長化、スタック、AAA、監視、STP方針、既存Configとのマージは未実装です。
- 台帳は単一L2ドメインを前提とし、VLAN IDは全機器共通です。VRF別アドレス重複検査は行いますが、Config生成はdefault VRFに限定します。
- IPv4のみ。IPv6、VRRP/HSRP等の意図的な共有アドレス、複数拠点の重複VLANは今後の拡張です。
- 入力対応：TXT/MD/CSV/CFG/LOG、DOCX本文と表、XLSXセル・数式・保存済み値、PPTX文字・表・ノート、VSDX/VDX図形文字・属性・登録済み接続、テキストPDF。各8MB、抽出16万字、案件20資料。画像/OCR、Visioマスター継承情報、Wordヘッダー等、Excel図形、旧バイナリ形式は未対応。詳細は[入力形式と制限](IMPORT_FORMATS.md)。
- 要件と具体的な設計値の意味的な適合性は自動検証していません。「確認済み」はユーザーの確認状態です。
- 出力したExcel/Wordを編集しても共通データには戻りません。再生成はアプリ内の設計データを元にします。
- VSDXはOOXMLパッケージとしての構造検査までです。Visioデスクトップでの表示、コネクタ追従、社内ステンシルの適合は未検証です。
- このPCにはLibreOfficeレンダラーがなく、DOCXの改ページ・印刷レイアウトの画像QAは未完了です。ファイルの構造・内容は検査済みですが、納品前にWordでの表示確認が必要です。

## テスト

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

このPCでは `start.ps1` と同じPython実行ファイルで実施できます。テストでは一時ディレクトリだけに案件を作り、HTTP API、競合制御、Config出力制限、ファイル内容、原文照合、ローカルAI模擬サーバーとの通信を確認します。実際のAIモデルの品質・実機ネットワーク動作を保証するテストではありません。

## 主なAPI

操作時は `Content-Type: application/json` と `X-Workbench-Request: 1` が必要です。

| API | 用途 |
|---|---|
| GET /api/health | アプリ状態、AI設定有無 |
| GET / POST /api/projects | 一覧 / 新規案件 |
| GET / POST /api/projects/{id} | 取得 / 版を指定して保存 |
| GET / POST /api/projects/{id}/sources | 原文一覧 / テキスト・base64ファイル登録 |
| POST /api/projects/{id}/sources/{source_id}/delete | 版を指定して資料を削除し、関連要件を未決に戻す |
| POST /api/projects/{id}/analyze | mode=local または ai、ジョブID返却 |
| POST /api/jobs/{id}/apply | 解析候補を元の版へ明示的に追加 |
| POST /api/projects/{id}/validate | 静的検査 |
| POST /api/projects/{id}/approve | 現在版の承認 |
| POST /api/projects/{id}/generate | 成果物生成ジョブ |
| GET /api/jobs/{id} | ジョブ状態 |
| GET /api/jobs/{id}/download | 完了したZIP取得 |

## 次の拡張順序

1. 匿名化済みの実案件と完成成果物で、抽出漏れ・設計不一致・修正時間を評価。
2. 機種/OSアダプタと社内ひな型を追加。設計値の変更影響と根拠を細粒度で関連付け。
3. Visio実機QAと既存ステンシルへの対応、試験環境・移行計画の構造化。
4. FastAPI等の本番用API、永続ジョブキュー、Entra ID認証・案件権限・監査・バックアップへ移行。
5. Agent BuilderからCopilot Studioへコピーした専用エージェントとの接続と、SharePoint上の設計ルール・雛形の取得を追加。現在の汎用M365 Chat API接続とは別の連携です。

## リポジトリに含めないデータ

取り込んだ資料・案件データ・生成済み成果物（`data/`）、実際の接続設定（`.env`など）、ログ（`logs/`）、Python仮想環境（`.venv/`）はGit管理から除外します。このリポジトリの取得だけでは既存案件や認証設定は移りません。利用先のPCで新たに設定してください。
