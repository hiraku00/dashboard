from line_openchat import parse as P
from sim import SimChat, SimComment, SimNote


def blocks_at(chat, y=0.0):
    chat.scroll_y = y
    return P.split_blocks(chat.screen())


def make_chat():
    return SimChat([
        SimNote("参加者F", "9/22放送のドキュメンタリーがとても面白かったのでシェアします。", "11 時間前", reactions=3),
        SimNote("ちきりん", "9月23日の報道特集の真ん中あたり。\n\n鉄道会社が海外に作った工場について", "昨日 午後 9:46", badge=True,
                card="工場ニュース", reactions=75,
                comments=[SimComment("参加者G", "番組の話を思い出しました。", "7時間前"),
                          SimComment("ちきりん", "補足です。", "5時間前", badge=True)], open=True),
        SimNote("参加者E", "ビル名鑑 https://example.com/a", "昨日 午後 12:59", reactions=17),
    ], jitter=False)


def test_notes_and_counts_are_read():
    chat = make_chat()
    chat.notes[1].open = False
    bs = [b for b in blocks_at(chat) if b.kind == "note"]
    assert [b.author for b in bs] == ["参加者F", "ちきりん", "参加者E"]
    assert [b.comments for b in bs] == [0, 2, 0]
    assert bs[1].badge and not bs[0].badge and not bs[2].badge
    assert all(b.complete for b in bs)


def test_paragraphs_and_wrapping():
    bs = [b for b in blocks_at(make_chat()) if b.kind == "note"]
    body = bs[1].text
    assert "\n\n" in body                       # 空行は段落の区切りとして残る
    assert "鉄道会社が海外に作った工場について" in body


def test_link_card_garbage_is_dropped_and_title_kept():
    b = [b for b in blocks_at(make_chat()) if b.kind == "note"][1]
    assert "地球" not in b.text                 # 画像内の文字をOCRが拾ったもの
    assert "工場ニュース" in b.link_title


def test_reaction_row_text_is_not_part_of_body():
    for b in blocks_at(make_chat()):
        assert "@" not in b.text and "山" not in b.text


def test_comment_blocks_have_author_badge_and_body():
    bs = [b for b in blocks_at(make_chat()) if b.kind == "comment"]
    assert [(b.author, b.badge) for b in bs] == [("参加者G", False), ("ちきりん", True)]
    assert bs[0].text == "番組の話を思い出しました。"
    assert bs[1].time_raw == "5時間前"


def test_end_marker_follows_the_last_comment():
    bs = blocks_at(make_chat())
    kinds = [b.kind for b in bs]
    assert kinds[-2:] == ["note", "note"] or "end" in kinds
    i = kinds.index("end")
    assert kinds[i - 1] == "comment"


def test_block_cut_at_top_is_incomplete():
    chat = make_chat()
    bs = blocks_at(chat, 185)                   # ちきりんのアバターが画面の上端で切れる位置
    first = bs[0]
    assert not first.complete


def test_short_author_name_falls_back_to_region_ocr():
    chat = make_chat()
    chat.notes[1].comments[0].author = "K"
    bs = [b for b in blocks_at(chat) if b.kind == "comment"]
    assert bs[0].author in ("K", "?")


import pytest


@pytest.mark.parametrize("share_w", [16.0, 13.5, 12.0])
@pytest.mark.parametrize("reactions,count", [(3, 8), (85, 8), (327, 0), (21, 24), (5, 100)])
def test_counts_are_read_correctly_even_if_the_share_icon_is_narrow(share_w, reactions, count):
    """実機で、共有アイコンが13.5ptと細く、数字の塊と誤認して「8」を「81」と読んだ(件数不一致を繰り返した)."""
    chat = SimChat([SimNote("参加者A", "本文です。", "昨日 午前 9:45", reactions=reactions,
                            comments=[SimComment("参加者B", f"コメント{i}", "1時間前") for i in range(count)])], jitter=False)
    chat.share_w = share_w
    note = next(b for b in blocks_at(chat) if b.kind == "note")
    assert (note.comments, note.comment_icon is not None) == (count, True)


def test_single_digit_count_is_not_lost_when_the_first_ocr_attempt_returns_nothing():
    """1桁の数字は、異なる repeat(横に並べる数)で2回以上一致するまで確定させない。
    ただし、打ち切りの判定にその条件が抜けていて、最初の読み取り(repeat=3)がたまたま失敗し、
    続く2回がどちらも repeat=5 で一致しただけで打ち切ってしまい、確からしい読みを「不明」として捨てていた(実機で発生)。"""
    chat = SimChat([SimNote("参加者A", "本文です。", "昨日 午前 9:45", reactions=25,
                            comments=[SimComment("参加者B", "コメント", "1時間前") for _ in range(8)])], jitter=False)
    chat.digit_flaky_first = True
    note = next(b for b in blocks_at(chat) if b.kind == "note")
    assert note.comments == 8


def test_a_note_whose_time_row_is_missing_is_not_merged_with_the_next_note_into_a_complete_block():
    """途中の投稿の時刻行をOCRが読み落とすと、隣り合う2つの投稿が1つの区切りに合体する。以前は、先頭のアバターの作者名を採り、
    「作者は前のノート・時刻とコメント数は次のノートのもの」という幽霊ノートを完全なブロックとして作った
    (2026-09-29の実機事故: 作者hibye・時刻とコメント数55はNaozo。本番にも送られた)。合体したブロックは完全とは扱わない。"""
    chat = SimChat([SimNote("hibye", "hibyeの本文です。", "昨日 午前 0:14", reactions=11),
                    SimNote("Naozo", "Naozoの本文です。", "一昨日 午後 11:27", reactions=55)], jitter=False)
    screen = chat.screen()
    assert [(b.author, b.complete) for b in P.split_blocks(screen) if b.kind == "note"] == [("hibye", True), ("Naozo", True)]
    screen.lines = [l for l in screen.lines if l.text != "昨日 午前 0:14"]        # hibye自身の時刻行を読み落とした
    notes = [b for b in P.split_blocks(screen) if b.kind == "note"]
    assert notes and not any(b.complete for b in notes), [(b.author, b.time_raw, b.complete) for b in notes]
    assert all(b.suspicious for b in notes)


def test_counts_row_without_any_number_reads_as_zero_reactions_and_zero_comments():
    """リアクションもコメントも0件のノートは、カウント行に数字が1つも無く、アイコン3つだけ(実機で確認: わを 2026-09-29)。
    以前は「読めない」とし、コメント数もコメントアイコンの位置も特定できず、新着ノートが要確認になった。"""
    chat = SimChat([SimNote("わを", "本文です。", "22分前", reactions=0)], jitter=False)
    note = next(b for b in P.split_blocks(chat.screen()) if b.kind == "note")
    assert (note.reactions, note.comments) == (0, 0)
    assert note.comment_icon is not None and note.counts_y is not None


def test_counts_row_with_only_reactions_still_reads_zero_comments():
    chat = SimChat([SimNote("はるも", "本文です。", "1時間前", reactions=5)], jitter=False)
    note = next(b for b in P.split_blocks(chat.screen()) if b.kind == "note")
    assert (note.reactions, note.comments) == (5, 0)
