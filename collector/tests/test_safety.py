"""LINEは参照のみ、という約束を機械的に確かめる."""
import re
from pathlib import Path

import pytest

from line_openchat import layout as K
from line_openchat.parse import split_blocks
from line_openchat.safety import ClickTarget, ReadOnlyViolation, guard_click
from sim import SimChat, SimComment, SimNote

PKG = Path(__file__).resolve().parents[1] / "line_openchat"


def screen_with_thread():
    chat = SimChat([SimNote("参加者A", "本文です。", "昨日 午前 9:45", comments=[SimComment("a", "b", "1時間前")] * 12,
                            reactions=39, open=True, long_body=True)], jitter=False)
    return chat, chat.screen()


def test_toggle_is_allowed_only_on_the_comment_icon():
    chat, screen = screen_with_thread()
    note = next(b for b in split_blocks(screen) if b.kind == "note")
    x0, x1 = note.comment_icon
    ok = ClickTarget("toggle_comments", (x0 + x1) / 2, note.counts_y, icon_span=(x0, x1), counts_y=note.counts_y)
    guard_click(ok, screen)                                            # 押してよい
    for x in (26.0, 47.0, x1 + 40):                                    # リアクションアイコン・数字・共有アイコンのあたり
        with pytest.raises(ReadOnlyViolation):
            guard_click(ClickTarget("toggle_comments", x, note.counts_y, icon_span=(x0, x1), counts_y=note.counts_y), screen)
    with pytest.raises(ReadOnlyViolation):                             # 数の行の外
        guard_click(ClickTarget("toggle_comments", (x0 + x1) / 2, note.counts_y + 30, icon_span=(x0, x1), counts_y=note.counts_y), screen)


def test_reaction_icon_span_is_rejected_even_if_claimed_as_the_comment_icon():
    chat, screen = screen_with_thread()
    with pytest.raises(ReadOnlyViolation):
        guard_click(ClickTarget("toggle_comments", 26, 500, icon_span=(18, 35), counts_y=500), screen)


def test_text_buttons_need_their_text_under_the_pointer():
    chat, screen = screen_with_thread()
    cut = next(l for l in screen.lines if "前のコメントを見る" in l.text)
    guard_click(ClickTarget("load_earlier_comments", cut.x + cut.w / 2, cut.cy, expect_text="前のコメントを見る"), screen)
    with pytest.raises(ReadOnlyViolation):                             # 文字のない場所
        guard_click(ClickTarget("load_earlier_comments", cut.x + cut.w / 2, cut.cy + 200, expect_text="前のコメントを見る"), screen)
    with pytest.raises(ReadOnlyViolation):                             # 期待する文字が違う
        guard_click(ClickTarget("load_earlier_comments", cut.x + cut.w / 2, cut.cy, expect_text="投稿"), screen)


def test_disallowed_kinds_and_zones_are_rejected():
    chat, screen = screen_with_thread()
    for kind in ("post", "reaction", "delete", "type_text", "share", "menu"):
        with pytest.raises(ReadOnlyViolation):
            guard_click(ClickTarget(kind, 100, 300, expect_text="x"), screen)
    with pytest.raises(ReadOnlyViolation):                             # 右下の投稿(+)ボタン
        guard_click(ClickTarget("expand_body", 380, K.WIN_H - 60, expect_text="もっと見る"), screen)
    with pytest.raises(ReadOnlyViolation):                             # 右端の「︙」メニュー
        guard_click(ClickTarget("expand_body", 400, 300, expect_text="もっと見る"), screen)
    with pytest.raises(ReadOnlyViolation):                             # ウィンドウの外
        guard_click(ClickTarget("expand_body", -5, 300, expect_text="もっと見る"), screen)


def test_input_box_neighbourhood_is_never_clicked():
    chat, screen = screen_with_thread()
    ends = [l for l in screen.lines if "コメントを入力" in l.text]
    if not ends:
        chat.scroll_y = chat.max_scroll()
        screen = chat.screen()
        ends = [l for l in screen.lines if "コメントを入力" in l.text]
    assert ends
    e = ends[0]
    with pytest.raises(ReadOnlyViolation):
        guard_click(ClickTarget("expand_body", e.x + 5, e.cy, expect_text="コメントを入力"), screen)


# ---------- ソースの走査: 書き込みにつながるAPIを使っていないこと ----------
SOURCES = {p.name: p.read_text(encoding="utf-8") for p in PKG.glob("*.py")}
CODE = {name: re.sub(r'(?s:""".*?""")|#[^\n]*', "", src) for name, src in SOURCES.items()}


def test_no_keyboard_or_text_input_apis_anywhere():
    banned = ["CGEventCreateKeyboardEvent", "kCGEventKeyDown", "keyboardSetUnicodeString", "AXUIElementSetAttributeValue",
              "NSPasteboard", "osascript", "pbcopy", "System Events", "keystroke", "CGEventKeyboardSetUnicodeString"]
    for name, code in CODE.items():
        if name == "lineui.py":
            code = code.replace("kCGEventKeyDown", "")           # 読み取り専用: キー入力の「検知」にだけ使う
        for token in banned:
            assert token not in code, f"{name} が {token} を使っています"
    assert "CGEventCreateKeyboardEvent" not in CODE["lineui.py"]


def test_key_detection_in_lineui_is_read_only():
    uses = [m.start() for m in re.finditer("kCGEventKeyDown", CODE["lineui.py"])]
    for pos in uses:
        assert "CGEventSourceSecondsSinceLastEventType" in CODE["lineui.py"][max(0, pos - 200):pos + 50]


def test_only_one_place_posts_mouse_button_events():
    hits = {n: c.count("kCGEventLeftMouseDown") for n, c in CODE.items() if "kCGEventLeftMouseDown" in c}
    assert list(hits) == ["lineui.py"] and hits["lineui.py"] == 2       # 1つは idle 検知、もう1つは click_at(押す処理)
    assert len(re.findall(r"CGEventCreateMouseEvent", CODE["lineui.py"])) == 1
    assert "right" not in CODE["lineui.py"].lower().replace("rightmouse", "x") or "kCGEventRightMouse" not in CODE["lineui.py"]
    assert "kCGEventRightMouse" not in CODE["lineui.py"] and "kCGEventOtherMouse" not in CODE["lineui.py"]


def test_clicks_only_go_through_session_click_and_the_guard():
    # click_at を呼んでよいのは Session._click だけ(guard_click の直後)
    callers = [n for n, c in CODE.items() if re.search(r"\.click_at\(", c)]
    assert callers == ["session.py"]
    s = CODE["session.py"]
    assert len(re.findall(r"\.click_at\(", s)) == 1
    body = s[s.index("def _click"):]
    assert body.index("guard_click(") < body.index(".click_at(")
    assert "DRIVER" not in s and "click_at" not in CODE["sync.py"] and "click_at" not in CODE["uploader.py"]


def test_ax_actions_are_limited_to_raise():
    for name, code in CODE.items():
        for m in re.finditer(r"AXUIElementPerformAction\(([^)]*)\)", code):
            assert "action" in m.group(1), f"{name}: {m.group(0)}"
    assert 'action = "AXRaise"' in CODE["lineui.py"]
    assert "AXPress" not in "".join(CODE.values()) and "AXConfirm" not in "".join(CODE.values())


def test_allowed_click_kinds_are_exactly_the_three_read_only_ones():
    from line_openchat.safety import ALLOWED_AX_ACTIONS, ALLOWED_CLICK_KINDS
    assert ALLOWED_CLICK_KINDS == {"toggle_comments", "load_earlier_comments", "expand_body"}
    assert ALLOWED_AX_ACTIONS == {"AXRaise"}
    for src in SOURCES.values():
        for kind in re.findall(r'ClickTarget\("(\w+)"', src):
            assert kind in ALLOWED_CLICK_KINDS
