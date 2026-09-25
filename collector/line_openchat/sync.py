"""ちきりんオプチャの同期(手動実行).

  python3 -m line_openchat.sync                # LINEから読み、台帳に反映し、Portalへ送る
  python3 -m line_openchat.sync --dry-run      # Portalへは送らない(台帳とJSONだけ)
  python3 -m line_openchat.sync --first-run    # 一覧の最後まで全件を読み直す

前提と実行中の注意は docs/chikirin-openchat.md。実行中はマウスを使うので、数分間Macを触らないでください。
LINEは参照のみ(safety.py)。マウスやキーボードを操作すると、その場で中断します。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .ledger import DEFAULT_ROOM
from .runner import RunnerError, SyncConfig, run_status, run_sync   # run_status は tests が使う

EXIT_OK, EXIT_ERROR = 0, 1
__all__ = ["main", "run_status"]


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

    where = "Portalへは送りません(--dry-run)" if args.dry_run else ("Portalへ送ります" if args.portal_url else "Portalへは送りません(PORTAL_URLが未設定)")
    print("\n同期を始めます。LINEの画面を読み取るため、終わるまでMacのマウスとキーボードに触らないでください(触ると中断します)。\n"
          f"  対象: {'一覧の最後まで全件' if args.first_run else '新しいノートと、コメントが増えたノート'}"
          f"{f'(最大{args.max_notes}件)' if args.max_notes else ''} / {where}\n", file=sys.stderr, flush=True)
    cfg = SyncConfig(portal_url=args.portal_url, dry_run=args.dry_run, first_run=args.first_run, scan_days=args.scan_days,
                     max_notes=args.max_notes, ledger_path=args.ledger, room=args.room)
    try:
        outcome = run_sync(cfg, log=lambda line: print(line, file=sys.stderr, flush=True))
    except lineui.EnvironmentError_ as exc:
        print(f"\n実行できません: {exc}", file=sys.stderr)
        return exc.code
    except RunnerError as exc:
        print(f"{exc.message}", file=sys.stderr)
        return 6 if exc.code == "already_running" else EXIT_ERROR
    s = outcome.summary
    labels = {"success": "完了", "partial": "完了(警告あり)", "aborted": "中断", "failed": "失敗"}
    print(f"\n== {labels.get(outcome.status, outcome.status)} == {s['elapsed_sec']}秒 / ノート{s['notes_scanned']}件を確認、{s['notes_opened']}件のコメント欄を開いた / "
          f"新しいコメント{s['comments_new']}件(うち対象の人{s['target_comments_new']}件)", file=sys.stderr)
    if outcome.error_code:
        from .runner import ERROR_TEXT
        print(f"   理由: {ERROR_TEXT.get(outcome.error_code, outcome.error_code)}", file=sys.stderr)
    for w in s["warnings"][:10]:
        print(f"   警告: {w}", file=sys.stderr)
    print(json.dumps(outcome.summary, ensure_ascii=False, indent=2))
    return EXIT_OK if outcome.status in ("success", "partial") else EXIT_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
