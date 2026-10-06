from datetime import datetime, timedelta, timezone

import pytest

from line_openchat.ledger import Ledger
from line_openchat.parse import Block
from line_openchat.screen import Line
from line_openchat.session import SEEK_STUCK_LIMIT, Options, Session, SessionError
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


def test_scan_logs_before_processing_a_note_that_needs_work():
    """本文を開く・コメント欄を探すなど時間のかかる処理の前に、どのノートを見ているかをログに出す
    (以前は _process_note が終わるまで何もログが出ず、長引くノートがあると進捗が分からなかった)。
    変化の無いノート(2回目以降)では、この事前ログは出ない(毎回全ノート分出ると読みにくいため)。"""
    chat = build(jitter=False)
    ledger = Ledger()
    logs: list[str] = []
    Session(SimDriver(chat), ledger, NOW, Options(first_run=True), log=logs.append).run()
    started = [l for l in logs if l.endswith("を確認しています…")]
    assert started                                              # 初回は全件が「開く必要あり」
    assert any("ちきりん" in l for l in started)

    logs.clear()
    Session(SimDriver(chat), ledger, NOW, Options(first_run=False), log=logs.append).run()
    assert not [l for l in logs if l.endswith("を確認しています…")]   # 2回目、変化が無ければ事前ログも無い


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
    assert wbs, "ちきりんのノートの本文が全文になっていない"
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


def test_non_target_note_with_no_comments_still_gets_its_body_expanded():
    """全スレッドを画面に出すので、ちきりんが関わらず・コメントが無いノートでも「もっと見る」を押して全文を取る."""
    chat = SimChat([SimNote("参加者A", "長い本文です。" * 40, "昨日 午前 9:45", long_body=True, comments=[])], jitter=False)
    ledger, stats = run(chat)
    assert ledger.notes[0]["body_complete"] and len(ledger.notes[0]["body_text"]) > 200, stats.warnings
    assert not ledger.notes[0]["author_is_target"]


def test_unreadable_comment_counts_are_unknown_not_zero():
    """1倍のディスプレイで小さな数字が読めないとき: 0件と取り違えず、コメント欄を開いて全件を読み、件数の照合・削除判定はしない."""
    chat = build(jitter=False)
    chat.digits_unreadable = True
    ledger, stats = run(chat)
    assert sum(len(n["comments"]) for n in ledger.notes) == 3 + 4 + 24 + 0 + 1 + 2
    assert not any(c.get("deleted_at") for n in ledger.notes for c in n["comments"])
    assert any("コメント数を読めませんでした" in w for w in stats.warnings)
    assert all(not n["needs_recheck"] for n in ledger.notes)


def test_unknown_counts_never_mark_comments_deleted_and_are_reread_next_time():
    chat = build(jitter=False)
    chat.digits_unreadable = True
    ledger, _ = run(chat)
    ids = {c["id"] for n in ledger.notes for c in n["comments"]}
    chat2 = build(seed=4)
    chat2.digits_unreadable = True
    del chat2.notes[5].comments[0]                          # 実際には1件消えているが、件数が読めないので削除とは断定しない
    ledger2, stats2 = run(chat2, ledger=ledger)
    assert stats2.notes_opened >= 4                          # 件数が分からないので、毎回開いて確かめる
    assert not any(c.get("deleted_at") for n in ledger2.notes for c in n["comments"])
    assert {c["id"] for n in ledger2.notes for c in n["comments"]} == ids     # 重複も増えない


def test_a_body_warning_is_withdrawn_when_the_capture_reads_the_whole_body():
    """走査の途中で「本文を開けませんでした」と警告したノートでも、撮影した画像で本文が最後まで読めていれば、警告を取り下げる(実機で、全文が取れているのに警告が残った)."""
    from line_openchat.parse import Block
    from line_openchat.session import note_obs
    chat = SimChat([SimNote("参加者A", "9/16 番組の感想\n二行目です。", "昨日 午前 9:45", reactions=3)], jitter=False)
    ledger = Ledger()
    session = Session(SimDriver(chat), ledger, NOW, Options(first_run=True))
    obs = note_obs(Block(kind="note", author="参加者A", time_raw="昨日 午前 9:45", y_top=0, y_time=0, complete=True, lines=[]), NOW)
    note, _ = ledger.upsert_note(obs, "2026-09-24T12:00:00+09:00")
    note["program_title"] = "9/16 番組の感想"
    session.stats.warnings.append(f"本文を開けませんでした: {session._label(note)}")
    session.stats.warnings.append("別の警告")
    full = Block(kind="note", author="参加者A", time_raw="昨日 午前 9:45", y_top=0, y_time=0, complete=True, lines=[])
    session._adopt_full_body(note, full)
    assert session.stats.warnings == ["別の警告"]
    partial = Block(kind="note", author="参加者A", time_raw="昨日 午前 9:45", y_top=0, y_time=0, complete=True, lines=[], more_y=100.0)
    session.stats.warnings.append(f"本文を開けませんでした: {session._label(note)}")
    session._adopt_full_body(note, partial)                      # 「もっと見る」が残っていれば、取り下げない
    assert len(session.stats.warnings) == 2


def test_unchanged_notes_are_not_reopened_on_later_runs():
    """実行のたびにノートウィンドウを閉じる運用(毎回、コメント欄も本文も閉じた状態から始まる)で、
    変化の無いノートを撮影の画像から「表示N件 / 取得0件」と読んで再確認に回し、次の実行で開き直していた(1回おきにほぼ全部を開いた)."""
    chat = build(jitter=False)
    ledger = Ledger()

    def close_window():
        for n in chat.notes:
            n.open = n.expanded = n.earlier_loaded = False
        chat.scroll_y = 0.0

    _, first = run(chat, ledger)
    assert first.notes_opened == 5
    chat.notes[0].comments.append(SimComment("参加者Z", "新しいコメントです。", "1時間前"))
    opened = []
    for _ in range(3):
        close_window()
        s = Session(SimDriver(chat), ledger, NOW, Options(first_run=False))
        stats = s.run()
        opened.append(stats.notes_opened)
        assert not any("走査で見えず" in w for w in stats.warnings), stats.warnings
        assert not any(n["needs_recheck"] for n in ledger.notes)
    assert opened == [1, 0, 0]              # コメントが増えた1件だけを開き、その後は何も開かない
    assert len(by_author(ledger, "参加者A")[0]["comments"]) == 4


def _close_window(chat):
    for n in chat.notes:
        n.open = n.expanded = n.earlier_loaded = False
    chat.scroll_y = 0.0


def _next_run(chat, ledger, first_run=False):
    s = Session(SimDriver(chat), ledger, NOW, Options(first_run=first_run))
    return s, s.run()


def _all_closed(chat) -> bool:
    return not any(n.open for n in chat.notes)


def test_each_changed_thread_is_read_where_it_is_and_closed_before_moving_on():
    """変わったノートは、開いたその場でそのコメント欄だけを撮影して読み、閉じてから次へ進む(毎回閉じて終わる).
    撮影は、ノートの見出しから(一覧の先頭からではなく)、開いたノートの数だけ行う。"""
    chat = build(jitter=False)
    ledger, stats = run(chat)
    assert _all_closed(chat)                                  # 終わったとき、コメント欄はすべて閉じている
    counts = {(n["author_name"], n["posted_at_raw"]): len(n["comments"]) for n in ledger.notes}
    assert sum(counts.values()) == 3 + 4 + 24 + 0 + 1 + 2
    assert not any(n["needs_recheck"] for n in ledger.notes)
    assert chat.forbidden_clicks == []


@pytest.mark.parametrize("changed_index", [0, 2, 5])
def test_consecutive_runs_start_with_all_threads_closed(changed_index):
    """ウィンドウを閉じ直さずに続けて実行しても、前の実行が閉じて終わっているので、次の実行も閉じた状態から始まる
    (以前は開いたまま残り、それが原因の不具合が続いた。テストが毎回閉じ直していて気づけなかった)。"""
    chat = build(jitter=False)
    ledger = Ledger()
    run(chat, ledger)
    assert _all_closed(chat)
    chat.notes[changed_index].comments.append(SimComment("参加者Z", "新しいコメントです。", "1時間前"))
    chat.scroll_y = 0.0                                       # ウィンドウは閉じ直さない
    s, stats = _next_run(chat, ledger)
    assert stats.notes_opened == 1 and stats.comments_new == 1, stats.warnings
    assert not stats.warnings, stats.warnings
    assert len(s.reader.calls) == 1                           # 撮影は、開いた1件ぶんだけ
    assert _all_closed(chat)
    assert not any(n["needs_recheck"] for n in ledger.notes)
    assert len(ledger.notes[changed_index]["comments"]) == len(chat.notes[changed_index].comments)


# ---------- 見出し探索: 本文が似た別の投稿に惑わされない(2026-09-28の実機事故の再発防止) ----------
def test_hint_y_ignores_content_match_with_very_different_time():
    """本文が似ている(内容だけの一致)ノートでも、投稿時刻が大きく違えば手がかりとして使わない.
    実機で、OCRの誤読で作られた重複ノート(本文はほぼ同じ、投稿時刻だけ約1時間41分ズレていた)に
    向けて、見出し探索が延々と迷走したことがあった(_hint_y は今まで内容の一致しか見ていなかった)。"""
    chat = SimChat([SimNote("参加者A", "特徴的な本文の冒頭がここにあります。", "昨日 午前 9:45", reactions=5)], jitter=False)
    s = Session(SimDriver(chat), Ledger(), NOW, Options())
    screen, blocks = s.shot()
    from line_openchat.timeparse import parse_display_time
    posted = parse_display_time("昨日 午前 9:45", NOW).utc

    far = {"body_text": "特徴的な本文の冒頭がここにあります。", "posted_at": "2026-09-01T00:00:00Z"}
    near = {"body_text": "特徴的な本文の冒頭がここにあります。", "posted_at": posted}
    assert s._hint_y(screen, blocks, far) is None                    # 大きくズレている: 手がかりとして使わない
    assert s._hint_y(screen, blocks, near) is not None                # ズレていない: 今までどおり手がかりになる


def test_hint_y_does_not_use_a_url_line_as_the_clue():
    """本文がURLの行から始まるノートは、URLを手がかりにしない(実機で、cosmのノートの見出し探索が、
    頭の16文字が同じ別のNHKリンクの投稿に惑わされて毎回失敗した)。"""
    url = "https://one.nhk/www.web.nhk/tv/pl/series-tep-ABC/ep/XYZ"
    chat = SimChat([SimNote("参加者A", url, "昨日 午前 9:45", reactions=5)], jitter=False)
    s = Session(SimDriver(chat), Ledger(), NOW, Options())
    screen, blocks = s.shot()
    from line_openchat.timeparse import parse_display_time
    posted = parse_display_time("昨日 午前 9:45", NOW).utc
    assert s._hint_y(screen, blocks, {"body_text": url, "posted_at": posted}) is None


def test_seek_header_gives_up_early_when_stuck_on_a_false_hint():
    """手がかりはあるのに見出しが確認できない状態が続いたら、48回まで待たずに早めに諦める
    (実機で、本文が似た別の投稿に惑わされて48回すべて迷走し、操作を検知して中断したことがあった)。"""
    chat = build(jitter=False)
    s = Session(SimDriver(chat), Ledger(), NOW, Options())
    s._find_block = lambda blocks, note, kind="note": None            # 絶対に見つからない
    s._hint_y = lambda screen, blocks, note: 100.0                    # 手がかりは常にある
    scrolls: list[int] = []
    s.scroll = lambda lines: scrolls.append(lines)                    # 実際には動かさず、回数だけ数える
    with pytest.raises(SessionError, match="惑わされている"):
        s._seek_header({"body_text": "x", "author_name": "x", "posted_at": "2026-09-23T00:00:00Z", "posted_at_precision": "exact"})
    assert len(scrolls) == SEEK_STUCK_LIMIT - 1                       # 48回ではなく、早めに諦める


# ---------- 段階3: 「前のコメントを見る」を必要なときだけ押す ----------
def test_already_read_by_content_or_by_time():
    """_already_read: (a) 台帳の既存コメントと内容が一致する / (b) 前回の確認時刻より前 のどちらかで既読とみなす."""
    chat = build(jitter=False)
    s = Session(SimDriver(chat), Ledger(), NOW, Options())
    note = {"comments": [{"id": "x", "ordinal": 0, "author_name": "参加者A", "body_text": "既読の内容です。",
                          "posted_at": "2026-09-23T10:00:00Z", "posted_at_precision": "exact", "posted_at_raw": "",
                          "deleted_at": None, "is_target": False}],
            "comments_checked_at": "2026-09-23T21:00:00+09:00"}     # UTC 12:00
    active = note["comments"]

    def block(author, text, time_raw):
        return Block(kind="comment", author=author, time_raw=time_raw, y_top=0, y_time=0, complete=True,
                     lines=[Line(text, 0, 0, 10, 10)])

    assert s._already_read(block("参加者A", "既読の内容です。", "9.23午後 7:00"), active, note)      # (a) 内容が一致
    assert s._already_read(block("参加者B", "知らない内容ですが前回より前です。", "9.23午後 8:00"), active, note)   # (b) 前回より前(UTC11:00)
    assert not s._already_read(block("参加者C", "知らない、新しい内容です。", "9.23午後 10:00"), active, note)     # 内容も違い、前回より後(UTC13:00)


def test_already_read_falls_back_to_the_previous_sync_run_time_when_never_opened_before():
    """このノートを個別に開いたことが一度も無くても(comments_checked_at が無くても)、前回の同期そのものが
    最後まで終わっていれば、その開始時刻(ledger.meta["last_run"]["at"]。Portalの「最後の取得」と同じ値)を
    基準に既読と判定してよい。ただし前回が中断していた場合は、途中までしか確かめていないので使わない。"""
    chat = build(jitter=False)
    led = Ledger()
    led.meta["last_run"] = {"at": "2026-09-23T21:00:00+09:00", "status": "success"}   # UTC 12:00
    s = Session(SimDriver(chat), led, NOW, Options())
    note = {"comments": [], "comments_checked_at": None}

    def block(author, text, time_raw):
        return Block(kind="comment", author=author, time_raw=time_raw, y_top=0, y_time=0, complete=True,
                     lines=[Line(text, 0, 0, 10, 10)])

    assert s._already_read(block("参加者B", "知らない内容ですが前回の同期より前です。", "9.23午後 8:00"), [], note)     # 前回(UTC11:00)より前
    assert not s._already_read(block("参加者C", "知らない、新しい内容です。", "9.23午後 10:00"), [], note)            # 前回(UTC13:00)より後

    led.meta["last_run"] = {"at": "2026-09-23T23:00:00+09:00", "status": "aborted"}    # 中断した回(途中までしか見ていない)
    assert not s._already_read(block("参加者B", "知らない内容ですが前回の同期より前です。", "9.23午後 8:00"), [], note)


def test_second_run_skips_earlier_click_when_new_comment_is_already_on_first_page():
    """新しいコメントが1件だけ増えても、読み込み済みの最初の10件の中に既読のコメントが見つかれば、
    「前のコメントを見る」を1回も押さずに済む(実機の実測: 開いた直後N=10件・1回押すごとにM=10件)."""
    chat = SimChat([SimNote("参加者A", "本文", "昨日 午前 9:45", comments=comments(30, "P"), reactions=10)], jitter=False)
    ledger, stats = run(chat)
    assert stats.notes_opened == 1
    note = by_author(ledger, "参加者A")[0]
    assert note["comment_count"] == 30 and not note["needs_recheck"]

    chat.notes[0].comments.append(SimComment("参加者Z", "新しいコメントです。", "1時間前"))
    _close_window(chat)
    s2, stats2 = _next_run(chat, ledger)
    assert not any("走査で見えず" in w or "件数不一致" in w for w in stats2.warnings), stats2.warnings
    assert chat.notes[0].earlier_loaded == 0                          # 押さずに済んだ
    note = by_author(ledger, "参加者A")[0]
    assert note["comment_count"] == 31 and not note["needs_recheck"]
    assert len(note["comments"]) == 31
    assert sorted(c["ordinal"] for c in note["comments"]) == list(range(31))
    assert sum(1 for c in note["comments"] if c.get("deleted_at")) == 0
    assert any(c["body_text"].startswith("新しいコメントです") for c in note["comments"])


def _load_earlier_note():
    return {"author_name": "x", "body_text": "x", "posted_at": "2026-09-23T00:45:00Z", "posted_at_precision": "exact",
            "posted_at_raw": "昨日 午前 9:45", "comments": [], "comments_checked_at": None}


def _load_earlier_session(shots):
    """shots: 順に返す (screen, blocks). 最後に来たら、同じものを返し続ける. _click/scroll は記録だけする."""
    from types import SimpleNamespace
    s = Session(SimDriver(build(jitter=False)), Ledger(), NOW, Options())
    it = iter(shots)
    last = {}
    def fake_shot():
        try:
            last["v"] = next(it)
        except StopIteration:
            pass
        return last["v"]
    s.shot = fake_shot
    s.clicks = []
    s.scrolls = []
    s._click = lambda *a, **k: s.clicks.append(a)
    s.scroll = lambda n: s.scrolls.append(n)
    return s, SimpleNamespace


def _blk(kind, y_top, y_time=None, time_raw="", complete=True, author="x"):
    return Block(kind=kind, author=author, time_raw=time_raw, y_top=y_top, y_time=y_top if y_time is None else y_time, complete=complete)


def test_load_earlier_scrolls_down_to_reveal_the_footer_of_a_tall_note_before_deciding():
    """見出しは見えるが、時刻行(フッター)が画面の下にはみ出すほど長いノートでは、まだ「前のコメントを見る」の有無を
    判断できない(ボタンは時刻行のすぐ下にある)。見えていない間に「全部読んだ」と即断せず、下へ進んで時刻行を出してから
    決める(2026-09-29、さとで、続きがあるのに見ないで済ませてしまった)。"""
    from types import SimpleNamespace
    screen = SimpleNamespace(lines=[], height=1130.0)
    own = _blk("note", 100, 400, "昨日 午前 9:45")
    s, _ = _load_earlier_session([(screen, []), (SimpleNamespace(lines=[Line("別", 0, 300, 10, 10)], height=1130.0),
                                                 [own, _blk("comment", 460, 520, "1時間前")])])
    s._header_y = lambda screen, blocks, note: 10.0        # 1枚目は、見出しだけが見える(時刻行は画面の下)
    assert s._load_earlier(_load_earlier_note(), full_expand=False) is False
    assert s.scrolls == [20]                                 # 判断できないので下へ1回進み、時刻行が見えてから終わる
    assert not s.clicks


def test_load_earlier_ignores_a_cut_button_that_belongs_to_another_note():
    """別のノートのコメント欄にある「前のコメントを見る」を、このノートのものと取り違えない。
    2026-09-29の実機事故: さとの処理が、下にある別ノートのボタンを見つけて「既読」と判定し、画面の位置が遠くへ飛んで終わり、
    その間にあるノート3件(てんぷら・Conny・のの)を走査が飛ばした。"""
    from types import SimpleNamespace
    cut_line = Line("前のコメントを見る", 150, 900, 130, 15)
    screen = SimpleNamespace(lines=[cut_line], height=1130.0)
    blocks = [_blk("note", 100, 200, "昨日 午前 9:45"),           # このノート(見出しの直下はコメント: ボタンは無い)
              _blk("comment", 250, 320, "1時間前"),
              _blk("note", 500, 700, "昨日 午後 3:23", author="別の人"),   # 次のノート
              _blk("cut", 900), _blk("comment", 950, 1010, "2時間前")]   # 次のノートのボタン
    s, _ = _load_earlier_session([(screen, blocks)])
    assert s._load_earlier(_load_earlier_note(), full_expand=False) is False
    assert not s.clicks and not s.scrolls                    # 別ノートのボタンは押さず、画面も動かさない


def test_load_earlier_looks_up_from_the_tail_when_the_header_is_off_screen():
    """開いた直後にLINEが最新のコメントまでジャンプして、見出しが画面の上に出ているときは、上へ戻って探す
    (下へ進むと、次のノートに入ってしまう)。自分のコメント欄の範囲にあるボタンが見つかれば、押す。"""
    from types import SimpleNamespace
    no_cut = SimpleNamespace(lines=[], height=1130.0)
    cut_line = Line("前のコメントを見る", 150, 300, 130, 15)
    with_cut = SimpleNamespace(lines=[cut_line], height=1130.0)
    s, _ = _load_earlier_session([(no_cut, [_blk("comment", 300, 360, "1時間前")]),
                                  (with_cut, [_blk("cut", 300), _blk("comment", 360, 420, "2時間前")]),
                                  (no_cut, [_blk("note", 100, 200, "昨日 午前 9:45"), _blk("comment", 260, 320, "3時間前")])])
    s._header_y = lambda screen, blocks, note: None
    assert s._load_earlier(_load_earlier_note(), full_expand=True) is False
    assert s.scrolls == [-24]                                # 見出しが見えないので上へ
    assert len(s.clicks) == 1                                # 見つけたボタンを1回押し、押し切ったら終わる


def test_load_earlier_gives_up_instead_of_wandering_when_the_screen_does_not_move():
    """画面が動かない(スクロールの端に達した・押せていない)まま、同じ画面が続くなら、際限なく続けず諦める
    (2026-09-29の実機で、下まで来てもなおスクロールし続け、操作を検知して中断した)。"""
    from types import SimpleNamespace
    screen = SimpleNamespace(lines=[], height=1130.0)
    s, _ = _load_earlier_session([(screen, [_blk("comment", 300, 360, "1時間前")])])
    s._header_y = lambda screen, blocks, note: None
    with pytest.raises(SessionError, match="動かない"):
        s._load_earlier(_load_earlier_note(), full_expand=False)
    assert len(s.scrolls) <= 4                               # 何十回も繰り返さない


def test_threads_left_open_by_an_interrupted_run_are_read_or_closed_with_a_warning():
    """前提は「閉じた状態から始まる」。前回の実行が途中で止まるとコメント欄が開いたまま残ることがあるので、
    変わったノートは警告を出して読んでから閉じ、変わっていないノートは警告を出して閉じる。走査は1件も飛ばさない。"""
    chat = SimChat([SimNote("さと", "本文A", "昨日 午後 7:58", comments=comments(31, "S"), reactions=10),
                    SimNote("てんぷら", "本文B", "昨日 午後 3:23", comments=comments(5, "T"), reactions=10),
                    SimNote("Conny", "本文C", "昨日 午後 2:35", comments=comments(8, "C"), reactions=10),
                    SimNote("のの", "本文D", "昨日 午後 7:34", comments=comments(16, "N"), reactions=10),
                    SimNote("てんぷら2", "本文E", "一昨日 午後 9:27", comments=comments(29, "T2"), reactions=10),
                    SimNote("たらおし", "本文F", "一昨日 午後 7:58", comments=comments(8, "R"), reactions=10)], jitter=False)
    ledger = Ledger()
    run(chat, ledger)
    assert _all_closed(chat)
    for i, add in [(0, 1), (1, 1), (2, 3), (3, 2)]:
        for k in range(add):
            chat.notes[i].comments.append(SimComment(f"新{k}", f"新しいコメント{i}-{k}です。", "3分前"))
    chat.notes[0].open = True                                 # 前回が中断して、変わったノートが開いたまま
    chat.notes[4].open = True                                 # 前回が中断して、変わっていないノートが開いたまま
    chat.notes[4].earlier_loaded = 1
    chat.scroll_y = 0.0
    s, stats = _next_run(chat, ledger)
    left_open = [w for w in stats.warnings if "開いたまま残って" in w]
    assert len(left_open) == 2 and len(stats.warnings) == 2, stats.warnings
    assert _all_closed(chat)
    assert not any(n["needs_recheck"] for n in ledger.notes)
    assert {n["author_name"]: n["comment_count"] for n in ledger.notes} == {
        "さと": 32, "てんぷら": 6, "Conny": 11, "のの": 18, "てんぷら2": 29, "たらおし": 8}
    assert chat.forbidden_clicks == []


def test_a_read_that_misses_the_thread_is_retaken_once_then_marked_for_recheck_and_still_closed():
    """撮影した画像にこのノートのコメント欄が写っていなければ1回撮り直す。それでもだめなら needs_recheck にして、
    コメント欄は閉じてから次へ進む(開いたまま次へ進むと、前提が崩れる)。"""
    chat = build(jitter=False)
    ledger = Ledger()
    run(chat, ledger)
    chat.notes[0].comments.append(SimComment("参加者Z", "新しいコメントです。", "1時間前"))
    chat.scroll_y = 0.0

    s = Session(SimDriver(chat), ledger, NOW, Options(first_run=False))
    real = s.reader.read_thread
    tries = {"n": 0}
    def flaky(start_y_pt, log=lambda m: None):
        tries["n"] += 1
        return ([], []) if tries["n"] == 1 else real(start_y_pt, log)
    s.reader.read_thread = flaky
    stats = s.run()
    assert tries["n"] == 2 and not stats.warnings, stats.warnings    # 1回目は写っていない → 撮り直して読めた
    assert ledger.notes[0]["comment_count"] == 4 and not ledger.notes[0]["needs_recheck"]
    assert _all_closed(chat)

    chat.notes[0].comments.append(SimComment("参加者Y", "もう一つ新しいコメントです。", "1時間前"))
    chat.scroll_y = 0.0
    s = Session(SimDriver(chat), ledger, NOW, Options(first_run=False))
    def never(start_y_pt, log=None):
        return [], []
    s.reader.read_thread = never
    stats = s.run()
    assert any("写っていませんでした" in w for w in stats.warnings), stats.warnings
    assert ledger.notes[0]["needs_recheck"]
    assert _all_closed(chat)                                  # 読めなくても、閉じてから次へ進む


def test_full_expand_option_disables_the_early_stop():
    """Options.full_expand=True(切り戻し用)なら、既読でも省かず、今までどおり押し切る."""
    chat = SimChat([SimNote("参加者A", "本文", "昨日 午前 9:45", comments=comments(30, "P"), reactions=10)], jitter=False)
    ledger, stats = run(chat)
    note = by_author(ledger, "参加者A")[0]
    assert note["comment_count"] == 30

    chat.notes[0].comments.append(SimComment("参加者Z", "新しいコメントです。", "1時間前"))
    _close_window(chat)
    s2 = Session(SimDriver(chat), ledger, NOW, Options(first_run=False, full_expand=True))
    stats2 = s2.run()
    assert not stats2.warnings, stats2.warnings
    assert chat.notes[0].earlier_loaded >= 3                          # 31件を全部表示するまで押し切る(N=10,M=10)
    note = by_author(ledger, "参加者A")[0]
    assert note["comment_count"] == 31 and not note["needs_recheck"]
    assert len(note["comments"]) == 31


def test_second_run_clicks_earlier_only_until_reaching_a_known_comment():
    """新しいコメントが最初の10件を超えて増えたときは、既読のコメントに届くまでだけ押す(押し切らない)."""
    chat = SimChat([SimNote("参加者A", "本文", "昨日 午前 9:45", comments=comments(30, "P"), reactions=10)], jitter=False)
    ledger, stats = run(chat)
    note = by_author(ledger, "参加者A")[0]
    assert note["comment_count"] == 30

    for i in range(15):
        chat.notes[0].comments.append(SimComment(f"参加者Z{i}", f"新しいコメント{i}です。", f"{i + 1}分前"))
    _close_window(chat)
    now2 = NOW + timedelta(hours=1)                                   # 実行の間隔ぶん時計を進める(前回の確認時刻との比較のため)
    s2 = Session(SimDriver(chat), ledger, now2, Options(first_run=False))
    stats2 = s2.run()

    assert not any("走査で見えず" in w or "件数不一致" in w for w in stats2.warnings), stats2.warnings
    assert chat.notes[0].earlier_loaded == 1                          # 30番目(既知)に届くまでの1回だけ
    note = by_author(ledger, "参加者A")[0]
    assert note["comment_count"] == 45 and not note["needs_recheck"]
    assert len(note["comments"]) == 45
    assert sorted(c["ordinal"] for c in note["comments"]) == list(range(45))
    assert sum(1 for c in note["comments"] if c.get("deleted_at")) == 0
    assert stats2.comments_new == 15


def test_deleted_comments_still_force_a_full_expand():
    """表示件数が台帳より減っている(削除の可能性)ときは、既読の判定を使わず全部読む."""
    chat = SimChat([SimNote("参加者A", "本文", "昨日 午前 9:45", comments=comments(15, "P"), reactions=10)], jitter=False)
    ledger, stats = run(chat)
    note = by_author(ledger, "参加者A")[0]
    assert note["comment_count"] == 15

    del chat.notes[0].comments[3]                                     # 1件削除された想定(表示14件)
    _close_window(chat)
    s2, stats2 = _next_run(chat, ledger)
    note = by_author(ledger, "参加者A")[0]
    assert note["comment_count"] == 14 and not note["needs_recheck"]
    assert sum(1 for c in note["comments"] if c.get("deleted_at")) == 1
    assert sum(1 for c in note["comments"] if not c.get("deleted_at")) == 14   # 全部読めている(押し切った)


def test_new_note_snapshot_is_saved_and_pruned(tmp_path, monkeypatch):
    """新しいノートを見つけた画面を、画像と読み取り結果で残す(幽霊ノートの原因調査用)。古いものは消す。"""
    import json
    from line_openchat import session as S
    monkeypatch.setattr(S, "SNAPSHOT_KEEP", 2)
    img = tmp_path / "shot.png"
    img.write_bytes(b"png")

    class FakeScreen:
        path = str(img)
        lines: list = []

    sess = S.Session.__new__(S.Session)
    sess.opts = S.Options(snapshot_dir=tmp_path / "snaps")
    for i in range(3):
        sess._save_snapshot({"id": f"{i:04d}-x", "author_name": "A", "posted_at": "t", "posted_at_raw": "r", "comment_count": 0}, FakeScreen(), [])
        import time; time.sleep(1.1)           # ファイル名は秒単位
    pngs = sorted((tmp_path / "snaps").glob("*.png"))
    assert len(pngs) == 2 and all(p.with_suffix(".json").exists() for p in pngs)
    assert json.loads(pngs[0].with_suffix(".json").read_text())["note"]["author_name"] == "A"


def _long_thread_chat():
    """コメントの多いノートの直下に、別のノートがある一覧. 1行あたりの移動量を小さくして、見出しを探す範囲
    (_seek_header)が、撮影の後のコメント欄の終わりから見出しまで届かない状況を作る(実機の Naozo 64件)."""
    return SimChat([SimNote("Naozo", "昨夜放送のNHK 未解決事件について", "一昨日 午後 11:27", comments=comments(64, "N"), reactions=10),
                    SimNote("ちきりん", "9月23日のWBSの真ん中あたり。工場について", "一昨日 午後 9:46", badge=True,
                            comments=comments(12, "W"), reactions=10),
                    SimNote("参加者D", "メッシと私 2026", "9.21 午後 7:57", comments=comments(2, "Y"), reactions=21)],
                   jitter=False, lines_per_scroll_px=4.0)


def test_a_long_thread_is_closed_after_reading_by_scrolling_back_by_the_captured_amount():
    """撮影の後は、撮影で下へ進んだ分だけ上へ戻してから見出しを探す. コメントの多いノートでも閉じられ、
    直下のノートも読める(実機で発生: 2026-10-03、閉じられなかった Naozo の下のちきりんが要確認になった)。"""
    ledger, stats = run(_long_thread_chat())
    assert not stats.warnings, stats.warnings
    assert {n["author_name"]: n["comment_count"] for n in ledger.notes} == {"Naozo": 64, "ちきりん": 12, "参加者D": 2}
    assert not any(n["needs_recheck"] for n in ledger.notes)


def test_a_thread_that_cannot_be_closed_sends_the_scan_back_to_the_top():
    """閉じられなかった(撮影で進んだ量が分からない、直す前の動き)ときは、警告を残し、一覧の先頭へ戻ってから続ける.
    位置が分からないまま進んで、ノートを飛ばさない。"""
    chat = _long_thread_chat()
    s = Session(SimDriver(chat), Ledger(), NOW, Options(first_run=True))
    s.reader.report_scroll = False
    logs: list[str] = []
    s.log = logs.append
    stats = s.run()
    assert any("閉じられませんでした" in w for w in stats.warnings), stats.warnings
    assert any("一覧の先頭へ戻って続けます" in l for l in logs)
    assert {n["author_name"] for n in s.ledger.notes} >= {"Naozo", "ちきりん", "参加者D"}


def test_why_comments_are_read_in_full_is_logged():
    """全部読み直す理由と、既読と判定できずに「前のコメントを見る」を押した理由を、ログに出す(後から原因を確かめるため)."""
    chat = SimChat([SimNote("参加者A", "本文", "昨日 午前 9:45", comments=comments(30, "P"), reactions=10)], jitter=False)
    ledger, _ = run(chat)
    note = ledger.notes[0]
    note["needs_recheck"] = True
    chat.notes[0].comments.append(SimComment("参加者Z", "新しいコメントです。", "1時間前"))
    _close_window(chat)
    logs: list[str] = []
    Session(SimDriver(chat), ledger, NOW, Options(first_run=False), log=logs.append).run()
    assert any("コメントを全部読み直します(前回、要確認になったため)" in l for l in logs), logs

    for c in note["comments"]:                                 # 台帳と一致せず、基準の時刻もない → 既読と判定できない
        c["body_text"] = "別の文面"
        c["author_name"] = "別人"
    note["comments_checked_at"] = None
    ledger.meta["last_run"] = {"at": NOW.isoformat(), "status": "aborted"}
    chat.notes[0].comments.append(SimComment("参加者Y", "もう一つ新しいコメントです。", "1時間前"))
    _close_window(chat)
    logs.clear()
    Session(SimDriver(chat), ledger, NOW, Options(first_run=False), log=logs.append).run()
    assert any("既読と判定できません(基準: 基準の時刻なし(前回の同期が中断))" in l for l in logs), logs


def test_a_block_that_borrowed_the_next_notes_time_is_not_put_into_the_ledger():
    """自分の時刻の行を読み落とし、次の投稿の作者名も読めない(合体を画面で見抜けない)と、「作者と本文はこのノート、時刻と件数は
    次の投稿」のブロックになる。台帳には入れず(幽霊を作らない・本物を書き換えない)、警告して画面を残す
    (実機で発生: 2026-10-05、hibye の本文に Naozo の時刻と件数がついたノートが処理され、本物の hibye は読まれなかった)。"""
    chat = SimChat([SimNote("参加者A", "別のノートの本文です。", "9.25 午後 9:58", comments=comments(2, "A"), reactions=10),
                    SimNote("hibye", "9/22、23に前後編で放送された世界のドキュメンタリーがとても面白かったのでシェアします。",
                            "9.24 午前 0:14", card="世界のドキュメンタリー", comments=comments(11, "H"), reactions=63),
                    SimNote("Naozo", "昨夜放送のNHK 未解決事件について。最初は何気なく見ていたのですが、考えさせられる番組でした。",
                            "9.23 午後 11:27", comments=comments(15, "N"), reactions=110),
                    SimNote("参加者D", "メッシと私 2026", "9.21 午後 7:57", comments=comments(2, "Y"), reactions=21)], jitter=False)
    ledger, stats = run(chat)
    assert {n["author_name"]: n["comment_count"] for n in ledger.notes} == {"参加者A": 2, "hibye": 11, "Naozo": 15, "参加者D": 2}
    hibye = by_author(ledger, "hibye")[0]
    before = (hibye["posted_at"], hibye["comment_count"], hibye["needs_recheck"])

    chat.hide_time, chat.hide_name = {1}, {2}             # hibye の時刻の行と、Naozo の作者名を読み落とす
    _close_window(chat)
    s, stats = _next_run(chat, ledger)
    assert len(ledger.notes) == 4, [(n["author_name"], n["posted_at_raw"]) for n in ledger.notes]   # 幽霊ノートを作らない
    assert (hibye["posted_at"], hibye["comment_count"], hibye["needs_recheck"]) == before           # 本物を書き換えない
    borrowed = [w for w in stats.warnings if "取り込んで" in w]
    assert len(borrowed) == 1 and "hibye" in borrowed[0] and "Naozo" in borrowed[0], stats.warnings
    assert not any(n["needs_recheck"] for n in ledger.notes)
    assert chat.forbidden_clicks == []
