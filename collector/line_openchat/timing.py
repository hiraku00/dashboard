"""実行時間の内訳を測る(動作は一切変えない. 速度の改善が効いたかを、同じ物差しで前後比較するため)."""
from __future__ import annotations

import time
from contextlib import contextmanager

TOTALS: dict[str, float] = {}
COUNTS: dict[str, int] = {}


def reset() -> None:
    TOTALS.clear()
    COUNTS.clear()


@contextmanager
def span(name: str):
    t0 = time.perf_counter()
    try:
        yield
    finally:
        TOTALS[name] = TOTALS.get(name, 0.0) + time.perf_counter() - t0
        COUNTS[name] = COUNTS.get(name, 0) + 1


def sleep(name: str, seconds: float) -> None:
    with span(name):
        time.sleep(seconds)


def report() -> str:
    """「名前 合計秒(回数)」を、合計の大きい順に並べた1行."""
    return " / ".join(f"{k} {v:.0f}秒({COUNTS[k]}回)" for k, v in sorted(TOTALS.items(), key=lambda kv: -kv[1]) if v >= 0.5)
