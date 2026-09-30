# M365 Copilot接続の設定手順

v0.5.0では「AIで全工程を生成」から全工程のドラフトを作成できます。入力と中間設計を4段階で送信します。実接続・生成品質は未検証です。[全工程生成の操作と制限](PIPELINE.md)

v0.4.0では、要件整理に加えて「M365 Copilotで設計案を生成」からWord基本設計書を作成できます。この操作では案件名、要件本文と確認状態、取り込んだ資料本文を送信します。[設計書作成の操作と制限](DESIGN_WORD.md)を参照してください。

このアプリからMicrosoft 365 Copilot Chat APIを呼び出す機能を追加しました。**コードと模擬通信のテストは完了していますが、会社のアプリ登録・管理者同意・実アカウントでの疎通確認はまだです。**

今回の経路は次のとおりです。Copilot Studioを介さず、現在のGUIを利用します。

```text
ブラウザ http://localhost:8080
  → ローカルHTTPプロキシ
  → 設計支援API
  → Microsoft Graph / M365 Copilot Chat API（プレビュー）
```

Copilot Studioからこの設計支援APIを呼ぶ社員向け経路は別工程です。今回の追加だけではM365 Copilot内にエージェントが公開されるわけではありません。

## 1 管理者に依頼する内容

以下を会社のEntra ID管理者に渡してください。ライセンスの保有と、アプリ登録・Graph権限への同意は別の条件です。

| 項目 | 設定内容 |
|---|---|
| 用途 | ローカルネットワーク設計支援PoCから、利用者本人の権限でCopilot Chat APIを呼び出す |
| 推奨アプリ名 | Network Design Workbench PoC |
| サポートするアカウント | この組織のディレクトリ内のみ（単一テナント） |
| プラットフォーム | モバイルとデスクトップ アプリ（パブリッククライアント） |
| リダイレクトURI | `http://localhost:8080/auth/m365/callback` |
| 認証 | MSALによる認可コードフロー、PKCE、ユーザー委任 |
| シークレット | 作成・配布不要 |
| 対象ユーザー | Microsoft 365 Copilot追加ライセンスがあるPoC参加者 |
| API種別 | Microsoft Graphの委任されたアクセス許可。Application権限は使用しない |

次の**7つすべて**が、現行のChat APIドキュメントに記載された必須委任権限です。

```text
Sites.Read.All
Mail.Read
People.Read.All
OnlineMeetingTranscript.Read.All
Chat.Read
ChannelMessage.Read.All
ExternalItem.Read.All
```

これらは資料の整理だけに比べて広い読み取り範囲を含みます。管理者が各権限とPoCの利用範囲を確認したうえで、組織の方針に従って同意してください。このアプリを作ったことやライセンスがあることだけでは、権限は付与されません。

MSALはサインイン・更新用の標準スコープも要求します。アプリ側でパスワードを収集したり、ユーザーなしでアクセスするクライアントクレデンシャル認証を使ったりしません。条件付きアクセスでパブリッククライアントが禁止されている場合は、その方針を変更して回避せず、管理者と別の構成を選定してください。

登録後、次の2つを確認します。いずれもGUIDです。

- ディレクトリ（テナント）ID
- アプリケーション（クライアント）ID

**M365のメールアドレスやパスワード、Copilot StudioのエージェントIDではありません。**

## 2 アプリの画面で設定

1. 起動済みなら `http://localhost:8080` を開きます。
2. 右上の「M365 未設定」または左メニューの「接続設定と対応範囲」を押します。
3. 「Microsoft 365 Copilot（プレビュー）」を選択します。
4. テナントIDとクライアントIDを入力し「登録情報を保存」を押します。
5. 「Microsoftにサインイン」を押し、Microsoftの画面で職場アカウントの認証を行います。
6. 同意が必要な場合は、表示される権限を確認して会社の承認手順に従います。
7. アプリへ戻ったら「接続テスト」を押します。案件資料を含まないテスト文字列でAPIの利用可否を確認します。
8. 「Chat API応答確認済み」になったら、案件の資料を登録して「M365 Copilotで要件を整理」を使用できます。

`127.0.0.1` で開いていた場合は、サインイン開始時に `localhost` へ移動します。未保存の設計値は移動前に保存します。リダイレクト先はlocalhostに固定しており、外部URLには設定できません。ポートを変更した場合は、設定画面に表示されるURIを登録してください。

## 3 データの扱い

- 登録IDは `data/m365-settings.json` に保存します。Git管理対象外です。
- トークンとMSALキャッシュはサーバーのメモリにのみ保持します。ブラウザやSQLite、.env、ログへ返しません。
- ブラウザにはHttpOnly・SameSite=LaxのランダムなセッションCookieだけを設定します。HTTPはloopback限定です。これは外部公開用の認証設計ではありません。
- セッションはブラウザごとに分離し、認証完了時にセッションIDを更新します。サインアウト・アプリ設定変更・サーバー再起動で認証状態を破棄します。
- 「接続テスト」は固定のテスト文字列だけを送信します。
- 「M365 Copilotで要件を整理」は、その案件に登録された資料の抽出テキストをMicrosoftへ送信します。元のOfficeファイル自体はアップロードしません。
- 各解析で新しいCopilot会話を作り、案件間で会話を使い回しません。
- Web検索はリクエストごとに `isWebEnabled=false` として無効化します。ただし、**Copilotの企業内検索をAPI側で完全に無効化する機能ではありません**。入力資料だけを使うよう指示し、要件ごとの引用を原文と照合します。確認事項の自由文もレビューしてください。
- Microsoft側の会話保存・監査・保持は組織のM365方針に従います。このアプリからサインアウトしても、Microsoft側の会話を削除することにはなりません。
- サインアウトしても、既に送信・実行中のリクエストは取り消せません。保存した解析結果は案件データとしてローカルに残ります。
- トークン更新はMSALに任せます。再認証が必要な応答を受けた場合は、ログインを求めて処理を停止します。

## 4 エラーの切り分け

| 状態 | 確認事項 |
|---|---|
| M365 未設定 | 2つの登録IDを入力したか |
| サインインボタンが無効 | 登録ID、PythonのMSAL導入を確認。`.venv/Scripts/python.exe -m pip install -r requirements.txt` |
| AADSTS50011 | リダイレクトURIとプラットフォームを確認。Web/SPAではなくモバイルとデスクトップを使用 |
| 管理者承認が必要 | 必須の委任権限と組織の同意方針を管理者に確認 |
| HTTP 401 | 認証期限や追加認証を確認し、再サインイン |
| HTTP 403 | Copilotライセンス、7権限の同意、API利用可否、条件付きアクセスを確認 |
| HTTP 429 | 利用制限。時間をおいて手動で再試行 |
| HTTP 504 | 長時間処理はAPIの制限。資料を小さくして再試行 |
| 原文の根拠と照合できない | AIの引用が不正。要件へ自動反映せず停止する正常な保護動作 |

通信先は `login.microsoftonline.com` と `graph.microsoft.com` です。この試作は認証情報を意図しないプロキシへ渡さないよう、OSのHTTP_PROXY設定を自動利用しません。社内の必須アウトバウンドプロキシやTLS検査がある場合は、管理者の承認済み構成で接続処理を追加する必要があります。証明書検証の無効化は行いません。

## 5 確認できたことと未完了のこと

実装・自動テスト：サインイン開始、state照合、有効期限、セッション分離、ログアウト、同一テナント確認、プロキシのCookie転送、Graphリクエスト形式、Web検索無効化、引用検証。

未完了：会社の実際のアプリ登録、管理者同意、実アカウントでのサインイン、実Copilotモデルの回答品質、Copilot Studioでのエージェント公開。

Chat APIはプレビューです。`/beta`の本番アプリ利用はMicrosoftのサポート対象外です。利用可能なAPI・権限は組織の環境でも確認してください。

## Microsoft公式資料

- [Chat APIの概要・ライセンス・制限](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/ai-services/chat/overview)
- [会話の作成と必須権限](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/ai-services/chat/copilotroot-post-conversations)
- [会話の実行とWeb検索の無効化](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/ai-services/chat/copilotconversation-chat)
- [MSAL Pythonによるトークンの取得](https://learn.microsoft.com/en-us/entra/msal/python/getting-started/acquiring-tokens)
- [localhostリダイレクトURIの制限](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)
