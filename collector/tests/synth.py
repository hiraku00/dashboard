"""スクロールする画面の合成(テスト用). 架空の内容だけ。画素のノイズで「文字の行」を表す。

文書(縦に長い画像)を、固定の見出し・右下の＋ボタン・スクロール中だけ出るスクロールバーを重ねた窓から見せる。
"""
from __future__ import annotations

import numpy as np

from line_openchat.capture import BG

BGU = BG.astype(np.uint8)


def make_document(seed: int, width: int, blocks: int, scale: float = 1.0, repeat_block: int | None = None,
                  bottom_pad: int = 0) -> np.ndarray:
    """アバター・文字の行(行ごとに違うノイズ)・無地の隙間を並べた文書. repeat_block を指定すると、その番号のブロックを3回繰り返す."""
    rng = np.random.default_rng(seed)
    rows: list[np.ndarray] = []

    def blank(n):
        rows.append(np.tile(BGU, (n, width, 1)))

    def ink_line(h, x0=int(49 * scale), x1=int(400 * scale)):
        line = np.tile(BGU, (h, width, 1))
        line[:, x0:x1] = rng.integers(60, 255, size=(h, x1 - x0, 3), dtype=np.uint8)
        return line

    def block():
        n_lines = int(rng.integers(2, 8))
        av = np.tile(BGU, (int(28 * scale), width, 1))
        av[:, int(16 * scale):int(43 * scale)] = rng.integers(60, 255, size=3, dtype=np.uint8)      # アバター(単色)
        av[:, int(49 * scale):int(120 * scale)] = rng.integers(60, 255, size=(av.shape[0], int(71 * scale), 3), dtype=np.uint8)   # 名前
        parts = [av]
        for _ in range(n_lines):
            parts.append(ink_line(int(13 * scale)))
            parts.append(np.tile(BGU, (int(3 * scale), width, 1)))
        parts.append(ink_line(int(12 * scale), x1=int(110 * scale)))                                  # 時刻の行
        return np.concatenate(parts)

    repeated = None
    for i in range(blocks):
        blank(int(rng.integers(int(16 * scale), int(34 * scale))))
        if repeat_block is not None and i in (repeat_block, repeat_block + 1, repeat_block + 2):
            repeated = repeated if repeated is not None else block()
            rows.append(repeated)
        else:
            rows.append(block())
    blank(int(bottom_pad))
    return np.concatenate(rows)


class SynthSource:
    """FrameSource の合成版. scroll(lines) は lines × px_per_line(±揺れ) だけ動く."""

    def __init__(self, doc: np.ndarray, scale: float = 1.0, win_w_pt: float = 428.0, win_h_pt: float = 1130.0,
                 px_per_line: float | None = None, jitter: float = 0.0, seed: int = 1, top_fixed_pt: float = 58.0,
                 fab: bool = True, scrollbar: bool = True, time_noise: float = 0.0, fail_grabs: bool = False):
        self.doc, self.scale, self.win_w_pt = doc, scale, win_w_pt
        self.W, self.H = int(round(win_w_pt * scale)), int(round(win_h_pt * scale))
        self.top_fixed = int(top_fixed_pt * scale)
        self.ppl = px_per_line if px_per_line is not None else 16.8 * scale
        self.jitter, self.rng = jitter, np.random.default_rng(seed)
        self.pos = 0.0
        self.fab, self.scrollbar, self.time_noise, self.fail_grabs = fab, scrollbar, time_noise, fail_grabs
        self.grabs = 0
        rng = np.random.default_rng(99)
        self._header = rng.integers(60, 255, size=(self.top_fixed, self.W, 3), dtype=np.uint8)          # 固定見出し(常に同じ)
        self._fab = rng.integers(60, 255, size=(int(130 * scale), int(80 * scale), 3), dtype=np.uint8)    # 固定の＋ボタン
        self._moved = False

    @property
    def view_h(self) -> int:
        return self.H - self.top_fixed

    @property
    def max_pos(self) -> int:
        return max(0, len(self.doc) - self.view_h)

    def scroll(self, lines: int) -> None:
        step = lines * self.ppl * (1 + self.rng.uniform(-self.jitter, self.jitter) if self.jitter else 1)
        self.pos = float(min(max(0, self.pos + step), self.max_pos))
        self._moved = True

    def doc_row(self, screen_y: int) -> int:
        return int(round(self.pos)) + (screen_y - self.top_fixed)

    def grab(self) -> np.ndarray:
        self.grabs += 1
        if self.fail_grabs:
            return self.rng.integers(0, 255, size=(self.H, self.W, 3), dtype=np.uint8)
        p = int(round(self.pos))
        frame = np.tile(BGU, (self.H, self.W, 1))
        frame[: self.top_fixed] = self._header
        seg = self.doc[p: p + self.view_h]
        w = min(self.W, seg.shape[1])
        frame[self.top_fixed: self.top_fixed + len(seg), :w] = seg[:, :w]
        if self.time_noise:
            n = int(self.view_h * self.time_noise)
            for y in self.rng.choice(self.view_h, size=n, replace=False):
                frame[self.top_fixed + y, int(49 * self.scale): int(110 * self.scale)] ^= np.uint8(0x55)     # 時刻の文字の更新
        if self.fab:
            fh, fw = self._fab.shape[:2]
            frame[self.H - fh:, self.W - fw - 1: self.W - 1] = self._fab
        if self.scrollbar and self._moved:
            y0 = int(self.view_h * p / max(1, len(self.doc)))
            frame[self.top_fixed + y0: self.top_fixed + y0 + int(120 * self.scale), self.W - int(8 * self.scale): self.W - 2] = 90
            self._moved = False
        return frame
