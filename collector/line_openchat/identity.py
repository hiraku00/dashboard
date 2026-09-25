"""同じノート・同じコメントかどうかの判定(OCRの揺れの吸収).

OCRは画面ごとに少しずつ違う結果を返す(さくらもと/さくらまと、本文冒頭の欠けなど)ので、
読み取った文字列のハッシュではなく、台帳の既存の記録と照合してIDを決める。
"""
from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

from .timeparse import EXACT, minutes_between, tolerance_minutes

_STRIP = re.compile(r"[\s 　・.…。、,，．]+")
_NAME_NOISE = re.compile(r"^[^\w@]+", re.UNICODE)

BODY_SIM = 0.85            # 本文冒頭がこれ以上似ていれば同じ
BODY_SIM_STRICT = 0.92     # 作者名が違って見えるときに必要な類似度
NAME_SIM = 0.5


def norm_name(s: str) -> str:
    return _NAME_NOISE.sub("", unicodedata.normalize("NFKC", s)).replace(" ", "").lower()


def norm_text(s: str) -> str:
    return _STRIP.sub("", unicodedata.normalize("NFKC", s))[:80]


def sim(a: str, b: str) -> float:
    na, nb = norm_text(a), norm_text(b)
    if not na or not nb:
        return 0.0
    return SequenceMatcher(None, na, nb).ratio()


def contain_sim(a: str, b: str) -> float:
    """片方がもう片方の一部(冒頭や末尾が画面の端で読めなかった)でも高くなる類似度.
    実機で、長いコメントの冒頭2行が別の画面では読めず、通常の類似度が0.64になったため。
    正規化した本文の、最も長い共通部分が、短い方の何割を占めるか(短すぎるときは通常の類似度)。"""
    na = _STRIP.sub("", unicodedata.normalize("NFKC", a))[:600]
    nb = _STRIP.sub("", unicodedata.normalize("NFKC", b))[:600]
    if min(len(na), len(nb)) < 12:
        return sim(a, b)
    m = SequenceMatcher(None, na, nb, autojunk=False).find_longest_match(0, len(na), 0, len(nb))
    return m.size / min(len(na), len(nb))


def name_sim(a: str, b: str) -> float:
    na, nb = norm_name(a), norm_name(b)
    if not na or not nb:
        return 0.0
    return 1.0 if na == nb else SequenceMatcher(None, na, nb).ratio()


MISREAD_HOURS = 4          # 相対表示(N時間前・N分前)の読み違いを許す幅


def _diff(a: dict, b: dict) -> tuple[float, int]:
    ap, bp = a["posted_at_precision"], b["posted_at_precision"]
    return minutes_between(a["posted_at"], b["posted_at"]), tolerance_minutes(ap, bp)


def note_score(existing: dict, cand: dict) -> float:
    """0なら別のノート. 大きいほど確からしい."""
    diff, tol = _diff(existing, cand)
    body = sim(existing["body_text"], cand["body_text"])
    same_name = name_sim(existing["author_name"], cand["author_name"])
    both_exact = existing["posted_at_precision"] == EXACT and cand["posted_at_precision"] == EXACT
    if same_name == 1.0 and both_exact and diff == 0:
        return 3.0 + body                          # 1. 作者と正確な日時が一致
    if same_name >= NAME_SIM and diff <= tol and body >= BODY_SIM:
        return 2.0 + body                          # 2. 作者が似ていて、日時の誤差内、本文冒頭が似ている
    if diff <= tol and body >= BODY_SIM_STRICT:
        return 1.0 + body                          # 3. 作者名が読めなくても本文がほぼ同じ
    approx = existing["posted_at_precision"] != EXACT and cand["posted_at_precision"] != EXACT
    if approx and diff <= MISREAD_HOURS * 60 and same_name >= 0.9 and body >= 0.97 and len(norm_text(cand["body_text"])) >= 20:
        return 1.5 + body                          # 4. 「N時間前」の数字の読み違い(19→17)。作者・本文が同じ長い投稿は同じノート
    return 0.0


def match_note(notes: list[dict], cand: dict) -> dict | None:
    best, best_score = None, 0.0
    for n in notes:
        s = note_score(n, cand)
        if s > best_score:
            best, best_score = n, s
    return best


def comment_score(existing: dict, cand: dict) -> float:
    diff, tol = _diff(existing, cand)
    body = sim(existing["body_text"], cand["body_text"])
    same_name = name_sim(existing["author_name"], cand["author_name"])
    if diff > tol:
        return 0.0
    if same_name >= NAME_SIM and body >= BODY_SIM:
        return 2.0 + body
    if body >= BODY_SIM_STRICT:
        return 1.0 + body
    return 0.0


def match_comment(existing: list[dict], cand: dict, claimed: set[int], ordinal: int) -> int | None:
    """そのノートの既存コメントから同じものを探す. 同じ人の同じ短文が2件あっても、
    まだ対応づけていないものの中から、表示順が最も近いものを選ぶ."""
    best: int | None = None
    best_key: tuple[float, float] = (0.0, 0.0)
    for i, c in enumerate(existing):
        if i in claimed:
            continue
        s = comment_score(c, cand)
        if s <= 0:
            continue
        key = (s, -abs(int(c.get("ordinal", 0)) - ordinal))
        if best is None or key > best_key:
            best, best_key = i, key
    return best


def same_block(a: dict, b: dict) -> bool:
    """連続する2枚の画面の重なり部分で、同じ投稿かを判定する(ノート・コメント共通).
    表示時刻の文字(posted_at_raw)が同じなら本文が似ていれば足りる. 違うときはほぼ同一の本文を要求する."""
    if a["posted_at_precision"] and b["posted_at_precision"]:
        diff, tol = _diff(a, b)
        if diff > max(tol, 90):      # 画面をまたぐ間に「N時間前」の表示が変わることがある
            return False
    names = name_sim(a["author_name"], b["author_name"])
    if not norm_text(a["body_text"]) and not norm_text(b["body_text"]):
        return names >= NAME_SIM        # 画像だけの投稿など
    body = max(sim(a["body_text"], b["body_text"]), contain_sim(a["body_text"], b["body_text"]) if names >= NAME_SIM else 0.0)
    raw_a = re.sub(r"\s", "", a.get("posted_at_raw", ""))
    raw_b = re.sub(r"\s", "", b.get("posted_at_raw", ""))
    if raw_a and raw_a == raw_b:
        return body >= BODY_SIM and names >= NAME_SIM
    return body >= 0.97 and names >= 0.9     # 表示の時刻の文字が違う(別の時刻のコメントかもしれない)ので、作者名もほぼ同じであることを求める
