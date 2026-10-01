"""リアクション・コメント数の数字を、見本の画像(digits/{倍率}x/{数字}_{描かれ方}.npy)と画素で照合して読む.

LINEは同じ数字をほぼ毎回同じ画素で描く(実測: 見本との差0.0。違う数字との差は14以上)。4 と 9 は、表示位置の端数で描かれ方が2通りあるので、見本も描かれ方ごとに持つ。
OCR(Vision)は1桁だけの画像を読めない・読み違える(「6」を「9」)ので、先にこちらで読み、読めなければOCRに戻す。
隣り合う2桁が接して1つの塊になることがある(「84」「64」。幅は1桁の約2倍)。塊は、見本を左から並べた組み合わせで照合する。
見本は digit_templates.py で集める。見本の無い倍率(1倍の外部ディスプレイなど)では None を返す(呼び出し側がOCRで読む)。
"""
from __future__ import annotations

from collections import Counter
from functools import lru_cache
from itertools import product
from pathlib import Path

import numpy as np

from . import layout as K

TEMPLATE_DIR = Path(__file__).resolve().parent / "digits"
MAX_DIFF = 10.0            # 見本との差(明るさの平均の差)がこれ以下なら一致(実測: 正解は0.0〜2.1)
MIN_MARGIN = 8.0           # 2番目に近い読みとの差がこれ以上あること(実測: 14以上)
MAX_DIGITS_PER_GLYPH = 3   # 1つの塊に接して並ぶ数字の最大数
GAPS = (-1, 0, 1)          # 接した数字の間隔(px). -1 は1列重なる

# 読み方の記録(1回の同期ぶん). 同期の最後に、見本で読めた数・OCRに戻った数・両者の食い違いをログに出す
STATS: Counter = Counter()
MISMATCHES: list[str] = []


# 見本でもOCRでも読めなかった数字の記録(1回の同期ぶん). 原因の調査用: 画素と、なぜ見本と合わなかったかを残す(dump_unreadable)
UNREADABLE: list[dict] = []
MAX_UNREADABLE_KEPT = 20      # 1回の同期で残す上限
MAX_DUMP_FILES = 200          # 保存先に残す画像の上限(古いものから消す)


def reset_stats() -> None:
    STATS.clear()
    MISMATCHES.clear()
    UNREADABLE.clear()


@lru_cache(maxsize=None)
def templates(scale_key: int) -> dict[str, list[np.ndarray]] | None:
    """{数字: [描かれ方ごとの見本]}. 同じ数字でも、表示位置の端数で画素の並びが変わるものがある(実測: 4 と 9 は2通り)."""
    d = TEMPLATE_DIR / f"{scale_key}x"
    if not d.is_dir():
        return None
    out = {k: [np.load(f).astype(np.float32) for f in sorted(d.glob(f"{k}_*.npy"))] for k in "0123456789"}
    return out if all(out.values()) else None


def templates_for(scale: float | None) -> dict[str, list[np.ndarray]] | None:
    if not scale or abs(scale - round(scale)) > 0.01:
        return None
    return templates(int(round(scale)))


# ---------- 切り分け ----------
def bright(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., :3].astype(np.int32).sum(axis=2) > K.COUNT_BRIGHT_SUM


def runs(on: np.ndarray, gap: int) -> list[tuple[int, int]]:
    """True の位置のまとまり [x0, x1). 位置の差が gap を超えたら分ける(gap=1 は隣り合う列だけをつなぐ = 暗い列が1列でもあれば分ける)."""
    xs = np.where(on)[0]
    out: list[tuple[int, int]] = []
    if not len(xs):
        return out
    start = prev = int(xs[0])
    for x in xs[1:]:
        x = int(x)
        if x - prev > gap:
            out.append((start, prev + 1))
            start = x
        prev = x
    out.append((start, prev + 1))
    return out


def split_glyphs(rgb: np.ndarray) -> list[np.ndarray]:
    """数字の範囲の画素(RGB)を、暗い列で区切った塊ごとに、明るさの配列(上下は字の外枠で詰める)にする."""
    on = bright(rgb)
    gray = rgb[..., :3].astype(np.float32).mean(axis=2)
    out = []
    for g0, g1 in runs(on.any(axis=0), 1):
        ys = np.where(on[:, g0:g1].any(axis=1))[0]
        out.append(np.clip(gray[ys[0]: ys[-1] + 1, g0:g1], 0, 255).astype(np.uint8))
    return out


# ---------- 照合 ----------
def _compose(seq: tuple[np.ndarray, ...], gaps: tuple[int, ...], h: int, w: int) -> np.ndarray:
    canvas = np.zeros((h, w), dtype=np.float32)
    x = 0
    for i, t in enumerate(seq):
        if i:
            x += gaps[i - 1]
        canvas[:, x: x + t.shape[1]] = np.maximum(canvas[:, x: x + t.shape[1]], t)
        x += t.shape[1]
    return canvas


def glyph_candidates(glyph: np.ndarray, T: dict[str, list[np.ndarray]]) -> list[tuple[float, str]]:
    """1つの塊を、見本を並べた読み(1〜3桁)と比べる. 戻り値: (差, 読み) の近い順(同じ読みは最も近いものだけ)."""
    g = glyph.astype(np.float32)
    h, w = g.shape
    variants = [(k, t) for k, ts in T.items() for t in ts if t.shape[0] == h]
    best: dict[str, float] = {}
    for n in range(1, MAX_DIGITS_PER_GLYPH + 1):
        for combo in product(variants, repeat=n):
            base = sum(t.shape[1] for _, t in combo)
            if base - n + 1 > w or base + n - 1 < w:          # 間隔(-1〜+1px)をどう取っても幅が合わない
                continue
            seq = tuple(t for _, t in combo)
            s = "".join(k for k, _ in combo)
            for gaps in product(GAPS, repeat=n - 1):
                if base + sum(gaps) != w:
                    continue
                d = float(np.abs(g - _compose(seq, gaps, h, w)).mean())
                if d < best.get(s, 1e9):
                    best[s] = d
    return sorted((d, s) for s, d in best.items())


def read_number(rgb: np.ndarray, scale: float | None) -> int | None:
    """数字だけが写った範囲の画素(RGB)を、見本と照合して読む. 読めなければ None."""
    T = templates_for(scale)
    if T is None or rgb.size == 0:
        return None
    glyphs = split_glyphs(rgb)
    if not glyphs:
        return None
    text = ""
    for glyph in glyphs:
        cands = glyph_candidates(glyph, T)
        if not cands or cands[0][0] > MAX_DIFF:
            return None
        if len(cands) > 1 and cands[1][0] - cands[0][0] < MIN_MARGIN:
            return None
        text += cands[0][1]
    return int(text)


# ---------- 読めなかった数字の診断 ----------
def diagnose(rgb: np.ndarray, scale: float | None) -> dict:
    """read_number() が None を返した理由を調べる(読めた/読めないの判定は変えない). 読めない原因が
    「見本が無い」「塊が切れない」「高さが見本と違う」「見本との差が大きい」「2番目の候補と近すぎる」のどれかを分ける."""
    T = templates_for(scale)
    info: dict = {"scale": scale, "shape": list(rgb.shape)}
    if T is None:
        return {**info, "reason": "見本が無い倍率"}
    if rgb.size == 0:
        return {**info, "reason": "画素が空"}
    glyphs = split_glyphs(rgb)
    if not glyphs:
        return {**info, "reason": "明るい画素が無く、塊を切り出せない"}
    template_heights = sorted({int(t.shape[0]) for ts in T.values() for t in ts})
    out = []
    for g in glyphs:
        h, w = g.shape
        cands = glyph_candidates(g, T)
        out.append({"h": int(h), "w": int(w), "height_in_templates": int(h) in template_heights,
                    "candidates": [(round(d, 2), s) for d, s in cands[:3]]})
    first_bad = next((g for g in out if not g["height_in_templates"] or not g["candidates"]
                      or g["candidates"][0][0] > MAX_DIFF
                      or (len(g["candidates"]) > 1 and g["candidates"][1][0] - g["candidates"][0][0] < MIN_MARGIN)), None)
    if first_bad is None:
        reason = "原因不明(診断では読めた)"
    elif not first_bad["height_in_templates"]:
        reason = f"塊の高さ {first_bad['h']}px が見本の高さ {template_heights} と違う"
    elif not first_bad["candidates"]:
        reason = f"幅 {first_bad['w']}px に合う見本の組み合わせが無い"
    elif first_bad["candidates"][0][0] > MAX_DIFF:
        reason = f"最も近い見本でも差が大きい({first_bad['candidates'][0][0]} > {MAX_DIFF})"
    else:
        reason = f"1番目と2番目の候補が近すぎる({first_bad['candidates'][0]} / {first_bad['candidates'][1]})"
    return {**info, "reason": reason, "glyphs": out}


def record_unreadable(rgb: np.ndarray, scale: float | None, x: float, cy: float) -> None:
    """見本でもOCRでも読めなかった数字を、診断つきで記録する(同期の最後に dump_unreadable で保存)."""
    if len(UNREADABLE) >= MAX_UNREADABLE_KEPT:
        return
    try:
        UNREADABLE.append({**diagnose(rgb, scale), "x": round(float(x), 1), "cy": round(float(cy), 1), "label": "", "pixels": np.array(rgb)})
    except Exception as exc:                         # noqa: BLE001 診断の失敗で、読み取り自体を止めない
        UNREADABLE.append({"reason": f"診断に失敗: {exc}", "x": round(float(x), 1), "cy": round(float(cy), 1), "label": ""})


def label_last_unreadable(label: str) -> None:
    """直前に記録した、まだ名前の無い読めなかった数字に、どのノートかを書き添える."""
    for rec in reversed(UNREADABLE):
        if not rec["label"]:
            rec["label"] = label
        break


def dump_unreadable(directory, stamp: str) -> list[str]:
    """記録を、画像(.npz: 画素)と1行の説明にして保存する. 戻り値: ログに出す行."""
    import json
    lines: list[str] = []
    if not UNREADABLE:
        return lines
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    for i, rec in enumerate(UNREADABLE):
        meta = {k: v for k, v in rec.items() if k != "pixels"}
        name = f"{stamp}-{i + 1:02d}"
        if "pixels" in rec:
            np.savez_compressed(directory / f"{name}.npz", pixels=rec["pixels"])
        (directory / f"{name}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
        lines.append(f"読めなかった数字: {rec['label'] or '(ノート不明)'} / {rec['reason']} → {directory.name}/{name}")
    files = sorted(directory.glob("*.*"), key=lambda f: f.stat().st_mtime)
    for f in files[:-MAX_DUMP_FILES]:
        f.unlink(missing_ok=True)
    return lines
