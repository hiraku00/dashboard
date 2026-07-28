"""Send already-captured Manage Asset snapshots to the Cloudflare portal.

This adapter never reads exchange credentials. API keys remain in the existing
macOS Keychain code path; this script only reads normalized local snapshots.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
import ssl
from datetime import datetime, timezone
from pathlib import Path

import certifi

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import app


def keychain_token() -> str:
    value = os.environ.get("PORTAL_SYNC_TOKEN", "").strip()
    if value:
        return value
    service = os.environ.get("PORTAL_SYNC_KEYCHAIN_SERVICE", "manage-asset:portal-sync")
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-a", "local-user", "-s", service, "-w"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise RuntimeError("Portal同期用Service TokenをmacOS Keychainから取得できませんでした") from exc
    return result.stdout.strip()


def post(base_url: str, token: str, body: dict) -> dict:
    client_id = os.environ.get("PORTAL_SYNC_CLIENT_ID", "").strip()
    if not client_id:
        raise RuntimeError("PORTAL_SYNC_CLIENT_IDを設定してください")
    request = urllib.request.Request(
        base_url.rstrip("/") + "/api/manage-asset/sync",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "CF-Access-Client-Id": client_id,
            "CF-Access-Client-Secret": token,
            "User-Agent": "manage-asset-portal-sync/1.0",
        },
        method="POST",
    )
    context = ssl.create_default_context(cafile=certifi.where())
    with urllib.request.urlopen(request, timeout=30, context=context) as response:
        return json.loads(response.read().decode("utf-8"))


def as_source(source_id: str, source: dict, source_type: str, provider: str, name: str, address: str = "") -> dict:
    return {"sourceId": source_id, "sourceType": source_type, "provider": provider, "displayName": name, "publicAddress": address}


def wallet_entry(row: dict) -> dict:
    source_id = str(row.get("wallet_id") or row.get("source_id") or row.get("id"))
    total_usd = row.get("total_usd", 0)
    fx_usdjpy = row.get("fx_usdjpy")
    total_jpy = row.get("total_jpy")
    if total_jpy in (None, "") and total_usd not in (None, "") and fx_usdjpy not in (None, ""):
        total_jpy = float(total_usd) * float(fx_usdjpy)
    snapshot = {**row, "capturedAt": row.get("captured_at"), "asOfDate": row.get("as_of_date"), "totalUsd": total_usd, "totalJpy": total_jpy or 0, "fxUsdjpy": fx_usdjpy}
    positions = list(row.get("tokens") or [])
    return {"source": as_source(source_id, row, "wallet", "debank", str(row.get("wallet_name") or row.get("name") or source_id), str(row.get("address") or "")), "snapshot": snapshot, "positions": positions}


def exchange_entry(row: dict) -> dict:
    source_id = str(row.get("source_id") or row.get("account_name") or row.get("id"))
    totals = row.get("totals") or {}
    total_usd = totals.get("net_asset_usd", row.get("total_usd", 0))
    fx_usdjpy = row.get("fx_usdjpy")
    total_jpy = totals.get("net_asset_jpy", row.get("total_jpy"))
    if total_jpy in (None, "") and total_usd not in (None, "") and fx_usdjpy not in (None, ""):
        total_jpy = float(total_usd) * float(fx_usdjpy)
    snapshot = {**row, "capturedAt": row.get("captured_at"), "asOfDate": row.get("as_of_date"), "totalUsd": total_usd, "totalJpy": total_jpy or 0, "fxUsdjpy": fx_usdjpy}
    return {"source": as_source(source_id, row, "exchange", str(row.get("provider") or "unknown"), str(row.get("account_name") or row.get("display_name") or source_id)), "snapshot": snapshot, "positions": row.get("positions") or []}


def main() -> int:
    base_url = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("PORTAL_URL", "")).strip()
    if not base_url:
        print("PORTAL_URLまたは第1引数でポータルURLを指定してください", file=sys.stderr)
        return 2
    token = keychain_token()
    wallets = app.latest_snapshots()
    exchanges = app.latest_portfolio_snapshots()
    entries = [wallet_entry(row) for row in wallets] + [exchange_entry(row) for row in exchanges]
    client_run_id = "manage-asset-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    start = post(base_url, token, {"action": "start", "clientRunId": client_run_id, "clientVersion": "manage-asset-local/1", "sourceCount": len(entries)})
    for entry in entries:
        post(base_url, token, {"action": "source", "clientRunId": client_run_id, **entry})
    done = post(base_url, token, {"action": "complete", "clientRunId": client_run_id})
    print(json.dumps({"ok": True, "run_id": start.get("runId"), "source_count": len(entries), "complete": done}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
