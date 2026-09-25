"""ノート一覧を上から読み、変わったノートだけを開いて、コメントを集める(差分取得の本体).

画面の操作は Driver(実機は lineui.LineDriver、テストは tests/sim.py)を通す。
Driver への「押す」操作は Session._click だけが行い、必ず safety.guard_click を通る。
"""
from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, Protocol

from . import identity, layout as K
from .ledger import CollectionResult, CommentObs, Ledger, NoteObs
from .parse import Block, TXT_CUT, TXT_MORE, split_blocks
from .safety import ClickTarget, guard_click
from .screen import Screen
from .timeparse import parse_display_time

MAX_CLICKS_PER_RUN = 3000


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
        self._pending: list[tuple[dict, int | None]] = []       # コメント欄を開いたノート(読み取りは走査のあと)
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
        stats = self.stats
        try:
            self.reader.prepare()                 # 撮影の調整(一覧の先頭へ戻る)
            self._scan()
            self._capture_pending()
        except Aborted as exc:
            stats.aborted = True
            stats.warnings.append(f"中断: {exc}")
        return stats

    def _scan(self) -> None:
        o, stats = self.opts, self.stats
        self.to_top()
        visited: set[str] = set()
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
                changed = self._process_note(note, is_new, obs, b, screen)
                self.opts.checkpoint()
                unchanged = 0 if (changed or is_new) else unchanged + 1
                self.log(f"note {note['author_name']} {note['posted_at']} 💬{obs.comments} {'NEW ' if is_new else ''}{'OPEN ' if changed else ''}")
                if changed:
                    opened = True
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
    def _process_note(self, note: dict, is_new: bool, obs: NoteObs, block: Block, screen: Screen) -> bool:
        """開く必要があれば開いて集める. 画面を動かしたら True."""
        expected = obs.comments
        need_comments = expected is None or expected != note["comment_count"] or note.get("needs_recheck", False)
        # ちきりんのノートに加え、コメント欄を読むノートは本文(番組の情報)も全文取る: ちきりんが関わるかは開いてから分かり、
        # 関わるノートは画面に、スレッド主の投稿として本文を出す
        need_body = not note["body_complete"] and (note["author_is_target"] or need_comments)
        if expected is None:
            self.stats.warnings.append(f"コメント数を読めませんでした(1倍のディスプレイでは小さい数字を読めないことがあります。Retinaディスプレイでの実行を推奨): {note['author_name']} {obs.posted_raw}")
        if not need_body and not need_comments:
            return False
        moved = False
        if need_body:
            moved |= self._expand_body(note, block, screen)
        if need_comments:
            if expected == 0:
                res = self.ledger.apply_collection(note, [], 0, self.now_iso)
                self._count(res)
            else:
                self._collect_thread(note, expected)
                moved = True
                self.stats.notes_opened += 1
        return moved

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
            return True
        obs2 = note_obs(b2, self.now)
        if obs2:
            obs2.body_complete = True
            self.ledger.upsert_note(obs2, self.now_iso)
        return True

    # ---------- コメント欄 ----------
    def _collect_thread(self, note: dict, expected: int | None) -> None:
        """コメント欄を開き、「前のコメントを見る」を押し切る. 読み取りは、走査が終わってから全体を1回で行う(_capture_pending)."""
        try:
            self._open_thread(note)
        except Aborted:
            raise                                       # ユーザーの操作による中断は、ノートの失敗として握りつぶさない
        except SessionError as exc:
            self.stats.warnings.append(f"{note['author_name']} {note['posted_at_raw']}: {exc}")
            note["needs_recheck"] = True
            note["pending_upload"] = True
            return
        self._pending.append((note, expected))

    def _capture_pending(self) -> None:
        """開いたコメント欄をまとめて読む: 一覧の先頭から末尾まで、スクロールだけで撮ってつなぎ、1回OCRして区切る(threadread.py)."""
        if not self._pending:
            return
        self.opts.pause()
        groups, warnings = self.reader.read_all()
        for w in warnings:
            self.stats.warnings.append(w)
        for note, expected in self._pending:
            best, best_s = None, 0.0
            for g in groups:
                o = note_obs(g.note, self.now)
                s = identity.note_score(note, o.as_match_dict()) if o else 0.0
                if s > best_s:
                    best, best_s = g, s
            label = self._label(note)
            if best is not None:
                self._adopt_full_body(note, best.note)
            if best is None:
                self.stats.warnings.append(f"{label}: 撮影した画像の中にノートが見つかりませんでした")
                note["needs_recheck"] = True
                note["pending_upload"] = True
                continue
            observed = []
            for b in best.comments:
                c = comment_obs(b, self.now)
                if c is None:
                    self.stats.warnings.append(f"時刻を読めないコメントがあります: {b.time_raw!r}")
                    continue
                observed.append(c)
            shown = best.note.comments
            if shown is not None and shown != expected:
                self.log(f"開いた後の件数に更新: {expected} → {shown}")
                expected = shown                        # 読んでいる間に増減したことがある。開いた後の見出しの件数が最新
            res = self.ledger.apply_collection(note, observed, expected, self.now_iso)
            self._count(res)
            for w in res.warnings:
                self.stats.warnings.append(f"{label}: {w}")
            self.opts.checkpoint()
        handled = {id(n) for n, _ in self._pending}
        self._pending.clear()
        self._apply_unvisited(groups, handled)

    def _apply_unvisited(self, groups: list, handled: set[int]) -> None:
        """走査で完全な形が見えなかったノート(画面の切れ目に掛かるなど)も、撮影した画像には写っている。
        コメント欄が開いていて、表示の件数と読めた件数が合うものは、ここで台帳に反映する(合わなければ、次回の再確認に回す)."""
        for g in groups:
            obs = note_obs(g.note, self.now)
            if obs is None:
                continue
            existing = identity.match_note(self.ledger.notes, obs.as_match_dict())
            if existing is not None and id(existing) in handled:
                continue
            if existing is None and self._reached_old({"posted_at": obs.posted_at}) and not self.opts.first_run:
                continue
            note, is_new = self.ledger.upsert_note(obs, self.now_iso)
            self._adopt_full_body(note, g.note)
            shown = g.note.comments
            observed = [c for c in (comment_obs(b, self.now) for b in g.comments) if c is not None]
            label = self._label(note)
            if shown is not None and shown == len(observed) and (observed or shown == 0):
                res = self.ledger.apply_collection(note, observed, shown, self.now_iso)
                self._count(res)
                self.stats.notes_scanned += 1 if is_new else 0
                self.log(f"note {label} 💬{shown} (撮影から)")
            else:
                note["needs_recheck"] = True
                note["pending_upload"] = True
                self.stats.warnings.append(f"{label}: 走査で見えず、撮影でも件数が合わないため、次回に確認します(表示{shown} / 取得{len(observed)})")
            self.opts.checkpoint()

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

    def _open_thread(self, note: dict) -> None:
        # 1. ノートの見出しを画面に出す
        header, screen, blocks = self._seek_header(note)
        # 2. コメント欄が閉じていれば開く. ノートの下が画面の外なら、少し進めて確かめる
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
        if is_open is False:
            if moved and stale:
                # 押すアイコンの位置は、見出しが完全に見える画面で測り直す(進んだ分を戻す)
                self.scroll(-moved)
                screen, blocks = self.shot()
                fresh = self._find_block(blocks, note)
                if fresh is not None:
                    header = fresh                # 見つからなければ、直前の画面の位置を使う(押す前に、画面で確認される)
            if not header.comment_icon or header.counts_y is None:
                raise SessionError("コメントアイコンの位置を特定できません")
            x0, x1 = header.comment_icon
            self._click(ClickTarget("toggle_comments", (x0 + x1) / 2, header.counts_y, icon_span=(x0, x1),
                                    counts_y=header.counts_y), screen)
        # 3. 「前のコメントを見る」を押し切って、見出しが見える位置まで戻る
        self._load_earlier(note)

    def _hint_y(self, screen: Screen, note: dict) -> float | None:
        """画面のどこかに、このノートの1行目が写っていれば、そのy(見出しが近い手がかり)."""
        head = identity.norm_text(note.get("body_text", ""))[:16]
        if len(head) < 12:
            return None
        for line in screen.lines:
            if line.y > K.TOP_MARGIN and identity.contain_sim(head, line.text) >= 0.85 and len(identity.norm_text(line.text)) >= 6:
                return line.y
        return None

    def _seek_header(self, note: dict):
        """ノートの見出し(作者〜時刻行がすべて見える位置)を画面に出す.
        1行目の文字が画面に写っていれば、その位置から上下どちらへ動くかを決める。写っていなければ、上下に順に探す。"""
        seen_up = seen_down = 0
        for i in range(48):
            screen, blocks = self.shot()
            h = self._find_block(blocks, note)
            if h is not None:
                return h, screen, blocks
            y = self._hint_y(screen, note)
            self.debug("  seek#%d hint_y=%s notes=%s" % (i, y and round(y), [(b.author[:4], b.complete, round(identity.note_score(note, o.as_match_dict()), 2))
                                                              for b in blocks if b.kind == "note" and (o := note_obs(b, self.now))]))
            if y is not None:
                # 見出しは、写っている1行目のすぐ上(作者行)から、時刻行までの高さ。下寄りなら下へ、上寄りなら上へ少し動かす
                self.scroll(8 if y > screen.height * 0.45 else -6)
            elif i < 24:
                self.scroll(-24)          # 手がかりが無い: まず上へ(1画面より小さい歩幅で)
            else:
                self.scroll(24)           # 上に無ければ下へ
        raise SessionError("ノートの見出しが見つかりません")

    def _header_y(self, screen: Screen, blocks: list[Block], note: dict) -> float | None:
        """ノートの見出し(作者行)の上端y. 時刻行まで見えていればそのブロックから、本文が画面より長く時刻行が見えないときは、
        本文の1行目の位置から求める(長いノートは、見出しと時刻行が同時に画面に入らない)."""
        h = self._find_block(blocks, note)
        if h is not None:
            return h.y_top
        y = self._hint_y(screen, note)
        return None if y is None else y - 42.0

    def _load_earlier(self, note: dict) -> None:
        for _ in range(120):
            screen, blocks = self.shot()
            cut = [l for l in screen.lines if TXT_CUT in l.text.replace(" ", "")]
            if cut:
                l = cut[0]
                self._click(ClickTarget("load_earlier_comments", l.x + l.w / 2, l.cy, expect_text=TXT_CUT), screen)
                continue
            if self._header_y(screen, blocks, note) is not None:
                return
            self.scroll(-24)
        raise SessionError("ノートの見出しまで戻れません")

    def _same_note(self, b: Block, note: dict) -> bool:
        obs = note_obs(b, self.now)
        return bool(obs and b.complete and identity.note_score(note, obs.as_match_dict()) > 0)


def identity_block_same(a: Block, b: Block) -> bool:
    if a.kind != b.kind:
        return False
    da = {"author_name": a.author, "body_text": a.text, "posted_at": "", "posted_at_precision": "", "posted_at_raw": a.time_raw}
    db = {"author_name": b.author, "body_text": b.text, "posted_at": "", "posted_at_precision": "", "posted_at_raw": b.time_raw}
    return identity.same_block(da, db)
