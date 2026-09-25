"""run_sync: コマンドとエージェントが共通で使う、同期1回ぶんの実行(LINEの画面を模擬して通しで確認)."""
import json
from datetime import datetime, timedelta, timezone

import re

import pytest

from line_openchat.ledger import Ledger
from line_openchat.runner import RunnerError, SyncConfig, acquire_lock, run_sync
from sim import SimDriver
from test_session import NOW, build


class FakeUploader:
    def __init__(self):
        self.calls = []
        self.sent = []

    def start(self, client_run_id, version, started_at=None):
        self.started_at = started_at
        self.calls.append("start")
        return "run-1"

    def send_notes(self, client_run_id, notes):
        self.calls.append("send")
        self.sent = [n["id"] for n in notes]
        return list(self.sent)

    def complete(self, client_run_id, status, stats, warnings):
        self.calls.append(("complete", status, stats))

    def fetch_ledger(self):
        self.calls.append("fetch")
        return {"notes": [], "comments": []}


def go(tmp_path, chat, **kw):
    up = kw.pop("uploader", FakeUploader())
    cfg_args = {"portal_url": "https://example.test", "first_run": True, "ledger_path": tmp_path / "ledger.json", **kw.pop("cfg", {})}
    cfg = SyncConfig(**cfg_args)
    outcome = run_sync(cfg, driver_factory=lambda: SimDriver(chat), uploader_factory=lambda url, log: up, now=NOW, **kw)
    return outcome, up, None


def test_full_run_reads_uploads_and_saves_the_ledger(tmp_path):
    outcome, up, progress = go(tmp_path, build(jitter=False))
    assert outcome.status == "success" and outcome.uploaded
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", up.started_at)        # 読み取りを始めた時刻を送る
    assert up.calls[:2] == ["fetch", "start"] and up.calls[-1][0] == "complete" and up.calls[-1][1] == "success"
    assert up.calls[-1][2]["notesScanned"] == 6
    ledger = Ledger.load(tmp_path / "ledger.json")
    assert len(ledger.notes) == 6
    assert not ledger.pending_notes()                        # 送れたものは pending が下りる
    assert ledger.meta["last_run"]["status"] == "success"


def test_dry_run_never_touches_the_portal(tmp_path):
    up = FakeUploader()
    outcome, _, _ = go(tmp_path, build(jitter=False), uploader=up, cfg={"dry_run": True})
    assert outcome.status == "success" and not outcome.uploaded
    assert up.calls == []
    assert len(Ledger.load(tmp_path / "ledger.json").pending_notes()) == 6      # 送っていないので pending のまま


def test_upload_failure_keeps_the_data_pending_for_next_time(tmp_path):
    class Broken(FakeUploader):
        def send_notes(self, client_run_id, notes):
            raise RuntimeError("Portalへの送信に失敗しました")
    outcome, _, _ = go(tmp_path, build(jitter=False), uploader=Broken())
    assert outcome.status == "failed" and outcome.error_code == "upload_failed"
    assert len(Ledger.load(tmp_path / "ledger.json").pending_notes()) == 6


def test_second_run_from_the_saved_ledger_opens_nothing(tmp_path):
    go(tmp_path, build(jitter=False))
    outcome, _, _ = go(tmp_path, build(seed=3), cfg={"first_run": False})
    assert outcome.stats.notes_opened == 0


def test_ledger_missing_and_restore_failing_aborts_without_touching_line(tmp_path):
    """台帳が無く、Portalからの復元も失敗したら、LINEの画面には触れずに中断する(既存データとの重複を防ぐ)。
    2026-09-25、認証設定の誤りで復元が失敗し、黙って空の台帳から新規スキャンした結果、Portalに既にある
    15ノートが新しいIDで重複した事故の再発防止。"""
    class Broken(FakeUploader):
        def fetch_ledger(self):
            self.calls.append("fetch")
            raise RuntimeError("認証エラー")

    def no_driver():
        raise AssertionError("復元に失敗した時点で中断すべきで、LINEの画面には触れないはず")

    cfg = SyncConfig(portal_url="https://example.test", first_run=False, ledger_path=tmp_path / "ledger.json")
    with pytest.raises(RunnerError) as e:
        run_sync(cfg, driver_factory=no_driver, uploader_factory=lambda url, log: Broken(), now=NOW)
    assert e.value.code == "ledger_missing"


def test_ledger_missing_and_no_portal_configured_aborts_too(tmp_path):
    """Portal未設定(URLが無い、または --dry-run で送信先が無い)で台帳も無いときも、同じ理由で中断する。"""
    def no_driver():
        raise AssertionError("中断すべきで、LINEの画面には触れないはず")

    cfg = SyncConfig(portal_url="", first_run=False, ledger_path=tmp_path / "ledger.json")
    with pytest.raises(RunnerError) as e:
        run_sync(cfg, driver_factory=no_driver, now=NOW)
    assert e.value.code == "ledger_missing"


def test_first_run_explicitly_allows_starting_empty_even_if_restore_fails(tmp_path):
    """--first-run を明示していれば、復元に失敗しても(本当に初回のつもりで)続行できる。"""
    class Broken(FakeUploader):
        def fetch_ledger(self):
            raise RuntimeError("認証エラー")
    outcome, _, _ = go(tmp_path, build(jitter=False), uploader=Broken(), cfg={"first_run": True})
    assert outcome.status == "success"


def test_restore_succeeding_with_zero_notes_does_not_abort(tmp_path):
    """Portalの復元自体は成功したが(たまたま0件でも)、それは「失敗」ではないので中断しない。"""
    outcome, _, _ = go(tmp_path, build(jitter=False), cfg={"first_run": False})
    assert outcome.status == "success"


def test_only_one_run_at_a_time(tmp_path):
    held = acquire_lock(tmp_path)
    try:
        with pytest.raises(RunnerError) as e:
            go(tmp_path, build(jitter=False))
        assert e.value.code == "already_running"
    finally:
        held.close()
    outcome, _, _ = go(tmp_path, build(jitter=False), cfg={"dry_run": True})
    assert outcome.status == "success"                        # ロックを離せば、また実行できる


def test_summary_is_json_serializable(tmp_path):
    outcome, _, _ = go(tmp_path, build(jitter=False))
    json.dumps(outcome.summary, ensure_ascii=False)


def test_cli_explains_a_missing_note_window_instead_of_crashing(monkeypatch, capsys, tmp_path):
    """ノートが開いていないとき、スタックトレースではなく、直し方つきの説明を出して終了する(終了コード5)。"""
    from line_openchat import lineui, sync
    monkeypatch.setattr(lineui, "check_environment", lambda: None)

    def no_window():
        raise lineui.EnvironmentError_("ノートウィンドウが見つかりません。LINEでオープンチャットを開き、ノートを表示してください", 5)
    monkeypatch.setattr(lineui, "LineDriver", no_window)
    code = sync.main(["--dry-run", "--ledger", str(tmp_path / "l.json")])
    err = capsys.readouterr().err
    assert code == 5
    assert "実行できません" in err and "ノートを表示してください" in err and "Traceback" not in err
    assert "触らないでください" in err                       # 開始前の案内は出ている
