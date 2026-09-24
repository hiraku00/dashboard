"""ローカル台帳の変更分をPortalへ送る. 認証は manage-asset と同じ Service Token(Keychain)."""
from __future__ import annotations

import json
import os
import ssl
import subprocess
import time
import urllib.error
import urllib.request
from typing import Callable

import certifi

MAX_NOTES_PER_REQUEST = 10
MAX_COMMENTS_PER_REQUEST = 40        # Workers Free の CPU 上限(10ms)に収めるため、1リクエストは小さくする
KEYCHAIN_SERVICE = "manage-asset:portal-sync"


def keychain_token() -> str:
    value = os.environ.get("PORTAL_SYNC_TOKEN", "").strip()
    if value:
        return value
    service = os.environ.get("PORTAL_SYNC_KEYCHAIN_SERVICE", KEYCHAIN_SERVICE)
    try:
        result = subprocess.run(["security", "find-generic-password", "-a", "local-user", "-s", service, "-w"],
                                check=True, capture_output=True, text=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise RuntimeError("Portal同期用Service TokenをmacOS Keychainから取得できませんでした") from exc
    return result.stdout.strip()


def note_payload(note: dict, comments: list[dict] | None = None) -> dict:
    """台帳のノート → APIの形. comments を省くとノートの全コメント."""
    cs = note["comments"] if comments is None else comments
    return {
        "id": note["id"], "room": note["room"], "authorName": note["author_name"], "authorIsTarget": bool(note["author_is_target"]),
        "programTitle": note["program_title"], "linkTitle": note["link_title"], "linkUrl": note["link_url"],
        "bodyText": note["body_text"], "bodyComplete": bool(note["body_complete"]),
        "postedAt": note["posted_at"], "postedAtPrecision": note["posted_at_precision"], "postedAtRaw": note["posted_at_raw"],
        "commentCount": int(note["comment_count"]), "needsRecheck": bool(note["needs_recheck"]),
        "firstSeenAt": note["first_seen_at"], "lastCheckedAt": note["last_checked_at"], "deletedAt": note.get("deleted_at"),
        "comments": [{
            "id": c["id"], "ordinal": int(c["ordinal"]), "authorName": c["author_name"], "isTarget": bool(c["is_target"]),
            "bodyText": c["body_text"], "postedAt": c["posted_at"], "postedAtPrecision": c["posted_at_precision"],
            "postedAtRaw": c["posted_at_raw"], "ocrMinConfidence": c.get("ocr_min_confidence"),
            "firstSeenAt": c["first_seen_at"], "lastSeenAt": c["last_seen_at"], "deletedAt": c.get("deleted_at"),
        } for c in cs],
    }


def chunk_notes(notes: list[dict]) -> list[list[tuple[dict, list[dict]]]]:
    """1リクエストが大きくなりすぎないよう、ノートとコメントを分割する. 各要素は (ノート, そのリクエストで送るコメント)."""
    chunks: list[list[tuple[dict, list[dict]]]] = []
    cur: list[tuple[dict, list[dict]]] = []
    count = 0

    def flush():
        nonlocal cur, count
        if cur:
            chunks.append(cur)
        cur, count = [], 0

    for note in notes:
        rest = list(note["comments"])
        if not rest:
            if len(cur) >= MAX_NOTES_PER_REQUEST:
                flush()
            cur.append((note, []))
            continue
        while rest:
            room = MAX_COMMENTS_PER_REQUEST - count
            if room <= 0 or len(cur) >= MAX_NOTES_PER_REQUEST:
                flush()
                room = MAX_COMMENTS_PER_REQUEST
            take, rest = rest[:room], rest[room:]
            cur.append((note, take))
            count += len(take)
    flush()
    return chunks


class Uploader:
    def __init__(self, base_url: str, token: str | None = None, client_id: str | None = None,
                 opener: Callable | None = None, log: Callable[[str], None] = lambda s: None):
        self.base_url = base_url.rstrip("/")
        self.token = token if token is not None else keychain_token()
        self.client_id = client_id if client_id is not None else os.environ.get("PORTAL_SYNC_CLIENT_ID", "").strip()
        if not self.client_id:
            raise RuntimeError("PORTAL_SYNC_CLIENT_IDを設定してください")
        self._opener = opener
        self.log = log

    def post(self, path: str, body: dict, timeout: int = 60) -> dict:
        request = urllib.request.Request(
            self.base_url + path, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST",
            headers={"Content-Type": "application/json", "CF-Access-Client-Id": self.client_id,
                     "CF-Access-Client-Secret": self.token, "User-Agent": "line-openchat-sync/1.0"})
        opener = self._opener or (lambda req, t: urllib.request.urlopen(req, timeout=t, context=ssl.create_default_context(cafile=certifi.where())))
        last: Exception | None = None
        for attempt in range(4):
            try:
                with opener(request, timeout) as response:
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                if exc.code < 500:                    # 4xxは再試行しても直らない
                    raise RuntimeError(f"Portalが拒否しました({exc.code}): {exc.read().decode('utf-8', 'replace')[:300]}") from exc
                last = exc
            except (urllib.error.URLError, TimeoutError) as exc:
                last = exc
            if attempt < 3:
                time.sleep(2 ** attempt)
        raise RuntimeError(f"Portalへの送信に失敗しました: {last}")

    def get(self, path: str, timeout: int = 60) -> dict:
        request = urllib.request.Request(self.base_url + path, method="GET",
                                         headers={"CF-Access-Client-Id": self.client_id, "CF-Access-Client-Secret": self.token,
                                                  "User-Agent": "line-openchat-sync/1.0"})
        opener = self._opener or (lambda req, t: urllib.request.urlopen(req, timeout=t, context=ssl.create_default_context(cafile=certifi.where())))
        with opener(request, timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    # ---------- 1回の同期 ----------
    def start(self, client_run_id: str, client_version: str) -> str:
        return self.post("/api/openchat/sync", {"action": "start", "clientRunId": client_run_id, "clientVersion": client_version})["runId"]

    def send_notes(self, client_run_id: str, notes: list[dict]) -> list[str]:
        """変更のあったノートを送る. 全コメントを送り終えたノートのIDを返す(台帳の pending_upload を下ろす対象)."""
        done: set[str] = set()
        failed: set[str] = set()
        chunks = chunk_notes(notes)
        for chunk in chunks:
            payload = [note_payload(n, cs) for n, cs in chunk]
            try:
                result = self.post("/api/openchat/sync", {"action": "notes", "clientRunId": client_run_id, "notes": payload}, timeout=120)
            except RuntimeError as exc:
                self.log(f"送信失敗: {exc}")
                failed.update(n["id"] for n, _ in chunk)
                continue
            for n, _ in chunk:
                bad = {r.get("id") for r in result.get("results", []) if r.get("error")}
                (failed if n["id"] in bad else done).add(n["id"])
        return [i for i in done if i not in failed]

    def complete(self, client_run_id: str, status: str, stats: dict, warnings: list[str]) -> dict:
        return self.post("/api/openchat/sync", {"action": "complete", "clientRunId": client_run_id, "status": status,
                                                 "stats": stats, "warnings": warnings[:50]})

    def fetch_ledger(self) -> dict:
        return self.get("/api/openchat/ledger?confirm=restore")
