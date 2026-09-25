"""同期1回ぶんの実行(コマンド sync.py から呼ぶ).

macOS専用の部品(lineui)は、実際に動かすときだけ読み込む。テストでは driver_factory に
LINEの画面を模擬したドライバを渡せる。
"""
from __future__ import annotations

import fcntl
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import VERSION
from .ledger import DEFAULT_ROOM, Ledger, default_path
from .session import Options, RunStats, Session

LOG_KEEP_DAYS = 7

ERROR_TEXT = {
    "interrupted": "実行中にマウスかキーボードが操作されたため、中断しました。もう一度実行すると、続きから始まります。",
    "upload_failed": "読み取りはできましたが、Portalへの送信に失敗しました。次回の実行で再送します。",
}


class RunnerError(RuntimeError):
    """実行できなかった理由(画面に出すコードと文)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class SyncConfig:
    portal_url: str = ""
    dry_run: bool = False
    first_run: bool = False
    scan_days: int = 21
    max_notes: int | None = None
    ledger_path: Path | None = None
    room: str = DEFAULT_ROOM


@dataclass
class RunOutcome:
    status: str                      # success | partial | failed | aborted
    stats: RunStats
    elapsed_sec: int
    uploaded: bool
    error_code: str = ""             # aborted/failed のときの理由(interrupted, upload_failed ...)
    summary: dict = field(default_factory=dict)


def run_status(stats: RunStats, upload_ok: bool) -> str:
    if stats.aborted:
        return "aborted"
    if not upload_ok:
        return "failed"
    return "partial" if stats.warnings else "success"


def prune_old_logs(directory: Path, keep_days: int = LOG_KEEP_DAYS) -> None:
    cutoff = time.time() - keep_days * 86400
    for f in directory.glob("run-*.log"):
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink()
        except OSError:
            pass


def acquire_lock(directory: Path):
    """同時に2つ実行しない(コマンドとエージェントの両方が同じロックを使う)."""
    directory.mkdir(parents=True, exist_ok=True)
    handle = open(directory / ".lock", "w")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        raise RunnerError("already_running", "別の同期が実行中です")
    return handle


def run_sync(cfg: SyncConfig, *, log: Callable[[str], None] = lambda s: None,
             driver_factory: Callable | None = None, uploader_factory: Callable | None = None,
             now: datetime | None = None, out_log_dir: Path | None = None) -> RunOutcome:
    ledger_path = cfg.ledger_path or default_path()
    directory = ledger_path.parent
    lock = acquire_lock(directory)
    try:
        prune_old_logs(directory)
        logfile = open(directory / f"run-{datetime.now():%Y%m%dT%H%M%S}.log", "a", encoding="utf-8")

        def note(msg: str) -> None:
            line = f"[{time.strftime('%H:%M:%S')}] {msg}"
            log(line)
            logfile.write(line + "\n")
            logfile.flush()

        upload = not cfg.dry_run and bool(cfg.portal_url)
        uploader = None
        if upload:
            if uploader_factory is None:
                from .uploader import Uploader
                uploader_factory = lambda url, lg: Uploader(url, log=lg)      # noqa: E731
            uploader = uploader_factory(cfg.portal_url, note)

        ledger = Ledger.load(ledger_path)
        first_run = cfg.first_run
        if ledger is None:
            if uploader is not None:
                try:
                    ledger = Ledger.from_portal(uploader.fetch_ledger(), cfg.room)
                    note(f"Portalから台帳を復元しました: ノート{len(ledger.notes)}件")
                except Exception as exc:                        # noqa: BLE001 復元できなければ、下で扱う(黙って新規開始しない)
                    note(f"台帳の復元に失敗: {exc}")
            if ledger is None:
                # ローカル台帳も無く、Portalからの復元もできない(またはそもそも試せない)。ここで黙って
                # 空の台帳から始めると、Portalに既にある内容をすべて新しいIDで送ってしまい、重複を作る
                # (実際に起きた事故: 2026-09-25、認証設定の誤りで復元が失敗し、既存15ノートが重複した)。
                # 本当に初回なら --first-run で明示してもらう。
                if not first_run:
                    raise RunnerError(
                        "ledger_missing",
                        "ローカル台帳が無く、Portalからの復元もできませんでした。このまま新規スキャンすると、"
                        "Portalに既にある内容と重複するおそれがあるため中断します。\n"
                        "  - 復元が失敗した場合は、PORTAL_URL・PORTAL_SYNC_CLIENT_ID・Keychainの設定を確認してください。\n"
                        "  - 本当に初めての実行であれば、--first-run を付けて実行してください。",
                    )
                ledger = Ledger(cfg.room)
            first_run = first_run or not ledger.notes
        when = now or datetime.now().astimezone()

        if driver_factory is None:
            from . import lineui
            driver_factory = lineui.LineDriver
        driver = driver_factory()

        def pause() -> None:
            if hasattr(driver, "pause"):
                driver.pause()

        opts = Options(scan_days=cfg.scan_days, first_run=first_run, max_notes=cfg.max_notes, pause=pause,
                       checkpoint=lambda: ledger.save(ledger_path))
        started = time.time()
        started_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")     # 読み取りを始めた時刻(送信が遅れても、取得の時刻として残す)
        session = Session(driver, ledger, when, opts, log=note)
        try:
            stats = session.run()
        finally:
            if hasattr(driver, "close"):
                driver.close()
            ledger.save(ledger_path)

        upload_ok = True
        if uploader is not None:
            client_run_id = f"line-openchat-{when.strftime('%Y%m%dT%H%M%S%z')}"
            try:
                uploader.start(client_run_id, VERSION, started_at=started_iso)
                pending = ledger.pending_notes()
                sent = set(uploader.send_notes(client_run_id, pending))
                for n in pending:
                    if n["id"] in sent:
                        n["pending_upload"] = False
                upload_ok = len(sent) == len(pending)
                uploader.complete(client_run_id, run_status(stats, upload_ok), {
                    "notesScanned": stats.notes_scanned, "notesOpened": stats.notes_opened,
                    "commentsNew": stats.comments_new, "targetCommentsNew": stats.target_comments_new}, stats.warnings)
            except Exception as exc:                            # noqa: BLE001 送れなかった分は次回に再送する
                note(f"Portalへの送信に失敗: {exc}")
                upload_ok = False
            ledger.save(ledger_path)

        status = run_status(stats, upload_ok)
        ledger.meta["last_run"] = {"at": when.isoformat(timespec="seconds"), "status": status}
        ledger.save(ledger_path)
        error_code = ""
        if stats.aborted:
            error_code = "interrupted"
        elif not upload_ok:
            error_code = "upload_failed"
        elapsed = round(time.time() - started)
        summary = {"status": status, "elapsed_sec": elapsed, "notes_scanned": stats.notes_scanned,
                   "notes_opened": stats.notes_opened, "comments_new": stats.comments_new,
                   "target_comments_new": stats.target_comments_new, "shots": stats.shots, "clicks": stats.clicks,
                   "reached_end": stats.reached_end, "uploaded": upload, "warnings": stats.warnings[:20]}
        return RunOutcome(status, stats, elapsed, upload, error_code, summary)
    finally:
        lock.close()
