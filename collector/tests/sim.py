"""LINEのノート画面を模擬するシミュレーター(テスト用).

実機で測った寸法(layout.py)どおりに、ノートとコメントを縦に並べた「文書」を作り、
スクロール位置に応じた画面(Screen)を返す。画像は使わず、OCR行と画素の矩形だけを持つ。
合成データだけを使い、実際の参加者の投稿は含めない。
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field

from line_openchat import layout as K
from line_openchat.screen import Line

BADGE = (0x00, 0x70, 0xFF)
WHITE = (240, 240, 240)
AVATAR_COLOR = (150, 120, 90)


@dataclass
class SimComment:
    author: str
    text: str
    time: str
    badge: bool = False


@dataclass
class SimNote:
    author: str
    text: str
    time: str
    badge: bool = False
    comments: list[SimComment] = field(default_factory=list)
    card: str = ""                  # リンクカードの題名
    long_body: bool = False         # 「もっと見る」で開く必要がある
    open: bool = False              # コメント欄が開いている
    expanded: bool = False          # 「もっと見る」を押した
    earlier_loaded: bool = False    # 「前のコメントを見る」を押した
    reactions: int = 3


class SimScreen:
    def __init__(self, lines, rects, width=K.WIN_W, height=K.WIN_H, digit_map=None, name_map=None):
        self.width, self.height = width, height
        self.lines = lines
        self._rects = rects
        self._digits = digit_map or []
        self._names = name_map or []

    def pixel(self, x, y):
        color = K.BG
        for (x0, y0, x1, y1, c) in self._rects:
            if x0 <= x < x1 and y0 <= y < y1:
                color = c
        return color

    def text_center_x(self, line, needle):
        idx = line.text.find(needle)
        if idx < 0:
            return line.x + line.w / 2
        return line.x + line.w * (idx + len(needle) / 2) / max(1, len(line.text))

    def ocr_region(self, x, y, w, h):
        for (ny, text) in self._names:
            if y - 6 <= ny <= y + h + 6:
                return text
        return ""

    def ocr_digits(self, x, y, w, h, repeat=1):
        for (dx0, dx1, dy, text) in self._digits:
            if abs(dy - (y + h / 2)) < 12 and x - 3 <= dx0 and dx1 <= x + w + 3:
                return " ".join([text] * repeat)
        return ""


def _wrap(text: str, width_chars: int) -> list[tuple[str, bool]]:
    """(行, 折り返しか). 改行はそのまま、長い行は width_chars で折り返す."""
    out: list[tuple[str, bool]] = []
    for para in text.split("\n"):
        if para == "":
            out.append(("", False))
            continue
        while len(para) > width_chars:
            out.append((para[:width_chars], True))
            para = para[width_chars:]
        out.append((para, False))
    return out


class SimChat:
    """ノート一覧(新しい順). shots/clicks を数え、禁止操作が無かったかを記録する."""

    NOTE_H_PAD = 50

    def __init__(self, notes: list[SimNote], seed: int = 1, jitter: bool = True, lines_per_scroll_px: float = 18.0):
        self.notes = notes
        self.scroll_y = 0.0
        self.rng = random.Random(seed)
        self.jitter = jitter
        self.px_per_line = lines_per_scroll_px
        self.shots = 0
        self.clicks: list[tuple[str, float, float]] = []
        self.forbidden_clicks: list[tuple[float, float]] = []
        self.ocr_noise = 0.0

    # ---------- 文書の組み立て ----------
    def layout(self):
        """(lines, rects, digits, names, total_height, hit_zones) を文書座標で返す."""
        lines: list[Line] = []
        rects: list = []
        digits: list = []
        names: list = []
        zones: list = []
        y = 90.0

        def avatar(y0, badge):
            rects.append((K.AVATAR_X0, y0, K.AVATAR_X1 - 1, y0 + 27, AVATAR_COLOR))
            if badge:
                rects.append((34, y0 + 14, 46, y0 + 26, BADGE))      # 実機と同じく x≈45 まで張り出す

        for n in self.notes:
            avatar(y, n.badge)
            lines.append(Line(n.author, 49, y + 5, 60, 15))
            y += 38
            body = n.text
            wrapped = _wrap(body, 26)
            if n.long_body and not n.expanded:
                wrapped = wrapped[:6]
            for text, cont in wrapped:
                if text == "":
                    y += 15
                    continue
                w = 396 if cont else max(20, 14.5 * len(text))
                lines.append(Line(text, 14.8, y, min(w, 396), 15))
                y += 15.5
            if n.long_body and not n.expanded:
                lines.append(Line("…もっと見る", 16, y, 80, 12))
                zones.append(("more", 14, y, 100, y + 12, n))
                y += 26
            else:
                y += 14
            if n.card:
                rects.append((14, y, 112, y + 83, (60, 60, 60)))
                lines.append(Line("地球", 20, y + 30, 40, 15, 0.5))      # 画像内の文字(OCRの拾い過ぎ)
                for i, t in enumerate(_wrap(n.card, 12)[:3]):
                    lines.append(Line(t[0], 125, y + 15 + i * 17, 200, 15))
                y += 100
            # 数の行: [😊][数][💬][数][共有]
            cy = y + 9
            rx = 18.0
            rects.append((rx, cy - 8, rx + 17, cy + 8, WHITE))
            rd = str(n.reactions)
            rw = 6.5 * len(rd)
            rects.append((40, cy - 6, 40 + rw, cy + 6, WHITE))
            digits.append((40, 40 + rw, cy, rd))
            cx0 = 40 + rw + 10
            rects.append((cx0, cy - 8, cx0 + 16, cy + 8, WHITE))
            zones.append(("comment_icon", cx0, cy - 8, cx0 + 16, cy + 8, n))
            count = len(n.comments)
            if count:
                cd = str(count)
                cw = 6.5 * len(cd)
                rects.append((cx0 + 22, cy - 6, cx0 + 22 + cw, cy + 6, WHITE))
                digits.append((cx0 + 22, cx0 + 22 + cw, cy, cd))
                sx = cx0 + 22 + cw + 8
            else:
                sx = cx0 + 22
            rects.append((sx, cy - 8, sx + 16, cy + 8, WHITE))
            # 誤読される行(アイコンを数字と読む): 実機と同じくOCR行として出す
            lines.append(Line(f"0 {rd} @ {count}山", 16.4, cy - 9, 100, 18, 0.5))
            zones.append(("reaction_icon", rx, cy - 8, rx + 17, cy + 8, n))
            y = cy + 16
            lines.append(Line(n.time, 14.8, y, 90, 15))
            y += 30
            if n.open:
                if not n.earlier_loaded and len(n.comments) > 10:
                    lines.append(Line("前のコメントを見る", 150, y, 130, 15))
                    zones.append(("earlier", 60, y - 4, 370, y + 19, n))
                    y += 34
                    shown = n.comments[-10:]
                else:
                    shown = n.comments
                for c in shown:
                    avatar(y, c.badge)
                    lines.append(Line(c.author, 49, y + 5, 60, 15))
                    names.append((y + 12, c.author))
                    lines.append(Line("2③", 362, y + 4, 28, 14))
                    y += 38
                    wrapped = _wrap(c.text, 24)
                    for text, cont in wrapped:
                        if text == "":
                            y += 15
                            continue
                        lines.append(Line(text, 49.2, y, 362 if cont else max(20, 14.5 * len(text)), 15))
                        y += 15.5
                    y += 6
                    lines.append(Line(c.time, 49.2, y, 60, 15))
                    y += 38
                lines.append(Line("コメントを入力", 30, y, 100, 15))
                zones.append(("input", 14, y - 10, 400, y + 30, n))
                y += 60
            y += self.NOTE_H_PAD - 30
        return lines, rects, digits, names, y, zones

    def _doc(self):
        sig = tuple((n.open, n.expanded, n.earlier_loaded, len(n.comments)) for n in self.notes)
        if getattr(self, "_sig", None) != sig:
            self._sig, self._cache = sig, self.layout()
        return self._cache

    # ---------- 操作 ----------
    def screen(self) -> SimScreen:
        self.shots += 1
        lines, rects, digits, names, total, zones = self._doc()
        off = self.scroll_y
        vis_lines = []
        for l in lines:
            y = l.y - off
            if y + l.h > K.TOP_MARGIN - 2 and y < K.WIN_H:
                vis_lines.append(Line(l.text, l.x, y, l.w, l.h, l.conf))
        vis_rects = [(x0, y0 - off, x1, y1 - off, c) for (x0, y0, x1, y1, c) in rects if y1 - off > 0 and y0 - off < K.WIN_H]
        vis_digits = [(a, b, y - off, t) for (a, b, y, t) in digits]
        vis_names = [(y - off, t) for (y, t) in names]
        # タイトルバー(「ノート」)
        vis_lines.append(Line("ノート", 193.5, 46, 38, 15))
        vis_lines.sort(key=lambda l: (round(l.y / 4), l.x))
        return SimScreen(vis_lines, vis_rects, digit_map=vis_digits, name_map=vis_names)

    def max_scroll(self) -> float:
        _, _, _, _, total, _ = self._doc()
        return max(0.0, total - K.WIN_H + 40)

    def scroll(self, lines: int):
        step = lines * self.px_per_line
        if self.jitter:
            step *= self.rng.uniform(0.7, 1.15)
        self.scroll_y = min(max(0.0, self.scroll_y + step), self.max_scroll())

    def click_at(self, kind: str, x: float, y: float):
        """実機のクリックに相当. 押した場所にあるものを判定する."""
        self.clicks.append((kind, x, y))
        _, _, _, _, _, zones = self._doc()
        dy = y + self.scroll_y
        for (zk, x0, y0, x1, y1, note) in zones:
            if x0 <= x <= x1 and y0 <= dy <= y1:
                if zk in ("reaction_icon", "input"):
                    self.forbidden_clicks.append((x, y))
                    return
                if zk == "comment_icon":
                    note.open = not note.open
                    if note.open:
                        note.earlier_loaded = False
                    return
                if zk == "earlier":
                    note.earlier_loaded = True
                    return
                if zk == "more":
                    note.expanded = True
                    return


class SimDriver:
    """Session に渡すDriver. 押す操作はシミュレーターの部品に対して行う."""

    def __init__(self, chat: SimChat):
        self.chat = chat

    def shot(self):
        return self.chat.screen()

    def scroll(self, lines: int) -> None:
        self.chat.scroll(lines)

    def click_at(self, x: float, y: float) -> None:
        self.chat.click_at("click", x, y)
