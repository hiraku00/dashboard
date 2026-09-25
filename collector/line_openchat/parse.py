"""OCR結果と画素 → ノート/コメントのブロックへの分解(画面1枚ぶん).

実機の検証(2026-09-24)で得た規則を実装している。寸法・色は layout.py。
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from . import layout as K
from .screen import Line, Screen
from .timeparse import is_time_text

MARK_CUT = "__CUT__"     # 「前のコメントを見る」
MARK_END = "__END__"     # 「コメントを入力」(コメント欄の終わり)
TXT_CUT = "前のコメントを見る"
TXT_END = "コメントを入力"
TXT_MORE = "もっと見る"


@dataclass
class Block:
    kind: str                       # note | comment | cut | end
    author: str = ""
    lines: list[Line] = field(default_factory=list)   # 本文の行
    time_raw: str = ""
    y_top: float = 0.0
    y_time: float = 0.0
    complete: bool = False          # 作者行から時刻行まで、この画面に収まっている
    badge: bool = False
    reactions: int | None = None
    comments: int | None = None
    counts_y: float | None = None
    comment_icon: tuple[float, float] | None = None
    more_y: float | None = None     # 「もっと見る」の行の中心y
    more_x: float | None = None
    link_title: str = ""
    min_conf: float = 1.0
    wrap_right: float = K.WRAP_RIGHT   # 折り返しの判定(ウィンドウ幅によって変わる)
    suspicious: bool = False        # 本文の中に時刻の行のようなものが混ざっている(隣のコメントと混ざって読めた疑い)

    @property
    def text(self) -> str:
        return join_lines(self.lines, self.wrap_right)

    @property
    def is_marker(self) -> bool:
        return self.kind in ("cut", "end")


# ---------- 画素 ----------
def is_bg(p: tuple[int, int, int]) -> bool:
    return sum(abs(a - b) for a, b in zip(p, K.BG)) <= K.BG_TOLERANCE


def has_avatar(screen: Screen, y: float) -> bool:
    """アバター列(x=16〜40)に何か描かれている行か."""
    if not is_bg(screen.pixel(K.AVATAR_LEFT_BG_X, y)) or not is_bg(screen.pixel(K.AVATAR_RIGHT_BG_X, y)):
        return False
    xs = [K.AVATAR_X0 + i for i in range(int(K.AVATAR_X1 - K.AVATAR_X0))]
    filled = sum(0 if is_bg(screen.pixel(x, y)) else 1 for x in xs)
    return filled / len(xs) >= K.AVATAR_MIN_FILL


def avatar_runs(screen: Screen) -> list[tuple[float, float]]:
    """アバター(直径約27ptの丸画像)が写っているyの範囲. 文字行(約15pt)・帯やカード(35pt超)は除く."""
    runs: list[tuple[float, float]] = []
    start: float | None = None
    y = K.TOP_MARGIN
    while y < screen.height:
        on = has_avatar(screen, y)
        if on and start is None:
            start = y
        elif not on and start is not None:
            if K.AVATAR_MIN_H <= y - start <= K.AVATAR_MAX_H:
                runs.append((start, y))
            start = None
        y += 1
    return runs


def is_badge_blue(r: int, g: int, b: int) -> bool:
    return r < 40 and 90 <= g <= 180 and b >= 235


def has_badge(screen: Screen, y0: float, y1: float) -> bool:
    """アバター右下の公式バッジ(青い丸)。アバターの下側45%〜下端+6pt、x=32〜49の範囲だけを見る."""
    hits = 0
    y = int(y0 + (y1 - y0) * 0.45)
    while y <= int(y1) + 6:
        for x in range(int(K.BADGE_X0), int(K.BADGE_X1)):
            if is_badge_blue(*screen.pixel(x, y)):
                hits += 1
        y += 1
    return hits >= K.BADGE_MIN_PIXELS


# ---------- 数の行(リアクション・コメント数) ----------
def column_clusters(screen: Screen, y0: float, y1: float) -> list[tuple[float, float]]:
    """行の中の明るい画素の塊(アイコン・数字)を、左から順に (x0, x1) で返す."""
    cols: list[bool] = []
    x = 0.0
    while x < K.COUNTS_SCAN_X_MAX:
        on = False
        y = y0
        while y < y1:
            r, g, b = screen.pixel(x, y)
            if r + g + b > K.COUNT_BRIGHT_SUM:
                on = True
                break
            y += 1
        cols.append(on)
        x += 0.5
    out: list[tuple[float, float]] = []
    start: float | None = None
    last: float | None = None
    for i, on in enumerate(cols):
        xp = i * 0.5
        if not on:
            continue
        if start is None:
            start = xp
        elif last is not None and xp - last > K.COUNT_CLUSTER_GAP:
            out.append((start, last))
            start = xp
        last = xp
    if start is not None and last is not None:
        out.append((start, last))
    return out


def _first_int(text: str) -> int | None:
    m = re.search(r"\d+", unicodedata.normalize("NFKC", text))
    return int(m.group()) if m else None


_CLOCK = re.compile(r"\d{1,2}\s*[:：]\s*\d{2}")
_AGO = re.compile(r"\d+\s*\S{0,2}\s*前$")


def clock_like(text: str) -> bool:
    """時刻の行に見える短い行か(読み違えた時刻の行も含む). 本文の中に混ざっていたら、隣のコメントと1つに読めた疑い."""
    t = unicodedata.normalize("NFKC", text).strip()
    return 0 < len(t) <= 18 and bool(_CLOCK.search(t) or _AGO.search(t))


def digit_runs(screen: Screen, a: float, e: float, cy: float) -> int:
    """数字の領域 [a, e] にある、文字の塊(縦に連続する明るい列のまとまり)の数 = 桁数."""
    runs, inside = 0, False
    x = a - 1
    while x <= e + 1:
        bright = any(sum(screen.pixel(x, y)) > K.COUNT_BRIGHT_SUM for y in (cy - 6 + i for i in range(13)))
        if bright and not inside:
            runs += 1
        inside = bright
        x += 0.5
    return runs


def read_counts(screen: Screen, cy: float):
    """[😊][数字][💬][数字][共有] の並びを画素で切り分け、数字の塊だけを読む.

    戻り値: (リアクション数, コメント数(数字が読めなければ None), コメントアイコンの(x0,x1)) . アイコンが2つ見つからなければ None.
    共有アイコンは行の一番右端の塊とし、数字の領域から外す(実機で、共有アイコンが13.5ptと細く、
    数字の塊と誤認して「8」を「81」と読んだため。アイコンの幅は15〜17.5ptだが、共有だけ細いことがある)。
    リアクション・コメントのアイコンは幅15〜18.5pt、数字は1桁6.5/2桁13〜14/3桁21.5pt。コメントが0件なら数字の塊が無い。
    """
    clusters = column_clusters(screen, cy - 8, cy + 8)
    if len(clusters) < 4:
        return None
    body = clusters[:-1]                                   # 右端の共有アイコンを除く
    icon_like = [i for i, (a, e) in enumerate(body) if K.ICON_W_MIN <= e - a <= K.ICON_W_MAX]
    if not icon_like or icon_like[0] != 0 or len(icon_like) < 2:
        return None
    first, second = icon_like[0], icon_like[-1]            # リアクション(左端)と、コメント(数字の後ろの最後のアイコン)
    if second == first:
        return None

    def read(g: list[tuple[float, float]]) -> int | None:
        if not g:
            return None
        a, e = g[0][0], g[-1][1]
        runs = digit_runs(screen, a, e, cy)
        if not 1 <= runs <= 4:
            return None
        # 数字の塊の数(1桁なら1つ)と桁数が合う読みだけを採る(実機で、表示が「6」なのに「999」と読んだ)。
        # 1桁だけだとOCRが読まないので同じ画像を並べ、それでも読めなければ、拡大率を変えて読み直し、多数決にする
        votes: list[str] = []
        repeats: set[int] = set()
        for repeat, enlarge in ((3, 5), (5, 5), (5, 8), (5, 12), (3, 8)):
            text = unicodedata.normalize("NFKC", screen.ocr_digits(a - 1, cy - 9, e - a + 3, 18, repeat=repeat, enlarge=enlarge))
            if runs == 1:
                # 同じ画像を並べているので、詰まって「111」「11171」のように読まれることがある。数字は、その中の多数派の1文字
                chars = re.findall(r"\d", text)
                # 詰まった読みが本物か(表示が「6」なのに「999」と読む誤読と区別)は、並べた数と文字数が合うかで見る
                if chars and repeat - 1 <= len(chars) <= repeat + 1:
                    top = max(set(chars), key=chars.count)
                    if chars.count(top) * 10 >= len(chars) * 7:
                        votes.append(top)
                        repeats.add(repeat)
            else:
                votes += [t for t in re.findall(r"\d+", text) if len(t) == runs]
            if len(votes) >= 2 and len(set(votes)) == 1:
                break
        if not votes or (runs == 1 and len(repeats) < 2):
            return None
        best = max(set(votes), key=votes.count)
        return int(best) if votes.count(best) * 2 > len(votes) else None

    reactions = read(body[first + 1:second])
    digits = body[second + 1:]
    # 数字の塊が無ければ0件。塊があるのに読めなかったときは「不明」(None)にする: 0件と取り違えると、コメントが増えても開かなくなる。
    # 実機では、Retinaでない(1倍の)ディスプレイに映すと、1桁の小さな数字をOCRが読めなかった。
    comments = read(digits) if digits else 0
    if digits and comments == 0:
        comments = None            # 0件のときは数字の塊が無い。塊があるのに0と読んだのは誤読(1倍の画面で「8」を「0」と読んだ)
    return reactions, comments, body[second]


# ---------- 文章の組み立て ----------
def join_lines(lines: list[Line], wrap_right: float = K.WRAP_RIGHT) -> str:
    """視覚上の行を文章に戻す. 折り返しはつなぎ、行間が空いたところは空行にする.
    wrap_right: 行の右端がこの位置(pt)以上なら折り返し(ウィンドウ幅が違うと変わるので、呼び出し側で幅から求める)."""
    out = ""
    prev: Line | None = None
    for ln in lines:
        t = ln.text.strip()
        if not t:
            continue
        if prev is None:
            out = t
        elif ln.y - prev.y > K.PARAGRAPH_GAP:
            out += "\n\n" + t
        elif prev.x + prev.w >= wrap_right:
            out += t                       # 前の行が右端まで届いている = 折り返し
        else:
            out += "\n" + t
        prev = ln
    return out


_NAME_NOISE = re.compile(r"^[^\w@]+", re.UNICODE)


def clean_name(text: str) -> str:
    return _NAME_NOISE.sub("", unicodedata.normalize("NFKC", text)).strip()


def merge_fragments(lines: list[Line]) -> list[Line]:
    """OCRが1行を2つに分けて返すことがある(例: 「…AI （SIE）」と「利用もアリだと…」). 同じ高さで近いものを1行に戻す."""
    ordered = sorted(lines, key=lambda l: l.cy)
    groups: list[list[Line]] = []
    for ln in ordered:
        if groups and abs(ln.cy - groups[-1][0].cy) <= 5:
            groups[-1].append(ln)
        else:
            groups.append([ln])
    out: list[Line] = []
    for g in groups:
        g.sort(key=lambda l: l.x)
        cur = g[0]
        for nxt in g[1:]:
            if nxt.x - (cur.x + cur.w) < 30:
                right = max(cur.x + cur.w, nxt.x + nxt.w)
                cur = Line(cur.text + nxt.text, cur.x, min(cur.y, nxt.y), right - cur.x,
                           max(cur.y + cur.h, nxt.y + nxt.h) - min(cur.y, nxt.y), min(cur.conf, nxt.conf))
            else:
                out.append(cur)
                cur = nxt
        out.append(cur)
    return out


def drop_card_garbage(rest: list[Line], counts_cy: float | None) -> list[Line]:
    """リンクカード(左に画像、右に題名)の画像内の文字をOCRが拾うので、カードの高さにある左側の行を捨てる."""
    link = [l for l in rest if l.x >= K.LINK_CARD_X_MIN]
    if not link:
        return rest
    top = min(l.cy for l in link) - 25
    bottom = (counts_cy - 12) if counts_cy is not None else float("inf")
    return [l for l in rest if l.x >= K.LINK_CARD_X_MIN or not (top <= l.cy < bottom) or TXT_MORE in l.text.replace(" ", "")]


# ---------- ブロックへの分割 ----------
def split_blocks(screen: Screen) -> list[Block]:
    all_lines = merge_fragments([ln for ln in screen.lines if ln.y > K.TOP_MARGIN])
    lines: list[Line] = []
    for ln in all_lines:
        flat = ln.text.replace(" ", "").replace(" ", "")
        if TXT_CUT in flat:
            lines.append(Line(MARK_CUT, 0, ln.y, 0, ln.h))
        elif TXT_END in flat:
            lines.append(Line(MARK_END, 0, ln.y, 0, ln.h))
        else:
            lines.append(ln)

    def is_boundary(ln: Line) -> bool:
        return ln.text in (MARK_CUT, MARK_END) or is_time_text(ln.text)

    runs = avatar_runs(screen)
    blocks: list[Block] = []
    prev_idx = -1
    prev_y = K.TOP_MARGIN
    for idx, tl in enumerate(lines):
        if not is_boundary(tl):
            continue
        seg = lines[prev_idx + 1: idx]
        seg_top = prev_y
        prev_idx = idx
        prev_y = tl.y + tl.h
        if tl.text in (MARK_CUT, MARK_END):
            marker = Block(kind="cut" if tl.text == MARK_CUT else "end", y_top=tl.y, y_time=tl.y, complete=True)
            if marker.kind == "end":
                # コメント欄の終わりの直前(最後のコメントの時刻行のすぐ下)には、本来、文字が無い。あれば、最後のコメントの
                # 時刻の行を読み落とし、そのコメントが終端の手前に埋もれた疑い
                stray = [l for l in seg if l.x >= K.NAME_X_MIN and not (l.x > K.SIDE_X_MIN and l.w < K.SIDE_W_MAX) and len(l.text.strip()) >= 3]
                marker.lines = stray
                marker.suspicious = bool(stray)
            blocks.append(marker)
            continue

        kind = "note" if tl.x < K.NOTE_X_MAX else "comment"
        cands = [r for r in runs if seg_top - 2 <= r[0] and r[1] <= tl.y]

        def named(r: tuple[float, float]) -> bool:
            return any(K.NAME_X_MIN < l.x < K.NAME_X_MAX and r[0] - 4 <= l.cy <= r[1] + 4 for l in seg)

        # 名前が作者位置(x=45〜70)に並ぶアバターを優先(検索欄・「大事なノート」帯などは名前が無い)
        run = next((r for r in cands if named(r)), cands[0] if cands else None)
        if run and run[0] <= K.AVATAR_TOP_EDGE:
            run = None   # 画面上端で切れたアバター: 作者名が見えていない可能性

        main = [l for l in seg if not (l.x > K.SIDE_X_MIN and l.w < K.SIDE_W_MAX)]
        if run:
            ry0, ry1 = run
            head = [l for l in main if K.NAME_X_MIN < l.x < K.SIDE_X_MIN and ry0 - 4 <= l.cy <= ry1 + 4]
            author = clean_name(head[0].text) if head else clean_name(screen.ocr_region(44, ry0 - 2, 280, ry1 - ry0 + 4))
            rest = [l for l in main if l.cy > ry1 + 2]
            y_top = ry0
        else:
            author, rest, y_top = "", main, (main[0].y if main else tl.y)
        if not rest and not author:
            continue

        b = Block(kind=kind, author=author or ("?" if run else ""), time_raw=tl.text.strip(),
                  y_top=y_top, y_time=tl.y, complete=run is not None)
        b.badge = has_badge(screen, run[0], run[1]) if run else False

        if kind == "note":
            cy = tl.y - K.COUNTS_ROW_ABOVE_TIME
            counts = read_counts(screen, cy)
            band = (cy - 12, cy + 12) if counts else None
            if counts:
                b.reactions, b.comments, b.comment_icon = counts
                b.counts_y = cy
            rest = drop_card_garbage(rest, cy if counts else None)
            for l in rest:
                t = l.text.strip()
                if band and band[0] <= l.cy <= band[1] and l.x < K.NOTE_X_MAX + 10:
                    continue                                   # 数の行の文字(アイコンの誤読を含む)
                if TXT_MORE in t.replace(" ", "") and l.x < K.LINK_CARD_X_MIN:
                    b.more_y, b.more_x = l.cy, screen.text_center_x(l, TXT_MORE)
                    stripped = t.replace(TXT_MORE, "").strip(" .…・")
                    if stripped:
                        b.lines.append(Line(stripped, l.x, l.y, l.w, l.h, l.conf))
                elif l.x >= K.LINK_CARD_X_MIN:
                    b.link_title = (b.link_title + " " + t).strip()
                else:
                    b.lines.append(l)
        else:
            b.lines = list(rest)
        confs = [l.conf for l in b.lines]
        b.min_conf = min(confs) if confs else 1.0
        b.suspicious = any(clock_like(l.text) for l in b.lines)
        blocks.append(b)
    return blocks
