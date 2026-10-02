"""ノート一覧を上から読み、変わったノートだけを開いて、コメントを集める(差分取得の本体).

画面の操作は Driver(実機は lineui.LineDriver、テストは tests/sim.py)を通す。
Driver への「押す」操作は Session._click だけが行い、必ず safety.guard_click を通る。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Protocol

from . import digits, identity, layout as K
from .ledger import CollectionResult, CommentObs, Ledger, NoteObs
from .parse import Block, TXT_CUT, TXT_MORE, split_blocks
from .safety import ClickTarget, guard_click
from .screen import Screen
from .timeparse import EXACT, parse_display_time, tolerance_minutes

MAX_CLICKS_PER_RUN = 3000
SNAPSHOT_KEEP = 30          # 新しいノートを見つけた画面を、直近これだけ残す
SEEK_LOG_EVERY = 8          # 見出しを探す処理が長引いたとき、これ回数ごとに進捗をログへ出す
SEEK_STUCK_LIMIT = 16       # 「手がかりはあるのに見出しが確認できない」がこれだけ連続したら、迷走とみなして早めに諦める
THREAD_ROOM_BELOW_FOOTER = 120  # ノートの時刻行の下に、この高さ(pt)以上が見えていれば、直下の「前のコメントを見る」の有無を判断できる
HINT_TIME_TOLERANCE_MIN = 240   # 手がかりの近くの投稿時刻が、このノートの投稿時刻とこれ(分)を超えてズレていたら、
                                 # 本文が似ているだけの別の投稿とみなし、手がかりとして使わない


class Driver(Protocol):
    def shot(self) -> Screen: ...
    def scroll(self, lines: int) -> None: ...
    def click_at(self, x: float, y: float) -> None:
        """ウィンドウ内の(x, y)を左クリックする. 呼べるのは Session._click だけ."""

    def thread_reader(self): ...     # 開いたコメント欄を、末尾まで撮って読む(threadread.ThreadReader)


class SessionError(RuntimeError):
    pass


class Aborted(SessionError):
    """ユーザーが操作した、などで途中で止めた."""


@dataclass
class Options:
    scan_days: int = 21                 # これより古いノートが続いたら止める(初回は全件)
    stop_after_unchanged: int = 5       # 上記に加えて、変化のないノートがこの件数続いたら止める
    first_run: bool = False
    max_notes: int | None = None
    max_scroll_steps: int = 4000
    start_step: int = 12                # 1回のスクロール(行)
    pause: Callable[[], None] = lambda: None     # 実機では、ユーザーの操作を検知して Aborted を投げる
    checkpoint: Callable[[], None] = lambda: None  # ノート1件を処理するたびに呼ぶ(台帳の保存)
    settle: float = 0.0                 # クリック後の待ち(秒)
    snapshot_dir: Path | None = None    # 新しいノートを見つけた画面の画像と読み取り結果を残す場所(幽霊ノートの原因調査用。None なら残さない)
    full_expand: bool = False           # True なら「前のコメントを見る」を常に押し切る(段階3の早期打ち切りをしない。切り戻し用)


@dataclass
class RunStats:
    notes_scanned: int = 0
    notes_opened: int = 0
    comments_new: int = 0
    target_comments_new: int = 0
    shots: int = 0
    clicks: int = 0
    warnings: list[str] = field(default_factory=list)
    reached_end: bool = False
    stopped_early: bool = False
    aborted: bool = False


# ---------- 画面のブロック → 観測 ----------
def note_obs(b: Block, now: datetime) -> NoteObs | None:
    t = parse_display_time(b.time_raw, now)
    if t is None:
        return None
    return NoteObs(author=b.author, badge=b.badge, body_text=b.text, posted_at=t.utc, posted_precision=t.precision,
                   posted_raw=t.raw, comments=b.comments, link_title=b.link_title, body_complete=b.more_y is None,
                   min_conf=b.min_conf)


def comment_obs(b: Block, now: datetime) -> CommentObs | None:
    t = parse_display_time(b.time_raw, now)
    if t is None:
        return None
    return CommentObs(author=b.author, badge=b.badge, body_text=b.text, posted_at=t.utc, posted_precision=t.precision,
                      posted_raw=t.raw, min_conf=b.min_conf)


class Session:
    def __init__(self, driver: Driver, ledger: Ledger, now: datetime, opts: Options | None = None,
                 log: Callable[[str], None] = lambda s: None, reader=None):
        self.d = driver
        self.reader = reader or driver.thread_reader()
        self.ledger = ledger
        self.now = now
        self.now_iso = now.astimezone().isoformat(timespec="seconds")
        self.opts = opts or Options()
        self.log = log
        # 画面1枚ごとの細かいログは、調べるとき(LINE_OPENCHAT_DEBUG=1)だけ出す
        self.debug = log if os.environ.get("LINE_OPENCHAT_DEBUG") else (lambda s: None)
        self.stats = RunStats()
        self._visited: set[str] = set()                         # 走査で件数を見て、開くかを判断したノートのID
        self._lost_position = False                             # 見出しを探して大きく動いた末に諦め、スクロール位置が分からなくなった
        self._left_open: dict | None = None                     # 開いた(開いているのを見つけた)まま、まだ閉じていないノート
        self._carry: tuple[Screen, list[Block]] | None = None   # _advance が撮った画面を、次の shot() で再利用する

    # ---------- 画面 ----------
    def shot(self) -> tuple[Screen, list[Block]]:
        if self._carry is not None:
            carried, self._carry = self._carry, None
            return carried
        self.opts.pause()
        screen = self.d.shot()
        self.stats.shots += 1
        return screen, split_blocks(screen)

    def scroll(self, lines: int) -> None:
        self._carry = None
        self.opts.pause()
        self.d.scroll(lines)

    def _click(self, target: ClickTarget, screen: Screen) -> None:
        """LINEに対する唯一の「押す」操作. 許可された場所だけを、画面で確認してから押す."""
        if self.stats.clicks >= MAX_CLICKS_PER_RUN:
            raise SessionError("クリック回数の上限に達しました")
        guard_click(target, screen)
        self.d.click_at(target.x, target.y)
        self.stats.clicks += 1
        if self.opts.settle:
            time.sleep(self.opts.settle)

    def to_top(self) -> None:
        prev = None
        for _ in range(60):
            self.scroll(-60)
            screen, _ = self.shot()
            sig = [(round(l.y), l.text) for l in screen.lines[:8]]
            if sig == prev:
                return
            prev = sig
        self.stats.warnings.append("一覧の先頭に到達したか確認できませんでした")

    # ---------- ノート一覧 ----------
    def run(self) -> RunStats:
        """一覧を上から走査し、変わったノートはその場で読んで閉じる(docs/openchat-per-note-capture-design.md).
        変わったノートごとに: 開く → 「前のコメントを見る」を必要な分だけ押す → そのコメント欄だけを撮影・OCRして台帳へ
        反映 → コメントアイコンを押して閉じる。毎回閉じて終わるので、次の実行もコメント欄が閉じた状態から始まる。"""
        stats = self.stats
        digits.reset_stats()
        try:
            self.log("一覧を走査します(変わったノートは、その場で読み取って閉じます)")
            self.reader.prepare()                 # 撮影の調整(倍率などを測る。一覧の先頭へ戻る)
            self._scan()
        except Aborted as exc:
            stats.aborted = True
            stats.warnings.append(f"中断: {exc}")
        self._log_digits()
        return stats

    def _log_digits(self) -> None:
        """件数の数字を、どの方法で読んだか(見本との照合 / OCR / 読めない)。移行期間は、見本とOCRの食い違いも出す."""
        st = digits.STATS
        if not st:
            return
        self.log(f"件数の読み取り: 見本 {st['template']}回・OCR {st['ocr']}回・読めない {st['unknown']}回"
                 + (f" / 行の位置がずれていて読み直した {st['recentered']}回" if st["recentered"] else "")
                 + (f" / 見本とOCRの食い違い {st['mismatch']}回: {', '.join(f'{k} ×{n}' for k, n in Counter(digits.MISMATCHES).items())}" if st["mismatch"] else ""))

    def _scan(self) -> None:
        o, stats = self.opts, self.stats
        self.to_top()
        visited = self._visited
        unchanged = 0
        step = o.start_step
        prev_sig: list | None = None
        end_hits = 0
        for _ in range(o.max_scroll_steps):
            screen, blocks = self.shot()
            opened = False
            for b in blocks:
                if b.kind != "note" or not b.complete:
                    continue
                obs = note_obs(b, self.now)
                if obs is None:
                    stats.warnings.append(f"時刻を読めないノートがあります: {b.time_raw!r}")
                    continue
                note, is_new = self.ledger.upsert_note(obs, self.now_iso)
                if note["id"] in visited:
                    continue
                warning = self.ledger.identity_warning(note)
                if warning:
                    stats.warnings.append(warning)
                visited.add(note["id"])
                stats.notes_scanned += 1
                if is_new:
                    self._save_snapshot(note, screen, blocks)
                needs_work = (is_new or note.get("needs_recheck", False) or not note["body_complete"]
                             or (obs.comments is not None and obs.comments != note["comment_count"]))
                if needs_work:
                    # 本文を開く・コメント欄を探すのに時間がかかることがある(長いノートでは見出しの探索が
                    # 何十回もスクロールを繰り返すこともある)。終わるまで何も出ないと止まって見えるので、先に出す
                    self.log(f"  {note['author_name']} {note['posted_at_raw']} を確認しています…")
                changed = self._process_note(note, is_new, obs, b, screen, blocks)
                self.opts.checkpoint()
                unchanged = 0 if (changed or is_new) else unchanged + 1
                self.log(f"note {note['author_name']} {note['posted_at']} 💬{obs.comments} {'NEW ' if is_new else ''}{'OPEN ' if changed else ''}")
                if changed:
                    opened = True
                    if self._lost_position:
                        # 見出しを探して上下へ大きく動いた末に諦めた。そのまま続けると、途中のノート(この下にある未確認のもの)を
                        # 飛ばして、ずっと下から読み始めてしまう(実機で、先頭のノートの失敗後に、7件下の「のの」から再開した)。
                        # 先頭へ戻る。確認済み(visited)のノートは読み飛ばすので、未確認のノートから再開する
                        self._lost_position = False
                        self.log("    位置が分からなくなったので、一覧の先頭へ戻って続けます")
                        self.to_top()
                    break                       # 画面が変わったので撮り直す
                if o.max_notes and stats.notes_scanned >= o.max_notes:
                    stats.stopped_early = True
                    return
                if self._reached_old(note) and unchanged >= o.stop_after_unchanged and not o.first_run:
                    stats.stopped_early = True
                    return
            if opened:
                prev_sig = None
                continue
            # 下へ進む
            sig = self._signature(blocks)
            if sig == prev_sig:
                end_hits += 1
                if end_hits >= 2:
                    stats.reached_end = True
                    return
            else:
                end_hits = 0
            prev_sig = sig
            step = self._advance(blocks, step)
        stats.warnings.append("スクロール回数の上限に達しました")

    def _save_snapshot(self, note: dict, screen: Screen, blocks: list[Block]) -> None:
        """新しいノートを見つけた画面を、画像と読み取り結果(ブロック・OCRの行)で残す. 本当に新しい投稿か、隣り合う投稿が
        つながってできた幽霊かを、あとから見分けるため(直近 SNAPSHOT_KEEP 件だけ残す)。残せなくても実行は続ける。"""
        d = self.opts.snapshot_dir
        src = getattr(screen, "path", None)
        if d is None or not src:
            return
        try:
            d.mkdir(parents=True, exist_ok=True)
            stem = f"{datetime.now().strftime('%Y%m%dT%H%M%S')}-{note['id'][:4]}"
            shutil.copyfile(src, d / f"{stem}.png")
            info = {"note": {k: note.get(k) for k in ("id", "author_name", "posted_at", "posted_at_raw", "comment_count")},
                    "blocks": [{"kind": b.kind, "complete": b.complete, "author": b.author, "time_raw": b.time_raw, "comments": b.comments,
                                "y_top": b.y_top, "y_time": b.y_time, "suspicious": b.suspicious, "body": b.text[:120]} for b in blocks],
                    "lines": [{"text": ln.text, "x": ln.x, "y": ln.y, "w": ln.w, "h": ln.h} for ln in screen.lines]}
            (d / f"{stem}.json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")
            for old in sorted(d.glob("*.png"))[:-SNAPSHOT_KEEP]:
                old.unlink(missing_ok=True)
                old.with_suffix(".json").unlink(missing_ok=True)
        except OSError:
            pass

    def _reached_old(self, note: dict) -> bool:
        from datetime import timedelta, timezone
        cutoff = self.now.astimezone(timezone.utc) - timedelta(days=self.opts.scan_days)
        return datetime.strptime(note["posted_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) < cutoff

    @staticmethod
    def _signature(blocks: list[Block]) -> list:
        return [(b.kind, b.author, round(b.y_top / 6), b.time_raw) for b in blocks]

    def _advance(self, blocks: list[Block], step: int) -> int:
        """次の画面へ進む. 画面が重ならないほど飛んだら、半分戻して小さい歩幅でやり直す.
        重なりは、実機では画素で測る(threadread.motion)。文字で見ると、コメントの多い所(ブロックが小さい)で見失う。"""
        before = [b for b in blocks if b.kind in ("note", "comment") and b.complete]
        f0 = self.reader.frame()
        self.scroll(step)
        if f0 is None and not before:
            return step
        for attempt in range(3):
            screen, after = self.shot()
            if f0 is not None:
                m = self.reader.motion(f0, self.reader.frame())
                if m in ("ok", "unchanged"):
                    self._carry = (screen, after)
                    return min(30, step + 3) if m == "ok" and attempt == 0 else step
            else:
                after_c = [b for b in after if b.kind in ("note", "comment")]
                if any(identity_block_same(a, c) for a in before for c in after_c):
                    overlap = sum(1 for a in before if any(identity_block_same(a, c) for c in after_c))
                    self._carry = (screen, after)
                    return min(30, step + 3) if overlap >= 3 else step
            smaller = max(3, step // 2)
            self.scroll(-(step - smaller))   # 半分の歩幅になる位置まで戻す
            step = smaller
        self.stats.warnings.append("画面が重ならないまま進みました(取りこぼしの可能性)")
        return step

    # ---------- 1件のノート ----------
    def _process_note(self, note: dict, is_new: bool, obs: NoteObs, block: Block, screen: Screen,
                      blocks: list[Block] | None = None) -> bool:
        """開く必要があれば開いて、その場で読んで閉じる. 画面を動かしたら True.
        変わっていないのにコメント欄が開いていたら(前回の実行が途中で止まった等)、読まずに閉じる。"""
        expected = obs.comments
        need_comments = expected is None or expected != note["comment_count"] or note.get("needs_recheck", False)
        # 全スレッドを画面に出すので、本文(番組の情報)は全スレッドで全文取る(1スレッドにつき「もっと見る」を1回押すだけ)
        need_body = not note["body_complete"]
        if expected is None:
            digits.label_last_unreadable(f"{note['author_name']} {obs.posted_raw}")
            self.stats.warnings.append(f"コメント数を読めませんでした(1倍のディスプレイでは小さい数字を読めないことがあります。Retinaディスプレイでの実行を推奨): {note['author_name']} {obs.posted_raw}")
        if not need_body and not need_comments:
            if blocks is not None and block in blocks and self._is_open(blocks, block):
                self.stats.warnings.append(f"{self._label(note)}: 開いたまま残っていたコメント欄を閉じました"
                                           "(前回の実行が途中で止まった可能性があります)")
                self._close_quietly(note)
                return True
            return False
        moved = False
        if need_body:
            moved |= self._expand_body(note, block, screen)
        if need_comments:
            if expected == 0:
                res = self.ledger.apply_collection(note, [], 0, self.now_iso)
                self._count(res)
            else:
                self._collect_thread(note, expected, self._full_expand_required(note, is_new, expected))
                moved = True
                self.stats.notes_opened += 1
        return moved

    def _full_expand_required(self, note: dict, is_new: bool, expected: int | None) -> bool:
        """「前のコメントを見る」を、読み込み済みの所で止めず、最後まで押し切る必要があるか.
        既読の判定(_already_read)を信用できない・安全に省けない状況では、必ず全部読む.

        既読の判定は、内容が一致する(a)か、前回実際に読んだ時刻より前(b)かのどちらかで成立する。
        (a)は comments_checked_at が無くても、既存コメントさえあれば試せる。comments_checked_at の
        有無だけで全部読むと決めると、段階3の導入後に一度も開いていないだけのノート(内容は台帳に
        既にある)まで、無駄に全部読み直してしまう(実機で、パエリアがこれで不要に全部押していた)。"""
        if self.opts.full_expand or self.opts.first_run or is_new or note.get("needs_recheck", False):
            return True
        if expected is None or expected < note["comment_count"]:
            return True                                    # 件数が読めない・減っている(削除の可能性)は、全部読んで確かめる
        if not any(not c.get("deleted_at") for c in note["comments"]):
            return True                                    # 比べる基準(既存コメント)が無い
        return False

    def _find_block(self, blocks: list[Block], note: dict, kind: str = "note") -> Block | None:
        best, best_s = None, 0.0
        for b in blocks:
            if b.kind != kind or not b.complete:
                continue
            obs = note_obs(b, self.now)
            if obs is None:
                continue
            s = identity.note_score(note, obs.as_match_dict())
            if s > best_s:
                best, best_s = b, s
        return best

    def _expand_body(self, note: dict, block: Block, screen: Screen) -> bool:
        if block.more_y is None:
            note["body_complete"] = True
            note["pending_upload"] = True
            return False
        self._click(ClickTarget("expand_body", block.more_x or 24, block.more_y, expect_text=TXT_MORE), screen)
        b2 = None
        for _ in range(8):
            screen2, blocks2 = self.shot()
            b2 = self._find_block(blocks2, note)
            if b2 is not None:
                break
            # 本文が縦に長くなり、末尾(時刻行)が画面の下にはみ出した(実機で確認)。投稿の末尾が見えるまで少しずつ下へ進む
            self.scroll(8)
        if b2 is None or b2.more_y is not None:
            self.stats.warnings.append(f"本文を開けませんでした: {self._label(note)}")
            self._lost_position = True
            return True
        obs2 = note_obs(b2, self.now)
        if obs2:
            obs2.body_complete = True
            self.ledger.upsert_note(obs2, self.now_iso)
        return True

    # ---------- コメント欄 ----------
    def _collect_thread(self, note: dict, expected: int | None, full_expand: bool) -> None:
        """コメント欄を開き、「前のコメントを見る」を必要な分だけ押し、その場で撮影・OCRして台帳へ反映し、閉じる.
        途中で失敗したら、そのノートは needs_recheck にして実行は続ける。開いていたら、失敗しても閉じてから次へ進む。"""
        self._left_open = None
        try:
            partial = self._open_thread(note, full_expand)
            self._read_thread(note, expected, partial)
        except Aborted:
            raise                                       # ユーザーの操作による中断は、ノートの失敗として握りつぶさない
        except SessionError as exc:
            self.stats.warnings.append(f"{note['author_name']} {note['posted_at_raw']}: {exc}")
            note["needs_recheck"] = True
            note["pending_upload"] = True
            self._lost_position = True
        if self._left_open is note:
            self._close_quietly(note)

    def _close_quietly(self, note: dict) -> None:
        """閉じる. 閉じられなくても実行は続ける(警告に残す。次の実行で、開いたまま残っていたものとして閉じる)."""
        try:
            self._close_thread(note)
            self.log("    コメント欄を閉じました")
        except Aborted:
            raise
        except SessionError as exc:
            self.stats.warnings.append(f"{self._label(note)}: コメント欄を閉じられませんでした({exc})")

    def _read_thread(self, note: dict, expected: int | None, partial: bool) -> None:
        """このノートのコメント欄だけを、見出しから終わりまで撮影・OCRし、台帳へ反映する(1回まで撮り直す)."""
        for attempt in range(2):
            header, screen, blocks = self._seek_header(note)
            band_top = float(getattr(self.reader, "band_top_pt", 0.0))
            for _ in range(4):                          # 見出しが撮影の帯(固定見出しの下)に入っていること
                if header.y_top >= band_top + 2:
                    break
                self.scroll(-3)
                header, screen, blocks = self._seek_header(note)
            self.log("    コメント欄を撮影して読み取ります")
            groups, warnings = self.reader.read_thread(header.y_top, log=self.log)
            info = getattr(self.reader, "last_info", None)
            if info:
                self._log_capture(info)
            best = self._match_group(note, groups)
            if best is not None and (best.comments or not (expected or 0)):
                for w in warnings:
                    self.stats.warnings.append(w)
                self._apply_group(note, expected, partial, best)
                return
            if attempt == 0:
                self.log("    撮影した画像に、このノートのコメント欄が写っていませんでした。撮り直します")
        raise SessionError("撮影した画像に、このノートのコメント欄が写っていませんでした")

    def _apply_group(self, note: dict, expected: int | None, partial: bool, best) -> None:
        """撮影して区切ったこのノートの塊を、台帳へ反映する(件数の照合は ledger.apply_collection)."""
        label = self._label(note)
        self._adopt_full_body(note, best.note)
        observed = []
        for b in best.comments:
            c = comment_obs(b, self.now)
            if c is None:
                self.stats.warnings.append(f"時刻を読めないコメントがあります: {b.time_raw!r}")
                continue
            observed.append(c)
        shown = best.note.comments
        if shown is not None and shown != expected:
            self.log(f"    開いた後の件数に更新: {expected} → {shown}")
            expected = shown                            # 読んでいる間に増減したことがある。開いた後の見出しの件数が最新
        # 走査時の記録(partial)を正とする。撮影(best.truncated)と食い違えば、安全側(削除を検知しない側)に倒す
        if partial and not best.truncated:
            partial = False                              # さらに読み込まれていた(良い方向): 全部として扱う
        elif not partial and best.truncated:
            self.stats.warnings.append(f"{label}: 撮影に「前のコメントを見る」が残っていました(取りこぼしの可能性)")
            partial = True
        res = self.ledger.apply_collection(note, observed, expected, self.now_iso, partial=partial)
        self._count(res)
        for w in res.warnings:
            self.stats.warnings.append(f"{label}: {w}")
        self.opts.checkpoint()

    def _match_group(self, note: dict, groups: list):
        """撮影した画像から区切ったノートの塊のうち、このノートに当たるもの(無ければ None)."""
        best, best_s = None, 0.0
        for g in groups:
            o = note_obs(g.note, self.now)
            sc = identity.note_score(note, o.as_match_dict()) if o else 0.0
            if sc > best_s:
                best, best_s = g, sc
        return best

    def _log_capture(self, info: dict) -> None:
        """1件ぶんの撮影の記録(枚数・各段の秒数)."""
        self.log(f"    撮影 {info['frames']}枚・{info['scan_sec']:.0f}秒 / OCR {info['ocr_sec']:.0f}秒 / 区切り {info['parse_sec']:.0f}秒")

    def _adopt_full_body(self, note: dict, block: Block) -> None:
        """撮影した画像で本文が最後まで読めている(「もっと見る」が残っていない)なら、その本文を採る.
        走査の途中で「本文を開けませんでした」と警告したノートも、ここで全文が取れていれば、その警告は取り下げる。"""
        if block.more_y is not None:
            return
        obs = note_obs(block, self.now)
        if obs is None:
            return
        stale = f"本文を開けませんでした: {self._label(note)}"      # 上書きで番組名が変わる前の名前で探す
        self.ledger.upsert_note(obs, self.now_iso)
        self.stats.warnings[:] = [w for w in self.stats.warnings if w != stale]

    @staticmethod
    def _label(note: dict) -> str:
        """警告に出す、どのノートか分かる名前: 投稿者・LINEの時刻表示・番組名(1行目)。"""
        title = (note.get("program_title") or "").strip()
        return f"{note['author_name']} {note['posted_at_raw']}" + (f"「{title[:24]}」" if title else "")

    def _count(self, res: CollectionResult) -> None:
        self.stats.comments_new += res.new_comments
        self.stats.target_comments_new += res.new_target_comments

    def _is_open(self, blocks: list[Block], header: Block) -> bool | None:
        i = blocks.index(header)
        if i + 1 >= len(blocks):
            return None                      # ノートの下が画面の外で、開いているか分からない
        return blocks[i + 1].kind in ("comment", "cut", "end")

    def _locate_thread(self, note: dict) -> tuple[Block, Screen, bool]:
        """見出しを画面に出し、コメント欄が開いているかを確かめる. 戻り値: (見出し, 画面, 開いているか).
        見出しは、コメントアイコンを押せる状態(完全に見える)で返す。"""
        header, screen, blocks = self._seek_header(note)
        is_open = self._is_open(blocks, header)
        moved = 0
        stale = False                            # 最後に見つけた見出しが、画面の上に出て不完全(押す位置を測り直す必要がある)
        for _ in range(8):
            if is_open is not None:
                break
            before = self._signature(blocks)
            self.scroll(6)
            moved += 6
            screen, blocks = self.shot()
            if self._signature(blocks) == before:
                is_open = False                  # これ以上進めない = 一覧の末尾のノートで、下に何も無い(閉じている)
                break
            found = self._find_block(blocks, note)
            if found is None:
                # 長いノートは、スクロールで見出し(アバター)が画面の上に出ると「不完全なブロック」になる。時刻の表示が同じ、不完全なノートで探し直す
                key = re.sub(r"\s", "", header.time_raw)
                found = next((b for b in blocks if b.kind == "note" and re.sub(r"\s", "", b.time_raw) == key), None)
            if found is not None:
                stale = not found.complete
                if found.complete:
                    header = found                    # 画面ごとに別のオブジェクトになるので、見つけ直す
                is_open = self._is_open(blocks, found)
            else:
                is_open = None
        if is_open is None:
            raise SessionError("コメント欄が開いているか判定できません")
        if moved and stale:
            # 押すアイコンの位置は、見出しが完全に見える画面で測り直す(進んだ分を戻す)
            self.scroll(-moved)
            screen, blocks = self.shot()
            fresh = self._find_block(blocks, note)
            if fresh is not None:
                header = fresh                    # 見つからなければ、直前の画面の位置を使う(押す前に、画面で確認される)
        return header, screen, is_open

    def _press_comment_icon(self, header: Block, screen: Screen) -> None:
        """コメントアイコン(開く・閉じるの切り替え)を押す."""
        if not header.comment_icon or header.counts_y is None:
            raise SessionError("コメントアイコンの位置を特定できません")
        x0, x1 = header.comment_icon
        self._click(ClickTarget("toggle_comments", (x0 + x1) / 2, header.counts_y, icon_span=(x0, x1),
                                counts_y=header.counts_y), screen)

    def _open_thread(self, note: dict, full_expand: bool) -> bool:
        """コメント欄を開き(閉じていれば)、「前のコメントを見る」を扱う. 戻り値は _load_earlier の結果
        (一部だけ読んで止めたら True). 前提は「閉じた状態から始まる」。開いていたら警告に残す。"""
        header, screen, is_open = self._locate_thread(note)
        if is_open:
            self.stats.warnings.append(f"{self._label(note)}: コメント欄が開いたまま残っていました"
                                       "(前回の実行が途中で止まった可能性があります。読み取って閉じます)")
        else:
            self._press_comment_icon(header, screen)
        self._left_open = note                   # ここから先で失敗しても、閉じてから次へ進む
        return self._load_earlier(note, full_expand)

    def _close_thread(self, note: dict) -> None:
        """コメント欄を閉じ、閉じたことを画面で確かめる."""
        for _ in range(3):
            header, screen, is_open = self._locate_thread(note)
            if not is_open:
                if self._left_open is note:
                    self._left_open = None
                return
            self._press_comment_icon(header, screen)
        raise SessionError("コメントアイコンを押しても閉じません")

    def _hint_y(self, screen: Screen, blocks: list[Block], note: dict) -> float | None:
        """画面のどこかに、このノートの1行目が写っていれば、そのy(見出しが近い手がかり).
        本文が似ているだけの別の投稿(誤読で作られた重複ノートなど)に惑わされないよう、手がかりの近くに
        時刻を読めるブロックがあれば、その投稿時刻がこのノートの投稿時刻と大きくズレていないか確かめる
        (実機で、本文がほぼ同じで投稿時刻だけ大きく違う重複ノートに向けて、延々と迷走したことがあった)。"""
        # URLの行は手がかりにしない(NHKのリンクは頭の16文字が同じで、他の投稿にも当てはまる。続きはOCRのたびに変わる)
        text = "\n".join(ln for ln in note.get("body_text", "").splitlines() if not re.match(r"\s*https?://", ln))
        head = identity.norm_text(text)[:16]
        if len(head) < 12:
            return None
        for line in screen.lines:
            if line.y > K.TOP_MARGIN and identity.contain_sim(head, line.text) >= 0.85 and len(identity.norm_text(line.text)) >= 6:
                if self._hint_time_mismatch(line.y, blocks, note):
                    continue
                return line.y
        return None

    def _hint_time_mismatch(self, y: float, blocks: list[Block], note: dict) -> bool:
        """y の近く(前後60pt)に、投稿時刻を読めるブロックがあり、そのどれもがこのノートの投稿時刻と
        HINT_TIME_TOLERANCE_MIN(分)を超えてズレているなら True(手がかりとして使わない)。
        近くに時刻を読めるブロックが無ければ判断できないので False(手がかりとして使う)."""
        near = [b for b in blocks if abs(b.y_time - y) <= 60 and b.time_raw]
        found_readable = False
        for b in near:
            t = parse_display_time(b.time_raw, self.now)
            if t is None:
                continue
            found_readable = True
            if identity.minutes_between(note["posted_at"], t.utc) <= HINT_TIME_TOLERANCE_MIN:
                return False
        return found_readable

    def _seek_header(self, note: dict):
        """ノートの見出し(作者〜時刻行がすべて見える位置)を画面に出す.
        1行目の文字が画面に写っていれば、その位置から上下どちらへ動くかを決める。写っていなければ、上下に順に探す。
        手がかりはあるのに見出しが確認できない状態が続いたら、迷走とみなして早めに諦める(SEEK_STUCK_LIMIT)。"""
        seen_up = seen_down = 0
        hint_without_match = 0
        for i in range(48):
            screen, blocks = self.shot()
            h = self._find_block(blocks, note)
            if h is not None:
                return h, screen, blocks
            if i and i % SEEK_LOG_EVERY == 0:
                self.log(f"    見出しを探しています({i}回目。コメントの多い長いノートでは時間がかかることがあります)")
            y = self._hint_y(screen, blocks, note)
            self.debug("  seek#%d hint_y=%s notes=%s" % (i, y and round(y), [(b.author[:4], b.complete, round(identity.note_score(note, o.as_match_dict()), 2))
                                                              for b in blocks if b.kind == "note" and (o := note_obs(b, self.now))]))
            if y is not None:
                hint_without_match += 1
                if hint_without_match >= SEEK_STUCK_LIMIT:
                    raise SessionError("見出しが見つかりません(本文が似た別の投稿に惑わされている可能性があります)")
                # 見出しは、写っている1行目のすぐ上(作者行)から、時刻行までの高さ。下寄りなら下へ、上寄りなら上へ少し動かす
                self.scroll(8 if y > screen.height * 0.45 else -6)
            elif i < 24:
                hint_without_match = 0
                self.scroll(-24)          # 手がかりが無い: まず上へ(1画面より小さい歩幅で)
            else:
                hint_without_match = 0
                self.scroll(24)           # 上に無ければ下へ
        raise SessionError("ノートの見出しが見つかりません")

    def _header_y(self, screen: Screen, blocks: list[Block], note: dict) -> float | None:
        """ノートの見出し(作者行)の上端y. 時刻行まで見えていればそのブロックから、本文が画面より長く時刻行が見えないときは、
        本文の1行目の位置から求める(長いノートは、見出しと時刻行が同時に画面に入らない)."""
        h = self._find_block(blocks, note)
        if h is not None:
            return h.y_top
        y = self._hint_y(screen, blocks, note)
        return None if y is None else y - 42.0

    def _is_own_block(self, b: Block, note: dict) -> bool:
        """このブロックが、処理中のノート自身の見出し(時刻行だけが見えている不完全なものを含む)か."""
        if b.kind != "note":
            return False
        obs = note_obs(b, self.now)
        if obs is None:
            return False
        if b.complete and identity.note_score(note, obs.as_match_dict()) > 0:
            return True
        # 見出し(アバター)が画面の上に出て不完全になったものは、時刻の表示か、時刻そのものが同じかで判定する
        if re.sub(r"\s", "", b.time_raw) == re.sub(r"\s", "", note.get("posted_at_raw", "")):
            return True
        tol = tolerance_minutes(obs.posted_precision, note.get("posted_at_precision", EXACT))
        return identity.minutes_between(note["posted_at"], obs.posted_at) <= tol

    def _thread_region(self, screen: Screen, blocks: list[Block], note: dict) -> tuple[Block | None, Block | None, float, float]:
        """画面のうち、このノートのコメント欄にあたる縦の範囲を返す: (自分の見出しのブロック, その直下のブロック, 上端y, 下端y).
        コメント欄は、自分の時刻行の下から、次のノートの見出しの手前まで。別のノートのコメント欄にある
        「前のコメントを見る」「コメントを入力」を、このノートのものと取り違えないために使う
        (取り違えると、別ノートの位置で「既読」と判定して終わり、その間にあるノートを走査が飛ばしてしまう。
        実機で発生: 2026-09-29、さとの処理のあと てんぷら・Conny・のの が走査されなかった)。
        自分の見出しが画面に無いとき(見出しが上に出ている)は、画面の上端からを自分のコメント欄とみなす。"""
        own_idx = next((i for i, b in enumerate(blocks) if self._is_own_block(b, note)), None)
        own = blocks[own_idx] if own_idx is not None else None
        after = blocks[own_idx + 1] if own_idx is not None and own_idx + 1 < len(blocks) else None
        top = own.y_time if own is not None else float(K.TOP_MARGIN)
        bottom = float(screen.height)
        for b in (blocks[own_idx + 1:] if own_idx is not None else blocks):
            if b.kind == "note" and not self._is_own_block(b, note):
                bottom = b.y_top
                break
        return own, after, top, bottom

    def _load_earlier(self, note: dict, full_expand: bool) -> bool:
        """「前のコメントを見る」を扱う.

        full_expand=True: 今までどおり、無くなるまで押し切る。
        full_expand=False: ボタンのすぐ下のコメント(読み込まれている中で一番古いもの)が既読と分かったら、
        それ以上は押さずに終える(LINEは新しいコメントを下に表示し、押すたびに古い方へ足すので、
        一番古い表示中のものが既読なら、それより上もすべて既読)。

        戻り値: 一部だけ読んで止めたら True(_read_thread が ledger.apply_collection の partial に渡す)。
        全部押し切った・元から閉じていた(ボタンが無かった)場合は False。

        「前のコメントを見る」は、コメント欄の一番上(見出しの時刻行のすぐ下)にある。
        - 自分の見出しの時刻行が見えているとき: その直下のブロックで決まる。ボタンなら押す/止める、
          コメントなら、ボタンは無い(全部読み込み済み)。
        - 見出しは見えるが時刻行が画面の下にはみ出すとき(長い本文・大きなリンクカード): 少しずつ下へ進んで、時刻行を出す。
        - 見出しも見えないとき(開いた直後に、LINEが最新のコメントまでジャンプした): 上へ戻って、ボタンか見出しを探す。
        どの場合も、「前のコメントを見る」「コメントを入力」は、このノート自身のコメント欄の範囲のものだけを見る
        (_thread_region)。別のノートのものを取り違えて画面が遠くへ飛ぶと、その間のノートを走査が飛ばしてしまう。
        """
        active = [c for c in note["comments"] if not c.get("deleted_at")]
        prev_frame: tuple | None = None
        same = 0                    # 画面が変わらなかった回数(押しても・スクロールしても動かない = スクロールの端、または押せていない)
        visits: Counter = Counter()  # 同じ画面に来た回数(上下に往復して終わらないのを止める)
        for i in range(120):
            screen, blocks = self.shot()
            frame = tuple((round(l.y / 6), l.text) for l in screen.lines)
            same = same + 1 if frame == prev_frame else 0
            prev_frame = frame
            visits[frame] += 1
            if same >= 3 or visits[frame] >= 5:
                raise SessionError("コメント欄の「前のコメントを見る」を確かめられません(画面が動かない、または同じ画面を行き来しています)")
            own, after, top, bottom = self._thread_region(screen, blocks, note)
            cut = [l for l in screen.lines if TXT_CUT in l.text.replace(" ", "") and top <= l.y < bottom]
            if cut:
                if not full_expand:
                    oldest = self._oldest_loaded_comment(blocks, top, bottom)
                    if oldest is None:
                        self.scroll(6)                         # ボタンのすぐ下のコメントの時刻行が、まだ画面に入っていない
                        continue
                    if self._already_read(oldest, active, note):
                        return True                            # 一番古い表示中のコメントが既読: これ以上は押さなくてよい
                l = cut[0]
                self._click(ClickTarget("load_earlier_comments", l.x + l.w / 2, l.cy, expect_text=TXT_CUT), screen)
                continue
            # このノートのコメント欄には、画面に見える範囲で「前のコメントを見る」が無い
            if own is not None:
                # 「前のコメントを見る」は、時刻行のすぐ下にある。その下に十分な余白が見えているのに無ければ、ボタンは無い
                # (直下のブロックがコメント/入力欄/次のノートでも、時刻行が読めずブロックにならなくても、同じ)。
                # 時刻行が画面の一番下に寄っていて、直下がまだ見えないときだけ、少し下へ進んで確かめる
                if after is not None or screen.height - own.y_time >= THREAD_ROOM_BELOW_FOOTER:
                    return False
                self.scroll(12)
                continue
            if i and i % SEEK_LOG_EVERY == 0:
                self.log(f"    コメント欄の「前のコメントを見る」を探しています({i}回目。コメントの多いノートでは時間がかかることがあります)")
            if self._header_y(screen, blocks, note) is not None:
                self.scroll(20)                               # 見出しは見えるが、時刻行が画面の下にはみ出している: 下へ
            else:
                self.scroll(-24)                              # 見出しも見えない(コメント欄の途中〜末尾): 上へ戻る
        raise SessionError("ノートの見出しまで戻れません")

    @staticmethod
    def _oldest_loaded_comment(blocks: list[Block], top: float = 0.0, bottom: float = float("inf")) -> Block | None:
        """「前のコメントを見る」の直後にある(=読み込まれている中で一番古い)コメント. 画面に見えていなければ None.
        top〜bottom は、このノートのコメント欄の範囲(別のノートの「前のコメントを見る」を取り違えないため)。"""
        idx = next((i for i, b in enumerate(blocks) if b.kind == "cut" and top <= b.y_top < bottom), None)
        if idx is None:
            return None
        nxt = next((b for b in blocks[idx + 1:] if b.kind == "comment" and b.y_top < bottom), None)
        return nxt if nxt is not None and nxt.complete else None

    def _already_read(self, block: Block, active: list[dict], note: dict) -> bool:
        """このコメントを前回までに読んでいるか.
        (a) 台帳の既存コメント(削除扱いでないもの)と内容が一致する。
        (b) 投稿時刻が、比べる基準の時刻より前(精度に応じた余裕つき)。基準は、このノートのコメント欄を
        前回実際に読んだ時刻(comments_checked_at)。それがまだ無ければ(このノートは今回が初めての
        判定)、前回の同期そのものの開始時刻(ledger.meta["last_run"]["at"]。Portalの「最後の取得」と同じ値)
        で代用する。前回の同期が最後まで終わっていれば、このノートを個別に開いていなくても、それより前の
        コメントは存在していたはずだからである。ただし前回が中断(aborted)していた場合は、途中までしか
        確かめていないので使わない。
        note["last_checked_at"](一覧の走査で見るたびに更新される、このノート自身の値)は、この判定より
        前に今回の実行時刻へ上書きされてしまうため使えない(前回の同期の値である ledger.meta とは別物)。
        どちらか(a/b)を満たせば既読とみなす。読めない・分からないときは False(安全側 = 押す方)."""
        obs = comment_obs(block, self.now)
        if obs is None:
            return False
        if identity.match_comment(active, obs.as_match_dict(), set(), 0) is not None:
            return True
        last = note.get("comments_checked_at")
        if not last:
            last_run = self.ledger.meta.get("last_run") or {}
            if last_run.get("status") != "aborted":
                last = last_run.get("at")
        if not last:
            return False
        try:
            checked = datetime.fromisoformat(last).astimezone(timezone.utc)
            posted = datetime.strptime(obs.posted_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            return False
        margin = tolerance_minutes(obs.posted_precision, EXACT)
        return posted <= checked + timedelta(minutes=margin)

    def _same_note(self, b: Block, note: dict) -> bool:
        obs = note_obs(b, self.now)
        return bool(obs and b.complete and identity.note_score(note, obs.as_match_dict()) > 0)


def identity_block_same(a: Block, b: Block) -> bool:
    if a.kind != b.kind:
        return False
    da = {"author_name": a.author, "body_text": a.text, "posted_at": "", "posted_at_precision": "", "posted_at_raw": a.time_raw}
    db = {"author_name": b.author, "body_text": b.text, "posted_at": "", "posted_at_precision": "", "posted_at_raw": b.time_raw}
    return identity.same_block(da, db)
