from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from agent.analysis import ai_candidates
from agent.m365 import M365Connection, GraphConnectionError, SCOPES, FLOW_SECONDS, COOKIE_NAME
from agent.server import create_handler
from agent.store import Store
from run import proxy_handler

TENANT = "11111111-1111-4111-8111-111111111111"
CLIENT = "22222222-2222-4222-8222-222222222222"


class FakeApp:
    tid = TENANT
    refresh_ok = True

    def initiate_auth_code_flow(self, scopes, **kwargs):
        self.scopes = scopes
        self.redirect = kwargs["redirect_uri"]
        return {"state":"test-state", "auth_uri":"https://login.microsoftonline.com/test/authorize", "code_verifier":"test-verifier"}

    def acquire_token_by_auth_code_flow(self, flow, query):
        if query.get("code") != "test-code":
            raise ValueError("wrong code")
        return {"access_token":"secret-test-token", "id_token_claims":{"tid":self.tid,"preferred_username":"tester@example.invalid"}}

    def get_accounts(self): return [{"home_account_id":"test-account"}]
    def acquire_token_silent(self, scopes, account): return {"access_token":"secret-test-token"} if self.refresh_ok else None


class M365Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.app = FakeApp()
        self.conn = M365Connection(self.root, 8080, lambda client, tenant: self.app)
        self.conn.configure({"tenant_id":TENANT,"client_id":CLIENT})

    def tearDown(self): self.temp.cleanup()

    def login(self):
        sid, _ = self.conn.start()
        return self.conn.finish(sid,{"state":"test-state","code":"test-code"})

    def test_no_browser_session_can_use_another_session_token(self):
        sid = self.login()
        self.assertEqual(self.conn.token(sid),"secret-test-token")
        self.assertFalse(self.conn.status("")["authenticated"])
        with self.assertRaises(ValueError): self.conn.token("other-browser")

    def test_auth_state_verified_and_callback_single_use(self):
        sid, _ = self.conn.start()
        with self.assertRaisesRegex(ValueError,"一致"): self.conn.finish(sid,{"state":"forged","code":"test-code"})
        sid, _ = self.conn.start()
        new_sid = self.conn.finish(sid,{"state":"test-state","code":"test-code"})
        self.assertNotEqual(new_sid,sid)
        with self.assertRaises(ValueError): self.conn.finish(sid,{"state":"test-state","code":"test-code"})

    def test_wrong_tenant_rejected(self):
        self.app.tid = CLIENT
        with self.assertRaisesRegex(ValueError,"テナント"): self.login()

    def test_flow_expiration(self):
        sid, _ = self.conn.start()
        with patch("agent.m365.time.time",return_value=time.time()+FLOW_SECONDS+1):
            with self.assertRaises(ValueError): self.conn.finish(sid,{"state":"test-state","code":"test-code"})

    def test_tokens_not_written_or_returned_in_status(self):
        sid = self.login()
        self.assertNotIn("secret-test-token",json.dumps(self.conn.status(sid)))
        files=list(self.root.iterdir())
        self.assertEqual([f.name for f in files],["m365-settings.json"])
        self.assertEqual(set(json.loads(files[0].read_text())),{"tenant_id","client_id"})

    def test_refresh_failure_requires_sign_in(self):
        sid = self.login(); self.app.refresh_ok=False
        with self.assertRaisesRegex(ValueError,"再サインイン"): self.conn.token(sid)
        self.assertFalse(self.conn.status(sid)["authenticated"])
        self.assertTrue(self.conn.status(sid)["expired"])

    def test_logout_and_config_change_clear_sessions(self):
        sid=self.login();self.conn.logout(sid)
        with self.assertRaises(ValueError):self.conn.token(sid)
        sid=self.login();self.conn.configure({"tenant_id":TENANT,"client_id":CLIENT})
        with self.assertRaises(ValueError):self.conn.token(sid)

    def test_settings_do_not_allow_secret_or_arbitrary_authority(self):
        with self.assertRaises(ValueError):self.conn.configure({"tenant_id":"https://evil.invalid","client_id":CLIENT})
        with self.assertRaises(ValueError):self.conn.configure({"tenant_id":TENANT,"client_id":CLIENT,"client_secret":"not-accepted"})

    def test_graph_request_disables_web_search_and_uses_fresh_conversations(self):
        sid=self.login()
        reply={"messages":[{"text":"input"},{"text":"output"}]}
        with patch("agent.m365.graph_post",side_effect=[{"id":"conversation1"},reply,{"id":"conversation2"},reply]) as graph:
            self.assertEqual(self.conn.chat(sid,"prompt","data"),"output")
            self.conn.chat(sid,"prompt2","other data")
            self.assertEqual(graph.call_args_list[0].args[0],"/beta/copilot/conversations")
            self.assertEqual(graph.call_args_list[2].args[0],"/beta/copilot/conversations")
            payload=graph.call_args_list[1].args[1]
            self.assertFalse(payload["contextualResources"]["webContext"]["isWebEnabled"])
            self.assertEqual(payload["additionalContext"],[{"text":"data"}])
        self.assertTrue(self.conn.status(sid)["chat_verified"])

    def test_graph_401_changes_ui_auth_state(self):
        sid=self.login()
        with patch("agent.m365.graph_post",side_effect=GraphConnectionError("再認証が必要",401)):
            with self.assertRaises(ValueError):self.conn.chat(sid,"test","data")
        self.assertFalse(self.conn.status(sid)["authenticated"])

    def test_m365_output_obeys_existing_evidence_guard(self):
        sources=[{"id":"s1","name":"test.txt","body":"L1: VLANで分離する"}]
        reply={"requirements":[{"source_id":"s1","text":"VLAN分離","quote":"VLANで分離する","category":"機能"}],"advice":"台数を確認"}
        result=ai_candidates(sources,chat=lambda p,c:json.dumps(reply))
        self.assertEqual(result["mode"],"m365")
        reply["requirements"][0]["quote"]="出典にない内容"
        with self.assertRaisesRegex(ValueError,"根拠"):ai_candidates(sources,chat=lambda p,c:json.dumps(reply))


class ProxyAuthTests(unittest.TestCase):
    def test_real_http_proxy_preserves_session_cookie_and_redirect(self):
        with tempfile.TemporaryDirectory() as temp:
            store=Store(Path(temp));hosts=set()
            conn=M365Connection(Path(temp),8080,lambda c,t:FakeApp())
            backend=ThreadingHTTPServer(("127.0.0.1",0),create_handler(store,hosts,conn))
            proxy=ThreadingHTTPServer(("127.0.0.1",0),proxy_handler(backend.server_port,0))
            # Assign the handler only after choosing a free local port.
            proxy.RequestHandlerClass=proxy_handler(backend.server_port,proxy.server_port)
            conn.gui_origin=f"http://localhost:{proxy.server_port}"
            conn.redirect_uri=conn.gui_origin+"/auth/m365/callback"
            hosts.update({f"localhost:{proxy.server_port}",f"127.0.0.1:{proxy.server_port}"})
            for server in (backend,proxy):threading.Thread(target=server.serve_forever,daemon=True).start()
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
            import http.cookiejar
            jar=http.cookiejar.CookieJar()
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(jar))
            def request(path,body=None,client=opener):
                req=urllib.request.Request(conn.gui_origin+path,data=json.dumps(body).encode() if body is not None else None,
                    headers={"Content-Type":"application/json","X-Workbench-Request":"1"})
                with client.open(req,timeout=10) as response:return response.read(),response.headers
            try:
                request("/api/m365/config",{"tenant_id":TENANT,"client_id":CLIENT})
                raw,headers=request("/api/m365/start",{})
                self.assertIn("HttpOnly",headers["Set-Cookie"])
                self.assertIn("SameSite=Lax",headers["Set-Cookie"])
                self.assertNotIn(b"secret-test-token",raw)
                request("/auth/m365/callback?state=test-state&code=test-code")
                status=json.loads(request("/api/m365/status")[0]);self.assertTrue(status["authenticated"])
                no_cookie=urllib.request.build_opener(urllib.request.ProxyHandler({}))
                status=json.loads(request("/api/m365/status",client=no_cookie)[0]);self.assertFalse(status["authenticated"])
                request("/api/m365/logout",{})
                status=json.loads(request("/api/m365/status")[0]);self.assertFalse(status["authenticated"])
            finally:
                for server in (proxy,backend):server.shutdown();server.server_close()


if __name__=="__main__":unittest.main()
