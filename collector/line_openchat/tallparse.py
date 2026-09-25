"""縦長の1枚画像(スクロール撮影をつないだもの)のOCR結果を、ノート/コメントに区切る.

1画面ずつ読む parse.py と同じ規則(時刻の行で区切る、アバターで作者、青いバッジでちきりん、数の行は画素で読む)を、
縦長画像の座標で適用する。画像は途中で切れないので、「切れた投稿」「画面の重なり」の扱いが要らない。
"""
from __future__ import annotations

import re
import unicodedata
from typing import Callable

import numpy as np

from . import layout as K
from .parse import (TXT_CUT, TXT_END, TXT_MORE, Block, clean_name, drop_card_garbage, is_badge_blue, merge_fragments, read_counts)
from .screen import Line
from .tallocr import TallImage
from .timeparse import is_time_text

BG = np.array(K.BG, dtype=np.int16)
DigitsReader = Callable[..., str]   # (画素, 全体での x, y, w, h(pt), 並べる数) -> 文字列
NameReader = Callable[[np.ndarray, float, float, float, float], str]
LineReader = Callable[..., list]    # (画素, x, y, w, h(pt), enlarge=, langs=, correction=) -> [(文字, x, y, w, h)]


class TallView:
    """縦長画像の一部を、parse.py の関数が使える Screen として見せる(座標は、切り出した範囲の左上が原点)."""

    def __init__(self, image: TallImage, y0_pt: float, y1_pt: float, scale: float, win_w_pt: float,
                 digits_reader: DigitsReader | None, name_reader: NameReader | None):
        self.scale, self.width, self.y0 = scale, win_w_pt, y0_pt
        self.height = y1_pt - y0_pt
        self.lines: list[Line] = []
        self._arr = image.crop(int(max(0, y0_pt) * scale), int(y1_pt * scale))
        self._digits, self._names = digits_reader, name_reader

    def pixel(self, x: float, y: float) -> tuple[int, int, int]:
        yy, xx = int(y * self.scale), int(x * self.scale)
        if 0 <= yy < self._arr.shape[0] and 0 <= xx < self._arr.shape[1]:
            r, g, b = self._arr[yy, xx]
            return int(r), int(g), int(b)
        return (0, 0, 0)

    def _sub(self, x, y, w, h) -> np.ndarray:
        s = self.scale
        return self._arr[max(0, int(y * s)):int((y + h) * s), max(0, int(x * s)):int((x + w) * s)]

    def ocr_region(self, x: float, y: float, w: float, h: float) -> str:
        return self._names(self._sub(x, y, w, h), x, self.y0 + y, w, h) if self._names else ""

    def ocr_digits(self, x: float, y: float, w: float, h: float, repeat: int = 1, enlarge: int = 5) -> str:
        return self._digits(self._sub(x, y, w, h), x, self.y0 + y, w, h, repeat, enlarge) if self._digits else ""

    def text_center_x(self, line: Line, needle: str) -> float:
        idx = line.text.find(needle)
        return line.x + line.w / 2 if idx < 0 else line.x + line.w * (idx + len(needle) / 2) / max(1, len(line.text))


# ---------------- アバター(全体) ----------------
def avatar_runs_tall(image: TallImage, scale: float, chunk_pt: int = 2000) -> list[tuple[float, float]]:
    """アバター(直径約27ptの丸画像)が写っている y の範囲(pt). 文字行(約15pt)・帯やカード(35pt超)は除く. numpyで一括."""
    xs = np.arange(int(K.AVATAR_X0 * scale), int(K.AVATAR_X1 * scale))
    xl, xr = int(K.AVATAR_LEFT_BG_X * scale), int(K.AVATAR_RIGHT_BG_X * scale)
    bg = BG
    on_all: list[np.ndarray] = []
    step = int(chunk_pt * scale)
    for y0 in range(0, image.height, step):
        arr = image.crop(y0, y0 + step).astype(np.int16)
        nonbg = np.abs(arr[:, xs] - bg).sum(axis=2) > K.BG_TOLERANCE
        left_bg = np.abs(arr[:, xl] - bg).sum(axis=1) <= K.BG_TOLERANCE
        right_px = arr[:, xr]
        right_bg = np.abs(right_px - bg).sum(axis=1) <= K.BG_TOLERANCE
        # 公式バッジ(青い王冠の丸)は、アバターの右下から右へ張り出す。Retinaでは右外側の列に掛かるので、青ならアバターの一部とみなす
        right_bg |= (right_px[:, 2] >= 200) & (right_px[:, 0] <= 80) & (right_px[:, 1] >= 80) & (right_px[:, 1] <= 200)
        on_all.append(left_bg & right_bg & (nonbg.mean(axis=1) >= K.AVATAR_MIN_FILL))
    on = np.concatenate(on_all) if on_all else np.zeros(0, dtype=bool)
    # バッジの縁(青と背景の境の1〜数行)で途切れた所をつなぐ(途切れると、アバターの高さが22pt未満になって見落とす)
    gap = max(1, int(2 * scale))
    idx = np.flatnonzero(on)
    if len(idx) > 1:
        jumps = np.flatnonzero((idx[1:] - idx[:-1] > 1) & (idx[1:] - idx[:-1] <= gap + 1))
        for j in jumps:
            on[idx[j]:idx[j + 1]] = True
    runs: list[tuple[float, float]] = []
    i, n = 0, len(on)
    while i < n:
        if on[i]:
            j = i
            while j < n and on[j]:
                j += 1
            h_pt = (j - i) / scale
            if K.AVATAR_MIN_H <= h_pt <= K.AVATAR_MAX_H:
                runs.append((i / scale, j / scale))
            i = j
        else:
            i += 1
    return runs


def _badge(image: TallImage, y0_pt: float, y1_pt: float, scale: float) -> bool:
    ya, yb = y0_pt + (y1_pt - y0_pt) * 0.45, y1_pt + 6
    arr = image.crop(int(ya * scale), int(yb * scale))[:, int(K.BADGE_X0 * scale):int(K.BADGE_X1 * scale)].astype(np.int16)
    if arr.size == 0:
        return False
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    hits = int(((r < 40) & (g >= 90) & (g <= 180) & (b >= 235)).sum())
    return hits / (scale * scale) >= K.BADGE_MIN_PIXELS


# ---------------- 時刻の行の読み直し ----------------
TIME_BAND_ABOVE = 30.0       # アバターの上端から、この範囲の中に、前の投稿の時刻の行がある
_RETRIES = ((3, ("ja-JP", "en-US")), (5, ("ja-JP", "en-US")), (2, ("ja-JP", "en-US")), (4, ("en-US",)), (6, ("ja-JP",)))


def recover_time_rows(image: TallImage, lines: list[Line], runs: list[tuple[float, float]], scale: float,
                      win_w_pt: float, line_reader: LineReader) -> tuple[list[Line], int]:
    """各投稿の直前(アバターの上)に、時刻の行があるはずなのに読めていない所を、拡大率を変えて読み直す.

    時刻の行は投稿の区切りなので、読み違える(例: '2時間前' → '2 時尚町')か読み落とすと、隣のコメントと1つに混ざる。
    1倍のディスプレイで実際に起きた。見つかった行は元の行と置き換える。戻り値: (行, 復元した数)."""
    out = list(lines)
    fixed = 0
    for ry0, _ in runs:
        band = (ry0 - TIME_BAND_ABOVE, ry0 - 1)
        inside = [l for l in out if band[0] <= l.y + l.h / 2 <= band[1] and l.x < win_w_pt * 0.6]
        if any(is_time_text(l.text) for l in inside):
            continue                                   # 時刻が読めている
        if any(TXT_CUT in l.text.replace(" ", "") or TXT_END in l.text.replace(" ", "") for l in inside):
            continue
        if any(len(l.text.strip()) > 14 for l in inside):
            continue                                   # 本文の行(時刻の行は短い)
        y0 = band[0]
        arr = image.crop(int(y0 * scale), int(band[1] * scale))[:, : int(win_w_pt * 0.6 * scale)]
        found = None
        for enlarge, langs in _RETRIES:
            for text, x, y, w, h in line_reader(arr, 0.0, y0, win_w_pt * 0.6, band[1] - y0, enlarge=enlarge, langs=langs, correction=False):
                if is_time_text(text):
                    found = Line(text, x, y0 + y, w, h, 0.5)
                    break
            if found:
                break
        if found:
            out = [l for l in out if l not in inside]
            out.append(found)
            fixed += 1
    out.sort(key=lambda l: (round(l.y / 4), l.x))
    return out, fixed


# ---------------- 区切り ----------------
def parse_tall(image: TallImage, lines: list[Line], scale: float, win_w_pt: float, *,
               digits_reader: DigitsReader | None = None, name_reader: NameReader | None = None,
               runs: list[tuple[float, float]] | None = None,
               line_reader: LineReader | None = None) -> tuple[list[Block], list[str]]:
    """縦長画像全体を、ノート/コメントのブロックに区切る. 戻り値: (ブロック, 警告)."""
    warnings: list[str] = []
    side_x = win_w_pt - (K.WIN_W - K.SIDE_X_MIN)
    wrap_right = win_w_pt - (K.WIN_W - K.WRAP_RIGHT)
    runs = runs if runs is not None else avatar_runs_tall(image, scale)
    lines = merge_fragments(sorted(lines, key=lambda l: (l.y, l.x)))
    if line_reader is not None:
        lines, fixed = recover_time_rows(image, lines, runs, scale, win_w_pt, line_reader)
        if fixed:
            warnings.append(f"読み違えた時刻の行を {fixed} 件、読み直しました")
    kept = []
    for l in lines:
        flat = l.text.replace(" ", "").replace(" ", "")
        if TXT_END in flat or TXT_CUT in flat or flat == "投稿" or flat.endswith("を入力"):
            continue                                   # コメント欄の入力欄・展開ボタン(本文ではない)
        kept.append(l)
    lines = kept

    blocks: list[Block] = []
    seg_start = 0.0
    prev_idx = -1
    for idx, tl in enumerate(lines):
        if not is_time_text(tl.text):
            continue
        seg = lines[prev_idx + 1: idx]
        seg_top, prev_idx = seg_start, idx
        seg_start = tl.y + tl.h
        kind = "note" if tl.x < K.NOTE_X_MAX else "comment"
        cands = [r for r in runs if seg_top - 2 <= r[0] and r[1] <= tl.y]

        def named(r):
            return any(K.NAME_X_MIN < l.x < K.NAME_X_MAX and r[0] - 4 <= l.y + l.h / 2 <= r[1] + 4 for l in seg)
        run = next((r for r in cands if named(r)), cands[-1] if cands else None)
        if run is None:
            warnings.append(f"作者の見つからない投稿があります(時刻 {tl.text.strip()} y={tl.y:.0f}pt)")
            continue
        ry0, ry1 = run
        main = [l for l in seg if not (l.x > side_x and l.w < K.SIDE_W_MAX)]
        head = [l for l in main if K.NAME_X_MIN < l.x < side_x and ry0 - 4 <= l.y + l.h / 2 <= ry1 + 4]
        view = TallView(image, ry0 - 4, tl.y + tl.h + 6, scale, win_w_pt, digits_reader, name_reader)
        author = clean_name(head[0].text) if head else clean_name(view.ocr_region(44, 2, 280, ry1 - ry0)) or "?"
        rest = [l for l in main if l.y + l.h / 2 > ry1 + 2]
        b = Block(kind=kind, author=author, time_raw=tl.text.strip(), y_top=ry0, y_time=tl.y, complete=True,
                  badge=_badge(image, ry0, ry1, scale), wrap_right=wrap_right)
        if kind == "note":
            cy = tl.y - K.COUNTS_ROW_ABOVE_TIME
            cview = TallView(image, cy - 14, cy + 14, scale, win_w_pt, digits_reader, name_reader)
            counts = read_counts(cview, 14.0)
            band = None
            if counts:
                b.reactions, b.comments, b.comment_icon = counts
                b.counts_y = cy
                band = (cy - 12, cy + 12)
            rest = drop_card_garbage(rest, cy if counts else None)
            for l in rest:
                t = l.text.strip()
                if band and band[0] <= l.y + l.h / 2 <= band[1] and l.x < K.NOTE_X_MAX + 10:
                    continue
                if TXT_MORE in t.replace(" ", "") and l.x < K.LINK_CARD_X_MIN:
                    b.more_y, b.more_x = l.y + l.h / 2, l.x + l.w / 2
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
        blocks.append(b)
    return blocks, warnings


# ---------------- ノートごとのまとめ ----------------
class NoteGroup:
    def __init__(self, note: Block):
        self.note = note
        self.comments: list[Block] = []


def group_notes(blocks: list[Block]) -> list[NoteGroup]:
    """ノートと、その直後に続くコメントをまとめる."""
    groups: list[NoteGroup] = []
    for b in blocks:
        if b.kind == "note":
            groups.append(NoteGroup(b))
        elif groups:
            groups[-1].comments.append(b)
    return groups
