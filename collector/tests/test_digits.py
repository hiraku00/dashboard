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


# ---------- 読めなかった数字の診断 ----------
def _shorter(rgb: np.ndarray) -> np.ndarray:
    """数字の上端の1行を背景色にして、塊の高さを見本(19px)より1px低くした画像(表示位置の端数で、字の端が暗くなった状態の模擬)."""
    out = rgb.copy()
    on = digits.bright(out)
    top = np.where(on.any(axis=1))[0][0]
    out[top] = np.array([0x2D, 0x2E, 0x30], dtype=np.uint8)
    return out


def test_diagnose_names_a_height_mismatch():
    img = _shorter(_render("1"))
    assert digits.read_number(img, 2.0) is None
    d = digits.diagnose(img, 2.0)
    assert "高さ" in d["reason"] and d["glyphs"][0]["h"] == 18 and d["glyphs"][0]["height_in_templates"] is False


def test_diagnose_names_missing_templates_and_empty_images():
    assert "見本が無い" in digits.diagnose(_render("1"), 1.0)["reason"]
    assert "塊を切り出せない" in digits.diagnose(np.zeros((20, 20, 3), dtype=np.uint8) + 0x2D, 2.0)["reason"]


class PixelScreen:
    """数字の画像だけを返す Screen(OCRは何も読めない = 見本でも読めない数字の模擬)."""
    scale = 2.0

    def __init__(self, arr):
        self.arr = arr
        self.lines = []

    def pixels(self, x, y, w, h):
        return self.arr

    def pixel(self, x, y):
        return (0x2D, 0x2E, 0x30)

    def ocr_digits(self, *a, **k):
        return ""

    def ocr_region(self, *a, **k):
        return ""


def test_unreadable_digits_are_recorded_labelled_and_dumped(tmp_path):
    digits.reset_stats()
    assert P.read_digits(PixelScreen(_shorter(_render("1"))), 10, 20, 30) is None
    assert digits.STATS["unknown"] == 1 and len(digits.UNREADABLE) == 1
    digits.label_last_unreadable("uva 昨日 午後 4:15")
    lines = digits.dump_unreadable(tmp_path / "unreadable-digits", "20261001T134002")
    assert len(lines) == 1 and "uva 昨日 午後 4:15" in lines[0] and "高さ" in lines[0]
    saved = sorted(p.name for p in (tmp_path / "unreadable-digits").iterdir())
    assert saved == ["20261001T134002-01.json", "20261001T134002-01.npz"]
    assert np.load(tmp_path / "unreadable-digits" / "20261001T134002-01.npz")["pixels"].shape[0] > 0


def test_readable_digits_leave_no_record():
    digits.reset_stats()
    assert P.read_digits(PixelScreen(_render("14")), 10, 20, 30) == 14
    assert digits.UNREADABLE == []


# ---------- 数の行の中心がずれたとき(2026-10-01 uva: 約4.5pt下にずれ、「1」の旗が帯から外れて読めなかった) ----------
@pytest.mark.parametrize("shift", [2.0, 4.5, 6.0, 8.0])
@pytest.mark.parametrize("path", CASES, ids=[p.stem for p in CASES])
def test_reads_counts_when_the_row_center_is_too_low(path, shift):
    reactions, comments, _ = P.read_counts(RowScreen(path), 14.0 + shift)
    assert (reactions, comments) == _truth(path)


def test_a_misplaced_row_is_recentered_and_counted():
    digits.reset_stats()
    P.read_counts(RowScreen(FIX / "r64_c29.png"), 14.0 + 4.5)
    assert digits.STATS["recentered"] == 1
    digits.reset_stats()
    P.read_counts(RowScreen(FIX / "r64_c29.png"), 14.0)
    assert digits.STATS["recentered"] == 0          # 正しい位置なら、読み直さない


def test_failed_attempts_are_not_recorded_when_the_recentered_read_succeeds():
    digits.reset_stats()
    P.read_counts(RowScreen(FIX / "r64_c29.png"), 14.0 + 4.5)
    assert digits.UNREADABLE == [] and digits.STATS["unknown"] == 0 and digits.STATS["recentered"] == 1


def test_a_row_that_cannot_be_read_anywhere_keeps_the_first_attempts_record():
    digits.reset_stats()
    blank = RowScreen(FIX / "r64_c29.png")
    blank.arr = np.zeros_like(blank.arr) + 0x2D
    assert P.read_counts(blank, 14.0) is None and digits.UNREADABLE == []     # 数字の塊が無い(読める数字が無い)なら、記録するものも無い
