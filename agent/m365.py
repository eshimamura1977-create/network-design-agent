"""Delegated Microsoft 365 Copilot integration. Tokens stay in server memory."""
from __future__ import annotations

import importlib.util
import json
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

SCOPES = ["https://graph.microsoft.com/" + scope for scope in (
    "Sites.Read.All", "Mail.Read", "People.Read.All", "OnlineMeetingTranscript.Read.All",
    "Chat.Read", "ChannelMessage.Read.All", "ExternalItem.Read.All",
)]
COOKIE_NAME = "nw_m365_session"
SESSION_SECONDS = 12 * 60 * 60
FLOW_SECONDS = 10 * 60


class GraphConnectionError(ValueError):
    def __init__(self, message, status):
        super().__init__(message)
        self.http_status = status


def valid_id(value):
    try:
        return str(uuid.UUID(str(value).strip()))
    except (ValueError, AttributeError, TypeError):
        raise ValueError("テナントIDとクライアントIDはGUID形式で入力してください。") from None


def create_msal_app(client_id, tenant_id):
    import msal
    import requests
    http = requests.Session()
    http.trust_env = False  # Never silently pass tokens through inherited proxy settings.
    return msal.PublicClientApplication(
        client_id, authority=f"https://login.microsoftonline.com/{tenant_id}",
        token_cache=msal.TokenCache(), http_client=http, timeout=15,
        enable_pii_log=False,
    )


class M365Connection:
    def __init__(self, root: Path, gui_port: int, app_factory=None):
        self.path = root / "m365-settings.json"
        self.redirect_uri = f"http://localhost:{gui_port}/auth/m365/callback"
        self.gui_origin = f"http://localhost:{gui_port}"
        self.app_factory = app_factory or create_msal_app
        self.sessions = {}
        self.lock = threading.RLock()
        self.config = {"tenant_id": "", "client_id": ""}
        if self.path.exists():
            try:
                value = json.loads(self.path.read_text(encoding="utf-8"))
                self.config = {key: valid_id(value[key]) for key in self.config}
            except (ValueError, KeyError):
                pass

    def settings(self):
        with self.lock:
            return {**self.config, "redirect_uri": self.redirect_uri,
                    "configured": all(self.config.values()), "sdk_available": bool(importlib.util.find_spec("msal")),
                    "permissions": [s.rsplit("/", 1)[-1] for s in SCOPES], "preview": True}

    def configure(self, value):
        if set(value) != {"tenant_id", "client_id"}:
            raise ValueError("保存できる項目はテナントIDとクライアントIDのみです。シークレットは不要です。")
        config = {key: valid_id(value[key]) for key in ("tenant_id", "client_id")}
        with self.lock:
            temp = self.path.with_suffix(".tmp")
            temp.write_text(json.dumps(config, indent=2), encoding="utf-8")
            temp.replace(self.path)
            self.config = config
            self.sessions.clear()
        return self.settings()

    def _clean(self):
        current = time.time()
        for sid, entry in list(self.sessions.items()):
            limit = SESSION_SECONDS if entry["authenticated"] else FLOW_SECONDS
            if current - entry["created"] > limit:
                self.sessions.pop(sid, None)

    def status(self, sid):
        with self.lock:
            self._clean()
            entry = self.sessions.get(sid)
            return {**self.settings(), "authenticated": bool(entry and entry["authenticated"]),
                    "account": entry["account_name"] if entry and entry["authenticated"] else "",
                    "expired": bool(entry and entry.get("expired")),
                    "chat_verified": bool(entry and entry.get("chat_verified")),
                    "last_error": entry.get("last_error", "") if entry else ""}

    def start(self, old_sid=""):
        with self.lock:
            self._clean()
            config = self.config.copy()
            if not all(config.values()):
                raise ValueError("先に会社のテナントIDと登録アプリのクライアントIDを保存してください。")
            if len(self.sessions) >= 32:
                raise ValueError("サインイン要求が多すぎます。しばらく待ってください。")
        try:
            app = self.app_factory(config["client_id"], config["tenant_id"])
            flow = app.initiate_auth_code_flow(SCOPES, redirect_uri=self.redirect_uri,
                                                prompt="select_account", response_mode="query")
            url = flow.get("auth_uri", "")
            parsed = urllib.parse.urlparse(url)
            if parsed.scheme != "https" or parsed.hostname != "login.microsoftonline.com":
                raise ValueError("invalid_authority")
        except Exception:
            raise ValueError("Microsoftの認証開始に失敗しました。登録ID、MSALの導入、Microsoftへの通信を確認してください。") from None
        sid = secrets.token_urlsafe(32)
        with self.lock:
            if config != self.config:
                raise ValueError("接続設定が変更されました。サインインをやり直してください。")
            self.sessions.pop(old_sid, None)
            self.sessions[sid] = {"app": app, "flow": flow, "created": time.time(), "authenticated": False,
                                  "account_name": "", "lock": threading.RLock(), "tenant_id": config["tenant_id"]}
        return sid, url

    def finish(self, sid, query):
        with self.lock:
            self._clean()
            entry = self.sessions.get(sid)
        if not entry:
            raise ValueError("サインインを開始したブラウザから戻ってください。期限切れの場合は再度サインインしてください。")
        with entry["lock"]:
            flow = entry.pop("flow", None)
            supplied_state = query.get("state", "")
            if not flow or not supplied_state or not secrets.compare_digest(str(flow.get("state", "")), supplied_state):
                raise ValueError("認証の確認情報が一致しません。サインインをやり直してください。")
            if query.get("error"):
                raise ValueError("Microsoftへのサインインがキャンセルまたは拒否されました。管理者同意と会社のアクセス方針を確認してください。")
            try:
                result = entry["app"].acquire_token_by_auth_code_flow(flow, query)
            except Exception:
                raise ValueError("認証の検証に失敗しました。サインインをやり直してください。") from None
            if not result or "access_token" not in result:
                raise ValueError("サインインを完了できませんでした。アプリの種類、リダイレクトURI、管理者同意を確認してください。")
            claims = result.get("id_token_claims", {})
            if str(claims.get("tid", "")).lower() != entry["tenant_id"].lower():
                raise ValueError("登録した会社のテナントとサインイン先が一致しません。")
            with self.lock:
                if self.sessions.get(sid) is not entry:
                    raise ValueError("認証中に接続設定が変更されました。再度サインインしてください。")
                self.sessions.pop(sid)
                new_sid = secrets.token_urlsafe(32)
                entry.update(authenticated=True, account_name=claims.get("preferred_username", "職場アカウント"),
                             created=time.time(), expired=False)
                self.sessions[new_sid] = entry
            return new_sid

    def logout(self, sid):
        with self.lock:
            self.sessions.pop(sid, None)

    def token(self, sid):
        with self.lock:
            self._clean()
            entry = self.sessions.get(sid)
        if not entry or not entry["authenticated"]:
            raise ValueError("M365 Copilotへサインインしてください。再起動後は再サインインが必要です。")
        with entry["lock"]:
            try:
                accounts = entry["app"].get_accounts()
                result = entry["app"].acquire_token_silent(SCOPES, account=accounts[0]) if accounts else None
            except Exception:
                raise ValueError("Microsoftの認証情報を更新できませんでした。通信を確認して再サインインしてください。") from None
            if not result or "access_token" not in result:
                entry.update(authenticated=False, expired=True, chat_verified=False)
                raise ValueError("認証の有効期限または会社のアクセス条件により再サインインが必要です。")
            with self.lock:
                if self.sessions.get(sid) is not entry:
                    raise ValueError("サインアウト済みです。再度サインインしてください。")
            return result["access_token"]

    def chat(self, sid, prompt, context):
        """Each operation creates a fresh conversation to avoid cross-project context reuse."""
        with self.lock:
            entry = self.sessions.get(sid)
        try:
            conversation = graph_post("/beta/copilot/conversations", {}, self.token(sid))
            cid = str(conversation.get("id", ""))
            if not cid or len(cid) > 200:
                raise ValueError("Copilotから会話IDが返されませんでした。")
            payload = {"message": {"text": prompt}, "locationHint": {"timeZone": "Asia/Tokyo"},
                       "contextualResources": {"webContext": {"isWebEnabled": False}},
                       "additionalContext": [{"text": context}]}
            response = graph_post("/beta/copilot/conversations/" + urllib.parse.quote(cid, safe="") + "/chat",
                                  payload, self.token(sid))
            messages = response.get("messages", [])
            if not isinstance(messages, list):
                raise ValueError("Copilotの応答形式が不正です。")
            texts = [m["text"] for m in messages if isinstance(m, dict) and isinstance(m.get("text"), str) and m["text"].strip()]
            if not texts or texts[-1] == prompt:
                raise ValueError("Copilotの回答が取得できませんでした。内容を短くして再実行してください。")
            if entry:
                entry.update(chat_verified=True, last_error="")
            return texts[-1]
        except ValueError as error:
            if entry:
                entry.update(chat_verified=False, last_error=str(error))
                if getattr(error, "http_status", None) == 401:
                    entry.update(authenticated=False, expired=True)
            raise


class RejectRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Microsoft Graphが別URLへ転送しようとしたため停止しました。")


def graph_post(path, body, token):
    request = urllib.request.Request("https://graph.microsoft.com" + path,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), RejectRedirect())
    try:
        with opener.open(request, timeout=120) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError("Copilotの応答サイズが上限を超えています。")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("Copilotの応答形式が不正です。")
        return value
    except urllib.error.HTTPError as error:
        reasons = {401: "認証が無効または追加認証が必要です。再サインインしてください。",
                   403: "Copilotライセンス、全必須権限の管理者同意、会社のアクセス方針を確認してください。",
                   429: "利用制限に達しました。時間をおいて再実行してください。",
                   504: "処理がタイムアウトしました。資料を短くしてください。"}
        # Do not echo Graph response bodies, tokens, URLs containing codes, or tenant data.
        raise GraphConnectionError(f"M365 Copilot接続エラー（HTTP {error.code}）。" + reasons.get(error.code, "プレビューAPIの利用可否とリクエスト内容を確認してください。"),error.code) from None
    except (urllib.error.URLError, TimeoutError):
        raise ValueError("Microsoft Graphへ接続できないか、タイムアウトしました。会社の通信設定を確認してください。") from None
    except json.JSONDecodeError:
        raise ValueError("Microsoft Graphの応答を読み取れませんでした。") from None
