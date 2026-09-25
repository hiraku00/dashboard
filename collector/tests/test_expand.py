"""「もっと見る」で本文を開いたら投稿が縦に長くなり、末尾(時刻行)が画面の下にはみ出す(実機で確認した形)."""
from line_openchat.ledger import Ledger
from line_openchat.parse import split_blocks
from line_openchat.session import Options, Session, note_obs
from sim import SimChat, SimComment, SimDriver, SimNote
from test_session import NOW

BODY = "長い本文の一文です。数字や固有名詞を入れずに、感想を書き連ねます。" * 26


def make(chat):
    ledger = Ledger()
    return Session(SimDriver(chat), ledger, NOW, Options(first_run=True)), ledger


def target_chat():
    notes = [SimNote(f"参加者{i}", f"短い投稿{i}の本文です。", "昨日 午前 9:45", reactions=3) for i in range(4)]
    notes.append(SimNote("ちきりん", BODY, "昨日 午後 9:46", badge=True, long_body=True, reactions=39,
                         comments=[SimComment("ちきりん", "補足のコメントです。別の話題について書きます。", "3時間前", badge=True)]))
    notes.append(SimNote("参加者9", "最後の短い投稿です。", "9.21 午後 7:57", reactions=3))
    return SimChat(notes, jitter=False)


def scroll_to_more_button(chat, screen_y):
    """対象ノートの「もっと見る」が、画面のyの位置に来るようにスクロールする."""
    _, _, _, _, _, zones = chat._doc()
    y = next(z[2] for z in zones if z[0] == "more")
    chat.scroll_y = y - screen_y


def test_time_row_is_off_screen_after_expanding_near_the_bottom():
    """前提の確認: 開くと末尾が画面の外に出て、そのままでは投稿として認識できない."""
    chat = target_chat()
    scroll_to_more_button(chat, 900)
    assert any(b.kind == "note" and b.author == "ちきりん" and b.complete and b.more_y for b in split_blocks(chat.screen()))
    chat.click_at("click", 60, 900 + 6)
    after = split_blocks(chat.screen())
    assert not any(b.kind == "note" and b.author == "ちきりん" for b in after), "末尾が見えているなら、この再現になっていない"


def test_expand_body_scrolls_down_until_the_end_of_the_note_is_visible():
    chat = target_chat()
    scroll_to_more_button(chat, 900)
    session, ledger = make(chat)
    screen, blocks = session.shot()
    block = next(b for b in blocks if b.kind == "note" and b.author == "ちきりん")
    note, _ = ledger.upsert_note(note_obs(block, NOW), session.now_iso)
    before = len(note["body_text"])
    session._expand_body(note, block, screen)
    assert session.stats.warnings == []
    assert note["body_complete"] and len(note["body_text"]) > before * 2
    assert note["body_text"].count("長い本文の一文です") >= 20


def test_seek_header_moves_toward_a_partly_visible_note_instead_of_searching_upward():
    """見出しの作者行は見えているが、時刻行が画面の下にある。上へ探し続けず、少し下へ進んで見つける."""
    chat = target_chat()
    chat.notes[4].expanded = True
    session, ledger = make(chat)
    lines = chat._doc()[0]
    y_first = next(l.y for l in lines if l.text.startswith("長い本文の一文です"))
    chat.scroll_y = y_first - 800                          # 対象ノートの先頭が、画面の下寄りに写る位置
    _, blocks = session.shot()
    assert not any(b.kind == "note" and b.author == "ちきりん" and b.complete for b in blocks)      # 見出しが揃って見えない
    note, _ = ledger.upsert_note(note_obs(next(b for b in split_blocks(chat.screen()) if b.kind == "note" and b.complete), NOW), session.now_iso)
    note.update({"author_name": "ちきりん", "body_text": BODY[:60], "posted_at": "2026-09-23T12:46:00Z", "posted_at_precision": "exact", "author_is_target": True})
    shots_before = chat.shots
    header, _, _ = session._seek_header(note)
    assert header.author == "ちきりん"
    assert chat.shots - shots_before <= 6, f"{chat.shots - shots_before}回撮影: 遠回りした"
