from datetime import datetime, timedelta, timezone

from line_openchat.timeparse import (APPROX_HOUR, APPROX_MIN, EXACT, better_time, is_time_text, minutes_between,
                                     parse_display_time, tolerance_minutes)

JST = timezone(timedelta(hours=9))
BKK = timezone(timedelta(hours=7))
NOW = datetime(2026, 9, 24, 12, 0, tzinfo=JST)


def p(raw, now=NOW):
    return parse_display_time(raw, now)


def test_exact_forms():
    assert p("昨日 午後 9:46").utc == "2026-09-23T12:46:00Z"          # JST 21:46 = UTC 12:46
    assert p("昨日 午後 9:46").precision == EXACT
    assert p("一昨日 午前 9:45").utc == "2026-09-22T00:45:00Z"
    assert p("9.21 午後 3:47").utc == "2026-09-21T06:47:00Z"
    assert p("2025.12.3 午前 0:05").utc == "2025-12-02T15:05:00Z"


def test_noon_and_midnight():
    assert p("昨日 午前 12:59").utc == "2026-09-22T15:59:00Z"          # 午前12時台 = 0時台
    assert p("昨日 午後 12:59").utc == "2026-09-23T03:59:00Z"          # 午後12時台 = 12時台


def test_relative_forms_are_approximate():
    t = p("11 時間前")
    assert t.precision == APPROX_HOUR and t.utc == "2026-09-23T16:00:00Z"
    assert p("35分前").precision == APPROX_MIN
    assert p("今").precision == APPROX_MIN


def test_ocr_spacing_variants():
    assert p("昨日午後 11:27").utc == p("昨日 午後 11:27").utc
    assert p("9.21午後2:22").utc == p("9.21 午後 2:22").utc
    assert p("7時間前").utc == p("7 時間前").utc


def test_year_is_previous_when_date_would_be_in_the_future():
    now = datetime(2026, 1, 5, 12, 0, tzinfo=JST)
    assert p("12.30 午後 3:00", now).utc == "2025-12-30T06:00:00Z"


def test_timezone_is_taken_from_now():
    now = datetime(2026, 9, 24, 12, 0, tzinfo=BKK)
    assert p("9.21 午後 3:47", now).utc == "2026-09-21T08:47:00Z"


def test_unreadable_returns_none_and_is_not_time():
    assert p("こんにちは") is None
    assert not is_time_text("こんにちは")
    assert is_time_text("昨日 午後 9:46") and is_time_text("5時間前")


def test_tolerance_and_better_time():
    assert tolerance_minutes(EXACT, APPROX_HOUR) == 90
    assert tolerance_minutes(EXACT, EXACT) == 2
    old = ("2026-09-23T16:00:00Z", APPROX_HOUR)
    exact = ("2026-09-23T15:20:00Z", EXACT)
    assert better_time(old, exact) == exact                 # 概算は正確な値で上書きする
    assert better_time(exact, old) == exact                 # 逆はしない
    assert better_time(old, ("2026-09-23T17:00:00Z", APPROX_HOUR)) == old
    assert minutes_between("2026-09-23T15:20:00Z", "2026-09-23T16:00:00Z") == 40
