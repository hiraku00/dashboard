"""件数の数字を、見本と画素で照合して読む(digits.py / parse.read_counts).

fixtures/counts/ は、実機(Retina, 2026-09-28)で撮った数の行 [😊][数字][💬][数字][共有] の切り出し(横200pt・縦28pt、中心が数の行)。
ファイル名が正解(r=リアクション数, c=コメント数)で、人の目で確かめてある。r47_c6 は、OCRが「6」を「9」と読んだもの。
"""
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from line_openchat import digits, parse as P

FIX = Path(__file__).parent / "fixtures" / "counts"
CASES = sorted(FIX.glob("r*_c*.png"))


class RowScreen:
    """切り出した画像を、parse の関数が使う Screen として見せる. OCRは使わない(見本との照合だけで読めることを確かめる)."""

    def __init__(self, path: Path, scale: float = 2.0):
        self.arr = np.asarray(Image.open(path).convert("RGB"))
        self.scale = scale
        self.width, self.height = self.arr.shape[1] / scale, self.arr.shape[0] / scale
        self.lines = []

    def pixel(self, x, y):
        yy, xx = int(y * self.scale), int(x * self.scale)
        if 0 <= yy < self.arr.shape[0] and 0 <= xx < self.arr.shape[1]:
            return tuple(int(v) for v in self.arr[yy, xx])
        return (0, 0, 0)

    def pixels(self, x, y, w, h):
        s = self.scale
        return self.arr[max(0, int(y * s)):int((y + h) * s), max(0, int(x * s)):int((x + w) * s)]

    def ocr_digits(self, *a, **k):
        return ""

    def ocr_region(self, *a, **k):
        return ""


def _truth(path: Path) -> tuple[int, int]:
    r, c = path.stem.split("_")
    return int(r[1:]), int(c[1:])


@pytest.fixture(autouse=True)
def _no_ocr_verify(monkeypatch):
    monkeypatch.setattr(P, "VERIFY_DIGITS_WITH_OCR", False)
    digits.reset_stats()


def test_fixtures_exist():
    assert len(CASES) >= 10


@pytest.mark.parametrize("path", CASES, ids=[p.stem for p in CASES])
def test_reads_real_count_rows_without_ocr(path):
    reactions, comments, _ = P.read_counts(RowScreen(path), 14.0)
    assert (reactions, comments) == _truth(path)


def test_counts_are_read_by_template_not_ocr():
    for path in CASES:
        P.read_counts(RowScreen(path), 14.0)
    assert digits.STATS["template"] > 0 and digits.STATS["ocr"] == 0 and digits.STATS["unknown"] == 0


def test_six_is_not_read_as_nine():
    reactions, comments, _ = P.read_counts(RowScreen(FIX / "r47_c6.png"), 14.0)
    assert comments == 6


# ---------- 見本を並べて作った数字 ----------
T = digits.templates(2)


def _render(text: str, gap: int = 1, pad: int = 6) -> np.ndarray:
    """見本を gap(px) 空けて並べ、背景色の上に描いた RGB 画像(実機の数字と同じ描き方: 明るい字・暗い背景)."""
    glyphs = [T[ch][0] for ch in text]
    h = glyphs[0].shape[0]
    w = sum(g.shape[1] for g in glyphs) + gap * (len(glyphs) - 1) + 2 * pad
    gray = np.zeros((h + 2 * pad, w), dtype=np.float32)
    x = pad
    for g in glyphs:
        gray[pad:pad + h, x:x + g.shape[1]] = np.maximum(gray[pad:pad + h, x:x + g.shape[1]], g)
        x += g.shape[1] + gap
    bg = np.array([0x2D, 0x2E, 0x30], dtype=np.float32)
    rgb = np.maximum(bg, gray[..., None])
    return rgb.astype(np.uint8)


@pytest.mark.parametrize("text", list("0123456789") + ["10", "11", "14", "41", "111", "404", "69", "96"])
def test_separated_digits(text):
    assert digits.read_number(_render(text, gap=1), 2.0) == int(text)


def test_every_variant_of_a_digit_is_read():
    """4 と 9 は描かれ方が2通りある(実機で「414」の2つ目の4が、1つ目と違う画素だった)."""
    for k, variants in T.items():
        for t in variants:
            bg = np.array([0x2D, 0x2E, 0x30], dtype=np.float32)
            rgb = np.full((t.shape[0] + 12, t.shape[1] + 12, 3), bg, dtype=np.float32)
            rgb[6:-6, 6:-6] = np.maximum(bg, t.astype(np.float32)[..., None])
            assert digits.read_number(rgb.astype(np.uint8), 2.0) == int(k)


@pytest.mark.parametrize("text", ["11", "14", "41", "44", "64", "84", "19", "71"])
@pytest.mark.parametrize("gap", [0, -1])
def test_touching_digits_are_read_as_a_pair(text, gap):
    """隣り合う数字が接して1つの塊になっても読む(実機で「84」「64」「44」が接していた)."""
    assert digits.read_number(_render(text, gap=gap), 2.0) == int(text)


def test_one_is_distinguished_by_its_narrow_width():
    assert T["1"][0].shape[1] < min(t.shape[1] for k in "023456789" for t in T[k]) / 2
    assert digits.read_number(_render("1"), 2.0) == 1


def test_no_templates_for_other_scales():
    assert digits.read_number(_render("5"), 1.0) is None
    assert digits.read_number(_render("5"), 1.5) is None


def test_rejects_non_digits():
    noise = np.full((31, 20, 3), 0x2D, dtype=np.uint8)
    noise[6:25, 6:14] = 255                                     # 数字でない四角
    assert digits.read_number(noise, 2.0) is None
