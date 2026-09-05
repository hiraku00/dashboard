import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { toLegacyExchangeSnapshot, toLegacyWalletSnapshot } from "@/app/lib/manage-asset-legacy";

function newestRecord(current: Record<string, unknown>, previous: Record<string, unknown>): boolean {
  const currentSync = String(current.sync_received_at ?? "");
  const previousSync = String(previous.sync_received_at ?? "");
  if (currentSync !== previousSync) return currentSync > previousSync;
  const currentCaptured = String(current.captured_at ?? "");
  const previousCaptured = String(previous.captured_at ?? "");
  return currentCaptured > previousCaptured;
}

export async function GET() {
  await ensureSchema({ seed: false });
  const records = (await env.DB.prepare("SELECT * FROM asset_history_records ORDER BY as_of_date ASC, captured_at ASC").all<Record<string, unknown>>()).results ?? [];
  let snapshots = records.filter(row => row.record_type === "wallet").map(row => JSON.parse(String(row.payload_json)));
  let exchangeSnapshots = records.filter(row => row.record_type === "exchange").map(row => JSON.parse(String(row.payload_json)));

  // The daily collector writes the normalized current snapshot tables, while
  // the migration endpoint writes the legacy history table. Merge both here so
  // today's data is available to the same charts as imported history.
  const normalized = (await env.DB.prepare(`SELECT s.*, a.source_type, a.display_name, a.public_address, r.received_at AS sync_received_at
    FROM asset_snapshots s JOIN asset_sources a ON a.id=s.source_id
    LEFT JOIN asset_sync_runs r ON r.id=s.run_id
    ORDER BY s.as_of_date ASC, s.captured_at ASC`).all<Record<string, unknown>>()).results ?? [];
  const normalizedPositions = (await env.DB.prepare(`SELECT p.*, s.id AS snapshot_id, s.source_id, s.as_of_date, s.captured_at, a.source_type, a.display_name
    FROM asset_positions p JOIN asset_snapshots s ON s.id=p.snapshot_id JOIN asset_sources a ON a.id=s.source_id
    ORDER BY s.as_of_date ASC, s.captured_at ASC`).all<Record<string, unknown>>()).results ?? [];
  const positionsBySnapshot = new Map<string, Record<string, unknown>[]>();
  for (const position of normalizedPositions) {
    // Position rows belong to one concrete asset_snapshots row. Do not group
    // by source/date/captured_at here: retries can create multiple snapshots
    // with the same values, and merging them multiplies every currency.
    const key = String(position.snapshot_id ?? "");
    if (!key) continue;
    const rows = positionsBySnapshot.get(key) ?? [];
    rows.push(position);
    positionsBySnapshot.set(key, rows);
  }
  for (const row of normalized) {
    const key = String(row.id ?? "");
    const positions = positionsBySnapshot.get(key) ?? [];
    // Same mappers /api/manage-asset/state uses, so the two endpoints cannot
    // drift in the shape they hand the legacy frontend.
    if (String(row.source_type).toLowerCase() === "wallet") {
      snapshots.push(toLegacyWalletSnapshot(row, positions));
    } else {
      exchangeSnapshots.push(toLegacyExchangeSnapshot(row, positions));
    }
  }
  // A launchd retry can leave both a legacy-import row and a normalized row
  // for the same source/date. The charts must use exactly one, newest record
  // per source and date; otherwise today's stETH balance is multiplied.
  const newestWallets = new Map<string, Record<string, unknown>>();
  for (const row of snapshots) {
    const key = `${String(row.wallet_id ?? "")}|${String(row.as_of_date ?? "").slice(0, 10)}`;
    const previous = newestWallets.get(key);
    if (key !== "|" && (!previous || newestRecord(row, previous))) newestWallets.set(key, row);
  }
  const newestExchanges = new Map<string, Record<string, unknown>>();
  for (const row of exchangeSnapshots) {
    const key = `${String(row.source_id ?? "")}|${String(row.as_of_date ?? "").slice(0, 10)}`;
    const previous = newestExchanges.get(key);
    if (key !== "|" && (!previous || newestRecord(row, previous))) newestExchanges.set(key, row);
  }
  snapshots = [...newestWallets.values()].sort((a, b) => String(a.as_of_date ?? "").localeCompare(String(b.as_of_date ?? "")));
  exchangeSnapshots = [...newestExchanges.values()].sort((a, b) => String(a.as_of_date ?? "").localeCompare(String(b.as_of_date ?? "")));
  // Only snapshots and exchange_snapshots are read by the one consumer of this
  // endpoint (public/manage-asset-original/app-ui.js, which feeds them to
  // Core.historyPoints / Core.currencyHistory / Core.previousOpeningPoint).
  //
  // This used to also return points, holdings, symbols, currencies,
  // lido_rewards and rates. Nothing read any of them: the page computes
  // holdings client-side from /state, and takes the Lido and FX rows from
  // /api/lido-rewards and /api/usd-jpy-rates. Producing them meant two extra
  // full table reads (asset_lido_rewards + asset_fx_rates, ~1,660 rows) and a
  // per-symbol currencyHistory pass over every position, on every page view.
  return Response.json({
    snapshots,
    exchange_snapshots: exchangeSnapshots,
  });
}
