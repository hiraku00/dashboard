"""開いたコメント欄を、一覧ごと1回で撮ってつなぎ、1回のOCRで読む(docs/openchat-capture-design.md §5〜§8).

1画面ずつ読んで文字で位置合わせする方式は、コメントの多いノートで上下に往復して破綻した。
ここでは画素だけで位置を測ってつなぎ(capture.py)、つないだ縦長の画像を1回で読み(tallocr.py)、区切る(tallparse.py)。
操作はスクロールだけ(クリックしない)。クリックは Session._click(guard_click 経由)だけが行う。
"""
from __future__ import annotations

import shutil
import tempfile
from typing import Protocol

from . import capture, tallocr, tallparse

MAX_FRAMES = 1500


class ThreadReader(Protocol):
    def prepare(self) -> None: ...           # 撮影の調整(一覧の先頭へ戻る)
    def frame(self): ...                     # 落ち着いた画面の画像(画素)。撮れない模擬では None
    def motion(self, before, after) -> str: ...   # "ok"(重なりがあり、位置を測れた) / "unchanged" / "rejected"(飛びすぎ)
    def read_all(self): ...                  # 一覧の先頭から末尾まで撮って読む. (NoteGroupの列, 警告)


class TallThreadReader:
    def __init__(self, driver):
        from .lineui import MacFrameSource
        self.driver = driver
        self.src = MacFrameSource(driver)
        self.cal: capture.Calibration | None = None

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

    def read_all(self):
        """一覧の先頭から末尾まで、スクロールだけで撮ってつなぎ、1回OCRして、ノートごとに区切る. 戻り値: (NoteGroupの列, 警告)."""
        assert self.cal is not None, "prepare() を先に呼ぶこと"
        cal, src = self.cal, self.src
        work = tempfile.mkdtemp(prefix="linecap-")
        st = None
        try:
            first = capture.scroll_to_top(src)
            res = capture.scan_down(src, cal, first, max_frames=MAX_FRAMES, workdir=work)
            st = res.stitcher
            lines = tallocr.ocr_tall(st, cal.frame_w, cal.scale)
            blocks, warnings = tallparse.parse_tall(
                st, lines, cal.scale, src.win_w_pt, digits_reader=tallocr.ocr_digits_array,
                name_reader=tallocr.ocr_name_array, line_reader=tallocr.ocr_lines_array)
            if res.rejected:
                warnings.append(f"位置を測れず捨てた画像が{res.rejected}枚ありました")
            return tallparse.group_notes(blocks), warnings
        finally:
            if st is not None:
                st.close()
            shutil.rmtree(work, ignore_errors=True)
