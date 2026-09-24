"""ノート一覧を上から読み、変わったノートだけを開いて、コメントを集める(差分取得の本体).

画面の操作は Driver(実機は lineui.LineDriver、テストは tests/sim.py)を通す。
Driver への「押す」操作は Session._click だけが行い、必ず safety.guard_click を通る。
"""
from __future__ import annotations

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


def merge_sequence(observed: list, new: list) -> tuple[int, list]:
    """連続する2画面の重なりを見つけ、新しく現れた分だけを返す. (重なった件数, 新しい分).
    同じ人の同じ短文が続く場合も、順序ごと照合するので1件にまとめてしまわない."""
    for j in range(min(len(observed), len(new)), 0, -1):
        if all(identity.same_block(observed[-j + i].as_match_dict(), new[i].as_match_dict()) for i in range(j)):
            return j, new[j:]
    return 0, list(new)


class Session:
    def __init__(self, driver: Driver, ledger: Ledger, now: datetime, opts: Options | None = None,
                 log: Callable[[str], None] = lambda s: None):
        self.d = driver
        self.ledger = ledger
        self.now = now
        self.now_iso = now.astimezone().isoformat(timespec="seconds")
        self.opts = opts or Options()
        self.log = log
        self.stats = RunStats()
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
            self._scan()
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
        """次の画面へ進む. 画面が重ならないほど飛んだら、半分戻して小さい歩幅でやり直す."""
        before = [b for b in blocks if b.kind in ("note", "comment") and b.complete]
        self.scroll(step)
        if not before:
            return step
        for attempt in range(3):
            screen, after = self.shot()
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
        need_body = note["author_is_target"] and not note["body_complete"]
        expected = obs.comments
        need_comments = expected is None or expected != note["comment_count"] or note.get("needs_recheck", False)
        if expected is None:
            self.stats.warnings.append(f"コメント数を読めませんでした: {note['author_name']} {obs.posted_raw}")
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
        screen2, blocks2 = self.shot()
        b2 = self._find_block(blocks2, note)
        if b2 is None or b2.more_y is not None:
            self.stats.warnings.append(f"本文を開けませんでした: {note['author_name']} {note['posted_at_raw']}")
            return True
        obs2 = note_obs(b2, self.now)
        if obs2:
            obs2.body_complete = True
            self.ledger.upsert_note(obs2, self.now_iso)
        return True

    # ---------- コメント欄 ----------
    def _collect_thread(self, note: dict, expected: int | None) -> None:
        last_error = ""
        for attempt in range(2):
            try:
                observed = self._read_thread(note)
            except Aborted:
                raise                                       # ユーザーの操作による中断は、ノートの失敗として握りつぶさない
            except SessionError as exc:
                last_error = str(exc)
                self.stats.warnings.append(f"{note['author_name']} {note['posted_at_raw']}: {exc}")
                note["needs_recheck"] = True
                note["pending_upload"] = True
                return
            if expected is None or len(observed) == expected or attempt == 1:
                break
            self.log(f"件数不一致 {len(observed)}/{expected}: やり直し")
        res = self.ledger.apply_collection(note, observed, expected, self.now_iso)
        self._count(res)
        for w in res.warnings:
            self.stats.warnings.append(f"{note['author_name']} {note['posted_at_raw']}: {w}")

    def _count(self, res: CollectionResult) -> None:
        self.stats.comments_new += res.new_comments
        self.stats.target_comments_new += res.new_target_comments

    def _is_open(self, blocks: list[Block], header: Block) -> bool | None:
        i = blocks.index(header)
        if i + 1 >= len(blocks):
            return None                      # ノートの下が画面の外で、開いているか分からない
        return blocks[i + 1].kind in ("comment", "cut", "end")

    def _read_thread(self, note: dict) -> list[CommentObs]:
        # 1. ノートの見出しを画面に出す
        header, screen, blocks = self._seek_header(note)
        # 2. コメント欄が閉じていれば開く. ノートの下が画面の外なら、少し進めて確かめる
        is_open = self._is_open(blocks, header)
        for _ in range(8):
            if is_open is not None:
                break
            before = self._signature(blocks)
            self.scroll(6)
            screen, blocks = self.shot()
            if self._signature(blocks) == before:
                is_open = False                  # これ以上進めない = 一覧の末尾のノートで、下に何も無い(閉じている)
                break
            header = self._find_block(blocks, note) or header
            is_open = self._is_open(blocks, header) if header in blocks else None
        if is_open is False:
            if not header.comment_icon or header.counts_y is None:
                raise SessionError("コメントアイコンの位置を特定できません")
            x0, x1 = header.comment_icon
            self._click(ClickTarget("toggle_comments", (x0 + x1) / 2, header.counts_y, icon_span=(x0, x1),
                                    counts_y=header.counts_y), screen)
        # 3. 「前のコメントを見る」を押し切って、見出しが見える位置まで戻る
        self._load_earlier(note)
        # 4. 見出しから下へ、コメント欄の終わりまで読む
        return self._read_down(note)

    def _seek_header(self, note: dict):
        for _ in range(120):
            screen, blocks = self.shot()
            h = self._find_block(blocks, note)
            if h is not None:
                return h, screen, blocks
            # 見つからないときは、上下どちらにあるか分からないので、まず上へ、次に下へ探す
            self.scroll(-24 if _ < 60 else 24)   # 1画面(約1100pt)より小さい歩幅で探す
        raise SessionError("ノートの見出しが見つかりません")

    def _load_earlier(self, note: dict) -> None:
        for _ in range(120):
            screen, blocks = self.shot()
            cut = [l for l in screen.lines if TXT_CUT in l.text.replace(" ", "")]
            if cut:
                l = cut[0]
                self._click(ClickTarget("load_earlier_comments", l.x + l.w / 2, l.cy, expect_text=TXT_CUT), screen)
                continue
            h = self._find_block(blocks, note)
            if h is not None:
                return
            self.scroll(-24)
        raise SessionError("ノートの見出しまで戻れません")

    def _read_down(self, note: dict) -> list[CommentObs]:
        observed: list[CommentObs] = []
        inside = False                # 見出しを見つけ、コメント欄の中を読んでいる
        step = 9
        for _ in range(400):
            screen, blocks = self.shot()
            hi = next((i for i, b in enumerate(blocks) if b.kind == "note" and self._same_note(b, note)), None)
            if hi is not None:
                region, inside = blocks[hi + 1:], True       # 見出しより上(前のノートのコメント欄など)は読まない
            elif inside:
                region = blocks
            else:
                self.scroll(step)                             # 見出しがまだ見えない
                continue
            seq: list[CommentObs] = []
            finished = False
            self.log("  read " + " ".join(f"{b.kind[0]}{'' if b.complete else '?'}:{b.author[:4]}:{b.time_raw.replace(' ', '')[:5]}" for b in region))
            for i, b in enumerate(region):
                if b.kind == "cut":
                    raise SessionError("「前のコメントを見る」が残っています")
                if b.kind == "end" or b.kind == "note":
                    if b.kind == "note" and hi is None and i == 0 and not b.complete:
                        continue                              # 画面の上端で切れた、このノート自身
                    finished = True
                    break
                if b.kind == "comment" and b.complete:
                    c = comment_obs(b, self.now)
                    if c is None:
                        self.stats.warnings.append(f"時刻を読めないコメントがあります: {b.time_raw!r}")
                        continue
                    seq.append(c)
            overlap, fresh = merge_sequence(observed, seq)
            self.log(f"  merge observed={len(observed)} new={len(seq)} overlap={overlap} fresh={len(fresh)}")
            if observed and seq and overlap == 0:
                # 画面が重なっていない: 飛ばした可能性. 半分戻して撮り直す
                step = max(3, step // 2)
                self.scroll(-step * 2)
                continue
            for a, c in zip(observed[len(observed) - overlap:], seq[:overlap]):
                if (c.min_conf, len(c.body_text)) > (a.min_conf, len(a.body_text)):
                    a.body_text, a.min_conf = c.body_text, c.min_conf
                a.badge = a.badge or c.badge
            observed.extend(fresh)
            if finished:
                return observed
            self.scroll(step)
        raise SessionError("コメント欄の終わりまで読めませんでした")

    def _same_note(self, b: Block, note: dict) -> bool:
        obs = note_obs(b, self.now)
        return bool(obs and b.complete and identity.note_score(note, obs.as_match_dict()) > 0)


def identity_block_same(a: Block, b: Block) -> bool:
    if a.kind != b.kind:
        return False
    da = {"author_name": a.author, "body_text": a.text, "posted_at": "", "posted_at_precision": "", "posted_at_raw": a.time_raw}
    db = {"author_name": b.author, "body_text": b.text, "posted_at": "", "posted_at_precision": "", "posted_at_raw": b.time_raw}
    return identity.same_block(da, db)
