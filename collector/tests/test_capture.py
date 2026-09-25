"""画素でのつなぎ合わせ: 合成した文書を、ずらしながら撮って、元の文書と行単位で完全に一致するか."""
import numpy as np
import pytest

from line_openchat.capture import (BG, CaptureError, Stitcher, blank_mask, calibrate, measure_shift, row_fingerprints,
                                   scan_down, scroll_to_top)
from synth import SynthSource, make_document


def setup(scale=1.0, blocks=120, **kw):
    doc = make_document(seed=kw.pop("doc_seed", 3), width=int(428 * scale), blocks=blocks, scale=scale, repeat_block=kw.pop("repeat_block", None),
                        bottom_pad=kw.pop("bottom_pad", 300))
    src = SynthSource(doc, scale=scale, **kw)
    return doc, src


def run_scan(src, **kw):
    cal = calibrate(src)
    first = scroll_to_top(src)
    return cal, scan_down(src, cal, first, **kw)


def expected_rows(doc, src, cal, virt_h):
    start = cal.band_top - src.top_fixed          # 先頭(pos=0)で撮った最初の画像の、帯の上端が指す文書の行
    return doc[start: start + virt_h]


@pytest.mark.parametrize("scale", [1.0, 2.0])
def test_calibration_finds_scale_bands_fab_and_line_height(scale):
    doc, src = setup(scale, blocks=60)
    cal = calibrate(src)
    assert cal.scale == scale and cal.frame_w == src.W and cal.frame_h == src.H
    assert cal.band_top >= src.top_fixed and cal.band_top <= src.top_fixed + int(20 * scale)
    assert cal.fab is not None and abs(cal.fab[1] - (src.H - int(130 * scale))) <= 2
    assert cal.band_bottom < cal.fab[1]
    assert abs(cal.px_per_line - src.ppl) < 0.5
    assert cal.x1 < src.W


def test_calibration_fails_clearly_when_the_screen_does_not_move():
    doc, src = setup(1.0, blocks=60)
    src.scroll = lambda lines: None
    with pytest.raises(CaptureError):
        calibrate(src)


@pytest.mark.parametrize("scale,jitter", [(1.0, 0.0), (2.0, 0.0), (1.0, 0.25), (2.0, 0.25)])
def test_stitched_image_equals_the_document_exactly(scale, jitter):
    doc, src = setup(scale, blocks=150, jitter=jitter)
    cal, result = run_scan(src)
    st = result.stitcher
    assert result.reached_end
    virt = st.crop(0, st.height)
    exp = expected_rows(doc, src, cal, st.height)
    assert len(virt) == len(exp)
    x1 = cal.x1
    fab_x0, fab_y0 = cal.fab[0], cal.fab[1]
    # ＋ボタンに隠れる、最後の画像の右下だけは背景色。それ以外は、1行も違わない
    tail_start = len(virt) - (src.H - fab_y0) - int(6 * scale)
    assert np.array_equal(virt[:tail_start, :x1], exp[:tail_start, :x1]), "縦長画像が文書と一致しません"
    assert np.array_equal(virt[tail_start:, :fab_x0 - 2], exp[tail_start:, :fab_x0 - 2])
    assert (virt[len(virt) - (src.H - fab_y0):, fab_x0:x1] == BG.astype(np.uint8)).all()
    st.close()


def test_no_row_is_duplicated_or_dropped():
    """重複・欠落が無いこと: 縦長画像の行数が、文書の該当範囲と同じで、各行が1回だけ現れる."""
    doc, src = setup(1.0, blocks=200, jitter=0.2)
    cal, result = run_scan(src)
    st = result.stitcher
    virt = st.crop(0, st.height)
    fp = row_fingerprints(virt, cal.x1)
    nonblank = ~blank_mask(virt, cal.x1)
    vals, counts = np.unique(fp[nonblank], return_counts=True)
    assert counts.max() == 1, "同じ内容の行が2回以上現れました(重複)"
    assert st.height == len(expected_rows(doc, src, cal, st.height))
    st.close()


def test_cuts_are_made_only_on_blank_rows():
    """画像の切り替え位置は、必ず無地の行(文字の行の途中で切らない)."""
    doc, src = setup(1.0, blocks=150, jitter=0.15)
    cal, result = run_scan(src)
    st = result.stitcher
    virt = st.crop(0, st.height)
    blank = blank_mask(virt, cal.x1)
    assert len(st.pieces) > 5
    for p in st.pieces[1:]:
        assert blank[p.dst_y0], f"y={p.dst_y0} は文字の行の途中で切れています"
    assert not st.warnings
    st.close()


def test_repeated_identical_blocks_do_not_confuse_the_alignment():
    """同じ内容が3回続く(同じ短文のコメントが続く形). 繰り返しの周期で取り違えず、重複も欠落もない."""
    doc, src = setup(1.0, blocks=90, repeat_block=40, jitter=0.1)
    cal, result = run_scan(src)
    st = result.stitcher
    virt = st.crop(0, st.height)
    exp = expected_rows(doc, src, cal, st.height)
    tail = len(virt) - (src.H - cal.fab[1]) - 6
    assert np.array_equal(virt[:tail, :cal.x1], exp[:tail, :cal.x1])
    st.close()


def test_time_text_changing_between_frames_is_tolerated():
    """「5分前」→「6分前」のように、行の一部が撮るたびに変わっても、位置は正しく測れる."""
    doc, src = setup(1.0, blocks=100, time_noise=0.08)
    cal, result = run_scan(src)
    assert result.reached_end and result.rejected == 0
    result.stitcher.close()


def test_too_large_a_jump_is_rejected_then_recovered_with_a_smaller_step():
    """1回に飛びすぎて重ならない場合、その画像を捨て、歩幅を半分にして撮り直す."""
    doc, src = setup(1.0, blocks=100)
    cal = calibrate(src)
    first = scroll_to_top(src)
    src.ppl = src.ppl * 6                        # 突然、スクロール量が6倍になる(慣性・加速)
    result = scan_down(src, cal, first)
    assert result.rejected >= 1 and result.reached_end
    virt = result.stitcher.crop(0, result.stitcher.height)
    exp = expected_rows(doc, src, cal, len(virt))
    tail = len(virt) - (src.H - cal.fab[1]) - 6
    assert np.array_equal(virt[:tail, :cal.x1], exp[:tail, :cal.x1])
    result.stitcher.close()


def test_three_failures_in_a_row_stop_with_a_clear_error():
    doc, src = setup(1.0, blocks=60)
    cal = calibrate(src)
    first = scroll_to_top(src)
    src.fail_grabs = True                        # 以後の画像は、前と全く重ならない
    with pytest.raises(CaptureError) as e:
        scan_down(src, cal, first)
    assert "回続けて" in str(e.value)


def test_end_of_list_is_detected_and_stops():
    doc, src = setup(1.0, blocks=30)
    cal, result = run_scan(src)
    assert result.reached_end
    assert result.frames < 60


def test_stop_condition_ends_the_scan_early():
    doc, src = setup(1.0, blocks=200)
    cal = calibrate(src)
    first = scroll_to_top(src)
    seen = {"n": 0}

    def stop(frame, offset=0):
        seen["n"] += 1
        return seen["n"] >= 5
    result = scan_down(src, cal, first, stop=stop)
    assert not result.reached_end and result.frames == 6
    assert result.stitcher.height > 0
    result.stitcher.close()


def test_scroll_bar_and_fixed_parts_never_enter_the_stitched_image():
    doc, src = setup(1.0, blocks=120)
    cal, result = run_scan(src)
    st = result.stitcher
    virt = st.crop(0, st.height)
    assert (virt[:, cal.x1:] == BG.astype(np.uint8)).all()                # スクロールバーの列
    hdr = src._header
    fp_hdr = set(row_fingerprints(hdr, cal.x1).tolist())
    fp_virt = set(row_fingerprints(virt, cal.x1).tolist())
    assert not (fp_hdr & fp_virt), "固定の見出しが混ざっています"
    fab_rows = set(row_fingerprints(np.pad(src._fab, ((0, 0), (0, cal.frame_w - src._fab.shape[1]), (0, 0))), cal.x1).tolist())
    st.close()


def test_tiles_cover_the_whole_image_with_overlap_and_can_be_shifted():
    doc, src = setup(1.0, blocks=100)
    cal, result = run_scan(src)
    st = result.stitcher
    tiles = list(st.tiles(1000, 200))
    assert tiles[0][0] == 0 and len(tiles) >= 2
    for (y0, img), (y1, _) in zip(tiles, tiles[1:]):
        assert y1 - y0 == 800                                             # 重なり200
    last_y, last_img = tiles[-1]
    assert last_y + len(last_img) == st.height
    assert np.array_equal(tiles[1][1][:200], st.crop(tiles[1][0], tiles[1][0] + 200))
    shifted = list(st.tiles(1000, 200, offset=400))
    assert shifted[0][0] == 0 and shifted[1][0] == 400
    assert shifted[-1][0] + len(shifted[-1][1]) == st.height
    st.close()


def test_measure_shift_reports_unchanged_for_identical_frames():
    doc, src = setup(1.0, blocks=60)
    cal = calibrate(src)
    a = scroll_to_top(src)
    fp, bl = row_fingerprints(a, cal.x1), blank_mask(a, cal.x1)
    assert measure_shift(fp, fp, bl, cal.band_top, cal.band_bottom, 1.0).kind == "unchanged"
