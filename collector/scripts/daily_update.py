#!/usr/bin/env python3
"""Run the configured wallet and exchange updates once.

This command is intended to be invoked by macOS launchd.  It does not start
the web server and therefore can run independently of the dashboard UI.
"""

from __future__ import annotations

import fcntl
import json
import logging
import os
import subprocess
import sys
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import app  # noqa: E402
from debank_auto import fetch_wallets_html  # noqa: E402


LOCK_FILE = app.DATA / "daily-update.lock"
STATE_FILE = app.DATA / "daily-update-state.json"
CONFIG_FILE = ROOT / "config" / "app-config.json"
LOG = logging.getLogger("manage_asset.daily_update")


def load_schedule() -> dict:
    try:
        config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        schedule = config.get("daily_update", {})
        if not isinstance(schedule, dict):
            raise ValueError("daily_update must be an object")
        return schedule
    except (OSError, ValueError, TypeError) as exc:
        LOG.error("Could not load daily update configuration: %s", exc)
        return {"enabled": False}


def scheduled_times(schedule: dict) -> set[str]:
    times: set[str] = set(str(item) for item in schedule.get("additional_retry_times", []))
    for window in schedule.get("windows", []):
        if not isinstance(window, dict):
            continue
        try:
            start = datetime.strptime(str(window["start"]), "%H:%M")
            end = datetime.strptime(str(window["end"]), "%H:%M")
            interval = int(window["interval_minutes"])
            if interval <= 0 or end < start:
                continue
        except (KeyError, TypeError, ValueError):
            continue
        current = start
        while current <= end:
            times.add(current.strftime("%H:%M"))
            current += timedelta(minutes=interval)
    return times


def due_slot(schedule: dict, now: datetime) -> str | None:
    """Return the latest configured slot reached today.

    launchd may start this script a little after the configured minute. Using
    the latest reached slot instead of an exact HH:MM match prevents a missed
    retry when the one-minute launchd wake-up is delayed.
    """
    current = now.strftime("%H:%M")
    reached = sorted(slot for slot in scheduled_times(schedule) if slot <= current)
    return reached[-1] if reached else None


def acquire_lock():
    LOCK_FILE.parent.mkdir(exist_ok=True)
    lock = LOCK_FILE.open("w", encoding="utf-8")
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        return None
    return lock


def update_wallets(run_id: str, as_of_date: str, wallet_ids: set[str] | None = None) -> tuple[int, int, list[str], dict[str, str]]:
    wallets = [wallet for wallet in app.load_wallets() if wallet.get("enabled", True)]
    if wallet_ids is not None:
        wallets = [wallet for wallet in wallets if wallet.get("wallet_id") in wallet_ids]
    if not wallets:
        LOG.info("No enabled wallets configured")
        return 0, 0, [], {}

    success = 0
    failed = 0
    failed_ids: list[str] = []
    errors: dict[str, str] = {}
    fx_rate = app.usd_jpy_rate()

    def handle(fetched) -> None:
        nonlocal success, failed
        if fetched.html is None:
            failed += 1
            failed_ids.append(fetched.wallet_id)
            errors[fetched.wallet_id] = fetched.error or "取得に失敗しました"
            app.append_jsonl(app.RUNS_FILE, {
                "schema_version": 1,
                "record_type": "import_event",
                "run_id": run_id,
                "wallet_id": fetched.wallet_id,
                "wallet_name": fetched.name,
                "as_of_date": as_of_date,
                "captured_at": app.now_iso(),
                "status": "error",
                "error": fetched.error,
                "trigger": "launchd",
            })
            LOG.error("Wallet %s failed: %s", fetched.name, fetched.error)
            return

        wallet = next(wallet for wallet in wallets if wallet["wallet_id"] == fetched.wallet_id)
        try:
            record = app.build_snapshot_record(
                wallet,
                fetched.html,
                as_of_date,
                run_id=run_id,
                source="debank_auto_browser",
                fx_usdjpy=fx_rate,
            )
            app.append_jsonl(app.SNAPSHOTS_FILE, record)
            app.append_jsonl(app.RUNS_FILE, {
                "schema_version": 1,
                "record_type": "import_event",
                "run_id": run_id,
                "wallet_id": fetched.wallet_id,
                "wallet_name": fetched.name,
                "as_of_date": as_of_date,
                "captured_at": record["captured_at"],
                "status": "success",
                "trigger": "launchd",
            })
            success += 1
            LOG.info("Wallet %s updated", fetched.name)
        except Exception as exc:  # noqa: BLE001 - continue with other wallets
            failed += 1
            failed_ids.append(fetched.wallet_id)
            errors[fetched.wallet_id] = str(exc)
            LOG.exception("Wallet %s could not be saved: %s", fetched.name, exc)

    fetch_wallets_html(wallets, on_result=handle)
    return success, failed, failed_ids, errors


def update_exchanges(run_id: str, source_ids: set[str] | None = None) -> tuple[int, int, list[str], dict[str, str]]:
    sources = [
        source for source in app.load_sources()
        if source.get("enabled", True) and source.get("credential_ref")
    ]
    if source_ids is not None:
        sources = [source for source in sources if source.get("source_id") in source_ids]
    success = 0
    failed = 0
    failed_ids: list[str] = []
    errors: dict[str, str] = {}
    for source in sources:
        try:
            snapshot = app.build_exchange_snapshot(source)
            snapshot["run_id"] = run_id
            app.append_jsonl(app.PORTFOLIO_SNAPSHOTS_FILE, snapshot)
            app.append_jsonl(app.RUNS_FILE, {
                "schema_version": 2,
                "record_type": "exchange_import_event",
                "run_id": run_id,
                "source_id": source["source_id"],
                "provider": source["provider"],
                "captured_at": snapshot["captured_at"],
                "status": "success",
                "trigger": "launchd",
            })
            success += 1
            LOG.info("Exchange %s updated", source.get("display_name"))
        except Exception as exc:  # noqa: BLE001 - continue with other sources
            failed += 1
            failed_ids.append(source["source_id"])
            errors[source["source_id"]] = str(exc)
            LOG.exception("Exchange %s failed: %s", source.get("display_name"), exc)
    return success, failed, failed_ids, errors


def load_retry_state(as_of_date: str) -> tuple[set[str] | None, set[str] | None]:
    """Return failed targets from today's earlier attempt, if any.

    A missing or stale state means this is the first attempt of the day and
    all enabled targets should be fetched.
    """
    if not STATE_FILE.exists():
        return None, None
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        LOG.warning("Could not read retry state; starting a full update")
        return None, None
    if state.get("as_of_date") != as_of_date:
        return None, None
    return set(state.get("failed_wallet_ids", [])), set(state.get("failed_source_ids", []))


def save_retry_state(
    as_of_date: str,
    failed_wallet_ids: list[str],
    failed_source_ids: list[str],
    errors: dict[str, str],
    *,
    last_run_slot: str | None = None,
    portal_sync_pending: bool | None = None,
) -> None:
    previous = {}
    if STATE_FILE.exists():
        try:
            loaded = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                previous = loaded
        except (OSError, ValueError):
            previous = {}
    STATE_FILE.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "as_of_date": as_of_date,
                "failed_wallet_ids": failed_wallet_ids,
                "failed_source_ids": failed_source_ids,
                "errors": errors,
                "last_run_slot": last_run_slot if last_run_slot is not None else previous.get("last_run_slot"),
                "portal_sync_pending": portal_sync_pending if portal_sync_pending is not None else bool(previous.get("portal_sync_pending")),
                "updated_at": app.now_iso(),
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def main() -> int:
    schedule = load_schedule()
    now = datetime.now()
    force_run = os.environ.get("MANAGE_ASSET_FORCE_RUN") == "1"
    slot = due_slot(schedule, now)
    as_of_date = date.today().isoformat()
    slot_key = f"{as_of_date}T{slot}" if slot else None
    existing_state = {}
    if STATE_FILE.exists():
        try:
            loaded = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            if isinstance(loaded, dict) and loaded.get("as_of_date") == as_of_date:
                existing_state = loaded
        except (OSError, ValueError):
            existing_state = {}
    if not force_run and (not schedule.get("enabled", True) or not slot or existing_state.get("last_run_slot") == slot_key):
        LOG.info("Outside the scheduled run window; skipping")
        return 0

    lock = acquire_lock()
    if lock is None:
        LOG.warning("Daily update is already running; skipping this run")
        return 0
    try:
        run_id = "run_" + uuid.uuid4().hex[:12]
        retry_wallet_ids, retry_source_ids = load_retry_state(as_of_date)
        attempt_label = "initial" if retry_wallet_ids is None else "retry"
        wallet_success, wallet_failed, failed_wallet_ids, wallet_errors = update_wallets(
            run_id, as_of_date, retry_wallet_ids
        )
        exchange_success, exchange_failed, failed_source_ids, exchange_errors = update_exchanges(
            run_id, retry_source_ids
        )
        # Read the pending flag from the state left by the PREVIOUS run before
        # overwriting it below. A run that ends up skipping the sync (nothing
        # new, previous sync already succeeded) must persist that same
        # "nothing pending" fact, or the next run reads a stale True and
        # syncs again — which is exactly what an earlier version of this fix
        # did: it always wrote portal_sync_pending=True here regardless of
        # outcome, so skip/sync alternated every other slot instead of
        # settling to skip after the first success.
        should_sync = bool(existing_state.get("portal_sync_pending", True)) or wallet_success > 0 or exchange_success > 0
        save_retry_state(
            as_of_date,
            failed_wallet_ids,
            failed_source_ids,
            {**wallet_errors, **exchange_errors},
            last_run_slot=slot_key,
            portal_sync_pending=should_sync,
        )
        total_failed = wallet_failed + exchange_failed
        LOG.info(
            "Daily update finished (%s): wallets=%d/%d, exchanges=%d/%d, retry_targets=%d",
            attempt_label,
            wallet_success, wallet_success + wallet_failed,
            exchange_success, exchange_success + exchange_failed,
            total_failed,
        )
        portal_url = os.environ.get("PORTAL_URL", "").strip()
        portal_sync_failed = False
        if portal_url and not should_sync:
            LOG.info("Portal sync skipped: no new data since the last successful sync")
        if portal_url and should_sync:
            try:
                result = subprocess.run(
                    [sys.executable, str(ROOT / "scripts" / "sync_to_portal.py"), portal_url],
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                if result.returncode:
                    portal_sync_failed = True
                    LOG.warning("Portal sync failed: %s", result.stderr.strip() or result.stdout.strip())
                else:
                    LOG.info("Portal sync completed: %s", result.stdout.strip())
                    save_retry_state(
                        as_of_date,
                        failed_wallet_ids,
                        failed_source_ids,
                        {**wallet_errors, **exchange_errors},
                        last_run_slot=slot_key,
                        portal_sync_pending=False,
                    )
            except (OSError, subprocess.SubprocessError) as exc:
                LOG.warning("Portal sync could not start: %s", exc)
        return 1 if total_failed or portal_sync_failed else 0
    finally:
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        lock.close()


if __name__ == "__main__":
    raise SystemExit(main())
