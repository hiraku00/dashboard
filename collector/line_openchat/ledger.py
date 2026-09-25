"""取得済み台帳(ローカルJSON). 差分判定はこの台帳だけで行い、D1は読まない."""
from __future__ import annotations

import json
import os
import re
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import identity
from .timeparse import better_time

LEDGER_VERSION = 1
TARGET_NAME = "ちきりん"
DEFAULT_ROOM = "atsumare-tv"


def default_path() -> Path:
    return Path(__file__).resolve().parents[1] / "data" / "line_openchat" / "ledger.json"


def first_line(text: str, limit: int = 120) -> str:
    for line in text.splitlines():
        if line.strip():
            return line.strip()[:limit]
    return ""


def extract_url(text: str) -> str:
    m = re.search(r"https?://[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]+", text)   # URLはASCIIのみ(全角の句読点で切る)
    return m.group(0).rstrip(".,);:") if m else ""


@dataclass
class NoteObs:
    """画面から読んだノート1件."""
    author: str
    badge: bool
    body_text: str
    posted_at: str
    posted_precision: str
    posted_raw: str
    comments: int | None = None
    link_title: str = ""
    body_complete: bool = False
    min_conf: float = 1.0

    def as_match_dict(self) -> dict:
        return {"author_name": self.author, "body_text": self.body_text, "posted_at": self.posted_at,
                "posted_at_precision": self.posted_precision, "posted_at_raw": self.posted_raw}


@dataclass
class CommentObs:
    author: str
    badge: bool
    body_text: str
    posted_at: str
    posted_precision: str
    posted_raw: str
    min_conf: float = 1.0

    def as_match_dict(self) -> dict:
        return {"author_name": self.author, "body_text": self.body_text, "posted_at": self.posted_at,
                "posted_at_precision": self.posted_precision, "posted_at_raw": self.posted_raw}


@dataclass
class CollectionResult:
    new_comments: int = 0
    new_target_comments: int = 0
    deleted_comments: int = 0
    count_matched: bool = True
    warnings: list[str] = field(default_factory=list)


def _target(name: str, badge: bool) -> bool:
    """ちきりんか. 公式バッジが決め手(名前だけの一致はなりすましの可能性があるので対象外)."""
    return bool(badge)


def _vote(votes: dict, name: str) -> str:
    votes[name] = votes.get(name, 0) + 1
    return max(votes.items(), key=lambda kv: (kv[1], len(kv[0])))[0]


class Ledger:
    def __init__(self, room: str = DEFAULT_ROOM, notes: list[dict] | None = None, meta: dict | None = None):
        self.room = room
        self.notes: list[dict] = notes or []
        self.meta: dict[str, Any] = meta or {}

    # ---------- 保存 ----------
    @classmethod
    def load(cls, path: Path | None = None) -> "Ledger | None":
        path = path or default_path()
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("version") != LEDGER_VERSION:
            raise RuntimeError(f"台帳のバージョンが違います: {data.get('version')}")
        return cls(data.get("room", DEFAULT_ROOM), data.get("notes", []), data.get("meta", {}))

    def save(self, path: Path | None = None) -> None:
        path = path or default_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({"version": LEDGER_VERSION, "room": self.room, "meta": self.meta, "notes": self.notes},
                             ensure_ascii=False, indent=1)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".ledger-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(payload)
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)          # 書き込み途中で止まっても、既存の台帳を壊さない
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    # ---------- ノート ----------
    def match_note(self, obs: NoteObs) -> dict | None:
        return identity.match_note(self.notes, obs.as_match_dict())

    def upsert_note(self, obs: NoteObs, now_iso: str) -> tuple[dict, bool]:
        """見えたノートを台帳に反映する. 戻り値は (ノートの記録, 新規か)."""
        note = self.match_note(obs)
        if note is None:
            note = {
                "id": str(uuid.uuid4()), "room": self.room, "author_name": obs.author, "author_votes": {obs.author: 1},
                "author_is_target": False, "badge_seen": False,
                "program_title": "", "link_title": "", "link_url": "", "body_text": "", "body_complete": False,
                "posted_at": obs.posted_at, "posted_at_precision": obs.posted_precision, "posted_at_raw": obs.posted_raw,
                "comment_count": 0, "target_comment_count": 0, "needs_recheck": False,
                "first_seen_at": now_iso, "last_checked_at": now_iso, "deleted_at": None,
                "pending_upload": True, "comments": [], "identity_warned": False,
            }
            self.notes.append(note)
            new = True
        else:
            new = False
            note["author_name"] = _vote(note.setdefault("author_votes", {note["author_name"]: 1}), obs.author)
        note["badge_seen"] = bool(note.get("badge_seen")) or obs.badge
        note["author_is_target"] = _target(note["author_name"], note["badge_seen"])
        posted = better_time((note["posted_at"], note["posted_at_precision"]), (obs.posted_at, obs.posted_precision))
        if posted != (note["posted_at"], note["posted_at_precision"]):
            note["posted_at"], note["posted_at_precision"], note["posted_at_raw"] = posted[0], posted[1], obs.posted_raw
            note["pending_upload"] = True
        # 本文: 全文を取れているものを優先。無ければ長い方
        if obs.body_complete or (not note["body_complete"] and len(obs.body_text) > len(note["body_text"])):
            if obs.body_text and obs.body_text != note["body_text"]:
                note["body_text"] = obs.body_text
                note["program_title"] = first_line(obs.body_text)
                note["link_url"] = extract_url(obs.body_text) or note.get("link_url", "")
                note["pending_upload"] = True
            note["body_complete"] = note["body_complete"] or obs.body_complete
        if obs.link_title and not note["link_title"]:
            note["link_title"] = obs.link_title
            note["pending_upload"] = True
        note["last_checked_at"] = now_iso
        return note, new

    def identity_warning(self, note: dict) -> str | None:
        """バッジと名前が食い違うノートの警告(1つのノートにつき1回だけ)。名前だけの一致は対象外にしている。"""
        if note.get("identity_warned"):
            return None
        has_name = TARGET_NAME in note["author_name"]
        if note["author_is_target"] == has_name:
            return None
        note["identity_warned"] = True
        return (f"ノート {note['author_name']} {note['posted_at_raw']}: 公式バッジは{'あり' if note['author_is_target'] else 'なし'}ですが、"
                f"名前は{'「ちきりん」を含みます' if has_name else '「ちきりん」を含みません'}")

    def needs_open(self, note: dict, is_new: bool, obs: NoteObs) -> bool:
        """コメント欄を開いて読む必要があるか."""
        if is_new or note.get("needs_recheck"):
            return True
        if obs.comments is not None and obs.comments != note.get("comment_count", 0):
            return True
        if note["author_is_target"] and not note["body_complete"]:
            return True
        return False

    # ---------- コメント ----------
    def apply_collection(self, note: dict, observed: list[CommentObs], expected: int | None, now_iso: str) -> CollectionResult:
        result = CollectionResult()
        existing: list[dict] = note["comments"]
        claimed: set[int] = set()
        for ordinal, obs in enumerate(observed):
            idx = identity.match_comment(existing, obs.as_match_dict(), claimed, ordinal)
            if idx is None:
                rec = {"id": str(uuid.uuid4()), "ordinal": ordinal, "author_name": obs.author, "author_votes": {obs.author: 1},
                       "is_target": _target(obs.author, obs.badge), "badge_seen": obs.badge, "body_text": obs.body_text,
                       "posted_at": obs.posted_at, "posted_at_precision": obs.posted_precision, "posted_at_raw": obs.posted_raw,
                       "ocr_min_confidence": obs.min_conf, "first_seen_at": now_iso, "last_seen_at": now_iso, "deleted_at": None}
                existing.append(rec)
                claimed.add(len(existing) - 1)
                result.new_comments += 1
                if rec["is_target"]:
                    result.new_target_comments += 1
                continue
            claimed.add(idx)
            rec = existing[idx]
            rec["ordinal"] = ordinal
            rec["last_seen_at"] = now_iso
            rec["deleted_at"] = None
            rec["author_name"] = _vote(rec.setdefault("author_votes", {rec["author_name"]: 1}), obs.author)
            rec["badge_seen"] = bool(rec.get("badge_seen")) or obs.badge
            was_target = rec["is_target"]
            rec["is_target"] = _target(rec["author_name"], rec["badge_seen"])
            if rec["is_target"] and not was_target:
                result.new_target_comments += 1
            posted = better_time((rec["posted_at"], rec["posted_at_precision"]), (obs.posted_at, obs.posted_precision))
            if posted != (rec["posted_at"], rec["posted_at_precision"]):
                rec["posted_at"], rec["posted_at_precision"], rec["posted_at_raw"] = posted[0], posted[1], obs.posted_raw
            # 本文は、OCRの信頼度が高い方(同じなら長い方)を採用
            if (obs.min_conf, len(obs.body_text)) > (rec.get("ocr_min_confidence", 0.0), len(rec["body_text"])):
                rec["body_text"], rec["ocr_min_confidence"] = obs.body_text, obs.min_conf
        for rec in existing:
            has_name = TARGET_NAME in rec["author_name"]
            if rec["id"] and rec["is_target"] != has_name and not rec.get("identity_warned") and not rec.get("deleted_at"):
                rec["identity_warned"] = True
                result.warnings.append(f"コメント {rec['author_name']} {rec.get('posted_at_raw', '')}: 公式バッジは"
                                       f"{'あり' if rec['is_target'] else 'なし'}ですが、名前は{'「ちきりん」を含みます' if has_name else '「ちきりん」を含みません'}")
        active_seen = len(observed)
        result.count_matched = expected is None or active_seen == expected
        if result.count_matched and expected is not None:
            for i, rec in enumerate(existing):
                if i not in claimed and not rec.get("deleted_at"):
                    rec["deleted_at"] = now_iso           # 件数が合ったときだけ、見えなくなったものを削除扱いにする
                    result.deleted_comments += 1
            note["comment_count"] = expected
        elif result.count_matched:
            pass                                    # 表示の件数を読めなかった: 取りこぼしを確かめられないので、削除扱いにも、件数の更新もしない
        else:
            result.warnings.append(f"件数不一致 表示{expected} / 取得{active_seen}")
        note["needs_recheck"] = not result.count_matched
        note["target_comment_count"] = sum(1 for c in existing if c["is_target"] and not c.get("deleted_at"))
        note["last_checked_at"] = now_iso
        note["pending_upload"] = True
        existing.sort(key=lambda c: (bool(c.get("deleted_at")), c.get("ordinal", 0)))
        return result

    # ---------- 送信用 ----------
    def pending_notes(self) -> list[dict]:
        return [n for n in self.notes if n.get("pending_upload")]

    # ---------- Portalからの復元 ----------
    @classmethod
    def from_portal(cls, payload: dict, room: str = DEFAULT_ROOM) -> "Ledger":
        notes: dict[str, dict] = {}
        for n in payload.get("notes", []):
            notes[n["id"]] = {
                "id": n["id"], "room": room, "author_name": n["authorName"], "author_votes": {n["authorName"]: 1},
                "author_is_target": bool(n.get("authorIsTarget")), "badge_seen": bool(n.get("authorIsTarget")),
                "program_title": n.get("programTitle", ""), "link_title": n.get("linkTitle", ""), "link_url": n.get("linkUrl", ""),
                "body_text": n.get("bodyHead", ""), "body_complete": bool(n.get("bodyComplete")),
                "posted_at": n["postedAt"], "posted_at_precision": n["postedAtPrecision"], "posted_at_raw": n.get("postedAtRaw", ""),
                "comment_count": int(n.get("commentCount", 0)), "target_comment_count": 0,
                "needs_recheck": bool(n.get("needsRecheck")), "first_seen_at": n.get("firstSeenAt", ""),
                "last_checked_at": n.get("lastCheckedAt", ""), "deleted_at": n.get("deletedAt"),
                "pending_upload": False, "restored": True, "comments": [],
            }
        for c in payload.get("comments", []):
            note = notes.get(c["noteId"])
            if not note:
                continue
            note["comments"].append({
                "id": c["id"], "ordinal": int(c.get("ordinal", 0)), "author_name": c["authorName"], "author_votes": {c["authorName"]: 1},
                "is_target": bool(c.get("isTarget")), "badge_seen": bool(c.get("isTarget")), "body_text": c.get("bodyHead", ""),
                "posted_at": c["postedAt"], "posted_at_precision": c["postedAtPrecision"], "posted_at_raw": "",
                "ocr_min_confidence": 0.0, "first_seen_at": "", "last_seen_at": "", "deleted_at": c.get("deletedAt"),
            })
        for note in notes.values():
            note["comments"].sort(key=lambda x: (bool(x.get("deleted_at")), x["ordinal"]))
            note["target_comment_count"] = sum(1 for x in note["comments"] if x["is_target"] and not x.get("deleted_at"))
        return cls(room, list(notes.values()), {"restored_from_portal": True})
