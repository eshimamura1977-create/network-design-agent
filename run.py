"""Run the loopback-only local reverse proxy and application API."""
from __future__ import annotations

import http.client
import logging
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT=Path(__file__).resolve().parent


def load_env():
    path=ROOT/".env"
    if path.exists():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            if line.strip() and not line.lstrip().startswith("#") and "=" in line:
                key,value=line.split("=",1)
                os.environ.setdefault(key.strip(),value.strip().strip('"').strip("'"))


def proxy_handler(api_port,gui_port):
    class Proxy(BaseHTTPRequestHandler):
        server_version="NetworkWorkbenchProxy/0.1"
        def log_message(self,*args): pass
        def do_GET(self): self.forward()
        def do_POST(self): self.forward()
        def do_OPTIONS(self): self.send_error(403)
        def forward(self):
            if self.headers.get("Host") not in (f"127.0.0.1:{gui_port}",f"localhost:{gui_port}"):
                self.send_error(403); return
            try: length=int(self.headers.get("Content-Length","0"))
            except ValueError: self.send_error(400); return
            if length<0 or length>12*1024*1024 or self.headers.get("Transfer-Encoding"):
                self.send_error(413); return
            if not self.path.startswith("/") or self.path.startswith("//"):
                self.send_error(400); return
            connection=http.client.HTTPConnection("127.0.0.1",api_port,timeout=120)
            try:
                headers={k:v for k,v in self.headers.items() if k.lower() in ("host","content-type","origin","x-workbench-request","cookie")}
                data=self.rfile.read(length) if length else None
                connection.request(self.command,self.path,body=data,headers=headers)
                response=connection.getresponse()
                self.send_response(response.status)
                for k,v in response.getheaders():
                    if k.lower() not in ("connection","transfer-encoding","server","date"): self.send_header(k,v)
                self.end_headers()
                while chunk:=response.read(65536): self.wfile.write(chunk)
            except (BrokenPipeError,ConnectionResetError): pass
            except Exception:
                logging.exception("Local proxy failure")
                self.send_error(502,"Local API is unavailable")
            finally: connection.close()
    return Proxy


def main():
    load_env()
    (ROOT/"logs").mkdir(exist_ok=True)
    logging.basicConfig(filename=ROOT/"logs"/"server.log",level=logging.WARNING,encoding="utf-8")
    from agent.server import make_server
    gui_port=int(os.environ.get("GUI_PORT","8080")); api_port=int(os.environ.get("API_PORT","8765"))
    api=make_server(api_port,gui_port)
    try: proxy=ThreadingHTTPServer(("127.0.0.1",gui_port),proxy_handler(api_port,gui_port))
    except Exception:
        api.server_close(); raise
    threading.Thread(target=api.serve_forever,daemon=True).start()
    print(f"Network Design Workbench: http://127.0.0.1:{gui_port}",flush=True)
    print(f"Local proxy {gui_port} -> API {api_port}. Ctrl+C to stop.",flush=True)
    try: proxy.serve_forever()
    except KeyboardInterrupt: pass
    finally: api.shutdown(); api.server_close(); proxy.server_close()


if __name__=="__main__": main()
