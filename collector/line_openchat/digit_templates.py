"""リアクション・コメント数の数字の見本(0〜9)を集める(読み取り専用: スクロールと撮影だけ。クリックしない).

  python3 -m line_openchat.digit_templates collect OUT_DIR [--steps 45]   # 一覧を撮って、数字を1桁ずつ切り出す
  python3 -m line_openchat.digit_templates build OUT_DIR                  # 集めた数字から見本を作る(OUT_DIR に保存)

見本は、2桁以上の数字から作る(Visionは2桁以上ならほぼ正確に読むが、1桁だけの画像は読めない・読み違えることがある)。
1桁の数字は、見本の確認用に、読んだ値と一緒に別に保存する。
倍率(Retinaは2、外部ディスプレイは1)ごとに別の見本になる。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from datetime import datetime
from pathlib import Path

import numpy as np

from . import layout as K
from .digits import bright as _bright, runs as _runs


# ---------- 画素だけで、数の行を切り分ける(切り分けの規則は digits.py と共通) ----------
def count_row_glyphs(img: np.ndarray, scale: float, cy: float) -> dict | None:
    """数の行 [😊][数字][💬][数字][共有] から、数字を1桁ずつ切り出す.
    戻り値: {"reactions": [(x0_pt, x1_pt, glyph)], "comments": [...]}(glyph は明るさの配列 uint8)。アイコンが見分けられなければ None."""
    y0, y1 = int(round((cy - 9) * scale)), int(round((cy + 9) * scale))
    row = img[y0:y1, : int(K.COUNTS_SCAN_X_MAX * scale)]
    on = _bright(row)
    clusters = _runs(on.any(axis=0), int(K.COUNT_CLUSTER_GAP * scale))
    if len(clusters) < 3:
        return None
    body = clusters[:-1]                                   # 右端は共有アイコン
    icons = [i for i, (a, e) in enumerate(body) if K.ICON_W_MIN <= (e - a) / scale <= K.ICON_W_MAX]
    if len(icons) < 2 or icons[0] != 0:
        return None
    first, second = icons[0], icons[-1]
    gray = row[..., :3].astype(np.float32).mean(axis=2)

    def glyphs(parts: list[tuple[int, int]]) -> list[tuple[float, float, np.ndarray]]:
        out = []
        for a, e in parts:
            for g0, g1 in _runs(on[:, a:e].any(axis=0), 1):        # 暗い列が1列でもあれば別の桁
                cols = on[:, a + g0: a + g1]
                ys = np.where(cols.any(axis=1))[0]
                glyph = gray[ys[0]: ys[-1] + 1, a + g0: a + g1]
                out.append(((a + g0) / scale, (a + g1) / scale, np.clip(glyph, 0, 255).astype(np.uint8)))
        return out

    return {"reactions": glyphs(body[first + 1: second]), "comments": glyphs(body[second + 1:])}


# ---------- 集める ----------
def _load(path: str) -> np.ndarray:
    from PIL import Image
    return np.asarray(Image.open(path).convert("RGB"))


def _ocr_label(shot, x0: float, x1: float, cy: float, n: int) -> str | None:
    """n 桁(n>=2)の数字を、拡大率を変えて2回読み、同じで桁数が合えば採る."""
    reads = []
    for enlarge in (5, 8):
        t = "".join(ch for ch in shot.ocr_digits(x0 - 1, cy - 9, x1 - x0 + 3, 18, repeat=1, enlarge=enlarge) if ch.isdigit())
        reads.append(t)
    return reads[0] if reads[0] == reads[1] and len(reads[0]) == n else None


def _objects(items: list) -> np.ndarray:
    """大きさの違う配列を、そのまま並べて持つ(np.array に渡すと、形が揃う所まで1つの配列にしようとして失敗する)."""
    arr = np.empty(len(items), dtype=object)
    for i, x in enumerate(items):
        arr[i] = x
    return arr


def collect(out: Path, steps: int, log=print) -> None:
    from . import lineui
    from .parse import split_blocks

    out.mkdir(parents=True, exist_ok=True)
    d = lineui.LineDriver()
    shot = d.shot()
    scale = round(shot._scale, 2)
    log(f"倍率 {scale} / ウィンドウ {d.win.w:.0f}x{d.win.h:.0f}pt")
    for _ in range(40):                                    # 一覧の先頭へ
        d.scroll(-60, wait=0.2)
    time.sleep(0.8)
    labeled: list[dict] = []                               # 2桁以上から、Visionの読みで名前を付けた桁
    singles: list[dict] = []                               # 1桁の数(確認用。名前は read_counts の読み)
    seen_rows: set[tuple] = set()
    prev_sig, same = None, 0
    for _ in range(steps):
        d.pause()
        shot = d.shot()
        img = _load(shot.path)
        blocks = split_blocks(shot)
        for b in blocks:
            if b.kind != "note" or b.counts_y is None:
                continue
            key = (b.author, b.time_raw.replace(" ", ""))
            if key in seen_rows:
                continue
            seen_rows.add(key)
            row = count_row_glyphs(img, shot._scale, b.counts_y)
            if row is None:
                continue
            for kind, value in (("reactions", b.reactions), ("comments", b.comments)):
                gl = row[kind]
                if not gl:
                    continue
                if len(gl) >= 2:
                    label = _ocr_label(shot, gl[0][0], gl[-1][1], b.counts_y, len(gl))
                    if label is None:
                        log(f"  読みが揃わず除外: {b.author} {kind}")
                        continue
                    for ch, (_, _, g) in zip(label, gl):
                        labeled.append({"label": ch, "glyph": g, "src": f"{b.author} {b.time_raw} {kind}={label}"})
                else:
                    singles.append({"label": "" if value is None else str(value), "glyph": gl[0][2],
                                    "src": f"{b.author} {b.time_raw} {kind}"})
        sig = [(b.author, b.time_raw) for b in blocks]
        same = same + 1 if sig == prev_sig else 0
        if same >= 2:
            break
        prev_sig = sig
        d.scroll(12)
    d.close()

    np.savez_compressed(out / "samples.npz", scale=scale,
                        labeled=_objects([s["glyph"] for s in labeled]),
                        labeled_y=np.array([s["label"] for s in labeled]),
                        singles=_objects([s["glyph"] for s in singles]),
                        singles_y=np.array([s["label"] for s in singles]), allow_pickle=True)
    (out / "samples.json").write_text(json.dumps(
        {"scale": scale, "collected_at": datetime.now().astimezone().isoformat(timespec="seconds"),
         "labeled": [{k: v for k, v in s.items() if k != "glyph"} for s in labeled],
         "singles": [{k: v for k, v in s.items() if k != "glyph"} for s in singles]}, ensure_ascii=False, indent=1))
    counts = Counter(s["label"] for s in labeled)
    log(f"見本の候補: {len(labeled)}桁 " + " ".join(f"{k}:{counts.get(k, 0)}" for k in "0123456789")
        + f" / 1桁の数(確認用): {len(singles)}件")


# ---------- 見本を作る ----------
MIN_VARIANT_SAMPLES = 2      # 描かれ方は、これだけ同じものが見つかったら見本にする(1つだけのものは、読み違いの可能性を除けない)


def build(out: Path, log=print) -> None:
    """数字ごとに、描かれ方(画素がまったく同じもの)をまとめ、描かれ方ごとに見本を保存する(OUT_DIR/{倍率}x/{数字}_{番号}.npy)."""
    data = np.load(out / "samples.npz", allow_pickle=True)
    scale = float(data["scale"])
    glyphs, labels = list(data["labeled"]), list(data["labeled_y"])
    tdir = out / f"{int(round(scale))}x"
    tdir.mkdir(parents=True, exist_ok=True)
    for old in tdir.glob("*.npy"):
        old.unlink()
    report = {}
    for digit in "0123456789":
        kinds = Counter((g.shape, g.tobytes()) for g, l in zip(glyphs, labels) if l == digit)
        kept = [(shape, raw, n) for (shape, raw), n in kinds.most_common() if n >= MIN_VARIANT_SAMPLES]
        for i, (shape, raw, _) in enumerate(kept):
            np.save(tdir / f"{digit}_{i}.npy", np.frombuffer(raw, dtype=np.uint8).reshape(shape))
        report[digit] = [{"shape": list(shape), "samples": n} for shape, _, n in kept]
        dropped = sum(kinds.values()) - sum(n for _, _, n in kept)
        log(f"  {digit}: 描かれ方 {len(kept)}通り " + " ".join(f"{s[1]}x{s[0]}px×{n}" for s, _, n in kept)
            + (f"(1つだけの {dropped}個は除外)" if dropped else "") if kept else f"  {digit}: 見本なし")
    (tdir / "report.json").write_text(json.dumps(report, indent=1))
    contact_sheet(out, tdir)


def contact_sheet(out: Path, tdir: Path) -> None:
    """人の目で確かめるための一覧画像: 上段に見本、下に数字ごとの候補、最後に1桁の数(読んだ値つき)."""
    from PIL import Image, ImageDraw
    data = np.load(out / "samples.npz", allow_pickle=True)
    glyphs, labels = list(data["labeled"]), list(data["labeled_y"])
    singles, singles_y = list(data["singles"]), list(data["singles_y"])
    z, cell = 3, 40
    files = sorted(tdir.glob("*_*.npy"))
    rows = [("見本", [np.load(f) for f in files], [f.stem for f in files])]
    for d in "0123456789":
        gs = [g for g, l in zip(glyphs, labels) if l == d][:24]
        rows.append((d, gs, [d] * len(gs)))
    rows.append(("1桁", singles[:24], [s or "?" for s in singles_y[:24]]))
    W = 60 + cell * z * 24 // 3
    H = len(rows) * (cell * z // 2 + 16)
    sheet = Image.new("RGB", (W, H), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    y = 0
    for name, gs, caps in rows:
        draw.text((4, y + 10), name, fill=(0, 0, 0))
        x = 60
        for g, cap in zip(gs, caps):
            if g is not None:
                im = Image.fromarray(g).resize((g.shape[1] * z, g.shape[0] * z), Image.NEAREST)
                sheet.paste(im, (x, y))
            draw.text((x, y + cell * z // 2), cap, fill=(200, 0, 0))
            x += cell * z // 3
        y += cell * z // 2 + 16
    sheet.save(out / "sheet.png")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="数字の見本を集める(読み取り専用)")
    ap.add_argument("cmd", choices=["collect", "build"])
    ap.add_argument("out", type=Path)
    ap.add_argument("--steps", type=int, default=45)
    a = ap.parse_args(argv)
    if a.cmd == "collect":
        collect(a.out, a.steps, log=lambda s: print(s, file=sys.stderr, flush=True))
    else:
        build(a.out, log=lambda s: print(s, file=sys.stderr, flush=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
