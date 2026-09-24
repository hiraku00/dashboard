"""LINEは参照のみ.

このcollectorがLINEに対して行ってよい操作は、次の4種類のクリックと、スクロール・撮影だけ。

  toggle_comments        ノートのコメントアイコンを押して、コメント欄を開く/閉じる
  load_earlier_comments  「前のコメントを見る」を押して、古いコメントを表示する
  expand_body            「もっと見る」を押して、ノート本文を全文表示する
  raise_window           ノートウィンドウを前面へ出す(AXRaise)

投稿・リアクション・返信・削除・通報・共有・入力欄への文字入力は一切しない。
キーボードイベントは送らない。クリックは必ず guard_click() を通し、押す場所に
期待する文字・アイコンが実際にあることを画面で確認してから押す。押そうとしている
場所が禁止領域(リアクション/共有アイコン、投稿ボタン「+」、入力欄、︙メニュー)に
かかるときは ReadOnlyViolation で止める。tests/test_safety.py が、この仕組みを
迂回するコードが混ざっていないかをソースの走査で確認する。
"""
from __future__ import annotations

from dataclasses import dataclass

from . import layout


class ReadOnlyViolation(RuntimeError):
    """LINEへの書き込みにつながりうる操作が要求された."""


ALLOWED_CLICK_KINDS = frozenset({"toggle_comments", "load_earlier_comments", "expand_body"})
ALLOWED_AX_ACTIONS = frozenset({"AXRaise"})

@dataclass(frozen=True)
class ClickTarget:
    """これから押す場所と、そこに何があるべきか."""
    kind: str
    x: float                 # ウィンドウ内pt
    y: float
    expect_text: str = ""    # OCRで読めるはずの文字(例: 「前のコメントを見る」)
    icon_span: tuple[float, float] | None = None   # コメントアイコンの横幅(toggle_comments)
    counts_y: float | None = None                  # 数の行の中心(toggle_comments)


def guard_click(target: ClickTarget, screen) -> None:
    """押してよい場所かを画面で確認する. だめなら ReadOnlyViolation."""
    if target.kind not in ALLOWED_CLICK_KINDS:
        raise ReadOnlyViolation(f"許可されていない操作: {target.kind}")
    x, y = target.x, target.y
    if not (0 <= x <= screen.width and 0 <= y <= screen.height):
        raise ReadOnlyViolation(f"ウィンドウの外です: ({x:.0f},{y:.0f})")
    if y < layout.TOP_MARGIN:
        raise ReadOnlyViolation("タイトルバー付近は押せません")
    # 右下の「投稿(+)」ボタン
    if x >= 340 and y >= screen.height - 130:
        raise ReadOnlyViolation("投稿ボタンの付近は押せません")
    # 各投稿の右上の「︙」メニュー(削除・通報などが出る)は x≈400. 押す対象は x≤380 にしかない
    if x >= 380:
        raise ReadOnlyViolation("右端(︙メニューなど)は押せません")

    if target.kind == "toggle_comments":
        _guard_toggle(target, screen)
    else:
        _guard_text_button(target, screen)


def _guard_text_button(target: ClickTarget, screen) -> None:
    if not target.expect_text:
        raise ReadOnlyViolation("押す場所の文字が指定されていません")
    hits = [l for l in screen.lines if target.expect_text in l.text.replace(" ", "").replace(" ", "")
            and l.y - 6 <= target.y <= l.y + l.h + 6
            and l.x - 6 <= target.x <= l.x + l.w + 6]
    if not hits:
        raise ReadOnlyViolation(f"「{target.expect_text}」が押す場所にありません")
    # 入力欄・投稿ボタンに触れないこと
    for l in screen.lines:
        if "コメントを入力" in l.text and abs(l.cy - target.y) < 40:
            raise ReadOnlyViolation("コメント入力欄の付近は押せません")
        if l.text.strip() == "投稿" and abs(l.cy - target.y) < 40:
            raise ReadOnlyViolation("投稿ボタンの付近は押せません")


def _guard_toggle(target: ClickTarget, screen) -> None:
    """コメントアイコン(数の行の2番目のアイコン)の内側だけを押す. 1番目はリアクション、3番目は共有."""
    if target.icon_span is None or target.counts_y is None:
        raise ReadOnlyViolation("コメントアイコンの位置が確認できていません")
    x0, x1 = target.icon_span
    if not (x0 <= target.x <= x1):
        raise ReadOnlyViolation("コメントアイコンの外側は押せません")
    if abs(target.y - target.counts_y) > 4:
        raise ReadOnlyViolation("数の行の外側は押せません")
    # リアクション(x=18〜35)・共有(数の行の3番目、x>=86)と重ならない: コメントアイコンは x=50〜92
    # (リアクション数の桁数で動く。実測: 1桁 約56〜72 / 2桁 64〜80 / 3桁 72〜88)
    if not (50.0 <= x0 and x1 <= 92.0):
        raise ReadOnlyViolation("コメントアイコンとして想定外の位置です(リアクション/共有アイコンの可能性)")
