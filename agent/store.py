from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


def now():
    return datetime.now(timezone.utc).isoformat()


class Conflict(Exception):
    pass


class Store:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.path = root / "workbench.sqlite3"
        with self.connect() as db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL, approved INTEGER, updated TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS revisions(project TEXT, revision INTEGER, body TEXT, created TEXT, PRIMARY KEY(project, revision));
            CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, project TEXT, name TEXT, body TEXT, created TEXT);
            CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project TEXT, kind TEXT, status TEXT, result TEXT, created TEXT);
            ''')
            db.execute("UPDATE jobs SET status='failed',result=? WHERE status IN ('queued','running')", (json.dumps({"error": "処理中にサーバーが再起動しました。再実行してください。"}, ensure_ascii=False),))

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        try:
            with db:
                yield db
        finally:
            db.close()

    def create(self, body):
        ident = uuid.uuid4().hex
        text = json.dumps(body, ensure_ascii=False)
        with self.connect() as db:
            db.execute("INSERT INTO projects VALUES(?,1,?,NULL,?)", (ident, text, now()))
            db.execute("INSERT INTO revisions VALUES(?,1,?,?)", (ident, text, now()))
        return self.get(ident)

    def get(self, ident):
        with self.connect() as db:
            row = db.execute("SELECT * FROM projects WHERE id=?", (ident,)).fetchone()
        if not row:
            raise KeyError("案件が見つかりません")
        return dict(id=row["id"], revision=row["revision"], approved_revision=row["approved"], updated=row["updated"], project=json.loads(row["body"]))

    def list(self):
        with self.connect() as db:
            rows = db.execute("SELECT * FROM projects ORDER BY updated DESC").fetchall()
        return [dict(id=r["id"], name=json.loads(r["body"])["name"], revision=r["revision"], updated=r["updated"]) for r in rows]

    def save(self, ident, revision, body):
        text = json.dumps(body, ensure_ascii=False)
        with self.connect() as db:
            cur = db.execute("UPDATE projects SET body=?,revision=revision+1,approved=NULL,updated=? WHERE id=? AND revision=?", (text, now(), ident, revision))
            if cur.rowcount != 1:
                raise Conflict("別の操作で更新されています。画面を再読み込みして最新の版を確認してください。")
            db.execute("INSERT INTO revisions VALUES(?,?,?,?)", (ident, revision + 1, text, now()))
        return self.get(ident)

    def approve(self, ident, revision):
        with self.connect() as db:
            cur = db.execute("UPDATE projects SET approved=? WHERE id=? AND revision=?", (revision, ident, revision))
            if cur.rowcount != 1:
                raise Conflict("承認対象の版が更新されました")
        return self.get(ident)

    def sources(self, ident):
        with self.connect() as db:
            return [dict(r) for r in db.execute("SELECT * FROM sources WHERE project=? ORDER BY created", (ident,))]

    def add_source(self, ident, name, body):
        self.get(ident)
        sid = uuid.uuid4().hex
        with self.connect() as db:
            db.execute("INSERT INTO sources VALUES(?,?,?,?,?)", (sid, ident, name, body, now()))
        return sid

    def design_inputs(self, ident, revision):
        """Read the project and its immutable source bodies in one DB snapshot."""
        with self.connect() as db:
            db.execute("BEGIN")
            row = db.execute("SELECT * FROM projects WHERE id=?", (ident,)).fetchone()
            if row is None:
                raise KeyError("案件が見つかりません")
            if row["revision"] != revision:
                raise Conflict("設計書の生成対象が更新されています。最新の版で再実行してください。")
            sources = [dict(s) for s in db.execute("SELECT * FROM sources WHERE project=? ORDER BY created", (ident,))]
            snapshot = dict(id=row["id"], revision=row["revision"], approved_revision=row["approved"],
                updated=row["updated"], project=json.loads(row["body"]))
        return snapshot, sources

    def job(self, ident):
        with self.connect() as db:
            r = db.execute("SELECT * FROM jobs WHERE id=?", (ident,)).fetchone()
        if not r:
            raise KeyError("処理が見つかりません")
        value = dict(r)
        value["result"] = json.loads(value["result"])
        return value

    def delete_source(self, project, source_id, revision):
        """Remove one imported source and invalidate reviews atomically.

        Original files and historical revisions/exports are intentionally retained.
        Legacy requirements have only a filename reference, so conservatively mark
        matching filenames unresolved. New requirements carry the exact source ID.
        """
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current = db.execute("SELECT * FROM projects WHERE id=?", (project,)).fetchone()
            source = db.execute("SELECT * FROM sources WHERE project=? AND id=?", (project, source_id)).fetchone()
            if current is None or source is None:
                raise KeyError("資料が見つかりません")
            if current["revision"] != revision:
                raise Conflict("別の操作で更新されています。再読み込みしてから削除してください。")
            body = json.loads(current["body"])
            affected = 0
            for requirement in body["requirements"]:
                ref = requirement.get("source", "")
                linked_id = requirement.get("source_id", "")
                linked = linked_id == source_id if linked_id else (ref == source["name"] or ref.startswith(source["name"] + " / "))
                if linked:
                    requirement["status"] = "unresolved"
                    requirement["source"] = ("【元資料削除】" + ref)[:300]
                    affected += 1
            text = json.dumps(body, ensure_ascii=False)
            stamp = now()
            db.execute("DELETE FROM sources WHERE project=? AND id=?", (project, source_id))
            db.execute("UPDATE projects SET body=?,revision=revision+1,approved=NULL,updated=? WHERE id=?", (text, stamp, project))
            db.execute("INSERT INTO revisions VALUES(?,?,?,?)", (project, revision + 1, text, stamp))
        return dict(deleted_id=source_id, affected_requirements=affected, revision=revision + 1)

    def jobs(self, project):
        with self.connect() as db:
            rows = db.execute("SELECT id FROM jobs WHERE project=? ORDER BY created DESC LIMIT 30", (project,)).fetchall()
        return [self.job(r["id"]) for r in rows]

    def new_job(self, project, kind):
        ident = uuid.uuid4().hex
        with self.connect() as db:
            db.execute("INSERT INTO jobs VALUES(?,?,?,'queued','{}',?)", (ident, project, kind, now()))
        return ident

    def set_job(self, ident, status, result=None):
        with self.connect() as db:
            db.execute("UPDATE jobs SET status=?,result=? WHERE id=?", (status, json.dumps(result or {}, ensure_ascii=False), ident))
