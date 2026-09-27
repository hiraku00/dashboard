"""コメント欄の終わり(入力欄の「投稿」ボタン)を数えて、撮影を止める判定(threadread.EndCounter / find_post_buttons)."""
import numpy as np

from line_openchat.capture import BG, Calibration, calibrate, scan_down, scroll_to_top
from line_openchat.threadread import POST_BTN, EndCounter, find_post_buttons
from synth import SynthSource, make_document

CAL = Calibration(scale=1.0, frame_w=428, frame_h=1130, x1=408, band_top=70, band_bottom=1000, fab=None, px_per_line=16.8)
BTN = tuple(int(v) for v in POST_BTN)


def canvas(scale=1.0, h_pt=900, w_pt=408):
    return np.tile(BG.astype(np.uint8), (int(h_pt * scale), int(w_pt * scale), 1))


def paint(img, scale, x_pt, y_pt, w_pt, h_pt, color):
    img[int(y_pt * scale):int((y_pt + h_pt) * scale), int(x_pt * scale):int((x_pt + w_pt) * scale)] = color


def post_button(img, scale, y_pt, text_rows=True):
    """実機と同じ寸法(高さ38pt・幅50pt)のくすんだ緑の四角. 中央に白い文字の行(緑が減る行)を置く."""
    paint(img, scale, 358, y_pt, 50, 38, BTN)
    if text_rows:
        paint(img, scale, 372, y_pt + 12, 22, 14, (230, 230, 230))


def test_post_button_is_found_at_any_scale():
    for scale in (1.0, 2.0):
        img = canvas(scale)
        post_button(img, scale, 300)
        ys = find_post_buttons(img, scale)
        assert len(ys) == 1 and abs(ys[0] - 319) < 2, ys                # 上端300 + 高さ38の半分


def test_other_green_things_are_not_counted():
    """右下の＋ボタン(明るい緑)・小さな緑のアバター・アバターより細い塊・ボタンより低いものは、入力欄ではない."""
    scale = 2.0
    img = canvas(scale)
    paint(img, scale, 340, 100, 58, 58, (7, 181, 59))          # ＋ボタン(明るい緑)
    paint(img, scale, 371, 250, 24, 24, BTN)                    # 小さな塊(アバター大)
    paint(img, scale, 300, 400, 100, 12, BTN)                   # 低い帯
    paint(img, scale, 20, 500, 50, 38, BTN)                     # 左側(画面の右側だけを見る)
    assert find_post_buttons(img, scale) == []


def test_a_button_cut_by_the_band_edge_is_not_counted_then_counted_whole():
    """帯の端で切れて高さが足りないものは数えず、次の画面(全体が写る)で数える."""
    scale = 1.0
    img = canvas(scale, h_pt=900)
    post_button(img, scale, 880)                                # 下端で切れる(20pt分しか写らない)
    assert find_post_buttons(img, scale) == []
    img2 = canvas(scale, h_pt=900)
    post_button(img2, scale, 500)
    assert len(find_post_buttons(img2, scale)) == 1


def frame():
    return np.zeros((1130, 428, 3), dtype=np.uint8)


def test_stops_when_the_target_count_is_reached():
    ys = iter([[100.0], [], [600.0]])
    c = EndCounter(CAL, 2, finder=lambda band, scale: next(ys))
    assert c(frame(), 0) is False
    assert c(frame(), 400) is False
    assert c(frame(), 800) is True and len(c.ends) == 2


def test_the_same_button_seen_in_consecutive_frames_is_counted_once():
    """同じ入力欄が、続く2枚の画面に写っても、一覧上の位置で1件と数える."""
    # 1枚目(offset 0): 帯の中 y=500 → 一覧上 70+500。2枚目(offset 400): 同じ位置 → 帯の中 y=100 → 400+70+100
    ys = iter([[500.0], [100.0]])
    c = EndCounter(CAL, 2, finder=lambda band, scale: next(ys))
    c(frame(), 0)
    assert c(frame(), 400) is False and len(c.ends) == 1


def test_a_target_of_zero_never_stops_and_looks_at_nothing():
    calls = []
    c = EndCounter(CAL, 0, finder=lambda band, scale: calls.append(1) or [])
    assert c(frame(), 0) is False and calls == []


def test_not_reaching_the_target_never_stops():
    ys = iter([[100.0]] + [[]] * 5)
    c = EndCounter(CAL, 2, finder=lambda band, scale: next(ys))
    assert not any(c(frame(), 300 * i) for i in range(6))


def test_works_as_the_stop_condition_of_scan_down():
    """scan_down の stop として使う: 目標に達したところで撮影が終わり、達しなければ末尾まで撮る."""
    doc = make_document(seed=3, width=428, blocks=200, bottom_pad=300)
    seen = []

    def finder(band, scale):
        seen.append(1)
        return [10.0] if len(seen) in (2, 4) else []
    src = SynthSource(doc)
    cal = calibrate(src)
    early = scan_down(src, cal, scroll_to_top(src), stop=EndCounter(cal, 2, finder=finder))
    assert not early.reached_end and early.frames == 4
    early.stitcher.close()

    src2 = SynthSource(doc)
    cal2 = calibrate(src2)
    full = scan_down(src2, cal2, scroll_to_top(src2), stop=EndCounter(cal2, 2, finder=lambda b, s: []))
    assert full.reached_end and full.frames > early.frames
    full.stitcher.close()
