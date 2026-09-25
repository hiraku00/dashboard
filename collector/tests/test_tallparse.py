"""縦長の1枚画像を、ノート/コメントに区切る(合成した画像・OCR行を使う。実際の投稿は使わない)."""
import os

import numpy as np
import pytest

from line_openchat import layout as K
from line_openchat import tallocr, tallparse
from line_openchat.screen import Line
from sim import SimChat, SimComment, SimNote

W = int(K.WIN_W)


def render(chat):
    """SimChat の文書全体を、1倍の縦長画像・OCR行・数字/名前の読み取り関数にする."""
    lines, rects, digits, names, total, _ = chat._doc()
    arr = np.empty((int(total) + 60, W, 3), dtype=np.uint8)
    arr[:] = K.BG
    for x0, y0, x1, y1, c in rects:
        arr[int(y0):int(y1), int(x0):int(x1)] = c

    def digits_reader(sub, x, y, w, h, repeat=1, enlarge=5):
        for a, b, dy, text in digits:
            if abs(dy - (y + h / 2)) < 12 and x - 3 <= a and b <= x + w + 3:
                return " ".join([text] * repeat)
        return ""

    def name_reader(sub, x, y, w, h):
        return next((t for ny, t in names if y - 6 <= ny <= y + h + 6), "")

    return tallocr.ArrayTall(arr), [l for l in lines if l.y > 0], digits_reader, name_reader


def chat_with(n_comments=(3, 0, 5)):
    notes = [SimNote(f"参加者{i}", f"投稿{i}の本文です。", "昨日 午前 9:45", badge=(i == 1), reactions=3 + i, open=True,
                     comments=[SimComment(f"人{i}-{j}", f"コメント{i}-{j}", f"{j + 1}時間前") for j in range(c)])
             for i, c in enumerate(n_comments)]
    return SimChat(notes, jitter=False)


def parse(chat, drop=None, line_reader=None):
    image, lines, dr, nr = render(chat)
    if drop:
        lines = [l for l in lines if not drop(l)]
    blocks, warnings = tallparse.parse_tall(image, lines, 1.0, float(W), digits_reader=dr, name_reader=nr, line_reader=line_reader)
    return tallparse.group_notes(blocks), warnings, image


def test_notes_comments_and_counts_are_split_from_one_tall_image():
    groups, warnings, _ = parse(chat_with())
    assert [len(g.comments) for g in groups] == [3, 0, 5]
    assert [g.note.comments for g in groups] == [3, 0, 5]
    assert [g.note.reactions for g in groups] == [3, 4, 5]
    assert groups[0].comments[1].author == "人0-1" and "コメント0-1" in groups[0].comments[1].text
    assert warnings == []


def test_time_row_misread_is_recovered_by_rereading_the_band():
    chat = chat_with((4,))
    seen = []

    def reader(arr, x, y, w, h, enlarge=3, langs=(), correction=False):
        seen.append(enlarge)
        return [("2時間前", 49.0, 4.0, 48.0, 14.0)] if enlarge >= 4 else [("2 時尚町", 49.0, 4.0, 48.0, 14.0)]

    groups, warnings, _ = parse(chat, drop=lambda l: l.text == "3時間前", line_reader=reader)
    assert len(groups[0].comments) == 4
    assert any("読み直し" in w for w in warnings) and max(seen) >= 4


def test_without_a_reader_a_lost_time_row_merges_comments():
    """読み直しが無ければ、時刻の行を読み落とした投稿は隣と混ざる(読み直しの意味の確認)."""
    groups, _, _ = parse(chat_with((4,)), drop=lambda l: l.text == "3時間前")
    assert len(groups[0].comments) == 3


FIXTURE = os.path.join(os.path.dirname(__file__), "..", "data", "line_openchat", "fixtures", "shottr_tall.png")


@pytest.mark.skipif(not os.path.exists(FIXTURE), reason="実機の縦長画像(gitignore)が無い")
def test_real_tall_image_note_counts_match_shown_counts():
    """実機の縦長画像(1倍・幅400)。表示されている件数と取れた件数が、ほぼ全ノートで合う(縫い目の重複は撮影ツールの都合)."""
    image = tallocr.load_image(FIXTURE)
    lines = tallocr.ocr_tall(image, image.width, 1.0)
    blocks, _ = tallparse.parse_tall(image, lines, 1.0, 400.0, digits_reader=tallocr.ocr_digits_array,
                                     name_reader=tallocr.ocr_name_array, line_reader=tallocr.ocr_lines_array)
    groups = tallparse.group_notes(blocks)
    # 1倍の画面では、1桁の数字はOCRが安定して読めない(Retinaでは読める)。読めたときは正しいことを確かめる。「不明」は許す
    wrong = [g for g in groups if g.note.comments is not None and g.note.comments != len(g.comments)]
    known = [g for g in groups if g.note.comments is not None]
    assert len(groups) >= 10 and len(known) >= len(groups) - 4 and len(wrong) <= 1


def test_thread_reader_module_imports():
    """実機用の読み取り部品が、構文や参照の誤りなく読み込める(模擬では通らない経路なので、読み込みだけ確かめる)."""
    from line_openchat import threadread
    assert hasattr(threadread.TallThreadReader, "read_all") and hasattr(threadread.TallThreadReader, "motion")
