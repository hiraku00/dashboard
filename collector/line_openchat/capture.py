"""スクロールしながら撮った画像を、画素で位置合わせして、1枚の縦長画像(仮想)につなぐ.

設計は docs/openchat-capture-design.md §5。要点:
- 重なりは「文字」ではなく「画素」で判定する(OCRの揺れの影響を受けない)。
- 縦長画像の各行は、必ず1枚の撮影画像からだけ取る(重なり部分は位置を測るためだけに使う)。
- 画像の切り替え位置は、文字の行の途中ではなく、何も書かれていない行にそろえる(行の途中の二重写りを防ぐ)。
- 上部の固定見出し、右下の＋ボタン、スクロールバーの範囲は、縦長画像に入れない。
"""
from __future__ import annotations

import os
import shutil
import tempfile
import zlib
from dataclasses import dataclass, field
from typing import Callable, Iterator, Protocol

import numpy as np

BG = np.array([0x2D, 0x2E, 0x30], dtype=np.int16)
BLANK_TOL = 6                      # 背景色との差の最大値がこれ以下なら「無地」

# 位置合わせの採用条件(実機の測定値: 一致率0.85〜0.88、2番目の候補は0.3〜0.4)
MIN_RATIO = 0.80
MIN_MARGIN = 0.25
MIN_MATCH_ROWS_PT = 40             # 無地でない一致行が、これ(pt)以上
MIN_OVERLAP_PT = 260               # 隣り合う画像の重なりの最小(pt)。切れ目の探索窓(200pt)+余裕
CUT_WINDOW_PT = 200                # 切れ目(無地の行)を探す窓の高さ(pt)
CUT_SAFETY_PT = 24                 # 帯の下端から、切れ目までの余裕
SCROLLBAR_PT = 20                  # 右端のスクロールバーの幅(比較・貼り付けの対象から除く)
FIXED_MARGIN_PT = 12               # 固定見出しの下端からの余裕
FAB_MARGIN_PT = 8
SAME_RATIO = 0.8                   # 無地でない行のこの割合以上が同じなら「変わっていない」(時刻の文字の更新などは許す)
MAX_FAILS = 6                      # 位置を測れない画像が、これだけ続いたら中止(歩幅が半分ずつになり、3行まで下がる)
FAB_MASK_PT = 4                    # 最後の画像で、ボタンの矩形を塗りつぶすときの上への余裕(丸いボタンの縁の取りこぼし対策)


class CaptureError(RuntimeError):
    """撮影・つなぎ合わせを続けられない(理由つき)."""


class FrameSource(Protocol):
    scale: float                   # 画像の幅(px) ÷ ウィンドウ幅(pt)
    win_w_pt: float

    def grab(self) -> np.ndarray: ...            # 落ち着いた状態のRGB(H, W, 3) uint8
    def scroll(self, lines: int) -> None: ...    # lines>0 で下へ


# ---------------- 行の指紋 ----------------
def _x_limit(width_px: int, scale: float) -> int:
    return int(width_px - SCROLLBAR_PT * scale)


def blank_mask(frame: np.ndarray, x1: int) -> np.ndarray:
    """各行が無地(背景色のみ)か. shape (H,)."""
    dist = np.abs(frame[:, :x1].astype(np.int16) - BG).max(axis=2)
    return dist.max(axis=1) <= BLANK_TOL


def row_fingerprints(frame: np.ndarray, x1: int) -> np.ndarray:
    """各行の画素をそのまま数値にしたもの(同じ行なら同じ値). shape (H,) uint32."""
    view = np.ascontiguousarray(frame[:, :x1])
    return np.fromiter((zlib.crc32(view[y].tobytes()) for y in range(view.shape[0])), dtype=np.uint32, count=view.shape[0])


# ---------------- ずれ幅の測定 ----------------
@dataclass
class Shift:
    kind: str               # ok | unchanged | rejected
    d: int = 0              # 次の画像は、前の画像を d 行(px)下へスクロールしたもの
    ratio: float = 0.0
    margin: float = 0.0
    rows: int = 0
    reason: str = ""


def measure_shift(fp_a: np.ndarray, fp_b: np.ndarray, blank_a: np.ndarray, top: int, bot: int, scale: float) -> Shift:
    """前の画像A → 次の画像B のずれ幅を、帯 [top, bot) の行の一致で測る."""
    n = bot - top
    a, b, ba = fp_a[top:bot], fp_b[top:bot], blank_a[top:bot]
    nonblank = ~ba
    if nonblank.sum() >= 5 and float(((a == b) & nonblank).sum() / nonblank.sum()) >= SAME_RATIO:
        return Shift("unchanged", 0, 1.0)
    min_overlap = int(MIN_OVERLAP_PT * scale)
    min_rows = int(MIN_MATCH_ROWS_PT * scale)
    if n - min_overlap < 1:
        return Shift("rejected", reason="帯が狭すぎます")
    ratios = np.zeros(n - min_overlap + 1)
    counts = np.zeros(n - min_overlap + 1, dtype=np.int64)
    for d in range(1, n - min_overlap + 1):
        nb = nonblank[d:]
        cnt = int(nb.sum())
        counts[d] = cnt
        if cnt >= min_rows:
            ratios[d] = float(((a[d:] == b[:n - d]) & nb).sum() / cnt)
    best = int(ratios.argmax())
    if best == 0 or ratios[best] <= 0:
        return Shift("rejected", reason="一致する位置がありません")
    matched = int(round(ratios[best] * counts[best]))
    far = np.abs(np.arange(len(ratios)) - best) > 2
    second = float(ratios[far].max()) if far.any() else 0.0
    ratio, margin = float(ratios[best]), float(ratios[best] - second)
    if ratio < MIN_RATIO:
        return Shift("rejected", best, ratio, margin, matched, f"一致率が低い({ratio:.2f})")
    if matched < min_rows:
        return Shift("rejected", best, ratio, margin, matched, "一致した行が少ない")
    if margin < MIN_MARGIN:
        return Shift("rejected", best, ratio, margin, matched, f"別の候補と区別できない(差{margin:.2f})")
    return Shift("ok", best, ratio, margin, matched)


# ---------------- 調整(キャリブレーション) ----------------
@dataclass
class Calibration:
    scale: float
    frame_w: int
    frame_h: int
    x1: int                 # 比較・貼り付けの右端(スクロールバーを除く)
    band_top: int
    band_bottom: int
    fab: tuple[int, int, int, int] | None      # 右下の固定ボタンの矩形 (x0, y0, x1, y1). 無ければ None
    px_per_line: float

    @property
    def band_h(self) -> int:
        return self.band_bottom - self.band_top


def _grab_scroll(src: FrameSource, lines: int) -> np.ndarray:
    src.scroll(lines)
    return src.grab()


def scroll_to_top(src: FrameSource, max_steps: int = 60) -> np.ndarray:
    """先頭まで戻る(画像が変わらなくなるまで). 戻り値は先頭の画像.
    「変わらない」は、無地でない行の8割以上が同じこと(時刻の文字の更新など、少しの変化は許す)."""
    prev = src.grab()
    x1 = _x_limit(prev.shape[1], src.scale)
    fp_prev, bl_prev = row_fingerprints(prev, x1), blank_mask(prev, x1)
    same = 0
    for _ in range(max_steps):
        cur = _grab_scroll(src, -60)
        fp = row_fingerprints(cur, x1)
        nb = ~bl_prev
        if nb.sum() >= 5 and float(((fp == fp_prev) & nb).sum() / nb.sum()) >= SAME_RATIO:
            same += 1
            if same >= 2:
                return cur
        else:
            same = 0
        prev, fp_prev, bl_prev = cur, fp, blank_mask(cur, x1)
    raise CaptureError("一覧の先頭まで戻れませんでした")


def calibrate(src: FrameSource, probe_lines: int = 6) -> Calibration:
    """倍率・固定表示の範囲・1行あたりの移動量を測る. 先頭に戻ってから、少しスクロールした2枚を比べる."""
    a = scroll_to_top(src)
    b = _grab_scroll(src, probe_lines)
    h, w = a.shape[:2]
    scale = src.scale
    x1 = _x_limit(w, scale)
    fa, fb = row_fingerprints(a, x1), row_fingerprints(b, x1)
    ba = blank_mask(a, x1)
    fixed = (fa == fb) & ~ba
    if float(fixed.mean()) > 0.9:
        raise CaptureError("スクロールしても画面が動きません(ノートが短すぎるか、スクロールが効いていません)")
    top_rows = np.where(fixed[: h // 3])[0]
    top_fixed = int(top_rows.max()) if len(top_rows) else 0
    band_top = top_fixed + int(FIXED_MARGIN_PT * scale)
    # 右下の固定ボタン: 2枚で同じ位置に同じ(無地でない)画素がある領域. 内容は動くので、同じ画素が重なるのは固定部品だけ
    fab = None
    x_lo, x_hi = int(w - 110 * scale), int(w - 2)
    region_a, region_b = a[h // 2:, x_lo:x_hi], b[h // 2:, x_lo:x_hi]
    fixed_ink = (region_a == region_b).all(axis=2) & (np.abs(region_a.astype(np.int16) - BG).max(axis=2) > BLANK_TOL)
    rows_ok = np.where(fixed_ink.sum(axis=1) >= int(30 * scale))[0]
    if len(rows_ok) >= int(10 * scale):
        top = int(rows_ok.min())
        cols = np.where(fixed_ink[top:].sum(axis=0) >= int(10 * scale))[0]
        fab = (x_lo + int(cols.min()) - 2, h // 2 + top, x_lo + int(cols.max()) + 3, h)
        band_bottom = fab[1] - int(FAB_MARGIN_PT * scale)
    else:
        band_bottom = h - int(FAB_MARGIN_PT * scale)
    if band_bottom - band_top < int((MIN_OVERLAP_PT + 200) * scale):
        raise CaptureError("ウィンドウの高さが足りません(帯が狭すぎます)。ウィンドウを縦に大きくしてください")
    shift = measure_shift(fa, fb, ba, band_top, band_bottom, scale)
    if shift.kind != "ok":
        raise CaptureError(f"スクロール量を測れませんでした: {shift.reason or shift.kind}")
    return Calibration(scale, w, h, x1, band_top, band_bottom, fab, shift.d / probe_lines)


# ---------------- つなぎ合わせ ----------------
@dataclass
class Piece:
    frame_no: int
    src_y0: int
    src_y1: int
    dst_y0: int
    path: str = ""          # 貼り付ける画素(その部分だけ)を保存したファイル


class Stitcher:
    """撮影画像を順に受け取り、縦長画像(仮想)を組み立てる."""

    def __init__(self, cal: Calibration, workdir: str | None = None):
        self.cal = cal
        self.workdir = workdir or tempfile.mkdtemp(prefix="linecap-")
        self._own_dir = workdir is None
        self.pieces: list[Piece] = []
        self.height = 0
        self.n_frames = 0
        self.warnings: list[str] = []
        self._prev: np.ndarray | None = None
        self._prev_fp: np.ndarray | None = None
        self._prev_blank: np.ndarray | None = None
        self._offset = 0            # 前の画像の行0が、内容の座標のどこか
        self._cut = None            # 直前の切れ目(内容の座標)
        self.shifts: list[Shift] = []

    # -- 内部 --
    def _fingerprint(self, frame: np.ndarray):
        return row_fingerprints(frame, self.cal.x1), blank_mask(frame, self.cal.x1)

    def _emit(self, frame: np.ndarray, frame_off: int, c0: int, c1: int, mask_fab: bool = False) -> None:
        """内容の座標 [c0, c1) を、frame から切り出して保存する."""
        y0, y1 = c0 - frame_off, c1 - frame_off
        if y1 <= y0:
            return
        img = frame[y0:y1].copy()
        img[:, self.cal.x1:] = BG.astype(np.uint8)                   # スクロールバーの列は背景色にする
        if mask_fab and self.cal.fab is not None:
            fx0, fy0, fx1, fy1 = self.cal.fab
            ys0 = max(0, fy0 - int(FAB_MASK_PT * self.cal.scale) - y0)
            if ys0 < img.shape[0]:
                img[ys0:, fx0:fx1] = BG.astype(np.uint8)
        path = os.path.join(self.workdir, f"piece{len(self.pieces):05d}.npy")
        np.save(path, img)
        self.pieces.append(Piece(self.n_frames - 1, y0, y1, self.height, path))
        self.height += img.shape[0]

    def _choose_cut(self, frame: np.ndarray, blank: np.ndarray, frame_off: int, floor: int) -> int:
        """frame の帯の下端の近くで、無地の行(文字の途中でない位置)を探す. 戻り値は内容の座標."""
        cal = self.cal
        hi = cal.band_bottom - int(CUT_SAFETY_PT * cal.scale)         # 帯の下端から余裕をとる
        lo = max(cal.band_top, hi - int(CUT_WINDOW_PT * cal.scale))
        lo = max(lo, floor - frame_off)
        for y in range(hi, lo, -1):
            if blank[y]:
                return frame_off + y
        # 窓の中に無地の行が無い(隙間の無い長い文字の並びなど): 文字が最も少ない行で切り、警告する
        ink = (np.abs(frame[lo:hi, : cal.x1].astype(np.int16) - BG).max(axis=2) > BLANK_TOL).sum(axis=1)
        y = lo + int(ink.argmin())
        self.warnings.append(f"つなぎ目に無地の行が見つからず、文字の間で切りました(y={frame_off + y})")
        return frame_off + y

    # -- 公開 --
    def begin(self, frame: np.ndarray) -> None:
        cal = self.cal
        self._prev = frame
        self._prev_fp, self._prev_blank = self._fingerprint(frame)
        self._offset = 0
        self._cut = cal.band_top                                       # 最初の画像は、固定見出しの下から
        self.n_frames = 1

    def add(self, frame: np.ndarray) -> Shift:
        """次の画像を追加する. 戻り値の kind: ok(つないだ) / unchanged(末尾) / rejected(位置が測れない)."""
        assert self._prev is not None, "begin() を先に呼んでください"
        cal = self.cal
        fp, blank = self._fingerprint(frame)
        shift = measure_shift(self._prev_fp, fp, self._prev_blank, cal.band_top, cal.band_bottom, cal.scale)
        self.shifts.append(shift)
        if shift.kind != "ok":
            return shift
        cut = self._choose_cut(self._prev, self._prev_blank, self._offset, self._cut)
        self._emit(self._prev, self._offset, self._cut, cut)
        self._cut = cut
        self._offset += shift.d
        self._prev, self._prev_fp, self._prev_blank = frame, fp, blank
        self.n_frames += 1
        return shift

    def finish(self) -> None:
        """末尾の画像の残りを追加する(＋ボタンの範囲は背景色にする)."""
        assert self._prev is not None
        cal = self.cal
        end = self._offset + cal.frame_h
        # 末尾では、＋ボタンの下(帯の外)にも本物の内容がある。ボタン自身の矩形だけを塗りつぶして、残りを使う
        self._emit(self._prev, self._offset, self._cut, end, mask_fab=True)
        self._cut = end

    # -- 取り出し --
    def crop(self, y0: int, y1: int) -> np.ndarray:
        """縦長画像の [y0, y1) を組み立てる."""
        y0, y1 = max(0, y0), min(self.height, y1)
        out = np.empty((max(0, y1 - y0), self.cal.frame_w, 3), dtype=np.uint8)
        out[:] = BG.astype(np.uint8)
        for p in self.pieces:
            lo, hi = max(y0, p.dst_y0), min(y1, p.dst_y0 + (p.src_y1 - p.src_y0))
            if hi <= lo:
                continue
            arr = np.load(p.path, mmap_mode="r")
            out[lo - y0: hi - y0] = arr[lo - p.dst_y0: hi - p.dst_y0]
        return out

    def tiles(self, tile_h: int, overlap: int, offset: int = 0) -> Iterator[tuple[int, np.ndarray]]:
        """OCR用のタイル (y0, 画像). offset で境目をずらせる."""
        starts = ([0] if offset else []) + list(range(offset, max(self.height, 1), tile_h - overlap))
        seen = set()
        for y0 in starts:
            if y0 in seen or y0 >= self.height:
                continue
            seen.add(y0)
            yield y0, self.crop(y0, y0 + tile_h)

    def close(self) -> None:
        if self._own_dir:
            shutil.rmtree(self.workdir, ignore_errors=True)


# ---------------- 下へ撮り進める ----------------
@dataclass
class ScanResult:
    stitcher: Stitcher
    frames: int
    rejected: int
    reached_end: bool


def scan_down(src: FrameSource, cal: Calibration, first: np.ndarray, *, max_frames: int = 1500,
              target_fraction: float = 0.55, on_frame: Callable[[int], None] | None = None,
              stop: Callable[[np.ndarray, int], bool] | None = None, workdir: str | None = None) -> ScanResult:
    """先頭の画像から、末尾(または stop が True を返した画像)まで、下へ撮り進めてつなぐ.

    歩幅は、帯の高さの target_fraction 倍のずれになるように、測ったずれ幅から調整する。
    位置を測れなかった画像は捨て、歩幅を半分にして、少し戻ってから撮り直す。3回続けて失敗したら CaptureError。
    """
    st = Stitcher(cal, workdir)
    st.begin(first)
    step = max(3, round(cal.band_h * target_fraction / cal.px_per_line))
    fails = end_hits = rejected = 0
    frames = 1
    try:
        while frames < max_frames:
            src.scroll(step)
            frame = src.grab()
            res = st.add(frame)
            frames += 1
            if on_frame:
                on_frame(frames)
            if res.kind == "ok":
                fails = end_hits = 0
                if stop and stop(frame, st._offset):        # 第2引数: この画像の先頭行の、最初の画像を0とした内容上の位置(px)
                    st.finish()
                    return ScanResult(st, frames, rejected, False)
                step = max(3, min(40, round(cal.band_h * target_fraction / max(1.0, res.d / max(1, step)))))
            elif res.kind == "unchanged":
                end_hits += 1
                if end_hits >= 2:
                    st.finish()
                    return ScanResult(st, frames, rejected, True)
            else:
                rejected += 1
                fails += 1
                if fails >= MAX_FAILS:
                    raise CaptureError(f"画像の位置を{MAX_FAILS}回続けて測れませんでした({res.reason})。撮影を中止します")
                src.scroll(-step)                    # 直前に受け入れた位置まで戻り、歩幅を半分にしてやり直す
                step = max(3, step // 2)
        raise CaptureError("撮影枚数の上限に達しました")
    except BaseException:
        st.close()
        raise
