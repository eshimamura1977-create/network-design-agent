from __future__ import annotations

import base64
import html
import json
import logging
import mimetypes
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from pydantic import ValidationError

from .analysis import ai_candidates, extract_file, llm_settings, local_candidates
from .importers import SUPPORTED_EXTENSIONS
from .domain import Project, Requirement, sample_project, validate_project
from .exports import export_bundle, topology_svg
from .store import Conflict, Store
from .m365 import M365Connection, COOKIE_NAME, SESSION_SECONDS
from .design_report import generate_design_report, prepare_input
from .pipeline import generate_pipeline

ROOT=Path(__file__).resolve().parent.parent
MAX_BODY=12*1024*1024
EXECUTOR=ThreadPoolExecutor(max_workers=2,thread_name_prefix="design-job")
PENDING=threading.BoundedSemaphore(4)


class ApiError(Exception):
    def __init__(self,message,status=400):
        super().__init__(message); self.status=status


def parse_project(value):
    return Project.model_validate(value).model_dump()


def create_handler(store: Store, allowed_hosts: set[str], m365=None):
    m365 = m365 or M365Connection(store.root, int(os.environ.get("GUI_PORT", "8080")))
    class Handler(BaseHTTPRequestHandler):
        server_version="NetworkWorkbench/0.1"

        def log_message(self,*args):
            pass

        def send(self,status,value,content_type="application/json; charset=utf-8",download=None,extra_headers=None):
            payload=json.dumps(value,ensure_ascii=False).encode() if content_type.startswith("application/json") else value
            self.send_response(status)
            self.send_header("Content-Type",content_type)
            self.send_header("Content-Length",str(len(payload)))
            self.send_header("Cache-Control","no-store")
            self.send_header("X-Content-Type-Options","nosniff")
            self.send_header("Referrer-Policy","no-referrer")
            self.send_header("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
            if download: self.send_header("Content-Disposition",f'attachment; filename="{download}"')
            for key, value in (extra_headers or {}).items(): self.send_header(key, value)
            self.end_headers(); self.wfile.write(payload)

        def session_id(self):
            try:
                cookie = SimpleCookie(self.headers.get("Cookie", ""))
                return cookie[COOKIE_NAME].value if COOKIE_NAME in cookie else ""
            except Exception:
                return ""

        def session_cookie(self, sid):
            return f"{COOKIE_NAME}={sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_SECONDS if sid else 0}"

        def body(self):
            if self.headers.get("Transfer-Encoding"):
                raise ApiError("チャンク形式の入力には対応していません")
            try: length=int(self.headers.get("Content-Length","0"))
            except ValueError: raise ApiError("不正なContent-Length")
            if not 0<length<=MAX_BODY: raise ApiError("リクエストサイズが範囲外です",413)
            if self.headers.get_content_type()!="application/json": raise ApiError("JSON形式で送信してください",415)
            value=json.loads(self.rfile.read(length))
            if not isinstance(value,dict): raise ApiError("JSONオブジェクトが必要です")
            return value

        def guard(self):
            host=self.headers.get("Host","")
            if host not in allowed_hosts: raise ApiError("許可されていない接続先名です",403)
            origin=self.headers.get("Origin")
            if origin and origin!=f"http://{host}": raise ApiError("別のサイトからの操作は禁止されています",403)
            if self.command=="POST" and self.headers.get("X-Workbench-Request")!="1": raise ApiError("操作用ヘッダーがありません",403)

        def do_GET(self): self.handle_request()
        def do_POST(self): self.handle_request()
        def do_OPTIONS(self): self.send(403,{"error":"外部サイトからの接続は許可していません"})

        def handle_request(self):
            try:
                self.guard(); self.dispatch()
            except ApiError as e: self.send(e.status,{"error":str(e)})
            except Conflict as e: self.send(409,{"error":str(e)})
            except KeyError: self.send(404,{"error":"対象が見つかりません"})
            except ValidationError as e:
                errors=[".".join(map(str,x["loc"]))+": "+x["msg"] for x in e.errors(include_input=False,include_context=False)]
                self.send(400,{"error":"入力内容を確認してください","details":errors})
            except (ValueError,TypeError) as e: self.send(400,{"error":str(e)[:600]})
            except (BrokenPipeError,ConnectionResetError): pass
            except Exception:
                logging.exception("API request failed")
                self.send(500,{"error":"処理に失敗しました。入力形式を確認し、logs/server.logを参照してください。"})

        def submit(self,project,kind,fn):
            if not PENDING.acquire(blocking=False): raise ApiError("処理が混み合っています。完了後に再実行してください。",429)
            ident=store.new_job(project,kind)
            def run():
                try:
                    store.set_job(ident,"running")
                    result=fn(ident)
                    store.set_job(ident,"completed",result)
                except (ValueError,Conflict) as e: store.set_job(ident,"failed",{"error":str(e)[:1000]})
                except Exception:
                    logging.exception("Background job failed")
                    store.set_job(ident,"failed",{"error":"処理に失敗しました。ログを確認してください。"})
                finally: PENDING.release()
            EXECUTOR.submit(run)
            self.send(202,{"job_id":ident})

        def dispatch(self):
            path=urlparse(self.path).path
            deletion = re.fullmatch(r"/api/projects/([a-f0-9]{32})/sources/([a-f0-9]{32})/delete", path)
            if deletion:
                if self.command != "POST":
                    raise ApiError("削除はPOSTで実行してください",405)
                body = self.body()
                if type(body.get("revision")) is not int:
                    raise ApiError("削除対象の版番号が必要です")
                return self.send(200, store.delete_source(*deletion.groups(), body["revision"]))
            if path == "/auth/m365/callback" and self.command == "GET":
                if "http://" + self.headers.get("Host", "") != m365.gui_origin:
                    raise ApiError("サインインを開始したlocalhostの画面から接続してください。",403)
                query = parse_qs(urlparse(self.path).query, keep_blank_values=True, max_num_fields=20)
                if any(len(values) != 1 for values in query.values()):
                    raise ApiError("認証応答に重複した項目があります",400)
                try:
                    sid = m365.finish(self.session_id(), {key: value[0] for key, value in query.items()})
                    return self.send(303,b"", "text/plain", extra_headers={"Location":"/?m365=signed-in", "Set-Cookie":self.session_cookie(sid)})
                except ValueError as error:
                    body = ('<!doctype html><html lang="ja"><meta charset="utf-8"><title>サインインの確認</title>'
                            '<link rel="stylesheet" href="/style.css"><main><h1>サインインを完了できませんでした</h1><p>'
                            + html.escape(str(error)) + '</p><a href="/">設計支援画面へ戻る</a></main></html>').encode()
                    return self.send(400, body, "text/html; charset=utf-8")
            if path == "/api/m365/status" and self.command == "GET":
                return self.send(200,m365.status(self.session_id()))
            if path == "/api/m365/config" and self.command == "POST":
                return self.send(200,m365.configure(self.body()))
            if path == "/api/m365/start" and self.command == "POST":
                self.body()
                if "http://" + self.headers.get("Host", "") != m365.gui_origin:
                    raise ApiError("Microsoftサインインはlocalhostの画面で実行してください。",409)
                sid, url = m365.start(self.session_id())
                return self.send(200,{"authorization_url":url},extra_headers={"Set-Cookie":self.session_cookie(sid)})
            if path == "/api/m365/logout" and self.command == "POST":
                self.body();m365.logout(self.session_id())
                return self.send(200,{"signed_out":True},extra_headers={"Set-Cookie":self.session_cookie("")})
            if path == "/api/m365/test" and self.command == "POST":
                self.body(); sid = self.session_id()
                if not m365.status(sid)["authenticated"]:
                    raise ApiError("先にMicrosoftへサインインしてください。",401)
                def connection_test(job):
                    answer = m365.chat(sid, "接続確認です。提示されたテスト文字列をそのまま返してください。他の情報を検索しないでください。", "NW-CONNECTION-OK")
                    return {"connected":True,"message":"Copilot Chat APIからテキスト応答を受信しました。案件資料は送信していません。"}
                return self.submit("m365-connection", "connection-test", connection_test)
            if self.command=="GET" and path in ("/","/app.js","/style.css","/favicon.svg"):
                file=ROOT/"web"/("index.html" if path=="/" else path[1:])
                content_type={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml"}[file.suffix]
                return self.send(200,file.read_bytes(),content_type)
            if path=="/api/health" and self.command=="GET":
                settings=llm_settings()
                return self.send(200,{"app":"network-design-workbench","version":"0.5.0","input_formats":list(SUPPORTED_EXTENSIONS),"ai":{"configured":settings["configured"],"local":settings["local"],"model":settings["model"]},"m365":m365.status(self.session_id()),"capabilities":["requirements","requirements-to-word","ai-lifecycle-draft","l2-validation","docx","xlsx","pptx-input","vsdx-input","svg","vsdx-experimental","config-draft","m365-copilot-preview"]})
            if path=="/api/projects":
                if self.command=="GET": return self.send(200,store.list())
                body=self.body()
                p=sample_project() if body.get("sample") else Project(name=body.get("name","新しいネットワーク案件")).model_dump()
                return self.send(201,store.create(p))
            match=re.fullmatch(r"/api/projects/([a-f0-9]{32})(?:/(sources|analyze|validate|approve|generate|design-document|pipeline|jobs|topology))?",path)
            if match:
                ident,action=match.groups(); snapshot=store.get(ident)
                if self.command=="GET":
                    if not action: return self.send(200,snapshot)
                    if action=="sources": return self.send(200,store.sources(ident))
                    if action=="jobs": return self.send(200,store.jobs(ident))
                    if action=="topology": return self.send(200,topology_svg(snapshot["project"]["design"]).encode(),"image/svg+xml")
                    raise ApiError("この操作はPOSTで実行してください",405)
                body=self.body()
                if not action:
                    if not isinstance(body.get("revision"),int): raise ApiError("版番号が必要です")
                    return self.send(200,store.save(ident,body["revision"],parse_project(body.get("project"))))
                if action=="sources":
                    if len(store.sources(ident))>=20: raise ApiError("資料は1案件20件までです。新規案件で分割してください。")
                    name=str(body.get("name","入力資料.txt"))[:150]
                    if body.get("base64"):
                        try: data=base64.b64decode(body["base64"],validate=True)
                        except Exception: raise ApiError("ファイルの送信形式が不正です")
                    else:
                        data=str(body.get("text","")).encode(); name=name if Path(name).suffix.lower() in (".txt",".md",".csv",".log",".cfg") else name+".txt"
                    text=extract_file(name,data)
                    source=store.add_source(ident,name,text)
                    return self.send(201,{"id":source,"characters":len(text)})
                if action=="analyze":
                    sources=store.sources(ident)
                    if not sources: raise ApiError("先に資料を登録してください")
                    mode=body.get("mode","local")
                    if mode not in ("local","ai","m365"): raise ApiError("解析モードが不正です")
                    if mode=="ai" and not llm_settings()["configured"]: raise ApiError("AI未接続です。.envのモデル・接続先を設定してください。")
                    sid = self.session_id()
                    if mode=="m365" and not m365.status(sid)["authenticated"]:
                        raise ApiError("M365 Copilotへサインインしてください。",401)
                    def analyze(job):
                        if mode=="m365":
                            result=ai_candidates(sources,chat=lambda prompt,context:m365.chat(sid,prompt,context))
                        else:
                            result=ai_candidates(sources) if mode=="ai" else local_candidates(sources)
                        for i,r in enumerate(result["requirements"],1): Requirement(id=f"REQ-{i:03d}",**r)
                        result["base_revision"]=snapshot["revision"]
                        return result
                    return self.submit(ident,"analysis",analyze)
                if action=="pipeline":
                    if type(body.get("revision")) is not int:
                        raise ApiError("生成対象の版番号が必要です")
                    package_snapshot, package_sources = store.design_inputs(ident, body["revision"])
                    prepare_input(package_snapshot, package_sources)
                    if not package_snapshot["project"]["requirements"]:
                        raise ApiError("先に要件候補を抽出し、要件一覧へ追加してください。")
                    mode = body.get("mode", "m365")
                    if mode not in ("ai", "m365"):
                        raise ApiError("全工程生成にはAI接続が必要です。")
                    if mode == "ai" and not llm_settings()["configured"]:
                        raise ApiError("AI未接続です。接続設定を完了してください。")
                    sid = self.session_id()
                    if mode == "m365" and not m365.status(sid)["authenticated"]:
                        raise ApiError("M365 Copilotへサインインしてください。", 401)
                    def pipeline(job):
                        chat = (lambda prompt, context: m365.chat(sid, prompt, context)) if mode == "m365" else None
                        def progress(stage):
                            store.set_job(job, "running", {"stage": stage, "revision": package_snapshot["revision"]})
                        result = generate_pipeline(package_snapshot, package_sources,
                            store.root / "pipelines" / job, mode, chat, progress)
                        return {**result, "download_url": f"/api/jobs/{job}/download"}
                    return self.submit(ident, "pipeline", pipeline)
                if action=="design-document":
                    if type(body.get("revision")) is not int:
                        raise ApiError("生成対象の版番号が必要です")
                    report_snapshot, report_sources = store.design_inputs(ident, body["revision"])
                    prepare_input(report_snapshot, report_sources)
                    mode = body.get("mode", "local")
                    if mode not in ("local", "ai", "m365"):
                        raise ApiError("設計書の生成モードが不正です")
                    if mode == "ai" and not llm_settings()["configured"]:
                        raise ApiError("AI未接続です。接続設定を確認するか、ローカルのドラフト作成を選んでください。")
                    sid = self.session_id()
                    if mode == "m365" and not m365.status(sid)["authenticated"]:
                        raise ApiError("M365 Copilotへサインインしてください。", 401)
                    def design_document(job):
                        chat = (lambda prompt, context: m365.chat(sid, prompt, context)) if mode == "m365" else None
                        result = generate_design_report(report_snapshot, report_sources,
                            store.root / "design-documents" / (job + ".docx"), mode, chat)
                        return {**result, "download_url": f"/api/jobs/{job}/download"}
                    return self.submit(ident, "design-document", design_document)
                if action=="validate": return self.send(200,{"revision":snapshot["revision"],"findings":validate_project(snapshot["project"])})
                if action=="approve":
                    if body.get("revision")!=snapshot["revision"]: raise Conflict("承認対象の版が更新されました")
                    findings=validate_project(snapshot["project"])
                    if any(x["level"] in ("error","warning") for x in findings): raise ApiError("エラー・未確認要件を解消してから設計を承認してください。",422)
                    return self.send(200,store.approve(ident,snapshot["revision"]))
                if action=="generate":
                    if body.get("revision")!=snapshot["revision"]: raise Conflict("生成対象の版が更新されました")
                    def generate(job):
                        manifest=export_bundle(snapshot,store.root/"exports"/job)
                        return {**manifest,"download_url":f"/api/jobs/{job}/download"}
                    return self.submit(ident,"export",generate)
            match=re.fullmatch(r"/api/jobs/([a-f0-9]{32})(?:/(apply|download))?",path)
            if match:
                ident,action=match.groups(); job=store.job(ident)
                if self.command=="GET" and not action: return self.send(200,job)
                if self.command=="GET" and action=="download":
                    if job["status"]!="completed": raise ApiError("成果物はまだ完成していません",409)
                    if job["kind"]=="design-document":
                        file=store.root/"design-documents"/(ident+".docx")
                        return self.send(200,file.read_bytes(),"application/vnd.openxmlformats-officedocument.wordprocessingml.document",f"network-basic-design-v{job['result']['revision']}.docx")
                    if job["kind"]=="pipeline":
                        file=store.root/"pipelines"/(ident+".zip")
                        return self.send(200,file.read_bytes(),"application/zip",f"network-lifecycle-draft-v{job['result']['revision']}.zip")
                    if job["kind"]!="export": raise ApiError("ダウンロード対象の成果物ではありません",409)
                    file=store.root/"exports"/(ident+".zip")
                    return self.send(200,file.read_bytes(),"application/zip",f"network-design-v{job['result']['revision']}.zip")
                if self.command=="POST" and action=="apply":
                    self.body()
                    if job["kind"]!="analysis" or job["status"]!="completed": raise ApiError("解析が完了していません",409)
                    current=store.get(job["project"])
                    if current["revision"]!=job["result"]["base_revision"]: raise Conflict("解析後に設計版が更新されました。最新の版で再解析してください。")
                    p=current["project"]; existing={(x["source"],x["quote"]) for x in p["requirements"]}
                    ids={x["id"] for x in p["requirements"]}
                    count=1
                    for r in job["result"]["requirements"]:
                        if (r["source"],r["quote"]) in existing: continue
                        while f"REQ-{count:03d}" in ids: count+=1
                        rid=f"REQ-{count:03d}"; ids.add(rid)
                        p["requirements"].append(Requirement(id=rid,**r).model_dump())
                        existing.add((r["source"],r["quote"]))
                    return self.send(200,store.save(current["id"],current["revision"],parse_project(p)))
            raise ApiError("APIが見つかりません",404)
    return Handler


def make_server(port,gui_port,data_dir=None):
    store=Store(Path(data_dir) if data_dir else ROOT/"data")
    hosts={f"{host}:{p}" for host in ("127.0.0.1","localhost") for p in (port,gui_port)}
    return ThreadingHTTPServer(("127.0.0.1",port),create_handler(store,hosts,M365Connection(store.root,gui_port)))
