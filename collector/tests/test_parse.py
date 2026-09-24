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
