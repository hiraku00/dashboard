import json

from line_openchat import identity
from line_openchat.ledger import CommentObs, Ledger, NoteObs, extract_url, first_line


def nobs(author="参加者A", body="9/16 クローズアップ現代 部屋が借りられない", at="2026-09-22T00:45:00Z", prec="exact",
         raw="一昨日 午前 9:45", comments=3, badge=False, complete=True):
    return NoteObs(author, badge, body, at, prec, raw, comments, "", complete)


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
