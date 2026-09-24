"""画面(1枚のスクリーンショット)の抽象. 実機は lineui.py、テストは tests/sim.py が実装する."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass
class Line:
    """OCRで読んだ1行. 座標はウィンドウ内のpt(yは行の上端)."""
    text: str
    x: float
    y: float
    w: float
    h: float
    conf: float = 1.0

    @property
    def cy(self) -> float:
        return self.y + self.h / 2


class Screen(Protocol):
    width: float
    height: float
    lines: list[Line]

    def pixel(self, x: float, y: float) -> tuple[int, int, int]:
        """ウィンドウ座標(pt)のRGB."""

    def text_center_x(self, line: Line, needle: str) -> float:
        """line の中で needle(例: 「もっと見る」)が写っている位置の中心x. 本文の最後の行に「もっと見る」が
        続く場合に、本文ではなくボタンの文字を押すため."""

    def ocr_region(self, x: float, y: float, w: float, h: float) -> str:
        """矩形だけを読み直す(短い名前の取りこぼし対策)."""

    def ocr_digits(self, x: float, y: float, w: float, h: float, repeat: int = 1) -> str:
        """小さい数字用: 拡大・余白付きで読む. repeat>1 なら同じ画像を横に並べて読む."""
