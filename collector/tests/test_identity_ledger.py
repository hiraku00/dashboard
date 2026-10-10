import json

from line_openchat import identity
from line_openchat.ledger import CommentObs, Ledger, NoteObs, extract_url, first_line


def nobs(author="参加者A", body="9/16 クローズアップ現代 部屋が借りられない", at="2026-09-22T00:45:00Z", prec="exact",
         raw="一昨日 午前 9:45", comments=3, badge=False, complete=True):
    return NoteObs(author, badge, body, at, prec, raw, comments, complete)


def cobs(author="参加者G", body="番組の話を思い出しました。", at="2026-09-23T16:00:00Z", prec="approx_hour", raw="7時間前", badge=False, conf=1.0):
    return CommentObs(author, badge, body, at, prec, raw, conf)


NOW = "2026-09-24T12:00:00+09:00"


def test_norm_and_similarity_absorb_ocr_noise():
    assert identity.norm_name("）TARO") == "taro"
    assert identity.name_sim("さくらもと", "さくらまと") >= 0.5
    assert identity.sim("再審請求しました", "再番請求しました") > 0.85
    assert identity.sim("", "") == 0.0


def test_same_note_seen_again_with_ocr_variation_is_matched():
    led = Ledger()
    a, new = led.upsert_note(nobs(), NOW)
    assert new
    b, new2 = led.upsert_note(nobs(author="参加者A'", body="9/16クローズアップ現代部屋が借りられない", raw="一昨日午前 9:45"), NOW)
    assert not new2 and b["id"] == a["id"] and len(led.notes) == 1


def test_different_notes_by_same_author_are_not_merged():
    led = Ledger()
    led.upsert_note(nobs(author="ちきりん", body="9月16日 BSスペシャル", at="2026-09-21T05:22:00Z", raw="9.21 午後 2:22", badge=True), NOW)
    led.upsert_note(nobs(author="ちきりん", body="9月16日 BS世界のドキュメンタリー", at="2026-09-21T05:20:00Z", raw="9.21 午後 2:20", badge=True), NOW)
    assert len(led.notes) == 2


def test_approx_note_time_is_upgraded_to_exact_without_creating_a_duplicate():
    led = Ledger()
    n, _ = led.upsert_note(nobs(at="2026-09-23T16:00:00Z", prec="approx_hour", raw="11 時間前"), NOW)
    n2, new = led.upsert_note(nobs(at="2026-09-23T15:20:00Z", prec="exact", raw="昨日 午後 9:46"), NOW)
    assert not new and n2["id"] == n["id"]
    assert n["posted_at"] == "2026-09-23T15:20:00Z" and n["posted_at_precision"] == "exact"


def test_target_needs_the_badge_not_just_the_name():
    led = Ledger()
    fake, _ = led.upsert_note(nobs(author="ちきりん", body="偽物", at="2026-09-20T00:00:00Z", badge=False), NOW)
    real, _ = led.upsert_note(nobs(author="ちきりん", body="本物", at="2026-09-21T00:00:00Z", badge=True), NOW)
    assert not fake["author_is_target"] and real["author_is_target"]


def test_same_author_two_similar_comments_are_kept_apart_and_matched_by_order():
    led = Ledger()
    note, _ = led.upsert_note(nobs(), NOW)
    obs = [cobs("ちきりん", "同感です。", "2026-09-23T10:00:00Z", "exact", "昨日 午後 7:00", True),
           cobs("参加者I", "私もそう思います。", "2026-09-23T10:05:00Z", "exact", "昨日 午後 7:05"),
           cobs("ちきりん", "同感です。", "2026-09-23T10:06:00Z", "exact", "昨日 午後 7:06", True)]
    r = led.apply_collection(note, obs, 3, NOW)
    assert r.new_comments == 3 and r.new_target_comments == 2 and r.count_matched
    ids = [c["id"] for c in note["comments"]]
    assert len(set(ids)) == 3
    # もう一度同じ内容を読んでも、ID・件数は変わらない
    r2 = led.apply_collection(note, obs, 3, NOW)
    assert r2.new_comments == 0 and [c["id"] for c in note["comments"]] == ids
    assert note["target_comment_count"] == 2


def test_count_mismatch_flags_recheck_and_never_deletes():
    led = Ledger()
    note, _ = led.upsert_note(nobs(), NOW)
    led.apply_collection(note, [cobs(body="一つ目"), cobs(body="二つ目", at="2026-09-23T17:00:00Z", raw="6時間前")], 2, NOW)
    r = led.apply_collection(note, [cobs(body="一つ目")], 2, NOW)          # 表示は2件なのに1件しか読めなかった
    assert not r.count_matched and note["needs_recheck"]
    assert all(not c.get("deleted_at") for c in note["comments"])
    assert note["comment_count"] == 2


def test_missing_comment_is_marked_deleted_only_when_counts_agree():
    led = Ledger()
    note, _ = led.upsert_note(nobs(), NOW)
    led.apply_collection(note, [cobs(body="一つ目"), cobs(body="二つ目", at="2026-09-23T17:00:00Z", raw="6時間前")], 2, NOW)
    r = led.apply_collection(note, [cobs(body="一つ目")], 1, NOW)
    assert r.deleted_comments == 1 and note["comment_count"] == 1
    assert sum(1 for c in note["comments"] if c.get("deleted_at")) == 1


def test_unreadable_count_records_what_was_read_but_never_deletes():
    """表示の件数が読めない(None)まま読んだら、台帳にあるコメントの数を件数にする(古い件数のまま、毎回開き直さないように)."""
    led = Ledger()
    note, _ = led.upsert_note(nobs(comments=None), NOW)
    assert note["comment_count"] == 0
    r = led.apply_collection(note, [cobs(body="一つ目"), cobs(body="二つ目", at="2026-09-23T17:00:00Z", raw="6時間前"),
                                    cobs(body="三つ目", at="2026-09-23T18:00:00Z", raw="5時間前")], None, NOW)
    assert r.count_matched and not note["needs_recheck"]
    assert note["comment_count"] == 3
    assert not led.needs_open(note, False, nobs(comments=3))           # 次回、表示の件数が読めて同じなら開かない
    assert led.needs_open(note, False, nobs(comments=4))               # 違えば開く(読めた数が少なかった場合も、ここで直る)
    r = led.apply_collection(note, [cobs(body="一つ目")], None, NOW)   # 件数が分からないときは、見えなかったものを削除扱いにしない
    assert r.deleted_comments == 0 and all(not c.get("deleted_at") for c in note["comments"])
    assert note["comment_count"] == 3                                  # 件数は、台帳にある(削除扱いでない)コメントの数


def _seed_five(led, note):
    """0〜4番目のコメントを、通常どおり(partial=False)で作っておく(段階3のテストの下ごしらえ)."""
    full = [cobs(body=f"コメント{i}", at=f"2026-09-23T{10 + i:02d}:00:00Z", raw=f"{15 - i}時間前") for i in range(5)]
    led.apply_collection(note, full, 5, NOW)
    return full


def test_partial_capture_reconciles_hidden_range_and_appends_new():
    """「前のコメントを見る」を途中までしか押さなかった回: 読んでいない(隠れている)分の数と、
    実際に読んだ分を足して表示件数と合えば良しとし、隠れている分は削除扱いにしない."""
    led = Ledger()
    note, _ = led.upsert_note(nobs(comments=5), NOW)
    _seed_five(led, note)
    tail = [cobs(body="コメント3", at="2026-09-23T13:00:00Z", raw="12時間前"),          # 既知(3番目)
            cobs(body="コメント4", at="2026-09-23T14:00:00Z", raw="11時間前"),          # 既知(4番目)
            cobs(body="新規1", at="2026-09-23T15:00:00Z", raw="10時間前"),
            cobs(body="新規2", at="2026-09-23T16:00:00Z", raw="9時間前")]
    r = led.apply_collection(note, tail, 7, NOW, partial=True)                          # 表示7件 = 隠れている3件 + 読んだ4件
    assert r.count_matched and not note["needs_recheck"]
    assert r.new_comments == 2 and r.deleted_comments == 0
    assert note["comment_count"] == 7
    assert all(not c.get("deleted_at") for c in note["comments"])                       # 隠れている0〜2番目も削除扱いにしない
    assert sorted(c["ordinal"] for c in note["comments"]) == [0, 1, 2, 3, 4, 5, 6]       # 新規2件が5,6として続く


def test_partial_capture_mismatch_flags_recheck_without_deleting():
    """一部だけ読んだ回で件数が合わなければ(判定を間違えた疑い)、needs_recheck にして次回は全部読み直す.
    削除扱いにはしない(見ていない範囲を、消えたと誤判定しないため)."""
    led = Ledger()
    note, _ = led.upsert_note(nobs(comments=5), NOW)
    _seed_five(led, note)
    tail = [cobs(body="コメント3", at="2026-09-23T13:00:00Z", raw="12時間前"),
            cobs(body="コメント4", at="2026-09-23T14:00:00Z", raw="11時間前")]
    r = led.apply_collection(note, tail, 8, NOW, partial=True)                          # 隠れている3件+読んだ2件=5 ≠ 表示8件
    assert not r.count_matched and note["needs_recheck"]
    assert r.deleted_comments == 0
    assert all(not c.get("deleted_at") for c in note["comments"])


def test_partial_capture_with_unresolvable_anchor_avoids_ordinal_collision():
    """一番古い観測(cutのすぐ下)が台帳のどれとも一致しない(新しいコメントが11件以上増えたなど)場合でも、
    観測した分は記録し、既存の ordinal と衝突させない(次回の全部読みで、正しい ordinal に直る)."""
    led = Ledger()
    note, _ = led.upsert_note(nobs(comments=3), NOW)
    full = [cobs(body=f"コメント{i}", at=f"2026-09-23T{10 + i}:00:00Z", raw=f"{13 - i}時間前") for i in range(3)]
    led.apply_collection(note, full, 3, NOW)
    unknown = [cobs(body="未知1", at="2026-09-23T20:00:00Z", raw="1時間前"),
              cobs(body="未知2", at="2026-09-23T21:00:00Z", raw="今")]
    r = led.apply_collection(note, unknown, 5, NOW, partial=True)
    assert not r.count_matched and note["needs_recheck"]
    ordinals = [c["ordinal"] for c in note["comments"]]
    assert len(ordinals) == len(set(ordinals))                                          # 衝突しない
    assert all(not c.get("deleted_at") for c in note["comments"])


def test_needs_open_rules():
    led = Ledger()
    note, is_new = led.upsert_note(nobs(comments=3), NOW)
    assert led.needs_open(note, is_new, nobs(comments=3))
    led.apply_collection(note, [cobs(), cobs(body="二", at="2026-09-23T17:00:00Z", raw="6時間前"),
                                cobs(body="三", at="2026-09-23T18:00:00Z", raw="5時間前")], 3, NOW)
    assert not led.needs_open(note, False, nobs(comments=3))
    assert led.needs_open(note, False, nobs(comments=4))                 # 件数が増えた
    note["needs_recheck"] = True
    assert led.needs_open(note, False, nobs(comments=3))                 # 前回、件数が合わなかった
    note["needs_recheck"] = False
    note["body_complete"] = False
    assert led.needs_open(note, False, nobs(comments=3))                 # 全スレッドを画面に出すので、本文が途中なら関わりを問わず開く


def test_save_load_roundtrip_is_atomic_and_private(tmp_path):
    led = Ledger()
    note, _ = led.upsert_note(nobs(), NOW)
    led.apply_collection(note, [cobs()], 1, NOW)
    path = tmp_path / "ledger.json"
    led.save(path)
    assert (path.stat().st_mode & 0o777) == 0o600
    back = Ledger.load(path)
    assert back.notes[0]["comments"][0]["body_text"] == "番組の話を思い出しました。"
    assert not list(tmp_path.glob(".ledger-*"))
    assert Ledger.load(tmp_path / "nothing.json") is None


def test_helpers():
    assert first_line("\n\n  最初の行  \n二行目") == "最初の行"
    assert extract_url("見て https://example.com/a?b=1。") == "https://example.com/a?b=1"
    assert extract_url("なし") == ""
    # 画面で折り返されて2行にまたがったURLは1つに繋ぐ(次の行が日本語や空白を含めば繋がない)
    assert extract_url("見て\nhttps://www.nhk.jp/p/ts/ABC/\nepisode/te/XYZ123/") == "https://www.nhk.jp/p/ts/ABC/episode/te/XYZ123/"
    assert extract_url("https://a.com/x\n次の行") == "https://a.com/x"
    assert extract_url("https://a.com/x\nnext line") == "https://a.com/x"


def test_from_portal_restores_ledger_that_matches_new_sightings():
    payload = {"notes": [{"id": "n1", "authorName": "ちきりん", "authorIsTarget": True, "programTitle": "報道特集", "bodyHead": "9月23日の報道特集の真ん中あたり",
                          "bodyComplete": True, "postedAt": "2026-09-23T12:46:00Z", "postedAtPrecision": "exact", "commentCount": 1}],
               "comments": [{"id": "c1", "noteId": "n1", "ordinal": 0, "authorName": "ちきりん", "isTarget": True,
                             "bodyHead": "補足です", "postedAt": "2026-09-23T14:00:00Z", "postedAtPrecision": "exact"}]}
    led = Ledger.from_portal(payload)
    assert led.notes[0]["target_comment_count"] == 1
    n, is_new = led.upsert_note(nobs(author="ちきりん", body="9月23日の報道特集の真ん中あたり。鉄道会社", at="2026-09-23T12:46:00Z", raw="昨日 午後 9:46", badge=True), NOW)
    assert not is_new and n["id"] == "n1"
    json.dumps(led.notes)


def test_badge_and_name_mismatch_is_warned_once():
    led = Ledger()
    fake, _ = led.upsert_note(nobs(author="ちきりん", body="なりすまし", at="2026-09-20T00:00:00Z", badge=False), NOW)
    warning = led.identity_warning(fake)
    assert warning and "公式バッジはなし" in warning and "「ちきりん」を含みます" in warning
    assert led.identity_warning(fake) is None                                  # 2回目は出さない
    note, _ = led.upsert_note(nobs(author="ちきりん", body="本物", at="2026-09-21T00:00:00Z", badge=True), NOW)
    assert led.identity_warning(note) is None                                  # バッジも名前も一致 = 警告なし
    r = led.apply_collection(note, [cobs(author="ちきりん", body="偽コメント", badge=False), cobs(author="匿名", body="バッジだけ", at="2026-09-23T17:00:00Z", raw="6時間前", badge=True)], 2, NOW)
    assert len([w for w in r.warnings if "公式バッジ" in w]) == 2
    r2 = led.apply_collection(note, [cobs(author="ちきりん", body="偽コメント", badge=False), cobs(author="匿名", body="バッジだけ", at="2026-09-23T17:00:00Z", raw="6時間前", badge=True)], 2, NOW)
    assert not [w for w in r2.warnings if "公式バッジ" in w]


def test_link_card_title_is_neither_kept_nor_sent(tmp_path):
    """リンクカードの題名のOCRは、顔アイコンの誤読(「あききます。」など)が入り、使い道も無かったので持たない(2026-10-10)。
    以前の台帳に残っている値は、読み込んだときに捨てる."""
    from line_openchat.uploader import note_payload
    led = Ledger()
    note, _ = led.upsert_note(nobs(), NOW)
    assert "link_title" not in note
    assert "linkTitle" not in note_payload(note)
    path = tmp_path / "ledger.json"
    led.save(path)
    data = json.loads(path.read_text(encoding="utf-8"))
    data["notes"][0]["link_title"] = "あききます。"
    path.write_text(json.dumps(data), encoding="utf-8")
    assert "link_title" not in Ledger.load(path).notes[0]
