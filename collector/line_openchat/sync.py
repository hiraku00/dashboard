"""ちきりんオプチャの同期(手動実行).

  python3 -m line_openchat.sync                # LINEから読み、台帳に反映し、Portalへ送る
  python3 -m line_openchat.sync --dry-run      # Portalへは送らない(台帳とJSONだけ)
  python3 -m line_openchat.sync --first-run    # 一覧の最後まで全件を読み直す

前提と実行中の注意は docs/chikirin-openchat.md。実行中はマウスを使うので、数分間Macを触らないでください。
LINEは参照のみ(safety.py)。マウスやキーボードを操作すると、その場で中断します。
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

from . import VERSION
from .ledger import DEFAULT_ROOM, Ledger, default_path
from .session import Options, RunStats, Session

EXIT_OK, EXIT_ERROR = 0, 1


def data_dir() -> Path:
    return default_path().parent


def prune_old_logs(directory: Path, keep_days: int = 7) -> None:
    cutoff = time.time() - keep_days * 86400
    for f in directory.glob("run-*.log"):
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink()
        except OSError:
            pass


def run_status(stats: RunStats, upload_ok: bool) -> str:
    if stats.aborted:
        return "aborted"
    if not upload_ok:
        return "failed"
    return "partial" if stats.warnings else "success"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="ちきりんオプチャの同期")
    ap.add_argument("portal_url", nargs="?", default=os.environ.get("PORTAL_URL", ""), help="PortalのURL(省略時は環境変数 PORTAL_URL)")
    ap.add_argument("--dry-run", action="store_true", help="Portalへ送らない")
    ap.add_argument("--first-run", action="store_true", help="一覧の最後まで全件を読む")
    ap.add_argument("--scan-days", type=int, default=21)
    ap.add_argument("--max-notes", type=int, default=None)
    ap.add_argument("--ledger", type=Path, default=None)
    ap.add_argument("--room", default=DEFAULT_ROOM)
    args = ap.parse_args(argv)

    # LINEを触る前に、環境を確認する(macOS専用の部品は、ここで初めて読み込む)
    from . import lineui
    try:
        lineui.check_environment()
    except lineui.EnvironmentError_ as exc:
        print(f"実行できません: {exc}", file=sys.stderr)
        return exc.code

    ledger_path = args.ledger or default_path()
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    prune_old_logs(ledger_path.parent)
    lock = open(ledger_path.parent / ".lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("別の同期が実行中です", file=sys.stderr)
        return 6

    logfile = open(ledger_path.parent / f"run-{datetime.now():%Y%m%dT%H%M%S}.log", "a", encoding="utf-8")

    def log(msg: str) -> None:
        line = f"[{time.strftime('%H:%M:%S')}] {msg}"
        print(line, file=sys.stderr, flush=True)
        logfile.write(line + "\n")

    upload = not args.dry_run and bool(args.portal_url)
    uploader = None
    if upload:
        from .uploader import Uploader
        uploader = Uploader(args.portal_url, log=log)

    ledger = Ledger.load(ledger_path)
    first_run = args.first_run
    if ledger is None:
        if uploader is not None:
            try:
                restored = uploader.fetch_ledger()
                ledger = Ledger.from_portal(restored, args.room)
                log(f"Portalから台帳を復元しました: ノート{len(ledger.notes)}件")
            except Exception as exc:                        # noqa: BLE001 復元できなければ新規で始める
                log(f"台帳の復元に失敗(新規で開始): {exc}")
        ledger = ledger or Ledger(args.room)
        first_run = first_run or not ledger.notes
    now = datetime.now().astimezone()

    driver = lineui.LineDriver()
    opts = Options(scan_days=args.scan_days, first_run=first_run, max_notes=args.max_notes, pause=driver.pause,
                   checkpoint=lambda: ledger.save(ledger_path))
    started = time.time()
    session = Session(driver, ledger, now, opts, log=log)
    try:
        stats = session.run()
    finally:
        driver.close()
        ledger.save(ledger_path)

    upload_ok = True
    client_run_id = f"line-openchat-{now.astimezone().strftime('%Y%m%dT%H%M%S%z')}"
    if upload and uploader is not None:
        try:
            uploader.start(client_run_id, VERSION)
            pending = ledger.pending_notes()
            sent = set(uploader.send_notes(client_run_id, pending))
            for n in pending:
                if n["id"] in sent:
                    n["pending_upload"] = False
            upload_ok = len(sent) == len(pending)
            status = run_status(stats, upload_ok)
            uploader.complete(client_run_id, status, {
                "notesScanned": stats.notes_scanned, "notesOpened": stats.notes_opened,
                "commentsNew": stats.comments_new, "targetCommentsNew": stats.target_comments_new}, stats.warnings)
        except Exception as exc:                           # noqa: BLE001 送れなかった分は次回に再送する
            log(f"Portalへの送信に失敗: {exc}")
            upload_ok = False
        ledger.save(ledger_path)
    status = run_status(stats, upload_ok)
    ledger.meta["last_run"] = {"at": now.isoformat(timespec="seconds"), "status": status}
    ledger.save(ledger_path)
    summary = {"status": status, "elapsed_sec": round(time.time() - started), "notes_scanned": stats.notes_scanned,
               "notes_opened": stats.notes_opened, "comments_new": stats.comments_new,
               "target_comments_new": stats.target_comments_new, "shots": stats.shots, "clicks": stats.clicks,
               "reached_end": stats.reached_end, "uploaded": upload, "warnings": stats.warnings[:20]}
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return EXIT_OK if status in ("success", "partial") else EXIT_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
