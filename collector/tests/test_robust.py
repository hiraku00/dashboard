"""実機で起きた、読み取りの不安定さ(数字の誤読・時刻の行の読み落とし)でも、往復し続けず、有限回で終わる."""
import pytest

from line_openchat.ledger import Ledger
from line_openchat.parse import clock_like, split_blocks
from line_openchat.session import Options, Session
from sim import SimChat, SimComment, SimDriver, SimNote
from test_session import NOW, comments, run


def one_note_chat(n=8, **kw):
    return SimChat([SimNote("花子", "9/16 番組の感想", "昨日 午前 9:45", reactions=39, comments=comments(n, "R")),
                    SimNote("太郎", "次の投稿です。", "昨日 午前 8:00", reactions=3)], jitter=False, **kw)


@pytest.mark.parametrize("garbage", ["999", "666", "1234", "66", ""])
def test_digits_that_do_not_fit_the_cluster_width_are_unknown_not_a_wrong_count(garbage):
    """表示が「6」(1桁)なのに、「999」など、桁数の合わない読みは、誤読として捨てる(以前は件数不一致→全件やり直しを繰り返した)."""
    chat = one_note_chat(6)
    chat.digit_garbage = garbage
    note = next(b for b in split_blocks(chat.screen()) if b.kind == "note")
    assert note.comments is None


def test_consistent_digits_are_accepted():
    chat = one_note_chat(6)
    chat.digit_garbage = "6 6 6"
    assert next(b for b in split_blocks(chat.screen()) if b.kind == "note").comments == 6


def test_a_garbled_count_does_not_trigger_a_full_reread_or_a_false_mismatch():
    chat = one_note_chat(8)
    chat.digit_garbage = "999"
    ledger, stats = run(chat)
    note = next(n for n in ledger.notes if n["author_name"] == "花子")
    assert len(note["comments"]) == 8 and not note["needs_recheck"]
    assert not any("件数不一致" in w for w in stats.warnings)


def test_clock_like_lines():
    assert clock_like("昨日 午復 9:32") and clock_like("5時問前") and clock_like("2時間前") and clock_like("9月21日(月) 午後10:30")
    assert not clock_like("この番組を見て、とても考えさせられました。ありがとうございました。")
    assert not clock_like("")


def test_a_comment_whose_time_row_is_misread_is_flagged():
    chat = one_note_chat(4)
    chat.corrupt = lambda y: True
    chat.corrupt_only = {"2時間前"}                   # 2件目だけ、時刻の行が読めない → 1件目と2件目が1つの塊に混ざる
    chat.notes[0].open = True
    blocks = split_blocks(chat.screen())
    merged = [b for b in blocks if b.kind == "comment" and b.suspicious]
    assert merged, [(b.kind, b.author, b.time_raw) for b in blocks]


def test_intermittent_misreading_is_worked_around_by_shifting_the_scroll_position():
    """位置によって時刻の行を読み落とす(実機で確認)。位置を少しずらして撮り直せば、全件読める."""
    chat = one_note_chat(14)
    chat.corrupt = lambda y: int(y) // 70 % 3 == 0
    ledger, stats = run(chat)
    note = next(n for n in ledger.notes if n["author_name"] == "花子")
    assert len(note["comments"]) == 14, stats.warnings
    assert chat.shots < 200
