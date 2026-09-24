import io
from pathlib import Path
import json
import urllib.error

import pytest

from line_openchat.ledger import CommentObs, Ledger, NoteObs
from line_openchat.sync import run_status
from line_openchat.session import RunStats
from line_openchat.uploader import MAX_COMMENTS_PER_REQUEST, MAX_NOTES_PER_REQUEST, Uploader, chunk_notes, note_payload

NOW = "2026-09-24T12:00:00+09:00"


def ledger_with(n_notes, n_comments):
    led = Ledger()
    for i in range(n_notes):
        note, _ = led.upsert_note(NoteObs("作者", False, f"本文{i}", f"2026-09-{10 + i:02d}T00:00:00Z", "exact", "9.1 午後1:00", n_comments), NOW)
        obs = [CommentObs(f"人{j}", j % 3 == 0, f"コメント{i}-{j}", f"2026-09-{10 + i:02d}T{j % 20:02d}:00:00Z", "exact", "", 1.0) for j in range(n_comments)]
        led.apply_collection(note, obs, n_comments, NOW)
    return led


def test_payload_shape_and_fields():
    led = ledger_with(1, 2)
    p = note_payload(led.notes[0])
    assert p["authorIsTarget"] is False and p["commentCount"] == 2 and len(p["comments"]) == 2
    assert {"id", "ordinal", "authorName", "isTarget", "bodyText", "postedAt", "postedAtPrecision", "deletedAt"} <= set(p["comments"][0])
    json.dumps(p, ensure_ascii=False)


def test_chunks_are_bounded_and_cover_every_comment_exactly_once():
    led = ledger_with(6, 25)                            # 150コメント
    chunks = chunk_notes(led.notes)
    seen = []
    for chunk in chunks:
        assert len(chunk) <= MAX_NOTES_PER_REQUEST
        assert sum(len(cs) for _, cs in chunk) <= MAX_COMMENTS_PER_REQUEST
        for note, cs in chunk:
            seen += [(note["id"], c["id"]) for c in cs]
    assert len(seen) == len(set(seen)) == 150
    assert {n["id"] for chunk in chunks for n, _ in chunk} == {n["id"] for n in led.notes}


def test_notes_without_comments_are_sent_once():
    led = ledger_with(3, 0)
    chunks = chunk_notes(led.notes)
    assert sum(len(c) for c in chunks) == 3


class FakeResponse(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *a): return False


def make_uploader(handler, log=None):
    calls = []

    def opener(request, timeout):
        body = json.loads(request.data.decode("utf-8")) if request.data else None
        calls.append((request.full_url, body, dict(request.header_items())))
        return handler(request, body, len(calls))
    up = Uploader("https://example.test/", token="secret", client_id="cid", opener=opener, log=log or (lambda s: None))
    return up, calls


def test_sends_service_token_headers_and_never_puts_them_in_the_body():
    up, calls = make_uploader(lambda r, b, n: FakeResponse(json.dumps({"runId": "r1"}).encode()))
    assert up.start("run-1", "v") == "r1"
    url, body, headers = calls[0]
    assert url == "https://example.test/api/openchat/sync"
    assert headers["Cf-access-client-id"] == "cid" and headers["Cf-access-client-secret"] == "secret"
    assert "secret" not in json.dumps(body)


def test_send_notes_returns_only_fully_sent_notes_and_survives_a_failed_chunk(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    led = ledger_with(12, 1)                            # 2 chunks (10 + 2)

    def handler(request, body, n):
        if n == 1:                                       # 1回目のリクエストは常に5xx
            raise urllib.error.HTTPError(request.full_url, 502, "bad gateway", {}, io.BytesIO(b"x"))
        return FakeResponse(json.dumps({"results": [{"id": x["id"]} for x in body["notes"]]}).encode())
    up, calls = make_uploader(handler)
    done = up.send_notes("run-1", led.notes)
    assert len(done) == 12                               # 5xxは再試行して成功する


def test_a_rejected_chunk_is_not_marked_done(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    led = ledger_with(12, 1)
    first_ids = {n["id"] for n in led.notes[:10]}

    def handler(request, body, n):
        ids = [x["id"] for x in body["notes"]]
        if set(ids) & first_ids:
            raise urllib.error.HTTPError(request.full_url, 400, "bad", {}, io.BytesIO(b"nope"))
        return FakeResponse(json.dumps({"results": [{"id": i} for i in ids]}).encode())
    up, _ = make_uploader(handler)
    done = up.send_notes("run-1", led.notes)
    assert set(done) == {n["id"] for n in led.notes[10:]}


def test_per_note_error_in_response_keeps_that_note_pending():
    led = ledger_with(3, 1)
    bad = led.notes[1]["id"]
    up, _ = make_uploader(lambda r, b, n: FakeResponse(json.dumps({"results": [{"id": x["id"], **({"error": "x"} if x["id"] == bad else {})} for x in b["notes"]]}).encode()))
    done = up.send_notes("run-1", led.notes)
    assert bad not in done and len(done) == 2


def test_missing_client_id_is_refused(monkeypatch):
    monkeypatch.delenv("PORTAL_SYNC_CLIENT_ID", raising=False)
    with pytest.raises(RuntimeError):
        Uploader("https://x", token="t", client_id="")


def test_run_status():
    ok = RunStats()
    assert run_status(ok, True) == "success"
    warn = RunStats(warnings=["x"])
    assert run_status(warn, True) == "partial"
    assert run_status(ok, False) == "failed"
    assert run_status(RunStats(aborted=True), True) == "aborted"


def test_payload_matches_the_fixture_the_worker_test_accepts():
    """Worker側(tests/workers/openchat.test.ts)は、同じ fixture を受け付けることを確かめている。
    キーの構成がずれたら、どちらかのテストが落ちる."""
    fixture = json.loads((Path(__file__).resolve().parents[2] / "tests/workers/fixtures/openchat-sync-payload.json").read_text(encoding="utf-8"))
    led = ledger_with(1, 2)
    made = note_payload(led.notes[0])
    sample = fixture["notes"][0]
    assert set(made) == set(sample)
    assert set(made["comments"][0]) == set(sample["comments"][0])
    for n in fixture["notes"]:
        assert set(n) == set(made)
