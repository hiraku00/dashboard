"""再取得依頼の確認が失敗し続けるとき、警告は途切れ1回につき1行だけ出す。"""

import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import daily_update  # noqa: E402


def messages(caplog):
    return [(record.levelname, record.getMessage()) for record in caplog.records if record.name == daily_update.LOG.name]


def test_warns_once_per_outage_and_reports_recovery(tmp_path, caplog):
    state = tmp_path / "resync-check-state.json"
    caplog.set_level(logging.DEBUG, logger=daily_update.LOG.name)

    daily_update.note_resync_check_result(None, state)
    assert messages(caplog) == []
    assert not state.exists()

    for _ in range(3):
        daily_update.note_resync_check_result("timed out", state)
    logged = messages(caplog)
    assert [level for level, _ in logged] == ["WARNING"]
    assert "timed out" in logged[0][1]
    assert json.loads(state.read_text(encoding="utf-8"))["failures"] == 3

    caplog.clear()
    daily_update.note_resync_check_result(None, state)
    logged = messages(caplog)
    assert [level for level, _ in logged] == ["INFO"]
    assert "after 3 failed checks" in logged[0][1]
    assert not state.exists()

    # 復旧のあとの失敗は、新しい途切れとしてもう一度警告する。
    caplog.clear()
    daily_update.note_resync_check_result("timed out", state)
    assert [level for level, _ in messages(caplog)] == ["WARNING"]


def test_unreadable_state_counts_as_no_failures(tmp_path, caplog):
    state = tmp_path / "resync-check-state.json"
    state.write_text("not json", encoding="utf-8")
    caplog.set_level(logging.DEBUG, logger=daily_update.LOG.name)
    daily_update.note_resync_check_result("boom", state)
    assert [level for level, _ in messages(caplog)] == ["WARNING"]
    assert json.loads(state.read_text(encoding="utf-8"))["failures"] == 1
