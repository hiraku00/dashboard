"""画面全体の読み(土台)を、タイルの読みで穴埋めする(tallocr.fill_gaps)。土台の行は一切変えない."""
from line_openchat import parse as P
from line_openchat import tallocr
from line_openchat.screen import Line
from sim import SimChat, SimNote


def test_base_lines_are_kept_as_they_are_and_only_lines_in_the_gaps_are_added():
    base = [Line("本文1", 15, 100, 200, 14), Line("本文3", 15, 140, 200, 14)]
    extra = [Line("本文1(タイルの読み)", 16, 101, 210, 14, 0.9),   # 土台と同じ場所: 足さない
             Line("本文2", 15, 120, 200, 14)]                        # 土台が読み落とした場所: 足す
    out = tallocr.fill_gaps(base, extra)
    assert [l.text for l in out] == ["本文1", "本文2", "本文3"]
    assert out[0] is base[0] and out[2] is base[1]                   # 土台の行は、同じ物がそのまま残る


def test_a_line_that_overlaps_a_base_line_only_partly_is_not_added():
    """同じ行を全体とタイルで違う切れ目に読んだもの(左だけ・全体)を両方残すと、merge_fragments で1行につながって文字が重複する."""
    base = [Line("9.23 午後", 15, 456, 50, 13)]
    extra = [Line("9.23 午後 11:27", 15, 455, 80, 14)]
    assert [l.text for l in tallocr.fill_gaps(base, extra)] == ["9.23 午後"]


def test_lines_on_neighbouring_rows_are_not_the_same_place():
    base = [Line("上の行", 15, 100, 300, 14)]
    extra = [Line("下の行", 15, 115, 300, 14)]                       # 1ptだけ重なる隣の行
    assert [l.text for l in tallocr.fill_gaps(base, extra)] == ["上の行", "下の行"]


def test_a_line_on_the_same_row_but_apart_is_added():
    base = [Line("C 111", 19, 429, 30, 14)]
    extra = [Line("66", 84, 432, 14, 12)]
    assert [l.text for l in tallocr.fill_gaps(base, extra)] == ["C 111", "66"]


def test_extra_lines_read_twice_are_added_once_preferring_the_one_readable_as_time():
    extra = [Line("9.23 午後 11:2フ", 15, 456, 80, 14, 1.0), Line("9.23 午後 11:27", 15, 456, 80, 14, 0.5)]
    out = tallocr.fill_gaps([], extra)
    assert [l.text for l in out] == ["9.23 午後 11:27"]


def test_time_rows_missed_by_the_whole_screen_read_are_restored_from_the_tiles():
    """2026-10-10 Naozo: 全体の読みが、Naozo と ちきりん の時刻の行を読み落とし、3つの投稿が1つに合体して、
    「作者と本文は Naozo、時刻と件数は和泉」の読み取りになった。タイルの読みで穴を埋めれば、3つに分かれる."""
    chat = SimChat([SimNote("Naozo", "Naozoの本文です。", "9.23 午後 11:27", reactions=111),
                    SimNote("ちきりん", "ちきりんの本文です。", "9.23 午後 9:46", reactions=126, badge=True),
                    SimNote("和泉", "和泉の本文です。", "9.23 午後 12:59", reactions=49)], jitter=False)
    screen = chat.screen()
    whole = list(screen.lines)
    lost = [l for l in whole if l.text in ("9.23 午後 11:27", "9.23 午後 9:46")]
    assert len(lost) == 2
    screen.lines = [l for l in whole if l not in lost]
    merged = [b for b in P.split_blocks(screen) if b.kind == "note"]
    assert len(merged) == 1 and not merged[0].complete                # 読み落としたままだと合体する
    tiles = [Line(l.text + "", l.x + 0.4, l.y + 0.3, l.w, l.h, 0.8) for l in whole]   # タイルの読み(座標が少しずれる)
    screen.lines = tallocr.fill_gaps(screen.lines, tiles)
    notes = [b for b in P.split_blocks(screen) if b.kind == "note"]
    assert [(b.author, b.time_raw, b.complete) for b in notes] == [
        ("Naozo", "9.23 午後 11:27", True), ("ちきりん", "9.23 午後 9:46", True), ("和泉", "9.23 午後 12:59", True)]
    assert len(screen.lines) == len(whole)                           # 同じ行が2重にならない
