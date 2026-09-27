"""開いたコメント欄を、一覧ごと1回で撮ってつなぎ、1回のOCRで読む(docs/openchat-capture-design.md §5〜§8).

1画面ずつ読んで文字で位置合わせする方式は、コメントの多いノートで上下に往復して破綻した。
ここでは画素だけで位置を測ってつなぎ(capture.py)、つないだ縦長の画像を1回で読み(tallocr.py)、区切る(tallparse.py)。
操作はスクロールだけ(クリックしない)。クリックは Session._click(guard_click 経由)だけが行う。
"""
from __future__ import annotations

import shutil
import tempfile
import time
from typing import Callable, Protocol

import numpy as np

from . import capture, tallocr, tallparse

MAX_FRAMES = 1500
END_DUP_PT = 10.0          # 一覧上の位置がこれ以内の入力欄は、同じもの

# コメント欄の末尾の入力欄の右にある「投稿」ボタン(くすんだ緑). 右下の＋ボタン(明るい緑 (7,181,59))・アバター・リアクションとは色と大きさで区別できる。
# 実機で測った値(2026-09-27, Retina): 色 (64,137,79)、高さ 約38pt・幅 約50pt。文字「投稿」の行は緑の画素が減るので、行ごとの下限は低くしてある
POST_BTN = np.array([64, 137, 79], dtype=np.int16)
POST_BTN_TOL = 14
POST_BTN_ROW_MIN_PT = 12.0        # 1行に、この幅以上の緑があれば、ボタンの行
POST_BTN_H_PT = (28.0, 50.0)      # ボタンの高さの範囲(帯の端で切れたものは、下限より低くなり、数えない。次の画面で全体が写る)
POST_BTN_W_MIN_PT = 40.0          # 塊の横の広がり(小さなアバターなどを除く)
POST_BTN_X_FROM = 0.7             # 画面の右側だけを見る


def find_post_buttons(band: np.ndarray, scale: float) -> list[float]:
    """帯(RGB)の中の「投稿」ボタンを探し、上端を基準にした中心のy(pt)を返す. 文字は読まない(OCRより桁違いに速い)."""
    x0 = int(band.shape[1] * POST_BTN_X_FROM)
    green = (np.abs(band[:, x0:].astype(np.int16) - POST_BTN).max(axis=2) <= POST_BTN_TOL)
    rows = green.sum(axis=1) >= int(POST_BTN_ROW_MIN_PT * scale)
    out: list[float] = []
    y, n = 0, len(rows)
    while y < n:
        if not rows[y]:
            y += 1
            continue
        y1 = y
        while y1 + 1 < n and rows[y1 + 1]:
            y1 += 1
        h_pt = (y1 - y + 1) / scale
        if POST_BTN_H_PT[0] <= h_pt <= POST_BTN_H_PT[1]:
            cols = np.where(green[y:y1 + 1].any(axis=0))[0]
            if (cols.max() - cols.min() + 1) / scale >= POST_BTN_W_MIN_PT:
                out.append((y + y1 + 1) / 2 / scale)
        y = y1 + 1
    return out


class EndCounter:
    """撮影の途中で、開いたコメント欄の終わり(入力欄の「投稿」ボタン)を数え、目標の数に達したら止める(scan_down の stop に渡す).

    撮影は上から下へ進む。開いたコメント欄は、それぞれ末尾に入力欄が1つある。開いた数だけ数えたら、開いたコメント欄は
    すべて撮れているので、それより下(走査で「変化なし」と判断したノート)は撮らなくてよい。
    画面ごとに、帯の全体で探し(画素だけなので軽い)、一覧上の位置で重複を除く。帯の端で切れたものは数えない(次の画面で全体が写る)。"""

    def __init__(self, cal: capture.Calibration, target: int, finder: Callable[[np.ndarray, float], list[float]] = find_post_buttons):
        self.cal, self.target = cal, target
        self._finder = finder
        self.ends: list[float] = []          # 数えた入力欄の、一覧上の位置(pt)
        self.seconds = 0.0

    def __call__(self, frame: np.ndarray, offset: int) -> bool:
        """frame の先頭行は、一覧上の offset(px)にある. 目標に達したら True."""
        if self.target <= 0:
            return False
        t0 = time.time()
        cal = self.cal
        band = frame[cal.band_top:cal.band_bottom, : cal.x1]
        for y in self._finder(band, cal.scale):
            pos = (offset + cal.band_top) / cal.scale + y
            if all(abs(pos - e) > END_DUP_PT for e in self.ends):
                self.ends.append(pos)
        self.seconds += time.time() - t0
        return len(self.ends) >= self.target


class ThreadReader(Protocol):
    def prepare(self) -> None: ...           # 撮影の調整(一覧の先頭へ戻る)
    def frame(self): ...                     # 落ち着いた画面の画像(画素)。撮れない模擬では None
    def motion(self, before, after) -> str: ...   # "ok"(重なりがあり、位置を測れた) / "unchanged" / "rejected"(飛びすぎ)
    def read_all(self, expect_ends: int | None = None): ...   # 一覧の先頭から撮って読む. (NoteGroupの列, 警告)
    # expect_ends: 開いたコメント欄の数. 指定すると、その数だけ「コメントを入力」を数えたところで撮影を止める(None は末尾まで)


class TallThreadReader:
    def __init__(self, driver):
        from .lineui import MacFrameSource
        self.driver = driver
        self.src = MacFrameSource(driver)
        self.cal: capture.Calibration | None = None
        self.last_info: dict = {}            # 直近の read_all の記録(枚数・止めたか・各段の秒数). ログ用

    def prepare(self) -> None:
        """倍率・固定表示の範囲・1行あたりの移動量を測る(一覧の先頭へ戻るので、走査の前に1回だけ呼ぶ)."""
        self.cal = capture.calibrate(self.src)

    def frame(self):
        return self.src.grab()

    def motion(self, before, after) -> str:
        """スクロールの前後の2枚が、画素で重なっているか(文字で判断しない)."""
        cal = self.cal
        assert cal is not None
        x1 = cal.x1
        res = capture.measure_shift(capture.row_fingerprints(before, x1), capture.row_fingerprints(after, x1),
                                    capture.blank_mask(before, x1), cal.band_top, cal.band_bottom, cal.scale)
        return res.kind

    def read_all(self, expect_ends: int | None = None):
        """一覧の先頭から、スクロールだけで撮ってつなぎ、1回OCRして、ノートごとに区切る. 戻り値: (NoteGroupの列, 警告).
        expect_ends を渡すと、開いたコメント欄の終わりをその数だけ数えたところで撮影を止める(渡さなければ末尾まで)."""
        assert self.cal is not None, "prepare() を先に呼ぶこと"
        cal, src = self.cal, self.src
        work = tempfile.mkdtemp(prefix="linecap-")
        st = None
        try:
            t0 = time.time()
            first = capture.scroll_to_top(src)
            counter = EndCounter(cal, expect_ends) if expect_ends else None
            res = capture.scan_down(src, cal, first, max_frames=MAX_FRAMES, workdir=work, stop=counter)
            st = res.stitcher
            t1 = time.time()
            lines = tallocr.ocr_tall(st, cal.frame_w, cal.scale)
            t2 = time.time()
            blocks, warnings = tallparse.parse_tall(
                st, lines, cal.scale, src.win_w_pt, digits_reader=tallocr.ocr_digits_array,
                name_reader=tallocr.ocr_name_array, line_reader=tallocr.ocr_lines_array)
            t3 = time.time()
            self.last_info = {"frames": res.frames, "stopped": not res.reached_end and counter is not None and len(counter.ends) >= counter.target,
                              "ends": len(counter.ends) if counter else 0, "expect": expect_ends,
                              "scan_sec": t1 - t0, "stop_ocr_sec": counter.seconds if counter else 0.0,
                              "ocr_sec": t2 - t1, "parse_sec": t3 - t2}
            if res.rejected:
                warnings.append(f"位置を測れず捨てた画像が{res.rejected}枚ありました")
            return tallparse.group_notes(blocks), warnings
        finally:
            if st is not None:
                st.close()
            shutil.rmtree(work, ignore_errors=True)
