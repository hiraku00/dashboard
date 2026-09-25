"""同じ投稿かどうかの判定: 実機で起きた「同じコメントなのに、画面によって読める範囲が違う」場合でも往復しない(架空のデータで再現)."""
from line_openchat import identity
from line_openchat.ledger import CommentObs
from sim import SimChat, SimComment, SimDriver, SimNote
from test_session import NOW, comments
from line_openchat.ledger import Ledger

LONG = ("内容には踏み込まないけど、国の司法判断を公共放送が丁寧に検証して番組を作れる国に住んでて良かった。というのが一番の感想。\n\n"
        "何年も追い続けるディレクターとしっかりした検証、そして結果を受け止める姿勢に、報道の役割を改めて考えさせられました。")


def c(author, body, raw="3時間前", conf=1.0):
    return CommentObs(author, False, body, "2026-09-24T03:00:00Z", "approx_hour", raw, conf)


def test_partial_text_of_the_same_comment_counts_as_the_same_block():
    """長いコメントの冒頭2行が、別の画面では読めなかった(実機で本文の類似度が0.64になった形)."""
    full = LONG
    a = {"author_name": "花子", "body_text": full, "posted_at": "", "posted_at_precision": "", "posted_at_raw": "3時間前"}
    b = {**a, "body_text": LONG[LONG.index("番組を作れる"):]}                 # 冒頭が読めなかった側
    assert identity.sim(full, b["body_text"]) < 0.85              # 通常の類似度では別物に見える
    assert identity.contain_sim(full, b["body_text"]) >= 0.9
    assert identity.same_block(a, b)


def test_contain_similarity_does_not_merge_different_comments():
    a = {"author_name": "花子", "body_text": "この番組を見て、とても考えさせられました。ありがとうございました。", "posted_at": "", "posted_at_precision": "", "posted_at_raw": "3時間前"}
    b = {**a, "body_text": "初めて知ることばかりで驚きました。続きも楽しみにしています。"}
    assert not identity.same_block(a, b)
    # 時刻の文字が違えば、本文がほぼ同一でなければ別のコメント
    c2 = {**a, "author_name": "太郎", "posted_at_raw": "5時間前"}
    assert not identity.same_block(a, c2)


def test_a_misread_relative_hour_does_not_split_one_note_into_two():
    """実機で、同じノートの「19時間前」を「17時間前」と読み、別のノートとして台帳に2件できた."""
    body = "9/22、23に前後編で放送された世界のドキュメンタリーがとても面白かったのでシェアします。"
    a = {"author_name": "花子", "body_text": body, "posted_at": "2026-09-23T17:31:00Z", "posted_at_precision": "approx_hour", "posted_at_raw": "19時間前"}
    b = {"author_name": "花子", "body_text": body, "posted_at": "2026-09-23T19:31:00Z", "posted_at_precision": "approx_hour", "posted_at_raw": "17時間前"}
    assert identity.note_score(a, b) > 0
    other = dict(b, body_text="全く別の投稿です。長さは二十文字を超える程度の本文にします。")
    assert identity.note_score(a, other) == 0
    exact = dict(b, posted_at_precision="exact")
    assert identity.note_score(a, exact) == 0
