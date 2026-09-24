from datetime import datetime, timedelta, timezone

import pytest

from line_openchat.ledger import Ledger
from line_openchat.session import Options, Session
from sim import SimChat, SimComment, SimDriver, SimNote

JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 9, 24, 12, 0, tzinfo=JST)


WORDS = ["雨", "鉄道", "選挙", "音楽", "医療", "農業", "宇宙", "教育", "港", "城", "祭り", "映画", "海", "山", "橋", "冬",
         "夏", "料理", "経済", "歴史", "言葉", "地図", "写真", "戦争", "平和", "技術", "家族", "仕事", "学校", "旅"]


def comments(n, prefix="コメント", author="参加者", start=0):
    return [SimComment(f"{author}{i % 7}名", f"{prefix}: {WORDS[(start + i) % 30]}と{WORDS[(start + i * 7 + 3) % 30]}の話が印象に残りました。{i}",
                       f"{(start + i) % 20 + 1}時間前") for i in range(n)]


def build(seed=1, jitter=True):
    return SimChat([
        SimNote("参加者A", "9/16 クローズアップ現代 部屋が借りられない", "昨日 午前 9:45", comments=comments(3, "A"), reactions=39),
        SimNote("ちきりん", "9月23日の報道特集の真ん中あたり。\n\n鉄道会社が海外に作った工場について", "昨日 午後 9:46", badge=True,
                card="工場ニュース", long_body=True, reactions=75,
                comments=[SimComment("参加者G", "番組の話を思い出しました。", "7時間前"),
                          SimComment("ちきりん", "補足: 一つ目のコメントです。", "5時間前", badge=True),
                          SimComment("参加者I", "ほかの人のコメントです。", "4時間前"),
                          SimComment("ちきりん", "補足: 二つ目のコメントです。全く別の文面です。", "3時間前", badge=True)]),
        SimNote("参加者C", "NHKスペシャル シリーズ病への挑戦", "9.21 午後 10:24", comments=comments(24, "P"), reactions=39),
        SimNote("参加者E", "ビル名鑑 https://example.com/a", "9.21 午後 12:59", reactions=17),
        SimNote("ちきりん", "9月16日 BSスペシャル ブレグジター", "9.21 午後 2:22", badge=True, reactions=35,
                comments=[SimComment("ちきりん", "本人のスレッドへの補足です。", "9.21 午後 3:00", badge=True)]),
        SimNote("参加者D", "メッシと私 2026", "9.21 午後 7:57", comments=comments(2, "Y"), reactions=21),
    ], seed=seed, jitter=jitter)


def run(chat, ledger=None, **opts):
    ledger = ledger or Ledger()
    s = Session(SimDriver(chat), ledger, NOW, Options(first_run=True, **opts))
    stats = s.run()
    return ledger, stats


def by_author(ledger, author):
    return [n for n in ledger.notes if n["author_name"] == author]


def test_first_run_collects_all_notes_and_comments():
    chat = build()
    ledger, stats = run(chat)
    assert stats.reached_end and not stats.aborted
    assert len(ledger.notes) == 6
    counts = {(n["author_name"], n["posted_at_raw"]): len(n["comments"]) for n in ledger.notes}
    assert sum(counts.values()) == 3 + 4 + 24 + 0 + 1 + 2
    assert chat.forbidden_clicks == []


def test_target_note_body_is_expanded_and_complete():
    ledger, _ = run(build())
    wbs = [n for n in by_author(ledger, "ちきりん") if n["body_complete"]]
    assert wbs, "ちきりんさんのノートの本文が全文になっていない"
    assert any("鉄道会社" in n["body_text"] for n in wbs)


def test_multiple_comments_by_target_in_one_note_are_kept_separately():
    ledger, _ = run(build())
    wbs = next(n for n in ledger.notes if "報道特集" in n["body_text"])
    mine = [c for c in wbs["comments"] if c["is_target"]]
    assert len(mine) == 2
    assert {c["body_text"][:8] for c in mine} == {"補足: 一つ目の", "補足: 二つ目の"}
    assert wbs["target_comment_count"] == 2


def test_target_thread_with_own_comment():
    ledger, _ = run(build())
    bs = next(n for n in ledger.notes if "ブレグジター" in n["body_text"])
    assert bs["author_is_target"] and bs["target_comment_count"] == 1


def test_non_target_note_with_same_name_but_no_badge_is_not_target():
    chat = build()
    chat.notes[0].author = "ちきりん"          # なりすまし: 名前だけ同じでバッジ無し
    ledger, _ = run(chat)
    n = next(n for n in ledger.notes if "クローズアップ" in n["body_text"])
    assert not n["author_is_target"]


def test_long_thread_uses_load_earlier_and_gets_every_comment():
    ledger, stats = run(build())
    p = next(n for n in ledger.notes if n["author_name"] == "参加者C")
    assert len(p["comments"]) == 24 and p["comment_count"] == 24 and not p["needs_recheck"]
    assert [c["ordinal"] for c in p["comments"]] == list(range(24))
    assert stats.warnings == []


def test_second_run_only_opens_notes_whose_comment_count_changed():
    chat = build()
    ledger, first = run(chat)
    opened_first = first.notes_opened
    assert opened_first >= 4
    chat2 = build(seed=5)
    chat2.notes[5].comments.append(SimComment("新人", "あとから増えたコメントです。", "1時間前"))
    chat2.notes[1].comments.append(SimComment("ちきりん", "後から書いた三つ目のコメントです。別の話題です。", "1時間前", badge=True))
    ledger2, second = run(chat2, ledger=ledger)
    assert second.notes_opened == 2
    wbs = next(n for n in ledger2.notes if "報道特集" in n["body_text"])
    assert wbs["target_comment_count"] == 3
    assert next(n for n in ledger2.notes if n["author_name"] == "参加者D")["comment_count"] == 3


def test_second_run_without_changes_opens_nothing_and_creates_no_duplicates():
    chat = build()
    ledger, _ = run(chat)
    ids = {n["id"] for n in ledger.notes}
    cids = {c["id"] for n in ledger.notes for c in n["comments"]}
    chat2 = build(seed=9)
    ledger2, stats = run(chat2, ledger=ledger)
    assert stats.notes_opened == 0
    assert {n["id"] for n in ledger2.notes} == ids
    assert {c["id"] for n in ledger2.notes for c in n["comments"]} == cids


def test_approx_times_become_exact_on_later_runs():
    chat = build()
    ledger, _ = run(chat)
    wbs = next(n for n in ledger.notes if "報道特集" in n["body_text"])
    assert wbs["posted_at_precision"] == "exact"
    c = next(c for c in wbs["comments"] if c["body_text"].startswith("補足: 一つ目"))
    assert c["posted_at_precision"] == "approx_hour"


def test_deleted_comment_is_marked_only_when_count_matches():
    chat = build()
    ledger, _ = run(chat)
    chat2 = build(seed=3)
    del chat2.notes[5].comments[0]                       # 参加者D のコメントが1件消えた
    ledger2, _ = run(chat2, ledger=ledger)
    y = next(n for n in ledger2.notes if n["author_name"] == "参加者D")
    assert sum(1 for c in y["comments"] if c.get("deleted_at")) == 1
    assert y["comment_count"] == 1


@pytest.mark.parametrize("seed", [1, 2, 3, 4, 5, 6])
def test_scroll_jitter_never_loses_or_duplicates_comments(seed):
    chat = build(seed=seed)
    ledger, stats = run(chat)
    total = sum(len(n["comments"]) for n in ledger.notes)
    assert total == 3 + 4 + 24 + 0 + 1 + 2, stats.warnings
    assert chat.forbidden_clicks == []


def test_only_allowed_clicks_are_made():
    chat = build()
    run(chat)
    assert chat.clicks, "クリックが1回もありません"
    assert chat.forbidden_clicks == []          # リアクションアイコン・入力欄は押していない


@pytest.mark.parametrize("reactions", [3, 21, 327, 1234])
def test_comment_icon_is_found_for_any_number_of_reaction_digits(reactions):
    """コメントアイコンの位置はリアクション数の桁数で動く(1桁〜4桁). どれでも開けて読める."""
    chat = SimChat([SimNote("参加者A", "9/16 クローズアップ現代", "昨日 午前 9:45", reactions=reactions, comments=comments(3, "R"))], jitter=False)
    ledger, stats = run(chat)
    assert len(ledger.notes[0]["comments"]) == 3, stats.warnings
    assert chat.forbidden_clicks == []


def test_more_button_is_pressed_on_the_button_text_not_on_the_body_text():
    """「もっと見る」が本文の最後の行の右端に続く形(実機で見られた)でも、ボタンの文字の位置を押す."""
    chat = SimChat([SimNote("ちきりん", "長い本文です。" * 40, "昨日 午後 9:46", badge=True, long_body=True, comments=[])], jitter=False)
    ledger, stats = run(chat)
    assert ledger.notes[0]["body_complete"] and len(ledger.notes[0]["body_text"]) > 200, stats.warnings
