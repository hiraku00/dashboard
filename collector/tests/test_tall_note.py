"""「もっと見る」で開くと、本文が画面数枚ぶんに伸びるノート(実機で確認: 2026-10-17、資料館を巡った長い感想のノート).
見出し(作者行)と時刻行が同じ画面に入らないので、「見出しから時刻行まで見える」ことを前提にした探し方では見つからない。"""
from line_openchat.ledger import Ledger
from line_openchat.session import Options, Session
from sim import SimChat, SimComment, SimDriver, SimNote
from test_session import NOW, by_author, comments

# 約3,000pt(画面3枚ぶん)の本文。1行目だけを見分けのつく文にし、残りは似た文を並べる
TALL = "先月のものですが、家族で行きたい資料館の番組を見ました。\n\n" + "\n".join(
    f"・展示{i}番目の感想です。印象に残った言葉を書き留めました。" for i in range(90))


def tall_chat(n_comments=9, tall_comment=False):
    cs = comments(n_comments, "T")
    if tall_comment:
        cs[-1] = SimComment("投稿者", "長いコメントです。\n" + "\n".join(f"・{i}つ目の補足を書きます。" for i in range(80)), "1時間前")
    return SimChat([
        SimNote("参加者A", "短い投稿の本文です。", "昨日 午前 9:45", comments=comments(2, "A"), reactions=3),
        SimNote("投稿者", TALL, "3時間前", long_body=True, card="戦争と平和", reactions=13, comments=cs),
        SimNote("参加者B", "最後の短い投稿です。", "9.21 午後 7:57", comments=comments(1, "B"), reactions=3),
    ], jitter=False)


def real_warnings(stats):
    """シミュレーターは画面の重なりを文字で確かめる(実機は画素の動きで確かめる)。画面いっぱいに本文だけが写ると
    重なりを確かめられず「画面が重ならないまま進みました」が出るが、これはシミュレーターだけの事情なので除く."""
    return [w for w in stats.warnings if not w.startswith("画面が重ならないまま進みました")]


def run(chat, ledger=None, logs=None, **opts):
    ledger = ledger or Ledger()
    opts.setdefault("first_run", True)
    s = Session(SimDriver(chat), ledger, NOW, Options(**opts), log=(logs.append if logs is not None else lambda s: None))
    return ledger, s.run()


def test_premise_the_expanded_note_is_taller_than_the_screen():
    chat = tall_chat()
    chat.notes[1].expanded = True
    lines = chat._doc()[0]
    top = next(l.y for l in lines if l.text == "投稿者")
    bottom = next(l.y for l in lines if l.text == "3時間前")
    assert bottom - top > 2.5 * 1130


def test_tall_note_body_and_comments_are_collected():
    chat = tall_chat()
    ledger, stats = run(chat)
    assert real_warnings(stats) == [], stats.warnings
    [note] = by_author(ledger, "投稿者")
    assert note["body_complete"]
    assert "展示89番目の感想" in note["body_text"]
    assert len(note["comments"]) == 9 and note["comment_count"] == 9
    assert not note.get("needs_recheck")
    assert not chat.notes[1].open                                 # 読んだら閉じている
    assert len(by_author(ledger, "参加者B")) == 1                 # 下のノートも飛ばさない
    assert chat.forbidden_clicks == []


def test_tall_note_with_a_tall_comment_is_collected():
    chat = tall_chat(tall_comment=True)
    ledger, stats = run(chat)
    assert real_warnings(stats) == [], stats.warnings
    [note] = by_author(ledger, "投稿者")
    assert len(note["comments"]) == 9
    assert any("79つ目の補足" in c["body_text"] for c in note["comments"])
    assert not chat.notes[1].open
    assert chat.forbidden_clicks == []


def test_tall_note_new_comments_on_second_run():
    chat = tall_chat()
    ledger, _ = run(chat)
    chat.notes[1].comments.append(SimComment("参加者Z", "あとから付いた新しいコメントです。", "1分前"))
    ledger, stats = run(chat, ledger, first_run=False)
    assert real_warnings(stats) == [], stats.warnings
    [note] = by_author(ledger, "投稿者")
    assert len(note["comments"]) == 10
    assert not chat.notes[1].open


def test_second_run_reads_past_the_expanded_tall_note():
    """開いたままの長いノートの本文だけが写る画面が続いても、一覧の末尾に着いたと誤らず、その下のノートまで読む
    (直す前: ブロックが一つも無い画面が2回続くと「末尾に着いた」とみなし、下のノートを読まずに終えていた)."""
    chat = tall_chat()
    ledger, _ = run(chat)
    chat.notes[2].comments.append(SimComment("参加者Y", "下のノートに付いた新しいコメントです。", "2分前"))
    ledger, stats = run(chat, ledger, first_run=False)
    assert real_warnings(stats) == [], stats.warnings
    [below] = by_author(ledger, "参加者B")
    assert len(below["comments"]) == 2


def test_tall_note_with_scroll_jitter():
    for seed in (1, 2, 3):
        chat = tall_chat(tall_comment=True)
        chat.jitter, chat.rng = True, __import__("random").Random(seed)
        ledger, stats = run(chat)
        assert real_warnings(stats) == [], (seed, stats.warnings)
        [note] = by_author(ledger, "投稿者")
        assert len(note["comments"]) == 9 and "展示89番目の感想" in note["body_text"], seed
        assert not chat.notes[1].open


def test_tall_note_without_comments_keeps_the_first_part_and_does_not_retry():
    """コメントが無いと、コメント欄の撮影(全文を取る所)が無い。冒頭だけを残し、取れたものとして扱う(毎回開き直さない)."""
    chat = tall_chat(n_comments=0)
    ledger, stats = run(chat)
    assert [w for w in real_warnings(stats) if "全文を取れませんでした" in w]
    assert len(real_warnings(stats)) == 1, stats.warnings
    [note] = by_author(ledger, "投稿者")
    assert note["body_complete"] and note["body_text"].startswith("先月のものですが")
    assert len(by_author(ledger, "参加者B")) == 1
    _, stats2 = run(chat, ledger, first_run=False)
    assert real_warnings(stats2) == [], stats2.warnings
    assert stats2.notes_opened == 0


def test_hint_is_found_when_ocr_splits_the_first_line_in_two():
    """実機(2026-10-20、こやまぐ): 1行目「10月20日 国際報道パキスタン…」がOCRで「10月20日」と「国際報道パキスタン…」の
    2行に分かれて読まれた。分かれたままでは頭16文字に一致せず、手がかりが無いまま一覧の先頭まで探しに行った."""
    from line_openchat.ledger import Ledger
    from line_openchat.screen import Line
    from line_openchat.session import Options, Session
    from sim import SimChat, SimDriver, SimScreen
    from test_session import NOW
    # 実機の画面(高さ1130)のOCRの行を並べたもの: 作者行の下に1行目、本文が続き、時刻行は画面の下の外
    rows = [(409, 15, 45, "2時間前"), (460, 49, 60, "こやまぐ"), (494, 15, 56, "10月20日"),
            (494, 77, 290, "国際報道パキスタン ガソリン高騰で電動バイク人気"),
            (524, 15, 396, "ガソリン価格が5割以上高騰しているパキスタンで、電動バイクの需要が"),
            (540, 15, 140, "急上昇というニュース。")] + [(570 + 30 * i, 15, 396, f"本文の続きの行です{i}。電動バイクが普及していく話。") for i in range(15)]
    screen = SimScreen([Line(t, x, y, w, 15) for (y, x, w, t) in rows], [])
    session = Session(SimDriver(SimChat([], jitter=False)), Ledger(), NOW, Options())
    note = {"body_text": "10月20日 国際報道パキスタンガソリン高騰で電動バイク人気\n\nガソリン価格が5割以上高騰しているパキスタンで",
            "posted_at": "2026-09-24T01:00:00Z"}
    hint = session._hint_y(screen, [], note)
    assert hint is not None and abs(hint - 494) < 1
    assert session._runs_past_screen(screen, [], hint)          # 見出しの下に時刻行が無い = 画面より長いノートとして扱える
