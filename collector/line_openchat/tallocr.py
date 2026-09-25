"""縦長の画像を、重なり付きのタイルに分けてOCRし、行を画像全体の座標(pt)で返す(macOSのVision).

設計は docs/openchat-capture-design.md §6。Shottrの縦長画像(1倍・幅400・高さ51,644px)で検証した方式:
- タイルは1,000pt、重なり200pt。各タイルで、中央寄りの行だけを採用する(端で切れた行を避ける)。
- タイルの境目を半分ずらして、もう1回読み、同じ位置の行は信頼度の高い方を採る
  (境目の近くで、Visionが行を読み落とすことがあったため。ちきりんのコメントの時刻の行が抜けた)。
"""
from __future__ import annotations

import os
import tempfile
from typing import Iterator, Protocol

import numpy as np

from .screen import Line
from .timeparse import is_time_text

TILE_PT = 1000
OVERLAP_PT = 200
# Retina(2倍)では、2000pxを超える縦長のタイルで、Visionが行を大量に読み落とす(実機で、本文の7行が丸ごと消えた。
# 1000pxのタイルなら読める)。タイルの高さは、画素で見て1,000〜1,500pxに収める
MAX_TILE_PX = 1000


class TallImage(Protocol):
    height: int          # px

    def crop(self, y0: int, y1: int) -> np.ndarray: ...


class ArrayTall:
    """numpy配列(RGB)を、TallImage として扱う(画像ファイルの検証用)."""

    def __init__(self, array: np.ndarray):
        self.array = array
        self.height = array.shape[0]
        self.width = array.shape[1]

    def crop(self, y0: int, y1: int) -> np.ndarray:
        return self.array[max(0, y0):min(self.height, y1)]


def load_image(path: str) -> ArrayTall:
    from PIL import Image
    return ArrayTall(np.asarray(Image.open(path).convert("RGB")))


def _recognize(png_path: str, langs=("ja-JP", "en-US"), correction: bool = True) -> list[tuple[str, float, float, float, float, float]]:
    import Vision
    from Foundation import NSURL
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setRecognitionLanguages_(list(langs))
    req.setUsesLanguageCorrection_(correction)
    Vision.VNImageRequestHandler.alloc().initWithURL_options_(NSURL.fileURLWithPath_(png_path), None).performRequests_error_([req], None)
    out = []
    for o in req.results() or []:
        c = o.topCandidates_(1)[0]
        b = o.boundingBox()
        out.append((str(c.string()), b.origin.x, 1 - b.origin.y - b.size.height, b.size.width, b.size.height, float(c.confidence())))
    return out


def ocr_tile(tile: np.ndarray, enlarge: int) -> list[tuple[str, float, float, float, float, float]]:
    """1つのタイルを、enlarge 倍に拡大して読む. 座標は 0〜1 の比率(左上が原点)."""
    from PIL import Image
    img = Image.fromarray(tile)
    if enlarge > 1:
        img = img.resize((img.width * enlarge, img.height * enlarge), Image.LANCZOS)
    fd, path = tempfile.mkstemp(suffix=".png", prefix="linetile-")
    os.close(fd)
    try:
        img.save(path)
        return _recognize(path)
    finally:
        os.unlink(path)


def _starts(height: int, tile: int, overlap: int, offset: int) -> list[int]:
    if height <= 0:
        return []
    starts = ([0] if offset else []) + list(range(offset, height, tile - overlap))
    seen, out = set(), []
    for y in starts:
        if y not in seen and y < height:
            seen.add(y)
            out.append(y)
    return out


def tile_sizes(scale: float) -> tuple[int, int]:
    """(タイルの高さpx, 重なりpx)。1倍は従来どおり、2倍は高さを1,000pxまでにする(重なりは高さの2割)."""
    tile = min(int(TILE_PT * scale), MAX_TILE_PX) if scale >= 1.5 else int(TILE_PT * scale)
    return tile, int(tile * OVERLAP_PT / TILE_PT)


def _one_pass(image: TallImage, scale: float, enlarge: int, offset_pt: int, width_px: int) -> Iterator[Line]:
    tile, overlap = tile_sizes(scale)
    starts = _starts(image.height, tile, overlap, int(offset_pt * scale))
    for i, y0 in enumerate(starts):
        arr = image.crop(y0, y0 + tile)
        h = arr.shape[0]
        nxt = starts[i + 1] if i + 1 < len(starts) else image.height
        lo = y0 + (overlap / 2 if y0 > 0 else 0)
        hi = y0 + h if nxt >= image.height else min(y0 + h, nxt + overlap / 2)
        for text, x, y, w, hh, conf in ocr_tile(arr, enlarge):
            cy = y0 + (y + hh / 2) * h
            if lo <= cy < hi:
                yield Line(text, x * width_px / scale, (y0 + y * h) / scale, w * width_px / scale, hh * h / scale, conf)


def _better(new: Line, old: Line) -> bool:
    """同じ位置の2通りの読みのうち、新しい方を採るか. 時刻として読める方を必ず優先する(時刻の行は投稿の区切りなので、
    読み違えると隣のコメントと混ざる)。それ以外は、信頼度が高い方、同じなら長い方。"""
    tn, to = is_time_text(new.text), is_time_text(old.text)
    if tn != to:
        return tn
    return (new.conf, len(new.text)) > (old.conf, len(old.text))


def ocr_tall(image: TallImage, width_px: int, scale: float, enlarge: int | None = None) -> list[Line]:
    """縦長の画像全体を読む. 戻り値は、画像全体の座標(pt)で上から順の行."""
    enlarge = enlarge if enlarge is not None else (3 if scale < 1.5 else 1)
    merged: list[Line] = []
    buckets: dict[int, list[int]] = {}            # y(5ptごと) → merged の位置。同じ位置の行を、全件を舐めずに探す
    tile_px, overlap_px = tile_sizes(scale)
    for pass_offset in (0, int((tile_px - overlap_px) / scale) // 2):
        for line in _one_pass(image, scale, enlarge, pass_offset, width_px):
            cy = line.y + line.h / 2
            k = int(cy // 5)
            dup_i = next((i for kk in (k - 1, k, k + 1) for i in buckets.get(kk, [])
                          if abs(merged[i].y + merged[i].h / 2 - cy) < 5 and abs(merged[i].x - line.x) < 20), None)
            if dup_i is None:
                buckets.setdefault(k, []).append(len(merged))
                merged.append(line)
            elif _better(line, merged[dup_i]):
                merged[dup_i] = line
    merged.sort(key=lambda l: (round(l.y / 4), l.x))
    return merged


def _ocr_png(img, langs, correction) -> str:
    fd, path = tempfile.mkstemp(suffix=".png", prefix="linesmall-")
    os.close(fd)
    try:
        img.save(path)
        return " ".join(t for t, *_ in _recognize(path, langs, correction))
    finally:
        os.unlink(path)


def ocr_digits_array(arr: np.ndarray, gx: float, gy: float, gw: float, gh: float, repeat: int = 1, enlarge: int = 5) -> str:
    """小さな数字用: 切り出して拡大し、周りに背景色の余白を付け、同じ画像を repeat 個横に並べて読む(1桁の数字はそのままだと読まれない)."""
    from PIL import Image
    if arr.size == 0:
        return ""
    h, w = arr.shape[:2]
    pad = 12
    canvas = np.empty((h + 2 * pad, w * repeat + pad * (repeat + 1), 3), dtype=np.uint8)
    canvas[:] = (0x2D, 0x2E, 0x30)
    for i in range(repeat):
        x0 = pad + i * (w + pad)
        canvas[pad:pad + h, x0:x0 + w] = arr
    img = Image.fromarray(canvas)
    img = img.resize((img.width * enlarge, img.height * enlarge), Image.LANCZOS)
    return _ocr_png(img, ("en-US",), False)


def ocr_name_array(arr: np.ndarray, gx: float, gy: float, gw: float, gh: float, enlarge: int = 3) -> str:
    """作者名の行だけを読み直す(OCRが名前の行を読み落としたとき)."""
    from PIL import Image
    if arr.size == 0:
        return ""
    img = Image.fromarray(arr)
    img = img.resize((img.width * enlarge, img.height * enlarge), Image.LANCZOS)
    return _ocr_png(img, ("ja-JP", "en-US"), False)


def ocr_lines_array(arr: np.ndarray, gx: float, gy: float, gw: float, gh: float, enlarge: int = 3,
                    langs=("ja-JP", "en-US"), correction: bool = False) -> list[tuple[str, float, float, float, float]]:
    """切り出した範囲を読み直し、(文字, x, y, w, h)をpt(切り出しの左上が原点)で返す(時刻の行の読み直し用)."""
    from PIL import Image
    if arr.size == 0:
        return []
    img = Image.fromarray(arr)
    img = img.resize((img.width * enlarge, img.height * enlarge), Image.LANCZOS)
    fd, path = tempfile.mkstemp(suffix=".png", prefix="lineline-")
    os.close(fd)
    try:
        img.save(path)
        return [(text, x * gw, y * gh, w * gw, h * gh) for text, x, y, w, h, _ in _recognize(path, langs, correction)]
    finally:
        os.unlink(path)
