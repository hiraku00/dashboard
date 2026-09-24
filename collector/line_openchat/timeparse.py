"""LINEの相対・省略表示の時刻 → UTCの時刻と精度."""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

EXACT, APPROX_MIN, APPROX_HOUR = "exact", "approx_min", "approx_hour"

_SPACE = re.compile(r"[\s 　]+")
_REL = re.compile(r"^(\d+)(秒|分|時間)前$")
_DAY = re.compile(r"^(一昨日|昨日)(午[前後])(\d{1,2}):(\d{2})$")
_DATE = re.compile(r"^(?:(\d{4})\.)?(\d{1,2})\.(\d{1,2})(午[前後])(\d{1,2}):(\d{2})$")
_TODAY = re.compile(r"^(午[前後])(\d{1,2}):(\d{2})$")


@dataclass(frozen=True)
class ParsedTime:
    utc: str          # "2026-09-23T14:46:00Z"
    precision: str    # exact | approx_min | approx_hour
    raw: str


def _squash(text: str) -> str:
    return _SPACE.sub("", text)


def is_time_text(text: str) -> bool:
    t = _squash(text)
    return t == "今" or any(r.match(t) for r in (_REL, _DAY, _DATE, _TODAY))


def _hour24(ampm: str, h: str) -> int:
    return int(h) % 12 + (12 if ampm == "午後" else 0)


def _utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:00Z")


def parse_display_time(raw: str, now: datetime) -> ParsedTime | None:
    """`now` はタイムゾーン付き(Macのローカル). 表示が読めなければ None."""
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    t = _squash(raw)
    if t == "今":
        return ParsedTime(_utc(now), APPROX_MIN, raw)
    m = _REL.match(t)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        delta = {"秒": timedelta(seconds=n), "分": timedelta(minutes=n), "時間": timedelta(hours=n)}[unit]
        return ParsedTime(_utc(now - delta), APPROX_HOUR if unit == "時間" else APPROX_MIN, raw)
    m = _DAY.match(t)
    if m:
        day = (now - timedelta(days=2 if m.group(1) == "一昨日" else 1)).date()
        dt = datetime(day.year, day.month, day.day, _hour24(m.group(2), m.group(3)), int(m.group(4)), tzinfo=now.tzinfo)
        return ParsedTime(_utc(dt), EXACT, raw)
    m = _TODAY.match(t)
    if m:  # 実機では未確認の形. 今日の日付とみなす
        dt = now.replace(hour=_hour24(m.group(1), m.group(2)), minute=int(m.group(3)), second=0, microsecond=0)
        return ParsedTime(_utc(dt), EXACT, raw)
    m = _DATE.match(t)
    if m:
        year = int(m.group(1)) if m.group(1) else now.year
        try:
            dt = datetime(year, int(m.group(2)), int(m.group(3)), _hour24(m.group(4), m.group(5)), int(m.group(6)), tzinfo=now.tzinfo)
        except ValueError:
            return None
        if not m.group(1) and dt > now + timedelta(hours=1):  # 年が無い表示が未来になるなら前年
            dt = dt.replace(year=year - 1)
        return ParsedTime(_utc(dt), EXACT, raw)
    return None


def tolerance_minutes(a_precision: str, b_precision: str) -> int:
    """2つの時刻が同じ投稿のものと言える差(分)."""
    if APPROX_HOUR in (a_precision, b_precision):
        return 90
    if APPROX_MIN in (a_precision, b_precision):
        return 5
    return 2      # exactどうし: 時刻の数字の読み違い(2:22→2:20など)を許す


def minutes_between(a_utc: str, b_utc: str) -> float:
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    return abs((datetime.strptime(a_utc, fmt) - datetime.strptime(b_utc, fmt)).total_seconds()) / 60


def better_time(old: tuple[str, str], new: tuple[str, str]) -> tuple[str, str]:
    """(utc, precision) の組のうち、より正確な方を返す. 同じ精度の概算どうしは古い方を残す."""
    rank = {EXACT: 0, APPROX_MIN: 1, APPROX_HOUR: 2}
    if rank[new[1]] < rank[old[1]] or rank[new[1]] == rank[old[1]] == 0:
        return new
    return old
