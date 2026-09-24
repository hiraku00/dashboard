"""LINE for Mac のノートウィンドウを、読み取り専用で操作する(macOS専用).

- 撮影: screencapture -l <windowId>(ほかのウィンドウの後ろでも撮れる)
- 文字: macOS標準の Vision(日本語)
- 操作: マウスのスクロールと、safety.guard_click を通ったクリックだけ。キーボードイベントは送らない
"""
from __future__ import annotations

import math
import os
import subprocess
import tempfile
import time
from dataclasses import dataclass

import ApplicationServices as AS
import Quartz
import Vision
from AppKit import NSApplicationActivateIgnoringOtherApps, NSBitmapImageRep, NSRunningApplication
from Foundation import NSMakeRange, NSURL

from . import layout as K
from .safety import ALLOWED_AX_ACTIONS, ReadOnlyViolation
from .screen import Line
from .session import Aborted

LINE_BUNDLE = "jp.naver.line.mac"


class EnvironmentError_(RuntimeError):
    """実行の前提を満たしていない(LINE未起動、画面ロックなど)."""

    def __init__(self, message: str, code: int):
        super().__init__(message)
        self.code = code


@dataclass
class Win:
    id: int
    x: float
    y: float
    w: float
    h: float


# ---------- 前提の確認 ----------
def line_pid() -> int:
    apps = NSRunningApplication.runningApplicationsWithBundleIdentifier_(LINE_BUNDLE)
    if not apps:
        raise EnvironmentError_("LINEが起動していません", 2)
    return apps[0].processIdentifier()


def screen_locked() -> bool:
    info = Quartz.CGSessionCopyCurrentDictionary() or {}
    return bool(info.get("CGSSessionScreenIsLocked", 0))


def idle_seconds() -> float:
    """キーボード・マウスの最後の操作からの秒数(この collector の操作は含まれない: 自分の合成イベントは別扱い)."""
    return min(
        Quartz.CGEventSourceSecondsSinceLastEventType(Quartz.kCGEventSourceStateHIDSystemState, t)
        for t in (Quartz.kCGEventKeyDown, Quartz.kCGEventLeftMouseDown, Quartz.kCGEventMouseMoved)
    )


def check_environment() -> None:
    line_pid()
    if screen_locked():
        raise EnvironmentError_("画面がロックされています", 3)
    if not AS.AXIsProcessTrusted():
        raise EnvironmentError_("アクセシビリティの許可がありません(システム設定 > プライバシーとセキュリティ)", 4)


def _ax_windows():
    app = AS.AXUIElementCreateApplication(line_pid())
    err, wins = AS.AXUIElementCopyAttributeValue(app, "AXWindows", None)
    return wins or []


def _ax_attr(el, name):
    err, value = AS.AXUIElementCopyAttributeValue(el, name, None)
    return value


def _is_note_ax(ax) -> bool:
    """ノートウィンドウ: タイトルが空で、幅300〜700ptの縦長ウィンドウ(本体は幅900pt・タイトル「LINE」)."""
    if _ax_attr(ax, "AXTitle"):
        return False
    size = _ax_attr(ax, "AXSize")
    if size is None:
        return False
    s = AS.AXValueGetValue(size, AS.kAXValueCGSizeType, None)[1]
    return 300 <= s.width <= 700 and s.height > 400


def _cg_windows() -> list[dict]:
    pid = line_pid()
    wins = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements, Quartz.kCGNullWindowID)
    out = []
    for w in wins:
        if w.get("kCGWindowOwnerPID") != pid or w.get("kCGWindowLayer") != 0:
            continue
        b = w["kCGWindowBounds"]
        if b["Width"] < 200:
            continue
        out.append({"id": w["kCGWindowNumber"], "name": w.get("kCGWindowName") or "",
                    "x": b["X"], "y": b["Y"], "w": b["Width"], "h": b["Height"]})
    return out


def find_note_window() -> Win | None:
    for ax in _ax_windows():
        if not _is_note_ax(ax):
            continue
        pos = _ax_attr(ax, "AXPosition")
        p = AS.AXValueGetValue(pos, AS.kAXValueCGPointType, None)[1]
        for w in _cg_windows():
            if abs(w["x"] - p.x) < 2 and abs(w["y"] - p.y) < 2 and w["name"] != "LINE":
                return Win(w["id"], w["x"], w["y"], w["w"], w["h"])
    return None


def raise_note_window() -> None:
    action = "AXRaise"
    if action not in ALLOWED_AX_ACTIONS:
        raise ReadOnlyViolation(action)
    for ax in _ax_windows():
        if _is_note_ax(ax):
            AS.AXUIElementPerformAction(ax, action)
            time.sleep(0.3)
            return


def activate_line() -> None:
    apps = NSRunningApplication.runningApplicationsWithBundleIdentifier_(LINE_BUNDLE)
    apps[0].activateWithOptions_(NSApplicationActivateIgnoringOtherApps)
    time.sleep(0.4)


# ---------- 画面 ----------
class MacScreen:
    """撮影した1枚. Screen プロトコルの実装."""

    def __init__(self, path: str, win: Win):
        self.path, self.win = path, win
        self.width, self.height = win.w, win.h
        url = NSURL.fileURLWithPath_(path)
        src = Quartz.CGImageSourceCreateWithURL(url, None)
        self._cg = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
        self._px_w = Quartz.CGImageGetWidth(self._cg)
        self._scale = self._px_w / win.w
        self._rep = NSBitmapImageRep.imageRepWithContentsOfFile_(path)
        self.lines: list[Line] = self._ocr()

    def _ocr(self) -> list[Line]:
        req = Vision.VNRecognizeTextRequest.alloc().init()
        req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
        req.setRecognitionLanguages_(["ja-JP", "en-US"])
        req.setUsesLanguageCorrection_(True)
        handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(NSURL.fileURLWithPath_(self.path), None)
        handler.performRequests_error_([req], None)
        lines = []
        for o in req.results() or []:
            c = o.topCandidates_(1)[0]
            b = o.boundingBox()
            line = Line(str(c.string()), b.origin.x * self.win.w, (1 - b.origin.y - b.size.height) * self.win.h,
                        b.size.width * self.win.w, b.size.height * self.win.h, float(c.confidence()))
            line._cand = c  # type: ignore[attr-defined]   # 文字単位の位置を後で取るため
            lines.append(line)
        lines.sort(key=lambda l: (round(l.y / 4), l.x))
        return lines

    def text_center_x(self, line: Line, needle: str) -> float:
        idx = line.text.find(needle)
        if idx < 0:
            return line.x + line.w / 2
        cand = getattr(line, "_cand", None)
        if cand is not None:
            try:
                box, _err = cand.boundingBoxForRange_error_(NSMakeRange(idx, len(needle)), None)
                if box is not None:
                    bb = box.boundingBox()
                    return (bb.origin.x + bb.size.width / 2) * self.win.w
            except Exception:                                    # noqa: BLE001 取れなければ比例で見積もる
                pass
        return line.x + line.w * (idx + len(needle) / 2) / max(1, len(line.text))

    def pixel(self, x: float, y: float) -> tuple[int, int, int]:
        c = self._rep.colorAtX_y_(int(x * self._scale), int(y * self._scale))
        if c is None:
            return (0, 0, 0)
        return (int(c.redComponent() * 255), int(c.greenComponent() * 255), int(c.blueComponent() * 255))

    def ocr_region(self, x: float, y: float, w: float, h: float) -> str:
        req = Vision.VNRecognizeTextRequest.alloc().init()
        req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
        req.setRecognitionLanguages_(["ja-JP", "en-US"])
        req.setUsesLanguageCorrection_(False)
        req.setRegionOfInterest_(Quartz.CGRectMake(x / self.win.w, 1 - (y + h) / self.win.h, w / self.win.w, h / self.win.h))
        handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(NSURL.fileURLWithPath_(self.path), None)
        handler.performRequests_error_([req], None)
        return " ".join(str(o.topCandidates_(1)[0].string()) for o in (req.results() or []))

    def ocr_digits(self, x: float, y: float, w: float, h: float, repeat: int = 1, scale: int = 5) -> str:
        """切り出して拡大し、周りに背景色の余白を付け、同じ画像を repeat 個横に並べて読む(1桁の数字対策)."""
        sx = self._scale
        crop = Quartz.CGImageCreateWithImageInRect(self._cg, Quartz.CGRectMake(x * sx, y * sx, w * sx, h * sx))
        pad = 12 * scale
        cw = int(w * sx * scale)
        W, H = cw * repeat + pad * (repeat + 1), int(h * sx * scale) + 2 * pad
        ctx = Quartz.CGBitmapContextCreate(None, W, H, 8, 0, Quartz.CGColorSpaceCreateDeviceRGB(),
                                           Quartz.kCGImageAlphaPremultipliedLast)
        Quartz.CGContextSetRGBFillColor(ctx, K.BG[0] / 255, K.BG[1] / 255, K.BG[2] / 255, 1)
        Quartz.CGContextFillRect(ctx, Quartz.CGRectMake(0, 0, W, H))
        Quartz.CGContextSetInterpolationQuality(ctx, Quartz.kCGInterpolationHigh)
        for i in range(repeat):
            Quartz.CGContextDrawImage(ctx, Quartz.CGRectMake(pad + i * (cw + pad), pad, cw, H - 2 * pad), crop)
        big = Quartz.CGBitmapContextCreateImage(ctx)
        req = Vision.VNRecognizeTextRequest.alloc().init()
        req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
        req.setRecognitionLanguages_(["en-US"])
        req.setUsesLanguageCorrection_(False)
        handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(big, None)
        handler.performRequests_error_([req], None)
        return " ".join(str(o.topCandidates_(1)[0].string()) for o in (req.results() or []))

    def close(self) -> None:
        try:
            os.unlink(self.path)
        except OSError:
            pass


# ---------- ドライバ ----------
class LineDriver:
    """session.Driver の実機実装. 撮影・スクロール・クリック(guard_click 済みのものだけ)."""

    def __init__(self, keep_screenshots: str | None = None):
        activate_line()
        raise_note_window()
        win = find_note_window()
        if win is None:
            raise EnvironmentError_("ノートウィンドウが見つかりません。LINEでオープンチャットを開き、ノートを表示してください", 5)
        self.win = win
        self._last_pos: tuple[float, float] | None = None
        self._last_action = 0.0
        self._start = time.time()
        self._prev: MacScreen | None = None
        self.keep = keep_screenshots

    # ユーザーの操作を検知して、中断する
    def pause(self) -> None:
        if screen_locked():
            raise Aborted("画面がロックされました")
        ev = Quartz.CGEventCreate(None)
        pos = Quartz.CGEventGetLocation(ev)
        if self._last_pos is not None and math.hypot(pos.x - self._last_pos[0], pos.y - self._last_pos[1]) > 30:
            raise Aborted(f"マウスが動かされたため中断しました(想定 {self._last_pos[0]:.0f},{self._last_pos[1]:.0f} → 実際 {pos.x:.0f},{pos.y:.0f})")
        # このcollectorはキーボードイベントを送らないので、開始後のキー入力はすべてユーザーの操作
        since_key = Quartz.CGEventSourceSecondsSinceLastEventType(Quartz.kCGEventSourceStateHIDSystemState, Quartz.kCGEventKeyDown)
        if since_key < time.time() - self._start:
            raise Aborted("キーボードが操作されたため中断しました")

    def shot(self) -> MacScreen:
        win = find_note_window()
        if win is None:
            raise Aborted("ノートウィンドウが閉じられました")
        self.win = win
        fd, path = tempfile.mkstemp(suffix=".png", prefix="linenote-")
        os.close(fd)
        os.chmod(path, 0o600)
        subprocess.run(["screencapture", "-x", "-o", "-l", str(win.id), path], check=True)
        if self._prev is not None and not self.keep:
            self._prev.close()
        self._prev = MacScreen(path, win)
        return self._prev

    def scroll(self, lines: int) -> None:
        """lines>0 で下へ. ピクセル単位のイベントはLINEが無視するので、行単位で送る."""
        x, y = self.win.x + self.win.w / 2, self.win.y + self.win.h * 0.55
        Quartz.CGWarpMouseCursorPosition((x, y))
        step = 3 if lines > 0 else -3
        for _ in range(max(1, abs(lines) // 3)):
            ev = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 1, -step)
            Quartz.CGEventSetLocation(ev, (x, y))
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
            time.sleep(0.03)
        time.sleep(0.6)
        self._last_pos, self._last_action = (x, y), time.time()

    def click_at(self, x: float, y: float) -> None:
        """Session._click からだけ呼ぶ(guard_click 済み). 押す場所は左クリック1回."""
        raise_note_window()
        pt = Quartz.CGPointMake(self.win.x + x, self.win.y + y)
        for t in (Quartz.kCGEventMouseMoved, Quartz.kCGEventLeftMouseDown, Quartz.kCGEventLeftMouseUp):
            ev = Quartz.CGEventCreateMouseEvent(None, t, pt, Quartz.kCGMouseButtonLeft)
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
            time.sleep(0.05)
        self._last_pos, self._last_action = (pt.x, pt.y), time.time()
        time.sleep(1.2)

    def close(self) -> None:
        if self._prev is not None and not self.keep:
            self._prev.close()
